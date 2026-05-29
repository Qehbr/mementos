# `Retriever` — how a query maps to top-k results

Sits one layer above `VectorIndex`. The vector index is just an ANN data structure (`Float32Array → top-k by cosine`); a retriever is the **strategy** applied to that index and any companion structures (BM25 inverted index, reranker, etc.). Different retrievers answer the same question with different trade-offs.

```typescript
interface Retriever {
  add(id: string, decryptText: () => string): void
  remove(id: string): void
  retrieve(query: string, queryVector: Float32Array, k: number, allowed?: ReadonlySet<string>): SearchResult[]
}
```

Selected at init via `--retriever=`. `decryptText` is a lazy thunk so retrievers that don't need the plaintext (semantic) never pay the AES-GCM decrypt cost. `allowed` is the filtered-recall hand-off: the dense leg goes through `index.filteredSearch`, the sparse leg restricts via its own predicate, results are guaranteed to be in the set.

Adding a new retriever is one folder under `src/retrievers/<name>/` — see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Implementations

| | Description |
|---|---|
| **`SemanticRetriever`** | Pure cosine top-k. `add`/`remove` are no-ops — the Vault writes the `VectorIndex` directly for its write-time dedup; mirroring would double-add. **Default.** |
| **`HybridRetriever`** | BM25 inverted index over decrypted text + dense vector search, fused via **Reciprocal Rank Fusion**. Catches exact-keyword matches (proper nouns, identifiers, error strings) that cosine misses. Sparse index is RAM-only, built from decrypted text at startup (~one AES-GCM decrypt per memory on top of what the cache-hit path already does for tags). |

Both produce ranked chunk-key lists; `Vault.recall` collapses those to mementos.

## BM25 + RRF — the math

**BM25** (Robertson & Spärck Jones, 1976) scores a document `D` against a query `Q`:

```
score(D, Q) = Σ_t IDF(t) · tf(t, D) · (k1 + 1) / (tf(t, D) + k1 · (1 - b + b · |D|/avgdl))
IDF(t)     = ln((N - df(t) + 0.5) / (df(t) + 0.5) + 1)
```

Constants `k1 = 1.2`, `b = 0.75` (industry defaults). The inverted index is `term → (docId → tf)`; `df(t)` reads straight off `postings.get(t).size`, no separate document-frequency map.

**Reciprocal Rank Fusion** (Cormack et al., 2009) combines rankings from the two retrievers:

```
score(d) = Σ_r 1 / (k_rrf + rank_r(d))    with k_rrf = 60
```

Rank-based by design — ignores the raw score magnitude of each retriever, which is exactly what's wanted when cosine distance and BM25 score live on incomparable scales.

## Cold-query gate

A query about something the vault doesn't know would otherwise return the top-k *least bad* matches — pure noise in the AI's context. The hybrid retriever short-circuits with `[]` when the dense leg's BEST match is at least `COLD_QUERY_THRESHOLD = 0.8` cosine distance AND BM25 found nothing. A warm query's best match is far closer than 0.8, so this never gates real recall.

## Why split this from `VectorIndex`?

Because they're different concerns:
- `VectorIndex` owns the **data structure** (HNSW, FAISS, …). Its contract is "given a vector, return top-k nearest."
- `Retriever` owns the **strategy** (pure-semantic, hybrid, reranker, ensemble). It calls the vector index and may layer additional indexes / fusion on top.

Swapping retrievers without touching the index is one knob; swapping the index without touching the retriever is another.
