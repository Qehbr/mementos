/**
 * TrigramSearcher — trigram inverted index narrows candidates; the real matcher still
 * runs to confirm matches and extract positions.
 *
 * Acceleration applies only to literal queries ≥ 3 chars. Regex and 1–2 char literals
 * fall back to a full scan — a regex has no guaranteed literal substring to filter on,
 * and filtering it wrong would silently drop real matches. The trigram index is a
 * *correctness-preserving* filter or it is nothing.
 *
 * Posting lists store interned integer ids and stay sorted ascending (ids are assigned in
 * `add` order, only appended). Updates tombstone the old slot rather than reusing it —
 * fine for a personal vault's update rate; heavy-churn would want compaction (not built).
 */
import type { Searcher, SearchOptions, SearchOutcome } from '../interface.js'
import type { SearcherImplementationModule } from '../registry.js'
import { ensurePluginSetup } from '../../core/plugins.js'
import { runTextSearch, asciiLower } from '../_utils/engine.js'
import { TextStore } from '../_utils/text-store.js'
import { TRIGRAM_SIZE } from './constants.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'trigram'
export function create(): Searcher {
  return new TrigramSearcher()
}
// Same dependency as `scan` — RE2 hardens regex-mode search against ReDoS.
export const setupAtInit = ensurePluginSetup('re2')
const _shape: SearcherImplementationModule = { type, create, setupAtInit }

/**
 * Distinct n-grams from an already-lowered string. Use when the caller holds the lower
 * form already; otherwise call `trigramsOf` which lowers first.
 */
export function trigramsOfLower(lower: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + TRIGRAM_SIZE <= lower.length; i++) out.add(lower.slice(i, i + TRIGRAM_SIZE))
  return out
}

/**
 * Distinct lowercased n-grams of `text`. ASCII-lowercased to match the literal matcher's
 * case folding — so the trigram filter and the verify step agree on case-insensitivity.
 * Convenience wrapper for callers (the query path) that don't already have the lower form.
 */
export function trigramsOf(text: string): Set<string> {
  return trigramsOfLower(asciiLower(text))
}

/** Intersect two ascending-sorted integer arrays. */
function intersectSorted(a: number[], b: number[]): number[] {
  const out: number[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(a[i])
      i++
      j++
    } else if (a[i] < b[j]) {
      i++
    } else {
      j++
    }
  }
  return out
}

export class TrigramSearcher implements Searcher {
  /** Resident text + lowered form, shared with ScanSearcher. */
  private store = new TextStore()
  /** Interned ids: `ids[n]` is the memento id for slot `n`; tombstoned slots are undefined. */
  private ids: (string | undefined)[] = []
  /** memento id → its interned slot. */
  private idIndex = new Map<string, number>()
  /** trigram → ascending-sorted list of interned ids whose text contains it. */
  private postings = new Map<string, number[]>()

  add(id: string, decryptText: () => string): void {
    // Defensive: a re-add of a live id rebuilds it cleanly. The Vault calls remove first.
    if (this.idIndex.has(id)) this.remove(id)
    const text = decryptText()
    const lower = this.store.add(id, text)
    const n = this.ids.length
    this.ids.push(id)
    this.idIndex.set(id, n)
    for (const tri of trigramsOfLower(lower)) {
      let list = this.postings.get(tri)
      if (!list) {
        list = []
        this.postings.set(tri, list)
      }
      // n is monotonically increasing, so the posting list stays sorted ascending.
      list.push(n)
    }
  }

  remove(id: string): void {
    const n = this.idIndex.get(id)
    if (n === undefined) return
    // Tombstone, don't splice — see module doc. `candidateIdsFor` filters tombstoned slots.
    this.store.remove(id)
    this.idIndex.delete(id)
    this.ids[n] = undefined
  }

  search(query: string, opts: SearchOptions): SearchOutcome {
    const ids = opts.orderedIds ?? this.store.keys()
    // Trigram acceleration applies only to literal queries with at least one trigram.
    // Everything else scans the full corpus (still correct, just unaccelerated).
    // Below one full n-gram there's nothing to filter on — must scan, not query postings.
    if (opts.regex || query.length < TRIGRAM_SIZE) {
      return runTextSearch(this.store.orderedEntries(ids), query, opts)
    }
    // The trigram index narrows to a candidate superset; the matcher then runs only on
    // those — but we still walk `ids` so the kept matches stay in recency order.
    const candidates = this.candidateIdsFor(query)
    return runTextSearch(this.store.orderedEntries(ids, candidates), query, opts)
  }

  /** Mementos that contain every trigram of `query` — a superset of the true matches. */
  private candidateIdsFor(query: string): Set<string> {
    const lists: number[][] = []
    for (const tri of trigramsOf(query)) {
      const list = this.postings.get(tri)
      // A required trigram that appears nowhere ⇒ nothing can match.
      if (!list) return new Set()
      lists.push(list)
    }
    if (lists.length === 0) return new Set()
    // Intersect shortest-first so the accumulator only ever shrinks.
    lists.sort((a, b) => a.length - b.length)
    let acc = lists[0]
    for (let i = 1; i < lists.length && acc.length > 0; i++) {
      acc = intersectSorted(acc, lists[i])
    }
    const out = new Set<string>()
    for (const n of acc) {
      const id = this.ids[n]
      if (id !== undefined) out.add(id)
    }
    return out
  }
}
