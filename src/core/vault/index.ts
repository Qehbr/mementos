/**
 * Vault — the encrypted memory store and core of mementos. See DESIGN.md for the data
 * model (chronicle + memento, chunks-inside-one-file), the index key space, and the
 * concurrency posture.
 *
 * One memento = one `<id>.mem` file. Chunk-keyed retrieval (`"<memento_id>#<i>"`) collapses
 * back to mementos in `recall`. Updates use optimistic concurrency: a stale etag throws
 * `StaleMementoError`. Depends only on the abstract dependency interfaces.
 */
import type { StorageBackend } from '../../storage/interface.js'
import { EtagMismatchError } from '../../storage/_utils/check-if-match.js'
import type { EmbeddingProvider } from '../../embeddings/interface.js'
import type { VectorIndex } from '../../vector/interface.js'
import type { KeyProvider } from '../../keys/interface.js'
import type { Retriever } from '../../retrievers/interface.js'
import type { Searcher, SearchOutcome } from '../../searchers/interface.js'
import type { SearchResult as VectorSearchResult } from '../../vector/interface.js'
import { AuthenticationError } from './crypto.js'
import { needsChunking, chunkText, buildChunks } from './chunker.js'
import type {
  MemFile, MemMeta, MemMetadata, MemChunk, Memory,
  RecallResult, MementoSummary, MementoDetail, ChronicleEntry,
  TagCount, ChronicleSummary, MementoIndexEntry, WriteOutcome, SearchResult,
} from './types.js'
import {
  SYNC_INTERVAL_MS, DUPLICATE_DISTANCE_THRESHOLD, RETRIEVAL_DISTANCE_THRESHOLD,
  DEFAULT_RECALL_K, DEFAULT_RECENT_LIMIT, DEFAULT_SEARCH_CONTEXT_CHARS,
  RECALL_OVERFETCH_MULT, RECALL_OVERFETCH_FLOOR,
  SEARCH_MAX_PER_MEMENTO, SEARCH_MAX_SNIPPETS, CACHE_FLUSH_INTERVAL_MS,
  MIN_LITERAL_QUERY_CHARS,
} from './constants.js'
import { randomUUID } from 'node:crypto'
import { validateId, idFromMemFilename } from './constants.js'
import { encryptMemPayloads, decryptMemChunks, decryptMemMeta } from './aad.js'
import { withLock } from './lock.js'
import { tryLoadIndexCache, saveIndexCache } from './cache.js'
import { MetaStore, metaMatches, isMetaFilterActive, type MetaFilter } from './meta-store.js'
import { chunkKey, mementoIdOf, chunkIndexOf } from './chunk-key.js'

/** Vault construction options. */
export interface VaultDeps {
  storage: StorageBackend
  embedder: EmbeddingProvider
  index: VectorIndex
  keys: KeyProvider
  /**
   * Retrieval strategy. Vault owns the VectorIndex directly for write-time dedup + the
   * encrypted HNSW cache; the retriever sits one layer up for the recall path.
   */
  retriever: Retriever
  /** Lexical search strategy, independent of `retriever`. Some implementations disable it entirely. */
  searcher: Searcher
  /** Re-sync from storage at most once per N ms. Default 10 minutes; tests may pass 0. */
  syncIntervalMs?: number
  /**
   * Local filesystem path used as a coarse-grained inter-process lock. If absent, no
   * locking happens — only safe in single-writer contexts. The CLI always provides this.
   */
  lockPath?: string
}

/**
 * Thrown by `updateMemento` when the optimistic-concurrency `ifMatch` precondition fails:
 * the memento file changed on disk between our read and our write (another device's sync,
 * a concurrent agent). The caller is expected to re-read the memento and re-apply its edit.
 */
export class StaleMementoError extends Error {
  readonly name = 'StaleMementoError'
  constructor(id: string) {
    super(`Memento ${id} changed since you read it — re-read with get_memento("${id}") and re-apply.`)
  }
}

/**
 * Thrown by `writeMemento` when the new memento duplicates an existing one (its first chunk
 * is within the dedup threshold of an indexed chunk). Recoverable, AI-actionable: the caller
 * should switch to `update_memento`. The MCP layer surfaces the message as normal content
 * (not an error) so the AI reads and acts on it — same rationale as `StaleMementoError`.
 */
export class DuplicateMementoError extends Error {
  readonly name = 'DuplicateMementoError'
  constructor(message: string) { super(message) }
}

/** What one reconcile pass changed — returned by `Vault.sync()`. */
export interface SyncSummary {
  /** Mementos new on disk since the last sync. */
  added: number
  /** Mementos whose content changed on disk. */
  updated: number
  /** Mementos removed from disk. */
  removed: number
}


/** Refuse a `.mem` whose structure is broken. `flavor` picks "tampered" vs "corrupt" suffix. */
function assertCorrupt(
  cond: unknown,
  id: string,
  what: string,
  flavor: 'corrupt' | 'tampered' = 'corrupt',
): asserts cond {
  if (!cond) {
    const suffix = flavor === 'tampered' ? 'file may have been tampered with' : 'file may be corrupt'
    throw new Error(`Memory ${id}: ${what} — ${suffix}`)
  }
}

/**
 * Walk `chunkHits` in best-first order, keep each memento once at the rank (and chunk) of
 * its strongest hit. Allowed-id filtering happens at the index layer (via `filteredSearch`),
 * so this function purely collapses chunk granularity to memento granularity.
 */
function collapseChunkHits(
  chunkHits: readonly VectorSearchResult[],
): { order: string[]; bestChunk: Map<string, number> } {
  const bestChunk = new Map<string, number>()
  const order: string[] = []
  for (const hit of chunkHits) {
    const id = mementoIdOf(hit.id)
    if (bestChunk.has(id)) continue
    bestChunk.set(id, chunkIndexOf(hit.id))
    order.push(id)
  }
  return { order, bestChunk }
}

export class Vault {
  private key: Buffer | null = null
  /** In-RAM metadata index, recency-ordered. See `MetaStore`. */
  private metaById = new MetaStore()
  private lastSyncAt = new Date(0)
  private inFlightSync: Promise<SyncSummary> | null = null
  private readonly syncIntervalMs: number
  /** Set by any write / sync that changed the index; cleared by a successful cache flush. */
  private cacheDirty = false
  /** Periodic cache-flush timer (unref'd so it never blocks exit); cleared by close(). */
  private cacheTimer: ReturnType<typeof setInterval> | null = null
  /**
   * In-flight timer flush; `close()` awaits it before its own — otherwise
   * `process.exit(0)` could kill writeFile mid-write and truncate the cache.
   */
  private inFlightFlush: Promise<void> | null = null

  constructor(private readonly deps: VaultDeps) {
    this.syncIntervalMs = deps.syncIntervalMs ?? SYNC_INTERVAL_MS
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** Initialise the vault — must be called once before any other method. */
  async startup(): Promise<void> {
    this.key = await this.deps.keys.getKey()
    await this.deps.storage.init()

    const memFiles = await this.deps.storage.list()
    const cachedMtimes = memFiles.length > 0
      ? await tryLoadIndexCache(this.deps.storage, this.deps.index, this.getKey(), memFiles)
      : null

    if (cachedMtimes) {
      await Promise.all(memFiles.map(f =>
        this.loadAndRegister(f, false, cachedMtimes.get(idFromMemFilename(f))),
      ))
    } else {
      await this.deps.index.init()
      await Promise.all(memFiles.map(f => this.loadAndRegister(f, true)))
      // hnswlib's writeIndex on a zero-point index produces an unreadable tmp file in some
      // environments (vitest forks notably); skip the cache-dirty flag when empty.
      if (this.metaById.size > 0) this.cacheDirty = true
    }
    this.metaById.reorderByUpdatedAt()
    this.lastSyncAt = new Date()
    // Start the cache timer LAST — any throw above leaves no timer to leak.
    this.startCacheTimer()
  }

  // ─── Cache flush ──────────────────────────────────────────────────────────

  private startCacheTimer(): void {
    if (this.cacheTimer) return
    this.cacheTimer = setInterval(() => {
      if (this.inFlightFlush) return
      const p = this.flushCache().catch((e: unknown) => {
        console.error(`cache flush skipped: ${(e as Error).message}`)
      })
      this.inFlightFlush = p
      void p.finally(() => { if (this.inFlightFlush === p) this.inFlightFlush = null })
    }, CACHE_FLUSH_INTERVAL_MS)
    this.cacheTimer.unref()
  }

  /** Persist the in-memory index to the encrypted cache; cheap no-op if clean. */
  async flushCache(): Promise<void> {
    if (!this.key) return
    await withLock(this.deps.lockPath, async () => {
      if (!this.cacheDirty) return
      const entries = [...this.metaById.values()].map(m => ({ id: m.id, mtimeMs: m.mtimeMs }))
      await saveIndexCache(this.deps.index, this.getKey(), entries)
      this.cacheDirty = false
    })
  }

  /** Stop the timer, await any in-flight flush, then flush. Safe to re-call. */
  async close(): Promise<void> {
    if (this.cacheTimer) {
      clearInterval(this.cacheTimer)
      this.cacheTimer = null
    }
    if (this.inFlightFlush) await this.inFlightFlush.catch(() => { /* already logged */ })
    await this.flushCache().catch((e: unknown) => {
      console.error(`cache flush skipped: ${(e as Error).message}`)
    })
  }

  /**
   * Read a `.mem` file and authenticate it: the filename must match `mem.id`, and both
   * encrypted payloads must decrypt under their id-bound AAD. Returns the parsed `MemFile`
   * plus the decrypted chunk array and the decrypted `meta`. Throws on any mismatch.
   */
  private async loadAndAuthenticate(
    filename: string,
  ): Promise<{ mem: MemFile; chunks: MemChunk[]; meta: MemMeta }> {
    const { data } = await this.deps.storage.get(filename)
    return this.authenticateMemFile(data, idFromMemFilename(filename))
  }

  /**
   * Parse a `.mem`, bind it to its expected id, and decrypt+validate both payloads. The
   * filename↔id binding is a security invariant — without it an on-disk attacker could
   * serve B's content from A.mem (AAD only authenticates the blob against its OWN claimed
   * id). Shared between the sync/startup and live-read paths so the check can't drift
   * weaker on one of them.
   */
  private authenticateMemFile(
    data: Buffer, expectedId: string,
  ): { mem: MemFile; chunks: MemChunk[]; meta: MemMeta } {
    const mem = JSON.parse(data.toString()) as MemFile
    if (mem.id !== expectedId) {
      throw new Error(`Memory file ${expectedId}.mem: id mismatch (claims id=${mem.id})`)
    }
    return { mem, chunks: this.decryptChunks(mem), meta: this.decryptMeta(mem) }
  }

  /** Decrypt + structurally validate a memento's `chunks` payload. */
  private decryptChunks(mem: MemFile): MemChunk[] {
    assertCorrupt(mem.chunks, mem.id, 'missing chunks field', 'tampered')
    const parsed = decryptMemChunks(mem, this.getKey()) as unknown
    assertCorrupt(Array.isArray(parsed) && parsed.length > 0, mem.id, 'chunks decrypted to a non-array or empty array')
    for (const c of parsed as unknown[]) {
      const chunk = c as Partial<MemChunk> | null
      assertCorrupt(
        !!chunk && typeof chunk.text === 'string' && Array.isArray(chunk.vector),
        mem.id, 'a chunk is missing text/vector',
      )
    }
    return parsed as MemChunk[]
  }

  /**
   * Decrypt + structurally validate the `meta` payload. `tags` is filtered to strings so
   * read-side code never sees a stray value from a hand-edited or buggy-write file.
   */
  private decryptMeta(mem: MemFile): MemMeta {
    assertCorrupt(mem.meta, mem.id, 'missing meta field', 'tampered')
    const parsed = decryptMemMeta(mem, this.getKey()) as unknown
    assertCorrupt(!!parsed && typeof parsed === 'object', mem.id, 'meta decrypted to a non-object')
    const m = parsed as Partial<MemMeta>
    assertCorrupt(typeof m.created_at === 'string' && typeof m.updated_at === 'string',
      mem.id, 'meta is missing created_at/updated_at')
    assertCorrupt(Array.isArray(m.tags), mem.id, 'meta has no tags array')
    return {
      created_at: m.created_at,
      updated_at: m.updated_at,
      chronicle_id: m.chronicle_id,
      parent_memento_id: m.parent_memento_id,
      tags: m.tags.filter((t): t is string => typeof t === 'string'),
    }
  }

  /** Failures are logged and skipped — one bad file can't abort the whole vault. */
  private async loadAndRegister(
    filename: string, addToIndex: boolean, knownMtimeMs?: number,
  ): Promise<void> {
    try {
      const { mem, chunks, meta } = await this.loadAndAuthenticate(filename)
      const mtimeMs = knownMtimeMs ?? (await this.deps.storage.stat(filename).catch(() => ({ mtimeMs: 0 }))).mtimeMs
      this.registerMemento(mem, chunks, meta, mtimeMs, { addToIndex })
    } catch (e) {
      this.warnLoadFailure(filename, e)
    }
  }

  /** Warn about a skipped `.mem`. ENOENT (vanished between listing and loading) is silent — benign race. */
  private warnLoadFailure(filename: string, e: unknown): void {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return
    const id = idFromMemFilename(filename)
    const detail = e instanceof AuthenticationError
      ? 'failed authentication — possible tampering'
      : e instanceof Error ? e.message : String(e)
    console.error(`Warning: memory ${id} could not be loaded — skipped: ${detail}`)
  }

  // ─── Sync ─────────────────────────────────────────────────────────────────

  /**
   * Reconcile with storage if the rate-limit timer has elapsed. Coalesces concurrent
   * callers behind one in-flight promise.
   *
   * Callers MUST invoke this BEFORE acquiring the per-vault lock — doSync also takes the
   * lock, so calling from inside one would deadlock.
   */
  private async syncIfStale(): Promise<void> {
    if (Date.now() - this.lastSyncAt.getTime() < this.syncIntervalMs) return
    if (!this.inFlightSync) {
      this.inFlightSync = this.doSync().finally(() => { this.inFlightSync = null })
    }
    await this.inFlightSync
  }

  /**
   * Force an immediate reconcile with the storage backend, bypassing the staleness
   * throttle that gates `syncIfStale`. Backs `mementos sync` and the `sync` MCP tool —
   * for "I just pushed a memory from another device, refresh now." Returns what changed.
   */
  async sync(): Promise<SyncSummary> {
    return this.doSync()
  }

  private async doSync(): Promise<SyncSummary> {
    return withLock(this.deps.lockPath, async () => {
      await this.deps.storage.sync()

      const onDisk = await this.deps.storage.list()
      const onDiskIds = new Set(onDisk.map(idFromMemFilename))
      let added = 0
      let updated = 0
      let removed = 0

      await Promise.all(onDisk.map(async filename => {
        const id = idFromMemFilename(filename)
        const known = this.metaById.get(id)
        const s = await this.deps.storage.stat(filename).catch(() => null)
        if (!s) return

        const isNew = !known
        // `!==` not `>`: a cross-device update can arrive with an OLDER mtime (writer's
        // clock behind ours; OS sync clients preserve mtime), and `>` would silently miss it.
        const isUpdated = !!known && s.mtimeMs !== known.mtimeMs
        if (!isNew && !isUpdated) return

        try {
          const { mem, chunks, meta } = await this.loadAndAuthenticate(filename)
          if (known) this.unregisterMemento(id, known.chunkCount)
          this.registerMemento(mem, chunks, meta, s.mtimeMs, { addToIndex: true })
          if (isNew) added++
          else updated++
        } catch (e) {
          this.warnLoadFailure(filename, e)
        }
      }))

      for (const [id, meta] of [...this.metaById.entries()]) {
        if (!onDiskIds.has(id)) {
          this.unregisterMemento(id, meta.chunkCount)
          removed++
        }
      }
      if (added > 0 || updated > 0 || removed > 0) {
        this.cacheDirty = true
        // Synced mementos carry remote timestamps — re-sort the recency list straight.
        this.metaById.reorderByUpdatedAt()
      }

      this.lastSyncAt = new Date()
      return { added, updated, removed }
    })
  }

  /** Resolve the cached AES key. Throws if the vault hasn't been started yet. */
  private getKey(): Buffer {
    if (!this.key) throw new Error('Vault not started — call startup() first')
    return this.key
  }

  // ─── In-RAM state helpers ─────────────────────────────────────────────────

  /** Build and register a memento's metadata. Caller must guarantee `id` is not yet in metaById. */
  private recordMeta(id: string, m: MemMeta, chunkCount: number, mtimeMs: number): MemMetadata {
    validateId(id)
    if (m.chronicle_id !== undefined) validateId(m.chronicle_id)
    if (m.parent_memento_id !== undefined) validateId(m.parent_memento_id)

    const meta: MemMetadata = {
      id,
      created_at: m.created_at,
      updated_at: m.updated_at,
      tags: m.tags,
      chronicle_id: m.chronicle_id,
      parent_memento_id: m.parent_memento_id,
      chunkCount,
      mtimeMs,
    }
    this.metaById.set(id, meta)
    return meta
  }

  /**
   * Register a memento in RAM: record metadata, then add every chunk to the retriever
   * (and, when `addToIndex`, the VectorIndex) under its `"<id>#<i>"` key.
   *
   * `addToIndex` is false only on the cache-hit startup path, where HNSW is restored from
   * the encrypted cache and re-adding would duplicate every chunk.
   */
  private registerMemento(
    mem: MemFile, chunks: MemChunk[], metaPlain: MemMeta, mtimeMs: number,
    opts: { addToIndex: boolean },
  ): MemMetadata {
    const meta = this.recordMeta(mem.id, metaPlain, chunks.length, mtimeMs)
    for (let i = 0; i < chunks.length; i++) {
      const key = chunkKey(mem.id, i)
      if (opts.addToIndex) this.deps.index.add(key, Float32Array.from(chunks[i].vector))
      const text = chunks[i].text
      this.deps.retriever.add(key, () => text)
    }
    // The searcher indexes the whole memento (chunks joined) so a match spanning a chunk
    // boundary is still found. `decryptText` is lazy — NoneSearcher never runs it.
    this.deps.searcher.add(mem.id, () => chunks.map(c => c.text).join('\n'))
    return meta
  }

  /** Remove a memento from RAM: drop every chunk key from index + retriever + searcher, forget meta. */
  private unregisterMemento(id: string, chunkCount: number): void {
    for (let i = 0; i < chunkCount; i++) {
      const key = chunkKey(id, i)
      this.deps.index.remove(key)
      this.deps.retriever.remove(key)
    }
    this.deps.searcher.remove(id)
    this.metaById.delete(id)
  }

  // ─── Encoding ─────────────────────────────────────────────────────────────

  /**
   * Split `text` into chunk strings: auto-chunk a single string by character count, or
   * take a pre-split array as-is. Whitespace-only chunks are dropped.
   */
  private splitChunks(text: string | string[]): string[] {
    const raw = Array.isArray(text)
      ? text
      : needsChunking(text) ? chunkText(text) : [text]
    return raw.filter(c => typeof c === 'string' && c.trim().length > 0)
  }

  private encodeMemFile(id: string, chunks: MemChunk[], meta: MemMeta): MemFile {
    const payloads = encryptMemPayloads(id, this.getKey(), {
      chunks: Buffer.from(JSON.stringify(chunks), 'utf8'),
      meta: Buffer.from(JSON.stringify(meta), 'utf8'),
    })
    return { id, ...payloads }
  }

  // ─── Write ────────────────────────────────────────────────────────────────

  /**
   * Store a new memento. Long text is auto-chunked; the chunks all live inside the one
   * `.mem` file. Rejects the write if its first chunk is too similar to an existing chunk.
   */
  async writeMemento(memory: Memory): Promise<WriteOutcome> {
    await this.syncIfStale()
    return withLock(this.deps.lockPath, () => this.doWriteMemento(memory))
  }

  private async doWriteMemento(memory: Memory): Promise<WriteOutcome> {
    const texts = this.splitChunks(memory.text)
    if (texts.length === 0) throw new Error('Cannot write an empty memory')

    const vectors = await this.deps.embedder.embedBatch(texts)

    // Dedup uses just the first chunk: inner chunks share content with their siblings by
    // design, so a per-chunk check would false-positive within the memory itself.
    const dup = this.findDuplicate(vectors[0])
    if (dup) throw new DuplicateMementoError(dup)

    const id = randomUUID()
    const chunks = buildChunks(texts, vectors)
    const createdAt = new Date().toISOString()
    const meta: MemMeta = {
      created_at: createdAt,
      updated_at: createdAt,
      tags: memory.tags ?? [],
    }
    const mem = this.encodeMemFile(id, chunks, meta)

    // `put` returns the mtime from the same FD that did the write — a separate
    // `storage.stat()` could see a sync client's substituted inode and poison the cache.
    const { mtimeMs } = await this.deps.storage.put(`${id}.mem`, Buffer.from(JSON.stringify(mem)))
    this.registerMemento(mem, chunks, meta, mtimeMs, { addToIndex: true })
    this.cacheDirty = true

    return { id, chunkCount: chunks.length }
  }

  /**
   * Idempotent bulk import of one chronicle's mementos. Each input becomes one `.mem`;
   * already-on-disk `mementoId`s are skipped, so re-runs converge. Long mementos are
   * chunked internally; one putBatch for the whole batch.
   *
   * Unlike `writeMemento`, NO vector-similarity dedup is applied — different chats are
   * expected to contain semantically similar turns; the dedup boundary is `mementoId`.
   */
  async ingest(
    chronicleId: string,
    mementos: Array<{ mementoId: string; parentMementoId?: string; text: string; createdAt?: string }>,
    opts: { tags?: string[]; createdAt?: string } = {},
  ): Promise<{ added: number; skipped: number }> {
    await this.syncIfStale()
    return withLock(this.deps.lockPath, () => this.doIngest(chronicleId, mementos, opts))
  }

  private async doIngest(
    chronicleId: string,
    mementos: Array<{ mementoId: string; parentMementoId?: string; text: string; createdAt?: string }>,
    opts: { tags?: string[]; createdAt?: string },
  ): Promise<{ added: number; skipped: number }> {
    validateId(chronicleId)
    for (const m of mementos) {
      validateId(m.mementoId)
      if (m.parentMementoId !== undefined) validateId(m.parentMementoId)
    }

    const seen = new Set<string>()
    let skipped = 0
    const fresh: typeof mementos = []
    for (const m of mementos) {
      if (this.metaById.has(m.mementoId) || seen.has(m.mementoId)) { skipped++; continue }
      seen.add(m.mementoId)
      fresh.push(m)
    }

    interface Pending { id: string; created_at: string; parent?: string; texts: string[] }
    const pending: Pending[] = []
    const defaultCreatedAt = opts.createdAt ?? new Date().toISOString()
    for (const m of fresh) {
      const texts = this.splitChunks(m.text)
      if (texts.length === 0) { skipped++; continue }
      pending.push({
        id: m.mementoId,
        created_at: m.createdAt ?? defaultCreatedAt,
        parent: m.parentMementoId,
        texts,
      })
    }
    if (pending.length === 0) return { added: 0, skipped }

    // One embedBatch across every chunk; track each memento's slice of the flat output.
    // `embedBatch` sub-batches internally, so large ingests don't OOM ONNX or exceed the
    // OpenAI per-request cap.
    const flatTexts: string[] = []
    const ranges: Array<{ start: number; end: number }> = []
    for (const p of pending) {
      ranges.push({ start: flatTexts.length, end: flatTexts.length + p.texts.length })
      flatTexts.push(...p.texts)
    }
    const flatVectors = await this.deps.embedder.embedBatch(flatTexts)

    const tags = opts.tags ?? []
    const files: Array<{ path: string; data: Buffer }> = []
    const built: Array<{ mem: MemFile; chunks: MemChunk[]; meta: MemMeta }> = []
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i]
      const { start } = ranges[i]
      const { end } = ranges[i]
      const chunks = buildChunks(p.texts, flatVectors.slice(start, end))
      const meta: MemMeta = {
        created_at: p.created_at,
        updated_at: p.created_at,
        chronicle_id: chronicleId,
        ...(p.parent ? { parent_memento_id: p.parent } : {}),
        tags,
      }
      const mem = this.encodeMemFile(p.id, chunks, meta)
      files.push({ path: `${p.id}.mem`, data: Buffer.from(JSON.stringify(mem)) })
      built.push({ mem, chunks, meta })
    }

    // One transaction: a throw leaves disk and RAM both at "nothing written" so a re-run
    // picks up cleanly. Returned mtimes come from the write FDs.
    const written = await this.deps.storage.putBatch(files)
    built.forEach((b, i) => this.registerMemento(b.mem, b.chunks, b.meta, written[i].mtimeMs, { addToIndex: true }))
    this.cacheDirty = true
    // Ingested timestamps are historical — they can land anywhere in recency order.
    this.metaById.reorderByUpdatedAt()

    return { added: built.length, skipped }
  }

  // ─── Recall ───────────────────────────────────────────────────────────────

  /**
   * Semantic top-k. Query is embedded with the write-time model; results filtered by
   * `chronicleId`/`tags`/`excludeTags` if given, then trimmed to `k` (default 5).
   */
  async recall(
    query: string,
    k = DEFAULT_RECALL_K,
    chronicleId?: string,
    tags?: string[],
    excludeTags?: string[],
  ): Promise<RecallResult[]> {
    if (chronicleId !== undefined) validateId(chronicleId)
    await this.syncIfStale()

    // Compute the allowed memento-id set up-front using MetaStore's inverted indexes —
    // O(matches) instead of O(corpus) for selective tag / chronicle filters. The same set
    // is then passed down to `rankSemantic`, which expands it to chunk-keys and hands it
    // to the index's native filteredSearch path. No post-filter walk; chunks come back
    // already restricted to the allowed set.
    const filter: MetaFilter = { chronicleId, tags, excludeTags }
    const allowed = isMetaFilterActive(filter) ? this.metaById.idsMatchingFilter(filter) : undefined
    if (allowed !== undefined && allowed.size === 0) return []

    const { order, bestChunk } = await this.rankSemantic(query, k, allowed)
    const picked = order.slice(0, k)
    if (picked.length === 0) return []

    const results = await Promise.all(picked.map(async (id): Promise<RecallResult | null> => {
      const loaded = await this.readMemento(id)
      if (!loaded) return null
      const { chunks, meta } = loaded
      const ci = Math.min(bestChunk.get(id) ?? 0, chunks.length - 1)
      return {
        id,
        ...(meta.chronicle_id ? { chronicleId: meta.chronicle_id } : {}),
        tags: meta.tags,
        text: chunks[ci].text,
        chunkIndex: ci,
        chunkCount: chunks.length,
      }
    }))
    return results.filter((r): r is RecallResult => r !== null)
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  /**
   * Exhaustive lexical search across every memento — backs the `search` MCP tool and the
   * `mementos search` CLI. Unlike `recall` (semantic ranking) this finds *exact* literal
   * or regex matches and returns short snippets with surrounding context.
   *
   * Result statuses cover every "no result" reason: empty / short query, filter excluded
   * all, invalid regex, nothing matched. The display-only `k` cap is applied by the renderer.
   */
  async search(
    query: string,
    contextChars = DEFAULT_SEARCH_CONTEXT_CHARS,
    regex = false,
    ignoreCase = true,
    chronicleId?: string,
    tags?: string[],
    excludeTags?: string[],
  ): Promise<SearchResult> {
    if (chronicleId !== undefined) validateId(chronicleId)
    if (query.length === 0) return { status: 'empty-query' }
    // Regex is exempt: `\d{4}` is deliberate and selective.
    if (!regex && query.length < MIN_LITERAL_QUERY_CHARS) return { status: 'short-query' }
    await this.syncIfStale()

    const filter: MetaFilter = { chronicleId, tags, excludeTags }
    const active = isMetaFilterActive(filter)
    const orderedIds = [...this.metaById.values()]
      .filter(meta => !active || metaMatches(meta, filter))
      .map(meta => meta.id)
    if (active && orderedIds.length === 0) return { status: 'no-candidates' }

    let outcome: SearchOutcome
    try {
      outcome = this.deps.searcher.search(query, {
        contextChars,
        regex,
        ignoreCase,
        maxPerMemento: SEARCH_MAX_PER_MEMENTO,
        maxSnippets: SEARCH_MAX_SNIPPETS,
        orderedIds,
      })
    } catch (e) {
      // Invalid regex / missing RE2 surfaces here; literal search never throws.
      if (regex) return { status: 'bad-regex', message: (e as Error).message }
      throw e
    }

    return outcome.totalMatches === 0
      ? { status: 'no-matches' }
      : { status: 'ok', outcome }
  }

  // ─── Update ───────────────────────────────────────────────────────────────

  /**
   * Replace a memento's text. Re-chunks, re-embeds, and rewrites the one `.mem` file.
   * Optimistic concurrency via the file's etag — a concurrent change throws
   * `StaleMementoError` and the caller should re-read and re-apply. Tags and the
   * chronicle/parent fields are preserved.
   */
  async updateMemento(id: string, text: string): Promise<WriteOutcome> {
    validateId(id)
    await this.syncIfStale()
    return withLock(this.deps.lockPath, () => this.doUpdateMemento(id, text))
  }

  private async doUpdateMemento(id: string, text: string): Promise<WriteOutcome> {
    const current = await this.readMemento(id)
    if (!current) throw new Error(`Cannot update — memento not found: ${id}`)
    const { meta: oldMeta, etag } = current
    const oldChunkCount = current.chunks.length

    const texts = this.splitChunks(text)
    if (texts.length === 0) throw new Error('Cannot update a memory to empty text')

    const vectors = await this.deps.embedder.embedBatch(texts)
    const chunks = buildChunks(texts, vectors)

    // Preserve created_at / chronicle / parent / tags; bump updated_at — an edit makes
    // the memento "active" now even if it was created long ago.
    const meta: MemMeta = { ...oldMeta, updated_at: new Date().toISOString() }
    const updated = this.encodeMemFile(id, chunks, meta)

    let mtimeMs: number
    try {
      ;({ mtimeMs } = await this.deps.storage.put(
        `${id}.mem`, Buffer.from(JSON.stringify(updated)), { ifMatch: etag },
      ))
    } catch (e) {
      if (e instanceof EtagMismatchError) throw new StaleMementoError(id)
      throw e
    }

    this.unregisterMemento(id, oldChunkCount)
    this.registerMemento(updated, chunks, meta, mtimeMs, { addToIndex: true })
    this.cacheDirty = true

    return { id, chunkCount: chunks.length }
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  /** Delete one memento — its single `.mem` file and every one of its chunk index keys. */
  async deleteMemento(id: string): Promise<void> {
    validateId(id)
    await this.syncIfStale()
    return withLock(this.deps.lockPath, () => this.doDeleteMemento(id))
  }

  private async doDeleteMemento(id: string): Promise<void> {
    const meta = this.metaById.get(id)
    if (!meta) throw new Error(`Memory not found: ${id}`)

    await this.deps.storage.delete(`${id}.mem`)
    this.unregisterMemento(id, meta.chunkCount)
    this.cacheDirty = true
  }

  // ─── Single-memento / chronicle reads ─────────────────────────────────────

  async getTags(): Promise<TagCount[]> {
    await this.syncIfStale()
    return Array.from(this.metaById.tagEntries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, count]) => ({ tag, count }))
  }

  async getMemento(id: string): Promise<MementoDetail | null> {
    validateId(id)
    await this.syncIfStale()
    const loaded = await this.readMemento(id)
    if (!loaded) return null
    const { chunks, meta } = loaded
    return {
      id,
      ...(meta.chronicle_id ? { chronicleId: meta.chronicle_id } : {}),
      ...(meta.parent_memento_id ? { parentMementoId: meta.parent_memento_id } : {}),
      tags: meta.tags,
      createdAt: meta.created_at,
      text: this.fullText(chunks),
    }
  }

  /** A memento's full text = its chunks joined by a single space. The one reconstruction
   *  rule shared by every display read (get_memento / get_chronicle / recent / range), so
   *  the same memento renders identically through any endpoint. (The searcher index joins
   *  with '\n' — a different rule, kept separate.) */
  private fullText(chunks: MemChunk[]): string {
    return chunks.map(c => c.text).join(' ')
  }

  /**
   * Every memento in a chronicle, ordered by `created_at`. A `parent_memento_id` shared
   * by 2+ mementos marks a fork — its `forkFrom` is set so the renderer can annotate it.
   */
  async getChronicle(chronicleId: string): Promise<ChronicleEntry[]> {
    validateId(chronicleId)
    await this.syncIfStale()

    const metas: MemMetadata[] = []
    for (const id of this.metaById.idsMatchingFilter({ chronicleId })) {
      const meta = this.metaById.get(id)
      if (meta) metas.push(meta)
    }
    metas.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    if (metas.length === 0) return []

    // A parent referenced by 2+ mementos is a fork point.
    const parentCounts = new Map<string, number>()
    for (const m of metas) {
      if (m.parent_memento_id) parentCounts.set(m.parent_memento_id, (parentCounts.get(m.parent_memento_id) ?? 0) + 1)
    }
    const forked = new Set([...parentCounts.entries()].filter(([, n]) => n > 1).map(([k]) => k))

    const entries = await Promise.all(metas.map(async (meta): Promise<ChronicleEntry | null> => {
      const loaded = await this.readMemento(meta.id)
      if (!loaded) return null
      return {
        id: meta.id,
        createdAt: meta.created_at,
        text: this.fullText(loaded.chunks),
        ...(meta.parent_memento_id && forked.has(meta.parent_memento_id)
          ? { forkFrom: meta.parent_memento_id }
          : {}),
      }
    }))
    return entries.filter((e): e is ChronicleEntry => e !== null)
  }

  async listChronicles(): Promise<ChronicleSummary[]> {
    await this.syncIfStale()
    const byChronicle = new Map<string, { count: number; earliest: string }>()
    for (const m of this.metaById.values()) {
      if (!m.chronicle_id) continue
      const c = byChronicle.get(m.chronicle_id)
      if (!c) byChronicle.set(m.chronicle_id, { count: 1, earliest: m.created_at })
      else {
        c.count++
        if (m.created_at < c.earliest) c.earliest = m.created_at
      }
    }
    return [...byChronicle.entries()]
      .sort(([, a], [, b]) => b.earliest.localeCompare(a.earliest))
      .map(([id, c]) => ({ chronicleId: id, mementoCount: c.count, earliest: c.earliest }))
  }

  /** Most-recently-active first (ordered by `updated_at`, not created_at). */
  async getRecentMementos(limit = DEFAULT_RECENT_LIMIT): Promise<MementoSummary[]> {
    await this.syncIfStale()
    // Take the prefix off the recency-ordered generator — it yields newest-first lazily, so
    // a top-k read is O(k). Spreading the whole thing would walk all n just to drop most.
    const n = Math.max(1, limit)
    const metas: MemMetadata[] = []
    for (const meta of this.metaById.values()) {
      metas.push(meta)
      if (metas.length === n) break
    }
    return this.loadSummaries(metas.map(m => m.id))
  }

  /**
   * Mementos active within a date window (matched against `updated_at`, so edits keep a
   * memento "in range"). With a `query`, results are ranked by the retriever and trimmed
   * to top-k; without one, returned reverse-chronological.
   */
  async getMementosInRange(start?: string, end?: string, query?: string, k = DEFAULT_RECENT_LIMIT): Promise<MementoSummary[]> {
    await this.syncIfStale()
    if (this.metaById.size === 0) return []

    // A date-only `end` ("2026-05-13") names the whole day. Without this, the lexical
    // compare against a full `updated_at` timestamp ("2026-05-13T10:00:00Z" > "2026-05-13")
    // would exclude everything that day except an exact-midnight entry — so a date-only
    // end is extended to the day's last instant, matching the "inclusive" contract.
    const endBound = end && /^\d{4}-\d{2}-\d{2}$/.test(end) ? end + 'T23:59:59.999Z' : end

    if (!query) {
      // No query: take recency-ordered prefix bounded by the date range. valuesInRange
      // walks the existing recency linked list from the head and early-bails past `start`
      // — O(range_size) for recent ranges instead of O(corpus).
      const ids: string[] = []
      const limit = Math.max(1, k)
      for (const meta of this.metaById.valuesInRange(start, endBound)) {
        ids.push(meta.id)
        if (ids.length >= limit) break
      }
      if (ids.length === 0) return []
      return this.loadSummaries(ids)
    }

    // Query: resolve the date predicate to an allowed memento-id set via MetaStore, then
    // rank semantically restricted to that set (native filteredSearch in the index).
    const allowed = this.metaById.idsMatchingFilter({ start, end: endBound })
    if (allowed.size === 0) return []
    const { order } = await this.rankSemantic(query, k, allowed)
    const ranked = order.slice(0, k)
    if (ranked.length === 0) return []
    return this.loadSummaries(ranked)
  }

  async listMementos(tags?: string[]): Promise<MementoIndexEntry[]> {
    await this.syncIfStale()
    // Tag-filtered: resolve via the tag inverted index FIRST, then sort the (smaller) result.
    // Sorting the full corpus to keep ~1% of it would be backwards.
    const metas: MemMetadata[] = []
    if (tags?.length) {
      for (const id of this.metaById.idsMatchingFilter({ tags })) {
        const meta = this.metaById.get(id)
        if (meta) metas.push(meta)
      }
    } else {
      for (const meta of this.metaById.values()) metas.push(meta)
    }
    metas.sort((a, b) => a.id.localeCompare(b.id))
    return metas.map(meta => ({
      id: meta.id,
      tags: meta.tags,
      chunkCount: meta.chunkCount,
      ...(meta.chronicle_id ? { chronicleId: meta.chronicle_id } : {}),
      createdAt: meta.created_at,
    }))
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * The semantic-query rule, shared by `recall` and the `getMementosInRange` query branch:
   * embed → fetch chunk hits → drop everything past the relevance cutoff → collapse to
   * memento order. One source so the cutoff and over-fetch can never be retuned in one
   * caller and silently diverge in the other.
   *
   * `allowed` (memento ids) is passed straight through to the retriever and on into the
   * index's native filteredSearch — all distance work stays in C++, the filter is checked
   * per-visited-node via a JS set-membership predicate. The walk's `ef` is sized adaptively
   * by selectivity (see `HNSWIndex.filteredSearch`), so the caller gets full-k results for
   * moderate selectivity. Very rare filters (<0.5% of corpus) may under-recall due to HNSW
   * graph-holes — the accepted trade for keeping a single-index design with no extra
   * in-RAM vector store. Documented in DESIGN.
   */
  private async rankSemantic(query: string, k: number, allowed?: ReadonlySet<string>) {
    const queryVector = await this.deps.embedder.embed(query)
    const fetchK = Math.max(k * RECALL_OVERFETCH_MULT, RECALL_OVERFETCH_FLOOR)
    const chunkHits = this.deps.retriever
      .retrieve(query, queryVector, fetchK, allowed)
      .filter(r => r.distance < RETRIEVAL_DISTANCE_THRESHOLD)
    return collapseChunkHits(chunkHits)
  }

  /**
   * Reject a write whose first chunk is closer than the duplicate threshold to any
   * existing chunk. Returns a user-facing message, or null when the write is clear.
   */
  private findDuplicate(vector: Float32Array): string | null {
    if (this.deps.index.size === 0) return null
    const results = this.deps.index.search(vector, 1)
    if (results.length > 0 && results[0].distance < DUPLICATE_DISTANCE_THRESHOLD) {
      const similarity = (1 - results[0].distance).toFixed(3)
      const id = mementoIdOf(results[0].id)
      // Names both tools in the order to call them and calls out the silent-overwrite
      // failure mode by name. Without this explicit framing, the cheapest reading of
      // "use update_memento" is "re-send your new text", which would clobber a richer
      // existing memento ("prefers vim in TypeScript files, neovim with NvChad…" → "prefer
      // vim over emacs").
      return `Similar memento exists (id=${id}, similarity=${similarity}). ` +
        `Call get_memento("${id}") to read its current text, then ` +
        `update_memento("${id}", merged_text) to refine it — do NOT just resend your new ` +
        `text, that would overwrite the existing memento and lose information.`
    }
    return null
  }

  /**
   * Read + authenticate one `.mem` by id. ENOENT-tolerant (returns null, reconciles the
   * stale RAM entry — every read path goes through here, self-healing a remote delete);
   * all other errors propagate. The etag is the optimistic-concurrency token.
   */
  private async readMemento(
    id: string,
  ): Promise<{ mem: MemFile; chunks: MemChunk[]; meta: MemMeta; etag: string } | null> {
    // Opt in to the etag: this read path feeds updateMemento's optimistic-concurrency check.
    const got = await this.deps.storage.get(`${id}.mem`, { etag: true }).catch((e: NodeJS.ErrnoException) => {
      if (e?.code === 'ENOENT') return null
      throw e
    })
    if (!got) {
      const known = this.metaById.get(id)
      if (known) this.unregisterMemento(id, known.chunkCount)
      return null
    }
    return { ...this.authenticateMemFile(got.data, id), etag: got.etag }
  }

  /**
   * Parallel `loadSummary` over `ids`; a benign ENOENT (concurrent delete) drops out as null,
   * but a real id-mismatch / auth / parse failure propagates — never `.catch`ed, or a tampered
   * memento would be silently dropped. The one bulk-summary-load policy for every read path.
   */
  private async loadSummaries(ids: string[]): Promise<MementoSummary[]> {
    const summaries = await Promise.all(ids.map(id => this.loadSummary(id)))
    return summaries.filter((s): s is MementoSummary => s !== null)
  }

  /** Read + decrypt one memento into a `MementoSummary` (full text); null if it's gone. */
  private async loadSummary(id: string): Promise<MementoSummary | null> {
    const loaded = await this.readMemento(id)
    if (!loaded) return null
    const { chunks, meta } = loaded
    return {
      id,
      ...(meta.chronicle_id ? { chronicleId: meta.chronicle_id } : {}),
      tags: meta.tags,
      createdAt: meta.created_at,
      updatedAt: meta.updated_at,
      text: this.fullText(chunks),
    }
  }
}
