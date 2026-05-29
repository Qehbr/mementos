# `VectorIndex` — how ANN search is performed

The in-memory ANN data structure. `init()` once at startup, populate with `add()`, query with `search()` / `filteredSearch()`, mutate with `remove()`. Persisted across restarts via `serialize()` / `load()` for the encrypted cache (the index always lives in RAM otherwise).

```typescript
interface VectorIndex {
  readonly size: number
  readonly dimensions: number
  init(): Promise<void>
  add(id: string, vector: Float32Array): void
  search(vector: Float32Array, k: number): SearchResult[]
  filteredSearch(vector: Float32Array, k: number, allowedMementoIds: ReadonlySet<string>): SearchResult[]
  remove(id: string): void
  serialize(): Promise<Buffer>
  load(data: Buffer): Promise<void>
}
```

Adding a new index is one folder under `src/vector/<name>/` — see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Implementations

| | Description |
|---|---|
| **`HNSWIndex`** | Hierarchical Navigable Small World, native C++ via `hnswlib-node`. O(log n), cosine, slot reuse via `allowReplaceDeleted=true`. The default — and currently the only — `VectorIndex` impl. The abstraction is preserved for a future second impl (e.g. `faiss-node` if its `IDSelector` ever lands in the Node binding) under the same `type` + `create` contract with no core edits. |

## HNSW: fast search at any scale

Comparing a query against every stored vector is O(n). HNSW navigates a multilayer graph, pruning most of the search space at each step — **O(log n) query time**, sub-millisecond regardless of vault size. Measured on an i9-14900K:

| Vault size | HNSW search (k=5, p50) |
|---:|---|
| 1,000 | 0.047 ms |
| 10,000 | 0.076 ms |
| 50,000 | 0.189 ms |

## Chunks and the index key space

A memento longer than ~1600 characters is split, sentence-aware, into several `chunks`. Each chunk gets its own embedding — so a query about something mentioned only in the middle of a long memory finds *that* chunk directly.

Every chunk is one entry in the vector index, keyed `"<memento_id>#<chunkIndex>"`. The index therefore returns *chunk* hits; `Vault.recall` collapses them back to mementos — a memento that matched on two chunks is returned once, ranked by its best hit. The chunk-key convention lives in [src/core/vault/chunk-key.ts](../core/vault/chunk-key.ts) and the lower layers (HNSW, HybridRetriever) consult `mementoIdOf` to map chunk-keys back to mementos for filter checks.

## Filtered search (`filteredSearch`)

`Vault.recall` with a tag / chronicle / date filter resolves the filter to a memento-id set using `MetaStore`'s inverted indexes (O(matches) instead of O(corpus)), then passes the set to `HNSWIndex.filteredSearch`. The implementation:

1. Maintains its own `mementoId → numeric-chunk-id-list` map (rebuilt from the id mapping on `load`).
2. Unions the allowed memento's numeric ids into one Set.
3. Calls hnswlib's native `searchKnn(q, k, filter)` with a JS predicate that checks set membership.

**Every distance comparison stays in C++** — the predicate is checked per-visited-node, no vectors round-trip into JS, no post-filter walk in the Vault.

`ef` is sized adaptively from filter selectivity: roughly `k / pass_rate` candidates visited to gather `k` passing, with a `FILTERED_EF_SAFETY` (1.5×) multiplier to absorb graph-clustering non-uniformity, capped by `FILTERED_MAX_EF` to bound worst-case latency. At extreme selectivity (<0.5% of corpus) the cap is hit and queries may under-recall — HNSW graph-holes mean matching nodes in regions the traversal doesn't visit. Documented as the accepted single-index trade.

## Lifecycle and the encrypted cache

The index lives entirely in RAM. At startup the Vault tries to `load` from `~/.config/mementos/cache/index.hnsw.enc` — an encrypted snapshot of the index, AAD-bound to its sorted id-set so replaying an older valid cache fails GCM authentication. On a miss (cache absent, stale, or unauthenticated), the Vault calls `init()` and re-`add`s every chunk.

The cache lives **outside** the vault directory so cloud-synced vault folders don't propagate per-machine state — see [src/core/vault/README.md](../core/vault/README.md) for the cache format and AAD scheme.

## Caveat: HNSW serialization uses tmp

`hnswlib-node` only supports file-based index I/O. `serialize()` writes the binary index (which contains plaintext vectors) to `os.tmpdir()`, reads it back, encrypts the bytes, then unlinks in `finally`. The window is milliseconds; a crash in it could leave plaintext vectors in `/tmp` until reboot. The `.mem` files and the cache itself are always encrypted on stable storage — this is the one transient exception.
