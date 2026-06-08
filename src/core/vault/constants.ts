/**
 * Vault-internal constants and the id-shape validator.
 *
 * `validateId` lives here (rather than its own file) because it's the path-traversal gate
 * for every MCP-reachable id, and the UUID_REGEX is its only configuration. Generation
 * itself doesn't need a wrapper: callers `import { randomUUID } from 'node:crypto'`
 * directly. Two different generators for memento ids vs chronicle ids would imply
 * different shapes; they're identical UUID v4s, so one source is enough.
 */

// ─── Tunables ─────────────────────────────────────────────────────────────────

/** Maximum interval between two syncs from the storage backend. Default: 10 minutes. */
export const SYNC_INTERVAL_MS = 10 * 60 * 1000

/**
 * Cosine distance below which a write is rejected as a duplicate. Empirically tuned for
 * `all-MiniLM-L6-v2`; if you swap embedders this value may need to change. This threshold
 * is specifically for write-time dedup, intentionally tight — a duplicate must be
 * near-identical text, not just topically related.
 */
export const DUPLICATE_DISTANCE_THRESHOLD = 0.08

/**
 * Cosine distance above which a retrieval result is dropped as "not relevant enough."
 * Without this cutoff, a cold query (asking about something the vault doesn't know) gets
 * back the top-k *least bad* matches — pollutes the AI's context window with noise.
 *
 * Looser than the duplicate threshold by design: a relevant memory only needs to be
 * topically close, not near-identical. Empirically tuned for `all-MiniLM-L6-v2`. If you
 * see real relevant matches getting cut, raise it; if you see noise getting through,
 * lower it.
 */
export const RETRIEVAL_DISTANCE_THRESHOLD = 0.5

// Defaults shared between the Vault's read methods, the MCP tool definitions, and the
// CLI handlers — bound once so the AI-facing tool descriptions can't claim a value the
// read methods don't enforce.

/** Default `k` for `recall` and `search` — top-N matches returned. */
export const DEFAULT_RECALL_K = 5
/** Default `k` for `getMementos` — the "recency feed" length. */
export const DEFAULT_RECENT_LIMIT = 10
/** Default `contextChars` for `search` — characters on each side of a match. */
export const DEFAULT_SEARCH_CONTEXT_CHARS = 48
/**
 * `recall`/range-recall over-fetch: chunk hits requested from the retriever per k.
 * Coupling: the HybridRetriever's `PER_RETRIEVER_TOPK` floor assumes this multiplier
 * provides the small-k fusion candidate pool for production reads — if you shrink this,
 * revisit `PER_RETRIEVER_TOPK` to keep RRF's fusion quality.
 */
export const RECALL_OVERFETCH_MULT = 20
/** `recall`/range-recall floor on the over-fetch — at least this many chunk hits. */
export const RECALL_OVERFETCH_FLOOR = 100

/**
 * Minimum length of a *literal* `search` query. A 1–2 char literal is noise and sits below
 * the trigram floor. Distinct from TRIGRAM_SIZE: this gates every searcher, not just
 * trigram, even though the two happen to coincide at 3.
 */
export const MIN_LITERAL_QUERY_CHARS = 3

/** `search`: max snippets collected from a single memento before moving to the next. */
export const SEARCH_MAX_PER_MEMENTO = 3
/** `search`: global cap on collected snippets before the result is count-only. */
export const SEARCH_MAX_SNIPPETS = 200

/**
 * MCP-facing upper bounds on user-supplied limits. Single source so the Zod `.max(...)`
 * gate and its `describe(... 'max N')` string can't drift — both interpolate the constant.
 */
/** `recall.k` upper bound — caps top-N for semantic recall. */
export const MAX_RECALL_K = 1000
/** `list_mementos.k` upper bound — caps how many mementos one listing call returns. */
export const MAX_RECENT_LIMIT = 1000
/** `search.context_chars` upper bound — characters of surrounding context per match. */
export const MAX_SEARCH_CONTEXT_CHARS = 4096
/**
 * Periodic interval at which the Vault's cache-flush timer fires (when a write has
 * dirtied the index). The close()-flush-race fix relies on this being long enough that
 * a single flush completes before the next tick — keep above the typical
 * `saveIndexCache` time on a large vault.
 */
export const CACHE_FLUSH_INTERVAL_MS = 180_000

// ─── Memento and chronicle ids ───────────────────────────────────────────────

/**
 * Both memento ids and chronicle ids are UUID v4 (canonical hyphenated 36-char form, 122 bits
 * of entropy). Collision risk is negligible at any realistic scale — including future
 * shared vaults where many devices generate ids concurrently.
 *
 * The regex bounds id shape so a path like `../../etc/passwd` cannot pass and a long id
 * from a tampered `.mem` cannot become a long filename attempt — this is also the
 * path-traversal gate.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Throws on any id that doesn't match the canonical UUID hex shape.
 *
 * The regex accepts any UUID version (v1/v3/v4/v5) — the path-traversal defense only
 * cares about the SHAPE of the id, not which UUID variant produced it.
 *
 * Security-critical: ids flow into `${id}.mem` filenames and on through
 * `LocalBackend.put/get/delete`. Anything not matching is rejected before it reaches the
 * storage layer.
 *
 * `isValidId` is the boolean form for callers that must SKIP (not throw) on a bad id —
 * the claude-code ingestor pre-filters Claude's native UUIDs through it so the shape rule
 * has one source, not a hand-copied mirror that could drift from this gate.
 */
export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && UUID_REGEX.test(id)
}
export function validateId(id: string): void {
  if (!isValidId(id)) {
    throw new Error(`Invalid id: ${String(id)}`)
  }
}

/** File extension every memento on disk wears. Centralised so a future change lands here. */
export const MEM_EXTENSION = '.mem'

// ─── Memory index (the curated summary memento) ──────────────────────────────

/**
 * Reserved tag for the single curated memory-index memento. The AI maintains
 * one memento with this tag as a high-level summary of vault contents
 * (analogous to the MEMORY.md index pattern in file-based memory systems).
 *
 * Invariant: every vault that has been served by the daemon at least once has
 * exactly one `_index` memento. The daemon's `vault.seedIndexIfMissing()`
 * runs on its startup path (`runDaemon` after `vault.startup`) — see
 * `daemon/runner.ts`. The seed is idempotent: a no-op if the singleton is
 * already present (a freshly-init'd vault on first daemon start writes it;
 * subsequent starts return immediately). `writeMemento` rejects a second
 * `_index` via `ReservedIndexTagError`; `update_memory_index` revises the
 * existing one. `get_memory_index` therefore always returns a real entry
 * once any daemon has booted against the vault — the "null" branch in the
 * tool handler is only reachable if the singleton was manually deleted, or
 * the tool is called against a freshly-init'd vault whose daemon hasn't
 * booted yet (unusual — the daemon is what serves the tool).
 */
export const INDEX_TAG = '_index'

/** Seed body written by the daemon on first start for the singleton `_index` memento. */
export const INDEX_SEED_TEXT =
  '(empty — this memory index gets populated as the AI accumulates ' +
  'knowledge about the user and ongoing work. Each line links one durable ' +
  'fact to its memento id. Update this memento, do not create a new one.)'

/**
 * Strip the `.mem` suffix from a memento filename, returning the id. Anchored to the end
 * so a future non-UUID filename containing `.mem` mid-string can't desync the id derivation.
 */
export function idFromMemFilename(filename: string): string {
  return filename.replace(/\.mem$/, '')
}

