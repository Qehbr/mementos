/**
 * MetaStore — the Vault's in-RAM index of memento metadata.
 *
 * It is a `Map<id, MemMetadata>` that is ALSO kept ordered by recency
 * (most-recently-updated first). The ordering is an intrusive doubly-linked list threaded
 * through the `MemMetadata` records themselves — each record's `recencyPrev` / `recencyNext`
 * hold its neighbours' ids. There is no second structure: one map, one entry per memento.
 *
 *   - `get(id)` — O(1) hash lookup, exactly like a plain `Map`.
 *   - `values()` — iterates newest-updated-first in O(n), no sort. The order is maintained
 *     incrementally, so a read never re-sorts.
 *
 * Why a linked list rather than a sorted array: `set` and `delete` are O(1) relink /
 * unlink, with no array shifting.
 *
 * Inverted indexes for filtered reads. Two derived structures are maintained transactionally
 * alongside the byId map: `tagIndex` (tag → set of ids that have that tag) and
 * `chronicleIndex` (chronicle id → set of memento ids in that chronicle). These are the same
 * shape as HybridRetriever's BM25 postings — derived inverted lookups, kept in sync inside
 * the same `set`/`delete` calls that touch byId — and turn `recall(tags=...)` /
 * `recall(chronicle_id=...)` from O(corpus) walks into O(matches) lookups. Date-range reads
 * use `valuesInRange`, which walks the existing recency linked list bounded by the range —
 * no new structure, fast for recent ranges (the common case).
 */
import type { MemMetadata } from './types.js'

/** Filter shared by recall / search / range readers. Every field is optional and conjunctive. */
export interface MetaFilter {
  chronicleId?: string
  tags?: string[]
  excludeTags?: string[]
  /** `updated_at >= start` (ISO timestamp, inclusive). */
  start?: string
  /** `updated_at <= end` (ISO timestamp, inclusive). */
  end?: string
}

/** True if `meta` passes every active field of `f`. An empty filter passes everything. */
export function metaMatches(meta: MemMetadata, f: MetaFilter): boolean {
  if (f.chronicleId && meta.chronicle_id !== f.chronicleId) return false
  if (f.tags?.length && !f.tags.some(t => meta.tags.includes(t))) return false
  if (f.excludeTags?.length && f.excludeTags.some(t => meta.tags.includes(t))) return false
  if (f.start !== undefined && meta.updated_at < f.start) return false
  if (f.end !== undefined && meta.updated_at > f.end) return false
  return true
}

export function isMetaFilterActive(f: MetaFilter): boolean {
  return !!(f.chronicleId || f.tags?.length || f.excludeTags?.length || f.start || f.end)
}

/** Singleton empty set returned for unknown-tag / unknown-chronicle lookups — avoids per-call allocation. */
const EMPTY_SET: ReadonlySet<string> = new Set<string>()

export class MetaStore {
  private byId = new Map<string, MemMetadata>()
  /** Most-recently-updated memento id — the start of the recency-ordered chain. */
  private head: string | undefined

  /** Inverted index: tag → set of memento ids that carry that tag. Maintained on set/delete. */
  private tagIndex = new Map<string, Set<string>>()
  /** Inverted index: chronicle_id → set of memento ids in that chronicle. Maintained on set/delete. */
  private chronicleIndex = new Map<string, Set<string>>()

  get size(): number {
    return this.byId.size
  }

  get(id: string): MemMetadata | undefined {
    return this.byId.get(id)
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  /**
   * Insert or replace `id`'s metadata and (re)link it at the head of the recency order.
   * Replacing an existing id first unlinks the old record and unindexes its old tags /
   * chronicle, then indexes the new ones — so a tag change or chronicle reassignment lands
   * cleanly. O(tags) for index maintenance, O(1) for the linked-list relink.
   */
  set(id: string, meta: MemMetadata): void {
    const existing = this.byId.get(id)
    if (existing) {
      this.unindexTags(id, existing.tags)
      this.unindexChronicle(id, existing.chronicle_id)
      this.unlink(existing)
    }
    this.byId.set(id, meta)
    this.linkAtHead(meta)
    this.indexTags(id, meta.tags)
    this.indexChronicle(id, meta.chronicle_id)
  }

  /** Remove `id`, unlinking it and unindexing its tags / chronicle. O(tags). No-op if absent. */
  delete(id: string): void {
    const meta = this.byId.get(id)
    if (!meta) return
    this.unindexTags(id, meta.tags)
    this.unindexChronicle(id, meta.chronicle_id)
    this.unlink(meta)
    this.byId.delete(id)
  }

  /** Metadata entries, most-recently-updated first. O(n) walk, no sort. */
  *values(): IterableIterator<MemMetadata> {
    let id = this.head
    while (id !== undefined) {
      const meta = this.byId.get(id)
      if (!meta) break  // safety net
      yield meta
      id = meta.recencyNext
    }
  }

  /** `[id, metadata]` pairs, most-recently-updated first. */
  *entries(): IterableIterator<[string, MemMetadata]> {
    for (const meta of this.values()) yield [meta.id, meta]
  }

  /**
   * Metadata entries with `updated_at` in `[start, end]`, most-recently-updated first.
   * Walks the recency linked list bounded by the range — for recent ranges (typical
   * "this week" / "last month" queries) this is O(range_size) rather than O(corpus).
   * Ancient ranges still pay the walk-past-newer cost.
   */
  *valuesInRange(start?: string, end?: string): IterableIterator<MemMetadata> {
    for (const meta of this.values()) {
      if (end !== undefined && meta.updated_at > end) continue  // not yet at the range
      if (start !== undefined && meta.updated_at < start) return  // past it; bail
      yield meta
    }
  }

  /** `[tag, count]` for every indexed tag. Unordered. */
  *tagEntries(): IterableIterator<[string, number]> {
    for (const [tag, ids] of this.tagIndex) yield [tag, ids.size]
  }

  /**
   * Resolve a `MetaFilter` to the set of memento ids that match every active field.
   * Picks the narrowest available index as the base (chronicle > tags > date range > all),
   * then narrows by per-id check against the full filter — correct for any combination of
   * predicates, fast in the common case where one of the predicates is selective enough to
   * scope the walk. Returns a fresh Set the caller may mutate.
   */
  idsMatchingFilter(f: MetaFilter): Set<string> {
    if (!isMetaFilterActive(f)) return new Set(this.byId.keys())

    let allowed: Set<string>
    if (f.chronicleId) {
      allowed = new Set(this.chronicleIndex.get(f.chronicleId) ?? EMPTY_SET)
    } else if (f.tags?.length) {
      // Tag union — "must match at least one of these tags".
      allowed = new Set()
      for (const tag of f.tags) {
        const set = this.tagIndex.get(tag)
        if (set) for (const id of set) allowed.add(id)
      }
    } else if (f.start !== undefined || f.end !== undefined) {
      allowed = new Set()
      for (const meta of this.valuesInRange(f.start, f.end)) allowed.add(meta.id)
    } else {
      // Only excludeTags is active — start from everything, then subtract below.
      allowed = new Set(this.byId.keys())
    }

    // Narrow by all remaining predicates per id. The base already enforces ONE of them;
    // the per-id check enforces the rest (cheap: bounded by `allowed.size`, which is the
    // narrowest set we could find).
    for (const id of allowed) {
      const meta = this.byId.get(id)
      if (!meta) { allowed.delete(id); continue }
      if (!metaMatches(meta, f)) allowed.delete(id)
    }
    return allowed
  }

  /**
   * Re-thread the whole list sorted by `updated_at` descending. The batch paths call this
   * after `set`-ing a group of mementos whose historical timestamps need not match
   * head-insertion order. O(n log n) — amortised across the batch. Inverted indexes are
   * untouched (they're recency-independent).
   */
  reorderByUpdatedAt(): void {
    const sorted = [...this.byId.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    this.head = sorted.length > 0 ? sorted[0].id : undefined
    for (let i = 0; i < sorted.length; i++) {
      sorted[i].recencyPrev = i > 0 ? sorted[i - 1].id : undefined
      sorted[i].recencyNext = i < sorted.length - 1 ? sorted[i + 1].id : undefined
    }
  }

  /** Splice `meta` out of the linked list, repairing its neighbours and the head. */
  private unlink(meta: MemMetadata): void {
    const prev = meta.recencyPrev
    const next = meta.recencyNext
    if (prev !== undefined) {
      const p = this.byId.get(prev)
      if (p) p.recencyNext = next
    } else {
      this.head = next
    }
    if (next !== undefined) {
      const n = this.byId.get(next)
      if (n) n.recencyPrev = prev
    }
    meta.recencyPrev = undefined
    meta.recencyNext = undefined
  }

  /** Link `meta` as the new head of the recency list. */
  private linkAtHead(meta: MemMetadata): void {
    meta.recencyPrev = undefined
    meta.recencyNext = this.head
    if (this.head !== undefined) {
      const oldHead = this.byId.get(this.head)
      if (oldHead) oldHead.recencyPrev = meta.id
    }
    this.head = meta.id
  }

  /** Add `id` to each tag's posting set, creating sets on demand. */
  private indexTags(id: string, tags: string[]): void {
    for (const tag of tags) {
      let set = this.tagIndex.get(tag)
      if (!set) { set = new Set(); this.tagIndex.set(tag, set) }
      set.add(id)
    }
  }

  /** Remove `id` from each tag's posting set; drop the tag entry when its set goes empty. */
  private unindexTags(id: string, tags: string[]): void {
    for (const tag of tags) {
      const set = this.tagIndex.get(tag)
      if (!set) continue
      set.delete(id)
      if (set.size === 0) this.tagIndex.delete(tag)
    }
  }

  /** Add `id` to its chronicle's posting set; no-op for mementos without a chronicle. */
  private indexChronicle(id: string, chronicleId: string | undefined): void {
    if (!chronicleId) return
    let set = this.chronicleIndex.get(chronicleId)
    if (!set) { set = new Set(); this.chronicleIndex.set(chronicleId, set) }
    set.add(id)
  }

  /** Remove `id` from its chronicle's posting set; drop the chronicle entry when empty. */
  private unindexChronicle(id: string, chronicleId: string | undefined): void {
    if (!chronicleId) return
    const set = this.chronicleIndex.get(chronicleId)
    if (!set) return
    set.delete(id)
    if (set.size === 0) this.chronicleIndex.delete(chronicleId)
  }
}
