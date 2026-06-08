/**
 * Vault-internal type definitions for a memory across its three lifecycle shapes:
 *
 *   - `Memory`        — input to a write. What the caller (MCP / CLI / ingest) describes.
 *   - `MemFile`       — on-disk encrypted form. Serialized to `<id>.mem`.
 *   - `MemMetadata`   — in-RAM cached form. Powers fast filtering without decrypting.
 *
 * Lives in `vault/` (not `core/types.ts`) because all three are consumed by the Vault
 * class and its helpers. Cross-cutting types (`MachineConfig`, `VaultConfig`, the `*Type`
 * string aliases) stay in `core/types.ts` because the storage/embedder/key registries
 * and the CLI all reference them.
 *
 * # The model: chronicle + memento
 *
 * A `memento` is one logical memory and is stored as exactly ONE `<id>.mem` file. If the
 * memory text is long it is split into several `chunks` — but those chunks live INSIDE the
 * one file (an internal `[{text,vector}]` array), they are never separate files. There is
 * no cross-file numbering anywhere: git's per-file merge unit equals the memento.
 *
 * A `chronicle` is a conversation — a set of mementos sharing a `chronicle_id`. It is not
 * a stored object; it is derived by grouping mementos in RAM.
 */
import type { Encrypted } from './crypto.js'
import type { SearchOutcome } from '../../searchers/interface.js'

/**
 * Input shape for `writeMemento`. One value describes one memento.
 *
 * `text` is either a single string (auto-chunked if longer than the chunk limit) or a
 * pre-split array of strings (used as-is, one chunk per element). Either way the result
 * is ONE memento — one `.mem` file with an internal chunk array.
 *
 * `ingest` takes a different shape — it gets memento id, parent id, and `createdAt`
 * per-record because it carries chronicle / fork / historical-timestamp metadata.
 * Direct writes get a fresh UUID and the current time; if a caller ever needs to seed
 * those, this interface grows then.
 */
export interface Memory {
  text: string | string[]
  tags?: string[]
}

/**
 * One chunk inside a memento — a slice of the memory text and its embedding vector.
 *
 * This is the plaintext shape of the `MemFile.chunks` payload: the full `chunks` array is
 * JSON-encoded and encrypted as a single blob. `vector` is a plain `number[]` (not a
 * `Float32Array`) because it round-trips through JSON; the Vault converts to/from
 * `Float32Array` at the embedder/index boundary.
 *
 * A short memory has one chunk; a long one has several. The full memory text is the chunk
 * texts joined — there is no separate `text` field (see `MemFile`).
 */
export interface MemChunk {
  text: string
  vector: number[]
}

/**
 * Decrypted plaintext of the `MemFile.meta` payload — everything about a memento except
 * its chunk text/vectors and its `id`.
 *
 *   - `created_at` — when the memento was first written (ISO 8601). Pinned to the source
 *     moment for ingested content; fixed for the memento's lifetime.
 *   - `updated_at` — when the memento's text was last replaced (ISO 8601). Equals
 *     `created_at` on first write; bumped by `updateMemento`. This is the recency signal
 *     for `search` / `getMementos` — a memory edited today
 *     is "active" today even if created long ago.
 *   - `chronicle_id` — the conversation this memento belongs to. Absent for direct writes.
 *   - `parent_memento_id` — the predecessor turn. Absent for a chronicle's first memento
 *     and for direct writes.
 *   - `tags` — the user/AI tag list. Always present; an empty array when there are none.
 */
export interface MemMeta {
  created_at: string
  updated_at: string
  chronicle_id?: string
  parent_memento_id?: string
  tags: string[]
}

/**
 * Wire format of one `<id>.mem` file on disk — one file per memento.
 *
 * Only `id` is plaintext: it is the filename (`<id>.mem`), so it cannot be encrypted, and
 * being a random UUID it leaks nothing. Everything else lives inside the two encrypted
 * payloads — there is no cleartext metadata on disk (see `aad.ts`).
 *
 * Encrypted payloads (`chunks`, `meta`) each carry their own 12-byte IV and 16-byte auth
 * tag, encrypted under a distinct field-bound AAD (`memAad(id, field)`) so an attacker
 * can neither swap the two ciphertexts within a file nor lift one into another id's file.
 *
 *   - `chunks` — plaintext is `MemChunk[]` (JSON). The whole memory: text + every chunk
 *     vector, in one payload. A re-chunk on `update` rewrites this whole field.
 *   - `meta` — plaintext is `MemMeta` (JSON): timestamps, chronicle/parent ids, tags.
 */
export interface MemFile {
  id: string
  chunks: Encrypted
  meta: Encrypted
}

/**
 * In-memory metadata cache populated at startup and kept in sync on every write/update/delete.
 *
 * Powers fast `getMementos`, `getTags`, tag-filtered `recall`, `delete`, and chronicle
 * grouping without re-reading + decrypting every `.mem` file. Tags are decrypted into RAM
 * at startup; plaintext tags never touch disk.
 *
 * `chunkCount` is the number of chunks in the memento — kept so `delete` knows which
 * `"<id>#<i>"` index keys to remove without re-reading the file.
 *
 * `mtimeMs` is the last-seen filesystem modification time, used by `syncIfStale` to
 * cheaply detect that a file changed on disk — it is NOT a logical recency signal
 * (it is clock-dependent and sync clients preserve it across devices). `created_at` /
 * `updated_at` are the logical timestamps. `tags` is always populated by `recordMeta`
 * (`[]` when the memory has none) so read-side code never has to deal with `undefined`.
 */
export interface MemMetadata {
  id: string
  created_at: string
  updated_at: string
  tags: string[]
  chronicle_id?: string
  parent_memento_id?: string
  chunkCount: number
  mtimeMs: number
  /**
   * Recency-list links — the previous / next memento id in most-recently-updated order.
   * Maintained solely by `MetaStore` (see `meta-store.ts`); these are infrastructure, not
   * memento data, and are never serialized (`MemMetadata` is in-RAM only).
   */
  recencyPrev?: string
  recencyNext?: string
}

/**
 * One `recall` hit — a memento matched by semantic search, with its best-matching chunk
 * surfaced. `recall` returns `RecallResult[]` (an empty array = nothing relevant found);
 * the presentation layer (`core/render.ts`) renders it into the text the AI reads.
 *
 * `text` is the matched chunk's text ONLY — when `chunkCount > 1` the memento has more,
 * retrieved in full via `get_memento`. `chunkIndex` is that chunk's 0-based position.
 */
export interface RecallResult {
  id: string
  chronicleId?: string
  tags: string[]
  text: string
  chunkIndex: number
  chunkCount: number
}

/**
 * One memento in a list view — `getMementos`'s row shape. Carries the memento's
 * FULL text (all chunks joined), not a matched chunk. `updatedAt` is the ordering key
 * (a memento edited today sorts to the top even if first created long ago); the renderer
 * shows it on every row alongside `createdAt` so the ordering key is always visible.
 * `core/render.ts` renders a `MementoSummary[]` into display text.
 */
export interface MementoSummary {
  id: string
  chronicleId?: string
  tags: string[]
  createdAt: string
  updatedAt: string
  text: string
}

/**
 * One memento's full detail — what `getMemento` returns (or `null` when the id is not
 * found). Carries the complete joined text plus the metadata the `get_memento` view
 * shows; `core/render.ts` renders it into the `[id=… ]` block the AI / CLI reads.
 */
export interface MementoDetail {
  id: string
  chronicleId?: string
  parentMementoId?: string
  tags: string[]
  createdAt: string
  text: string
}

/**
 * One memento inside a chronicle listing — what `getChronicle` returns as an ordered
 * array. `text` is the memento's FULL joined text; the chronicle view's length-capped
 * preview is applied by `core/render.ts`. `forkFrom` is set only when this memento's
 * `parent_memento_id` is a fork point (shared by 2+ mementos in the chronicle).
 */
export interface ChronicleEntry {
  id: string
  createdAt: string
  text: string
  forkFrom?: string
}

/** One tag and how many mementos carry it — one entry of `getTags`'s result. */
export interface TagCount {
  tag: string
  count: number
}

/**
 * One chronicle in the `listChronicles` overview — its id, how many mementos it holds,
 * and the timestamp of its earliest one. `core/render.ts` formats a `ChronicleSummary[]`.
 */
export interface ChronicleSummary {
  chronicleId: string
  mementoCount: number
  earliest: string
}

/**
 * Outcome of a write — `writeMemento` and `updateMemento` both return this. `chunkCount`
 * is how many chunks the (re-)chunked text produced; `core/render.ts` turns it into the
 * `Stored memento (…)` / `Updated memento (…)` confirmation.
 */
export interface WriteOutcome {
  id: string
  chunkCount: number
}

/**
 * Result of a `search` call — a discriminated union. The Vault does all the work
 * (validate, filter, drive the searcher) and classifies the result; `core/render.ts`
 * (`renderSearch`) turns each variant into the text the AI reads.
 *
 *   - `ok`            — matches found; `outcome` carries the counts + capped snippets.
 *   - `no-matches`    — the search ran but nothing matched.
 *   - `no-candidates` — a tag / chronicle filter left no mementos to search.
 *   - `empty-query`   — the query string was empty.
 *   - `short-query`   — a literal query below the 3-character floor.
 *   - `bad-regex`     — a regex query that failed to compile (or RE2 is missing);
 *                       `message` is the engine's actionable explanation.
 */
export type SearchResult =
  | { status: 'ok'; outcome: SearchOutcome }
  | { status: 'no-matches' }
  | { status: 'no-candidates' }
  | { status: 'empty-query' }
  | { status: 'short-query' }
  | { status: 'bad-regex'; message: string }
