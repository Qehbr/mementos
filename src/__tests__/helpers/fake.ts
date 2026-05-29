import type { EmbeddingProvider } from '../../embeddings/interface.js'
import type { VectorIndex, SearchResult } from '../../vector/interface.js'
import { mementoIdOf } from '../../core/vault/chunk-key.js'

/**
 * Test embedder dimensionality. Random-pair cosine variance scales as 1/√D; 64-d is
 * the smallest size that puts every common test pattern comfortably outside the
 * threshold zones:
 *   - 2-of-3 shared-word texts → similarity ~0.667 (well below the 0.92 dup threshold)
 *   - 1-of-3 shared-word query→text → distance ~0.42 (consistently below the 0.5
 *     relevance cutoff, ±~0.07 variance at this dim)
 *   - unrelated texts → distance ~1.0 (well above 0.5)
 * Tried 4, 16, 32 first — all produced occasional flaky tests due to unlucky cross-term
 * sums on specific word hashes. Exported so tests construct matched-dim vector indexes
 * without re-hardcoding.
 */
export const FAKE_DIMS = 64

/**
 * Word-bag deterministic embedder — no ONNX, no network, 4-dim.
 *
 * Contract for tests:
 *   - **Identical text → distance 0.** Lets dup-detection tests assert exact hits.
 *   - **Shared-word texts → closer than unrelated texts.** Lets relevance-cutoff and
 *     filter-on-allowed-set tests assert strict contracts — recall(query, k, filter)
 *     can deterministically return tagged items whose text shares words with the query.
 *   - **No shared words → far apart** (typically distance ≥ 1 in 4-d after normalization
 *     of randomly-directed word sums).
 *   - Deterministic across runs.
 *
 * Earlier version was per-text DJB2 — distances between two distinct texts were essentially
 * random in 4-d, so tests had to assert weak contracts (`length > 0`) to survive the
 * `RETRIEVAL_DISTANCE_THRESHOLD = 0.5` cutoff. Per-word vectors with shared-word overlap
 * make the cutoff predictable, so tests can assert exact-k.
 */
export class FakeEmbedder implements EmbeddingProvider {
  readonly dimensions = FAKE_DIMS

  async embed(text: string): Promise<Float32Array> {
    // Tokenise on non-word chars; lowercase so "Apples" and "apples" share a vector.
    // A tiny stopword list stands in for production embedders' down-weighting of common
    // English words — without it, a 1-word query against a 5-word text like
    // "directly written by the AI" has expected cos = 1/√5 ≈ 0.447, putting distance
    // (0.553) above the 0.5 relevance cutoff *before any noise* — the query signal is
    // diluted to nothing. Numeric tokens are kept so tests can use them as distinguishers.
    const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 0 && !STOPWORDS.has(w))
    if (words.length === 0) return new Float32Array(FAKE_DIMS)

    // Sum each word's hash-direction vector. Identical word sets → identical sum.
    // Shared words → sums share contributions → directions align after normalisation.
    const sum = new Float32Array(FAKE_DIMS)
    for (const word of words) {
      const wv = wordVec(word)
      for (let i = 0; i < FAKE_DIMS; i++) sum[i] += wv[i]
    }
    const norm = Math.sqrt(sum.reduce((s, v) => s + v * v, 0))
    if (norm === 0) return sum
    const out = new Float32Array(FAKE_DIMS)
    for (let i = 0; i < FAKE_DIMS; i++) out[i] = sum[i] / norm
    return out
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map(t => this.embed(t)))
  }
}

/**
 * Minimal English stopword list — common function words that carry no topical signal
 * and dilute query-to-text cosine if left in. Kept small (no domain terms) so it doesn't
 * remove anything tests might use as a distinguisher.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'and', 'or', 'but', 'if', 'then', 'of', 'in', 'on', 'at', 'by',
  'for', 'to', 'from', 'with', 'as', 'into', 'about',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that', 'these', 'those',
  'do', 'does', 'did', 'has', 'have', 'had',
])

/** DJB2 → LCG → FAKE_DIMS floats in [-1, 1] — deterministic per-word "direction" vector. */
function wordVec(word: string): number[] {
  let h = 5381
  for (let i = 0; i < word.length; i++) h = Math.imul(h, 33) ^ word.charCodeAt(i)
  const out = new Array<number>(FAKE_DIMS)
  for (let i = 0; i < FAKE_DIMS; i++) {
    h = (Math.imul(h, 1664525) + 1013904223) | 0
    out[i] = (h & 0xffff) / 0x8000 - 1
  }
  return out
}

/** Pure-JS cosine-distance index — no native deps, for tests only. */
export class BruteForceIndex implements VectorIndex {
  private points = new Map<string, Float32Array>()

  constructor(readonly dimensions: number) {}

  get size() { return this.points.size }

  async init() { this.points.clear() }

  add(id: string, vector: Float32Array) {
    this.points.set(id, new Float32Array(vector))
  }

  search(query: Float32Array, k: number): SearchResult[] {
    return Array.from(this.points.entries())
      .map(([id, vec]) => ({ id, distance: cosineDist(query, vec) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k)
  }

  /**
   * Exact filtered top-k for tests — restrict the brute-force scan to chunks belonging
   * to mementos in `allowedMementoIds`, then take top-k. Matches the production HNSWIndex
   * contract: results are guaranteed to be chunks of allowed mementos, ordered by distance
   * ascending. Memento id is parsed from the `"<mementoId>#<i>"` chunk-key convention.
   */
  filteredSearch(query: Float32Array, k: number, allowedMementoIds: ReadonlySet<string>): SearchResult[] {
    return Array.from(this.points.entries())
      .filter(([id]) => allowedMementoIds.has(mementoIdOf(id)))
      .map(([id, vec]) => ({ id, distance: cosineDist(query, vec) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k)
  }

  remove(id: string) { this.points.delete(id) }

  async serialize(): Promise<Buffer> {
    const entries: [string, number[]][] = []
    for (const [id, vec] of this.points) entries.push([id, Array.from(vec)])
    return Buffer.from(JSON.stringify(entries))
  }

  async load(data: Buffer): Promise<void> {
    this.points.clear()
    if (data.byteLength === 0) return
    const entries = JSON.parse(data.toString()) as [string, number[]][]
    for (const [id, vec] of entries) this.points.set(id, new Float32Array(vec))
  }
}

function cosineDist(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? 1 - dot / denom : 1
}
