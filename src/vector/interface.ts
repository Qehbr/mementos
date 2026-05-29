/**
 * VectorIndex — abstracts the in-memory ANN data structure.
 *
 * The Vault calls `init()` once at startup, populates with `add()`, queries with `search()`,
 * mutates with `remove()`, and persists across restarts via `serialize()` / `load()`. The
 * index always lives in RAM; `serialize`/`load` exist only so the encrypted cache file can
 * skip rebuilding from .mem files on hot restarts.
 *
 * Concrete implementation: HNSWIndex (hnswlib-node, native C++ HNSW).
 */

/** One result from `search()`. `distance` is whatever metric the index was built with. */
export interface SearchResult {
  id: string
  distance: number
}

export interface VectorIndex {
  /** Number of currently-live entries. Excludes tombstoned (deleted-but-slot-retained) ids. */
  readonly size: number

  /** Vector dimensionality the index was built for. Vectors of any other length are invalid. */
  readonly dimensions: number

  /** Initialize an empty index. Must be called before any other method. */
  init(): Promise<void>

  /** Insert a vector under the given string id. The id namespace is the caller's responsibility. */
  add(id: string, vector: Float32Array): void

  /** Find the k nearest neighbours to `vector`, sorted by distance ascending. */
  search(vector: Float32Array, k: number): SearchResult[]

  /**
   * Top-k restricted to chunks belonging to mementos in `allowedMementoIds`, using the
   * index's native filtered-search path so every distance computation stays in C++ (the
   * predicate is checked per-visited-node; no vectors round-trip into JS). Returns at most
   * `min(k, allowed-chunk-count)`, ordered by distance ascending — same shape as `search`.
   *
   * The index expects chunk keys of the form `"<mementoId>#<i>"`: implementations maintain
   * `mementoId → numeric-ids` internally so the caller passes only memento ids (the index
   * resolves them to chunk-numeric-ids in one pass). Used by the Vault for tag /
   * date-range / chronicle / multi-predicate filtered recall.
   */
  filteredSearch(vector: Float32Array, k: number, allowedMementoIds: ReadonlySet<string>): SearchResult[]

  /** Remove an id. Implementations may use tombstones internally — that's an implementation detail. */
  remove(id: string): void

  /** Serialize the entire index (including any internal id maps) to a buffer for caching. */
  serialize(): Promise<Buffer>

  /**
   * Restore from a previously-serialized buffer. Must produce an index that behaves
   * identically (same `add`/`search`/`remove` results) to the one that was serialized.
   * `load` is responsible for fully constructing internal state — `init()` is NOT called
   * beforehand on the cache-restore path.
   */
  load(data: Buffer): Promise<void>
}
