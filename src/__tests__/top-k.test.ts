/**
 * Unit tests for `topK` — the min-heap-based top-k selector that backs HybridRetriever's
 * BM25 hot path (audit-7). Direct coverage so a heap bug (wrong sift direction, off-by-one,
 * wrong drain order, broken iterable consumption) shows up here rather than as a silent
 * "BM25 returns some-but-wrong results" — which RRF would then mask in the integration
 * tests until queries got large.
 */
import { describe, it, expect } from 'vitest'
import { topK } from '../retrievers/_utils/top-k.js'

describe('topK', () => {
  it('returns all input items best-first when k > N', () => {
    const items = [{ s: 3 }, { s: 1 }, { s: 5 }, { s: 2 }]
    expect(topK(items, 10, i => i.s)).toEqual([{ s: 5 }, { s: 3 }, { s: 2 }, { s: 1 }])
  })

  it('returns [] when k = 0', () => {
    expect(topK([{ s: 1 }, { s: 2 }], 0, i => i.s)).toEqual([])
  })

  it('returns exactly the top N/2 in descending score order', () => {
    const items = [...Array(20)].map((_, i) => ({ s: i }))
    // top 10 of [0..19] is [19, 18, …, 10] descending.
    expect(topK(items, 10, i => i.s).map(i => i.s))
      .toEqual([19, 18, 17, 16, 15, 14, 13, 12, 11, 10])
  })

  it('ties at the kth boundary: both candidates fit if exactly at k; first-seen-wins beyond k', () => {
    // With k=2 and three items scoring [5, 5, 5], the heap keeps the FIRST two it saw
    // (subsequent equals don't beat heap.peek() because `s > heap.peek()` is strict `>`).
    const items = [{ id: 'a', s: 5 }, { id: 'b', s: 5 }, { id: 'c', s: 5 }]
    const result = topK(items, 2, i => i.s)
    expect(result).toHaveLength(2)
    expect(result.map(i => i.id).sort()).toEqual(['a', 'b'])
  })

  it('handles negative scores correctly (BM25 scores can be ≤ 0)', () => {
    const items = [{ s: -3 }, { s: -1 }, { s: -5 }, { s: -2 }]
    expect(topK(items, 2, i => i.s)).toEqual([{ s: -1 }, { s: -2 }])
  })

  it('consumes an Iterable in a single pass (hot-path: scores.entries() is a generator)', () => {
    let consumed = 0
    function* gen() {
      for (const s of [4, 1, 9, 2, 7]) { consumed++; yield { s } }
    }
    expect(topK(gen(), 2, i => i.s)).toEqual([{ s: 9 }, { s: 7 }])
    expect(consumed).toBe(5)  // one pass — every item visited exactly once
  })
})
