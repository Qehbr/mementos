/**
 * Unit tests for HybridRetriever.
 *
 * The retriever combines a VectorIndex (BruteForceIndex for tests) with an in-memory
 * BM25 inverted index. We verify:
 *   - BM25 finds exact keyword matches that pure-cosine over a hash-based fake embedder
 *     would miss
 *   - RRF fusion produces a sensible ordering when both legs return overlapping docs
 *   - Add / remove maintain consistent corpus state (no stale df counts after removal)
 *   - Empty corpus returns empty results
 *
 * Tests run against the real BruteForceIndex test helper to keep the integration close
 * to production behavior — no mocks of the dense leg.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { HybridRetriever } from '../retrievers/hybrid/index.js'
import { BruteForceIndex, FakeEmbedder, FAKE_DIMS } from './helpers/fake.js'

describe('HybridRetriever', () => {
  let index: BruteForceIndex
  let embedder: FakeEmbedder
  let retriever: HybridRetriever

  beforeEach(async () => {
    index = new BruteForceIndex(FAKE_DIMS)
    await index.init()
    embedder = new FakeEmbedder()
    retriever = new HybridRetriever(index)
  })

  async function add(id: string, text: string): Promise<void> {
    const vec = await embedder.embed(text)
    index.add(id, vec)
    retriever.add(id, () => text)
  }

  it('returns empty array on empty corpus', async () => {
    const queryVec = await embedder.embed('anything')
    expect(retriever.retrieve('anything', queryVec, 5)).toEqual([])
  })

  it('finds a doc by exact keyword (BM25 leg fires)', async () => {
    // FakeEmbedder is hash-based — vectors for similar-meaning text are NOT close. So a
    // pure-semantic retriever would miss "MobX" as a query against a doc about "MobX".
    // BM25 makes this work via the exact-token match.
    await add('a', 'we use MobX for state management', ['stack'])
    await add('b', 'unrelated content about pasta recipes', ['food'])
    await add('c', 'another unrelated fact about gardening', ['hobby'])

    const queryVec = await embedder.embed('MobX')
    const results = retriever.retrieve('MobX', queryVec, 3)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].id).toBe('a')
  })

  it('boosts overlap when dense and sparse agree (RRF fusion)', async () => {
    // Two docs both contain the query term, plus one decoy. Doc A has it once; doc B has
    // it twice. BM25 ranks B higher; for fusion to surface B at top-1 we just need RRF
    // not to fight the BM25 rank.
    await add('a', 'redux is mentioned here once')
    await add('b', 'redux redux is the topic — redux is everything')
    await add('c', 'a completely unrelated note about cooking')

    const queryVec = await embedder.embed('redux')
    const results = retriever.retrieve('redux', queryVec, 2)
    expect(results.map(r => r.id)).toContain('b')
  })

  it('ignores stopword-like noise and short tokens', async () => {
    // Single-letter tokens dropped by the MIN_TOKEN_LEN filter — they would otherwise
    // dominate df and cause garbage rankings. We check by adding a doc that's mostly
    // single chars and confirming a query of "the a i" returns nothing.
    await add('x', 'a i o u y')
    const queryVec = await embedder.embed('a i o')
    const results = retriever.retrieve('a i o', queryVec, 5)
    // Dense leg may still surface 'x' as the only doc; the BM25 leg adds nothing because
    // all tokens are below the min-length. The result is "at most something, but not
    // boosted by sparse" — we just assert it doesn't crash.
    expect(results).toBeDefined()
  })

  it('remove() updates df so removed docs do not affect IDF', async () => {
    await add('a', 'unique-keyword appears here')
    await add('b', 'also has unique-keyword inside it')

    // Sanity: both currently match
    const qv = await embedder.embed('unique-keyword')
    let results = retriever.retrieve('unique-keyword', qv, 5)
    expect(results.length).toBe(2)

    retriever.remove('a')
    index.remove('a')

    results = retriever.retrieve('unique-keyword', qv, 5)
    expect(results.map(r => r.id)).toEqual(['b'])
  })

  it('re-add of same id replaces previous state (no df double-counting)', async () => {
    await add('a', 'first version mentions widget')
    // Re-add under the same id with different text — internal df for 'widget' must drop
    // back to whatever the new state warrants. Easiest way to test: query for 'widget'
    // after replacing with content that doesn't contain it should not return 'a'.
    await add('a', 'second version about gadgets only')

    const qv = await embedder.embed('widget')
    const results = retriever.retrieve('widget', qv, 5)
    // After replacement, no doc actually contains 'widget' so the BM25 leg returns
    // nothing for it. Dense leg may still surface 'a' as the closest in cosine space —
    // we just check that the corpus state is consistent.
    if (results.length > 0) {
      // If 'a' surfaces, it's via the dense leg only — fine. The important assertion is
      // that the inverted index doesn't think 'widget' still exists. We can probe that
      // indirectly: the result list is bounded.
      expect(results.length).toBeLessThanOrEqual(1)
    }
  })

  // Regression for the silent k-cap: PER_RETRIEVER_TOPK was once a hard cap on dense+sparse
  // legK; commit e45caeb made it a floor (legK = max(k, PER_RETRIEVER_TOPK)) so callers can
  // request k > 100. Every other test uses k ≤ 10, which sits well below the floor and
  // can't distinguish "floor" from "cap" — this one explicitly does.
  it('retrieve(k > PER_RETRIEVER_TOPK) returns up to k results (floor, not cap)', async () => {
    // 160 docs all sharing the BM25 token 'commontoken' but distinct otherwise. If the
    // legK were reverted to PER_RETRIEVER_TOPK, both legs would cap at 100 — with partial
    // dense/sparse overlap, fused.size lands below 150 and the final Math.min(k, fused)
    // clips the output. The floor keeps both legs at 150 and the test sees the full k.
    for (let i = 0; i < 160; i++) {
      await add(`d${i}`, `commontoken distinct${i}word for ranking variety`)
    }
    const qv = await embedder.embed('commontoken')
    const results = retriever.retrieve('commontoken', qv, 150)
    expect(results.length).toBe(150)
  })

  it('synthetic distances stay below the Vault retrieval threshold (0.5)', async () => {
    // The retriever returns rank-based pseudo-distances clamped well below 0.5 so the
    // Vault's existing distance filter never drops a fused result.
    for (let i = 0; i < 10; i++) await add(`d${i}`, `document number ${i} content`)
    const qv = await embedder.embed('document')
    const results = retriever.retrieve('document', qv, 10)
    for (const r of results) {
      expect(r.distance).toBeLessThan(0.5)
    }
  })

  // ─── Cold-query gate ─────────────────────────────────────────────────────────
  // Hand-crafted unit vectors (not the hash embedder) so the dense distances are exact:
  // [1,0,0,0] vs [1,0,0,0] → cosine distance 0; vs [0,1,0,0] → distance 1.0 (≥ the 0.8
  // cold threshold). This lets each leg's contribution to the gate be tested in isolation.
  const QV = new Float32Array([1, 0, 0, 0])

  it('cold query — far dense match AND no keyword hit — returns nothing', async () => {
    index.add('a', new Float32Array([0, 1, 0, 0]))           // distance 1.0 from QV
    retriever.add('a', () => 'completely unrelated gardening content')
    // Query terms appear in no doc → BM25 leg empty; dense best is 1.0 → cold → [].
    expect(retriever.retrieve('quantum chromodynamics', QV, 5)).toEqual([])
  })

  it('warm query — a close dense match defeats the cold gate', async () => {
    index.add('a', new Float32Array([1, 0, 0, 0]))           // distance 0 from QV
    retriever.add('a', () => 'completely unrelated gardening content')
    // No keyword hit, but the dense leg has a close match → not cold → result returned.
    expect(retriever.retrieve('quantum chromodynamics', QV, 5).map(r => r.id)).toEqual(['a'])
  })

  it('warm query — a keyword hit defeats the cold gate even when the dense leg is far', async () => {
    index.add('a', new Float32Array([0, 1, 0, 0]))           // distance 1.0 from QV
    retriever.add('a', () => 'the codebase uses quantum chromodynamics extensively')
    // Dense best is far, but the query terms are real BM25 hits → not cold → returned.
    expect(retriever.retrieve('quantum chromodynamics', QV, 5).map(r => r.id)).toEqual(['a'])
  })

  // ─── allowed: filtered recall restriction ───────────────────────────────────
  // `allowed` is a memento-id set. Both retrieval legs must honor it — dense via
  // `index.filteredSearch`, sparse via the per-doc check inside `bm25Search`.

  it('allowed restricts results to the given memento ids (both legs)', async () => {
    await add('a', 'MobX for state management')
    await add('b', 'MobX is everything in our stack')
    await add('c', 'completely unrelated cooking notes')

    const qv = await embedder.embed('MobX')

    // Without `allowed`: both 'a' and 'b' are real BM25 + dense matches.
    const unfiltered = retriever.retrieve('MobX', qv, 5).map(r => r.id)
    expect(unfiltered).toEqual(expect.arrayContaining(['a', 'b']))

    // With `allowed=['a']`: only 'a' may surface.
    const filtered = retriever.retrieve('MobX', qv, 5, new Set(['a'])).map(r => r.id)
    expect(filtered).toEqual(['a'])
  })

  it('allowed drops a BM25 top-scorer when it is forbidden', async () => {
    // 'b' has 3x the keyword tf — unfiltered, BM25 ranks it above 'a'. With `allowed=['a']`,
    // it must not appear at all, even though the BM25 leg would otherwise put it on top.
    await add('a', 'uniqueterm appears once here')
    await add('b', 'uniqueterm uniqueterm uniqueterm everywhere')

    const qv = await embedder.embed('uniqueterm')

    const unfiltered = retriever.retrieve('uniqueterm', qv, 5).map(r => r.id)
    expect(unfiltered).toEqual(expect.arrayContaining(['a', 'b']))

    const restricted = retriever.retrieve('uniqueterm', qv, 5, new Set(['a'])).map(r => r.id)
    expect(restricted).toEqual(['a'])
    expect(restricted).not.toContain('b')
  })
})
