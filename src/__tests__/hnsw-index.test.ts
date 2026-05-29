/**
 * Unit tests for HNSWIndex. The Vault-level tests use the in-process BruteForceIndex fake,
 * so without these the production hnswlib-backed filteredSearch path (adaptive `ef`, the
 * `setEf`/finally restoration, the `mementoIdToNumIds` resolution) ships with no direct
 * coverage — a revert of the `finally` block, or of the memento-id resolution, would not
 * fail any other test.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { HNSWIndex } from '../vector/hnsw/index.js'
import { DEFAULT_EF_SEARCH } from '../vector/hnsw/constants.js'
import { chunkKey, mementoIdOf } from '../core/vault/chunk-key.js'

const DIM = 32

/** A deterministic unit-norm vector pointed along axis `i mod DIM`. */
function basisVec(i: number): Float32Array {
  const v = new Float32Array(DIM)
  v[i % DIM] = 1
  return v
}

describe('HNSWIndex.filteredSearch', () => {
  let idx: HNSWIndex

  beforeEach(async () => {
    idx = new HNSWIndex(DIM)
    await idx.init()
  })

  it('returns only chunks whose memento id is in allowedMementoIds', async () => {
    // 5 mementos × 2 chunks each — 10 keys. Each memento's chunks point in close
    // directions so an unfiltered query against memento 'm0' would surface its own chunks.
    for (let m = 0; m < 5; m++) {
      for (let c = 0; c < 2; c++) {
        idx.add(chunkKey(`m${m}`, c), basisVec(m * 2 + c))
      }
    }

    const query = basisVec(0)  // closest to m0's chunk 0
    const allowed = new Set(['m1', 'm3'])
    const results = idx.filteredSearch(query, 5, allowed)

    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(allowed.has(mementoIdOf(r.id))).toBe(true)
    }
  })

  it('caps result count at min(k, total allowed chunks)', async () => {
    for (let m = 0; m < 4; m++) {
      for (let c = 0; c < 2; c++) idx.add(chunkKey(`m${m}`, c), basisVec(m * 2 + c))
    }
    // allowed has 1 memento × 2 chunks = 2 candidate keys; even with k=10 we cap at 2.
    const results = idx.filteredSearch(basisVec(0), 10, new Set(['m1']))
    expect(results.length).toBe(2)
  })

  it('empty allowed set returns no results without touching the index', async () => {
    for (let i = 0; i < 5; i++) idx.add(chunkKey(`m${i}`, 0), basisVec(i))
    expect(idx.filteredSearch(basisVec(0), 5, new Set())).toEqual([])
  })

  it('an allowed memento id the index does not know returns []', async () => {
    for (let i = 0; i < 3; i++) idx.add(chunkKey(`m${i}`, 0), basisVec(i))
    // No knowledge of 'unknown-id' — drops through the resolver and matches nothing.
    expect(idx.filteredSearch(basisVec(0), 5, new Set(['unknown-id']))).toEqual([])
  })

  it('restores DEFAULT_EF_SEARCH after a filteredSearch call (success path)', async () => {
    for (let m = 0; m < 10; m++) idx.add(chunkKey(`m${m}`, 0), basisVec(m))
    // Force a very selective filter so the adaptive ef computation lifts above default.
    idx.filteredSearch(basisVec(0), 1, new Set(['m0']))
    expect(idx.currentEf).toBe(DEFAULT_EF_SEARCH)
  })

  it('restores DEFAULT_EF_SEARCH even if the underlying call throws', async () => {
    for (let m = 0; m < 5; m++) idx.add(chunkKey(`m${m}`, 0), basisVec(m))
    // Wrong-dim vector triggers a runtime error inside hnswlib. The `finally` block must
    // still restore ef — otherwise subsequent unfiltered queries run elevated forever.
    const badVec = new Float32Array(DIM + 1)
    expect(() => idx.filteredSearch(badVec, 1, new Set(['m0']))).toThrow()
    expect(idx.currentEf).toBe(DEFAULT_EF_SEARCH)
  })

  it('unfiltered search still works after a filteredSearch (state isolation)', async () => {
    for (let m = 0; m < 5; m++) idx.add(chunkKey(`m${m}`, 0), basisVec(m))
    idx.filteredSearch(basisVec(0), 1, new Set(['m2']))
    // Sanity: the index is still usable; nothing about filteredSearch wedged the state.
    const results = idx.search(basisVec(0), 3)
    expect(results.length).toBe(3)
  })

  it('mementoIdToNumIds index follows add/remove', async () => {
    idx.add(chunkKey('m0', 0), basisVec(0))
    idx.add(chunkKey('m0', 1), basisVec(1))
    idx.add(chunkKey('m1', 0), basisVec(2))

    // Before remove: filter on m0 returns its 2 chunks.
    let results = idx.filteredSearch(basisVec(0), 5, new Set(['m0']))
    expect(results.length).toBe(2)

    // Remove m0's chunk 0 — filter on m0 now returns only chunk 1.
    idx.remove(chunkKey('m0', 0))
    results = idx.filteredSearch(basisVec(0), 5, new Set(['m0']))
    expect(results.length).toBe(1)
    expect(mementoIdOf(results[0].id)).toBe('m0')

    // Remove m0's last chunk — filter on m0 returns nothing.
    idx.remove(chunkKey('m0', 1))
    expect(idx.filteredSearch(basisVec(0), 5, new Set(['m0']))).toEqual([])
  })

  // Regression for the encrypted-cache fast path: when the index is restored via load()
  // (not rebuilt by re-adding), mementoIdToNumIds must be rebuilt from numToStr. If that
  // rebuild ever drops, every filtered recall after a cache-hit warm-startup silently
  // returns [] — invisible to the rest of the suite which uses BruteForceIndex.
  it('load() rebuilds mementoIdToNumIds so filteredSearch works after serialize/load round-trip', async () => {
    for (let m = 0; m < 3; m++) {
      idx.add(chunkKey(`m${m}`, 0), basisVec(m * 2))
      idx.add(chunkKey(`m${m}`, 1), basisVec(m * 2 + 1))
    }
    const blob = await idx.serialize()

    const restored = new HNSWIndex(DIM)
    await restored.load(blob)

    // Without the load-time rebuild of mementoIdToNumIds, this returns [] (unknown memento).
    const results = restored.filteredSearch(basisVec(2), 5, new Set(['m1']))
    expect(results.length).toBe(2)
    for (const r of results) {
      expect(mementoIdOf(r.id)).toBe('m1')
    }
  })
})
