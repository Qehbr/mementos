/** HybridRetriever tunables — BM25 scoring, RRF fusion, and the cold-query gate. */

/** BM25 term-frequency saturation. */
export const BM25_K1 = 1.2
/** BM25 length-normalisation strength. */
export const BM25_B = 0.75
/** Reciprocal Rank Fusion constant (k_rrf). 60 is Cormack et al.'s recommendation. */
export const RRF_K = 60
/**
 * Minimum candidate pool size per leg for RRF fusion quality. Used as a FLOOR, not a cap:
 * each leg fetches `Math.max(k, PER_RETRIEVER_TOPK)`, so small-k callers still get a pool
 * big enough for RRF's "moderate-in-both" items to surface, while large-k callers honor the
 * `retrieve(...k)` contract exactly. Industry-typical fusion pools are 50–200; 100 sits in
 * the middle.
 *
 * Why no per-k multiplier (e.g. `5*k`): the Vault already over-fetches by
 * `RECALL_OVERFETCH_MULT` (= 20) before calling `retrieve`, so for the production read path
 * the retriever sees a k that's already inflated 20×. A second multiplier here would
 * compound (default `recall(k=5)` → vault k'=100 → retriever 5×100=500/leg) for no RRF
 * benefit past ~200 pool. The floor of 100 is purely for callers that bypass the Vault
 * inflation (benchmarks, direct unit tests) — they pass small k and need a usable fusion
 * pool. **If `RECALL_OVERFETCH_MULT` / `RECALL_OVERFETCH_FLOOR` ever shrink, revisit this
 * floor — the small-k fusion budget assumes that inflation provides the production pool.**
 *
 * Changing this is a recall-quality change — re-run `bench:retrieval`.
 */
export const PER_RETRIEVER_TOPK = 100
/**
 * Cold-query gate: if the BEST dense match is at least this cosine distance AND BM25 found
 * nothing, the query is treated as unanswerable and `retrieve` returns []. Deliberately
 * high — a warm query's nearest match is far closer (typically < 0.5) — so warm-query
 * recall is never gated; only a query the vault genuinely has nothing for trips it.
 */
export const COLD_QUERY_THRESHOLD = 0.8
/** Token length floor — drop very short tokens (mostly noise). */
export const MIN_TOKEN_LEN = 2
