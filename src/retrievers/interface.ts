/**
 * Retriever — abstracts the "query → top-k memento ids" strategy.
 *
 * Sits one layer above `VectorIndex`. The vector index is just an ANN data structure
 * (`Float32Array → top-k by cosine`); a retriever is the *strategy* applied to that index
 * and any companion structures (BM25 inverted index, reranker, etc.). Different retrievers
 * answer the same question with different trade-offs:
 *
 *   - `SemanticRetriever`  — pure VectorIndex.search
 *   - `HybridRetriever`    — dense (VectorIndex) + sparse (BM25 inverted index) fused by RRF
 *
 * Vault still owns the `VectorIndex` directly — write-time duplicate detection and the
 * encrypted HNSW cache aren't retrieval concerns. The retriever takes the VectorIndex as a
 * constructor dependency so any retriever has dense search available for free.
 *
 * `add` is called by Vault for every memory at startup AND on every write/update. `remove`
 * is called on delete/update. The retriever decides how to store what it gets — a semantic
 * retriever ignores the text payload entirely; a hybrid retriever tokenises and builds an
 * inverted index. Text is provided via a lazy thunk so retrievers that don't need it never
 * pay the decryption cost.
 */
import type { VectorIndex, SearchResult } from '../vector/interface.js'

export type { SearchResult } from '../vector/interface.js'

export interface Retriever {
  /**
   * Notify the retriever that a memory exists. Called once per memory at startup, and
   * again on every successful `writeMemento` / `updateMemento`.
   *
   * `decryptText` is a thunk so retrievers that don't need the text never pay the AES-GCM
   * decrypt cost. SemanticRetriever ignores it; HybridRetriever calls it.
   */
  add(id: string, decryptText: () => string): void

  /** Notify the retriever a memory is gone. Called on delete and at the start of an update. */
  remove(id: string): void

  /**
   * Top-k retrieval. Vault has already embedded the query — both string and vector forms
   * are passed so the retriever can mix sparse (string-tokenised) and dense (vector) lookups.
   * Returned results carry the standard `{ id, distance }` shape; `distance` is whatever
   * scalar this retriever produces (cosine distance for pure semantic, fused score for
   * hybrid). Lower = better, same convention as VectorIndex.
   *
   * `allowed`, when given, is a memento-id set restricting retrieval to chunks of those
   * mementos — the dense leg goes through `index.filteredSearch` (which resolves memento
   * ids to its internal chunk ids; all distance work stays in C++); the sparse leg, if any,
   * skips chunks whose memento id is not in `allowed`. Returned results' memento ids are
   * guaranteed to be in `allowed`. Used by the Vault for tag / date-range / chronicle /
   * multi-predicate filtered recall — the Vault computes the allowed set from `metaById`
   * and passes it through here, so retrievers don't carry their own copy of tag/date metadata.
   */
  retrieve(query: string, queryVector: Float32Array, k: number, allowed?: ReadonlySet<string>): SearchResult[]
}

/** Registry factory shape. */
export type RetrieverFactory = (index: VectorIndex) => Retriever
