/**
 * HNSW algorithm parameters.
 *
 * Implementation-specific tuning constants for the hnswlib-node backend. Not exposed in
 * the vault-portable config (`VaultConfig`) — different VectorIndex implementations have
 * different parameters, so they each carry their own constants here.
 *
 * Defaults follow Malkov & Yashunin's HNSW paper recommendations.
 */

/**
 * Maximum bidirectional connections each node has at each layer.
 * Higher = better recall, more memory. 16 is the canonical default for general use.
 */
export const HNSW_M = 16

/**
 * Number of candidate neighbours considered when building each new node's connections.
 * Higher = better-quality index, slower to build. 200 is "good quality" without being slow.
 */
export const HNSW_EF_CONSTRUCTION = 200

/**
 * Fixed random seed for layer assignment during insertion. Makes index construction
 * deterministic for the same insertion order — useful for reproducible builds.
 */
export const HNSW_RANDOM_SEED = 100

/**
 * Cap on cumulative additions (NOT live entries — `markDelete` doesn't decrement the
 * underlying counter, even with `allowReplaceDeleted=true`).
 *
 * 100k is far beyond realistic personal-vault size. Long-running vaults with extreme churn
 * (millions of cumulative adds + deletes over years) eventually need a manual rebuild. See
 * DESIGN.md for the trade-off.
 */
export const MAX_ELEMENTS = 100_000

/**
 * Distance metric. `'cosine'` matches the L2-normalized output of LocalEmbedder and the
 * normalized vectors returned by OpenAI's embedding models — cosine distance is the
 * natural similarity metric for both.
 */
export const DISTANCE_METRIC = 'cosine'

// ─── Filtered-search tunables ────────────────────────────────────────────────

/**
 * Default `ef_search` for unfiltered queries. hnswlib's library default is 10; we raise
 * to 50 because chunk-keyed indexes need a slightly larger candidate pool to collapse
 * cleanly to k distinct mementos in `recall`. `filteredSearch` temporarily raises `ef`
 * for the filtered query, then restores this default in `finally`.
 */
export const DEFAULT_EF_SEARCH = 50

/**
 * Safety multiplier on `k / selectivity` when sizing `ef` for native filtered ANN. The
 * naive formula `ef = k / pass_rate` gives the bare minimum to return k passing
 * candidates IF the graph traversal visits a uniform sample. Real graph neighbourhoods
 * cluster, so passing nodes are non-uniform; the multiplier absorbs that variance.
 */
export const FILTERED_EF_SAFETY = 1.5

/**
 * Cap on `ef` for filtered ANN, even when selectivity-derived `ef` would push higher —
 * bounds worst-case query latency. At extremely selective filters this cap is hit; the
 * accepted trade-off is that very-rare-tag queries (<0.5% of corpus) may under-recall
 * due to HNSW graph-holes (matching nodes in regions the traversal doesn't visit).
 * Documented in DESIGN.md retrieval section.
 */
export const FILTERED_MAX_EF = 5000
