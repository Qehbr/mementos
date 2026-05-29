/**
 * HybridRetriever — fuses dense (VectorIndex) and sparse (BM25) retrieval via Reciprocal
 * Rank Fusion (RRF).
 *
 * BM25 (Okapi BM25, Robertson & Sparck-Jones, 1976):
 *   score(D, Q) = Σ_t IDF(t) · tf(t, D) · (k1 + 1) / (tf(t, D) + k1 · (1 - b + b · |D|/avgdl))
 *   IDF(t)    = ln((N - df(t) + 0.5) / (df(t) + 0.5) + 1)
 *
 * RRF (Cormack et al., 2009):
 *   score(d) = Σ_r 1 / (k_rrf + rank_r(d))    with k_rrf = 60
 *
 * Inverted index lives entirely in RAM. Built incrementally on every `add` (write/sync/
 * startup) and updated on `remove`. Plaintext never touches disk — same pattern as the
 * decrypted-tags map already in Vault.metaById. There is no persistent BM25 cache yet; the
 * index rebuilds from decrypted text at every Vault startup. Cost is roughly one AES-GCM
 * decrypt per memory on top of what the cache-hit path already does for tags — fine for
 * personal-vault scales (10k–100k memories).
 *
 * Cold-query gate: returns [] if dense's best match is far AND BM25 found nothing
 * (see `retrieve`). A fused result's `distance` is synthetic — RRF scores aren't
 * comparable to cosine distance — kept below the Vault's threshold so its filter passes.
 */
import type { Retriever } from '../interface.js'
import type { VectorIndex, SearchResult } from '../../vector/interface.js'
import type { RetrieverImplementationModule } from '../registry.js'
import { topK } from '../_utils/top-k.js'
import { mementoIdOf } from '../../core/vault/chunk-key.js'
import {
  BM25_K1, BM25_B, RRF_K, PER_RETRIEVER_TOPK, COLD_QUERY_THRESHOLD, MIN_TOKEN_LEN,
} from './constants.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'hybrid'
export function create(index: VectorIndex): Retriever {
  return new HybridRetriever(index)
}
const _shape: RetrieverImplementationModule = { type, create }

/**
 * Tokenize a text into BM25 terms. Lowercase, split on non-word characters, drop tokens
 * shorter than MIN_TOKEN_LEN. Intentionally simple — language-specific stemming and
 * stopword removal can come later. The cost of "tokenize once at write, look up at query"
 * means the tokenizer runs once per text, never per query/doc pair.
 */
function tokenize(text: string): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= MIN_TOKEN_LEN) out.push(raw)
  }
  return out
}

/**
 * Forward-index entry: the unique terms a document contains (so `remove(id)`, which is
 * given only an id and no text, knows which posting lists to prune) and its token length
 * (for BM25 length normalisation).
 */
interface DocEntry {
  terms: string[]
  length: number
}

export class HybridRetriever implements Retriever {
  /**
   * Inverted index: term → (docId → term-frequency in that doc). This is the query-time
   * shape — a query term resolves to its documents in a single lookup. `df(t)` is just
   * `postings.get(t).size`, so no separate document-frequency map is kept.
   */
  private postings = new Map<string, Map<string, number>>()
  /**
   * Forward index: docId → its unique terms + token length. Inverted + forward is the
   * standard search-index pair — each answers one access direction (term→docs for query,
   * doc→terms for removal), neither cheaply derivable from the other when it is needed.
   */
  private docs = new Map<string, DocEntry>()
  /** Sum of all doc lengths — divide by docs.size for avgdl. */
  private totalLength = 0

  constructor(private readonly index: VectorIndex) {}

  add(id: string, decryptText: () => string): void {
    // Re-add of an existing id: scrub the old entry first so the postings stay correct.
    if (this.docs.has(id)) this.remove(id)

    const tokens = tokenize(decryptText())
    if (tokens.length === 0) {
      // Empty doc — still track it so the corpus size (N) reflects every memory, even if
      // BM25 will never match it. It has no terms, so no postings and no totalLength.
      this.docs.set(id, { terms: [], length: 0 })
      return
    }

    const tf = new Map<string, number>()
    for (const tok of tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1)
    this.docs.set(id, { terms: [...tf.keys()], length: tokens.length })
    this.totalLength += tokens.length

    // Post each term under its inverted-index entry: term → (this doc → its tf). df(t) is
    // later read straight off `postings.get(t).size`.
    for (const [term, count] of tf) {
      let posting = this.postings.get(term)
      if (!posting) {
        posting = new Map()
        this.postings.set(term, posting)
      }
      posting.set(id, count)
    }
  }

  remove(id: string): void {
    const doc = this.docs.get(id)
    if (!doc) return
    this.docs.delete(id)
    this.totalLength -= doc.length
    // Prune this doc from each of its terms' posting lists; drop a term that empties out.
    for (const term of doc.terms) {
      const posting = this.postings.get(term)
      if (!posting) continue
      posting.delete(id)
      if (posting.size === 0) this.postings.delete(term)
    }
  }

  retrieve(query: string, queryVector: Float32Array, k: number, allowed?: ReadonlySet<string>): SearchResult[] {
    // Both legs at full breadth — the dense leg is a fusion candidate pool, not final
    // output, so it is NOT per-result filtered (that discards moderately-relevant
    // evidence RRF should still get to rank).
    // Honor the caller's k while preserving fusion quality at small k: floor each leg's
    // fetch at PER_RETRIEVER_TOPK so RRF always has enough material, but scale up to k when
    // the caller wants more — so we never silently return fewer than k when more exist.
    // When `allowed` is given, both legs restrict to that set in their own native paths:
    // dense via index.filteredSearch (HNSW filter callback), sparse via bm25Search's
    // built-in `allowed` filter. Fusion (RRF below) is unchanged.
    const legK = Math.max(k, PER_RETRIEVER_TOPK)
    const dense = allowed === undefined
      ? this.index.search(queryVector, legK)
      : this.index.filteredSearch(queryVector, legK, allowed)
    const sparse = this.bm25Search(query, legK, allowed)

    // Cold-query gate (all-or-nothing, decided per query). If even the single closest
    // vector is very far AND BM25 found no keyword hit, the vault has nothing for this
    // query — return [] rather than fusing the top-k least-bad vectors into noise. A warm
    // query's best match is far closer than COLD_QUERY_THRESHOLD, so this never gates it.
    const denseBest = dense[0]?.distance ?? Infinity
    if (denseBest >= COLD_QUERY_THRESHOLD && sparse.length === 0) return []

    // Reciprocal Rank Fusion. Each retriever contributes 1 / (k_rrf + rank); we sum over
    // retrievers and rank descending. RRF is rank-based by design — it ignores the raw
    // score magnitude of each retriever, which is exactly what we want when cosine
    // distance and BM25 score live on incomparable scales.
    const fused = new Map<string, number>()
    for (const leg of [dense, sparse]) {
      leg.forEach((r, i) => fused.set(r.id, (fused.get(r.id) ?? 0) + 1 / (RRF_K + i + 1)))
    }

    if (fused.size === 0) return []

    // Sort by fused score descending. The synthetic `distance` is kept strictly below the
    // Vault's RETRIEVAL_DISTANCE_THRESHOLD so its filter passes every result — relevance
    // gating already happened (the cold-query short-circuit above).
    const sorted = [...fused.entries()].sort(([, a], [, b]) => b - a)
    const out: SearchResult[] = []
    for (let i = 0; i < Math.min(k, sorted.length); i++) {
      const [id] = sorted[i]
      // Synthetic distance: linear ramp inside [0, 0.4]. Always below 0.5 so the Vault's
      // existing filter passes; preserves rank ordering for any downstream tie-break.
      out.push({ id, distance: 0.4 * (i / Math.max(1, k - 1)) })
    }
    return out
  }

  // ─── BM25 internals ─────────────────────────────────────────────────────────

  /**
   * BM25 over the in-memory inverted index. For each unique query term a single
   * `postings` lookup yields exactly the documents that contain it (with their tf), and
   * `df(t)` is that posting list's `size`. Cost is O(Σ postings of the query terms) — only
   * documents that actually contain a query word are touched, independent of corpus size.
   *
   * `allowed`, when given, restricts scoring to docs in the set — a doc not in `allowed`
   * is skipped before any score math, so the cost is bounded by the intersection of query
   * postings and `allowed`. IDF still uses the global `df` (filter doesn't change a term's
   * intrinsic informativeness), so scores remain comparable to unfiltered queries.
   */
  private bm25Search(query: string, k: number, allowed?: ReadonlySet<string>): Array<{ id: string }> {
    const N = this.docs.size
    if (N === 0) return []

    const queryTerms = tokenize(query)
    if (queryTerms.length === 0) return []

    const avgdl = this.totalLength / N
    const scores = new Map<string, number>()

    for (const term of new Set(queryTerms)) {
      const posting = this.postings.get(term)
      if (!posting) continue
      // df(t) — documents containing t — is exactly the posting list's size.
      const df = posting.size
      // BM25 IDF — the +1 inside the log keeps the score non-negative even when df > N/2.
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1)

      for (const [docId, tf] of posting) {
        // `allowed` is a memento-id set; docId is a chunk key (`"<mementoId>#<i>"`).
        if (allowed && !allowed.has(mementoIdOf(docId))) continue
        const doc = this.docs.get(docId)
        if (!doc) continue
        const norm = 1 - BM25_B + BM25_B * (doc.length / avgdl)
        const tfPart = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm)
        scores.set(docId, (scores.get(docId) ?? 0) + idf * tfPart)
      }
    }

    if (scores.size === 0) return []

    // O(N log k) min-heap; `scores.size` is tens of thousands on a large vault for common
    // terms while k stays small. A full sort would be ~3× the work for the same top-k.
    // We only need the ids in rank order — RRF fuses by rank, not score, so the score
    // doesn't ride along into the return.
    const top = topK(scores.entries(), k, ([, s]) => s)
    return top.map(([id]) => ({ id }))
  }
}
