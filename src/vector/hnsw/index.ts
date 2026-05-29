/**
 * HNSWIndex — VectorIndex backed by hnswlib-node (Hierarchical Navigable Small World).
 *
 * O(log n) approximate nearest-neighbour search, native C++ via N-API. Configured for cosine
 * distance to match LocalEmbedder's L2-normalized output.
 *
 * Internal id mapping: hnswlib uses 32-bit integer ids; mementos uses string UUIDs. This
 * class keeps two Maps for the bidirectional translation. The numeric counter is monotonic
 * — `markDelete` frees the slot for reuse via `allowReplaceDeleted=true` but the label is
 * never re-issued. After enough cumulative adds (independent of how many are still live),
 * addPoint will fail; the cap is the `MAX_ELEMENTS` constant. See DESIGN.md for the
 * long-term-churn trade-off.
 *
 * Serialization uses a /tmp file because hnswlib only supports file-based I/O. The tmp file
 * contains plaintext vectors and is cleaned up in `finally` so it doesn't leak on errors.
 */
import { writeFile, readFile } from 'node:fs/promises'
import type { VectorIndex, SearchResult } from '../interface.js'
import type { VectorIndexImplementationModule } from '../registry.js'
import { ensurePluginSetup, requireFromPlugins } from '../../core/plugins.js'
import { mementoIdOf } from '../../core/vault/chunk-key.js'
import { frameIndex, unframeIndex, withTempFile } from '../_utils/index-io.js'
import {
  HNSW_M, HNSW_EF_CONSTRUCTION, HNSW_RANDOM_SEED,
  MAX_ELEMENTS, DISTANCE_METRIC,
  DEFAULT_EF_SEARCH, FILTERED_EF_SAFETY, FILTERED_MAX_EF,
} from './constants.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'hnsw'
export function create(dimensions: number): VectorIndex {
  return new HNSWIndex(dimensions)
}
export const setupAtInit = ensurePluginSetup('hnswlib-node')
const _shape: VectorIndexImplementationModule = { type, create, setupAtInit }

export class HNSWIndex implements VectorIndex {
  private index: HnswlibIndex | null = null
  private numToStr = new Map<number, string>()
  private strToNum = new Map<string, number>()
  /**
   * Inverted index for filteredSearch: memento id → numeric chunk ids. Derived from the
   * `"<mementoId>#<i>"` chunk-key convention. Maintained on add/remove; rebuilt from
   * numToStr on load. ~64 B per memento (negligible at 100k), and lets filteredSearch
   * union numeric ids in one pass instead of materialising a parallel chunk-key set.
   */
  private mementoIdToNumIds = new Map<string, number[]>()
  /**
   * Mirrors the internal hnswlib `ef`. Updated only through `setEf` — so the invariant
   * "filteredSearch always restores DEFAULT_EF_SEARCH" is observable in tests via `currentEf`,
   * and a refactor that drops the `finally` block fails that test instead of silently
   * leaving unfiltered queries running at the elevated `ef`.
   */
  private currentEfValue = DEFAULT_EF_SEARCH
  private counter = 0
  /**
   * Scratch `number[]` reused across `add`/`search` calls. The hnswlib-node binding takes
   * `number[]` (not `Float32Array`) and copies the values into native memory on each call,
   * so reuse is safe (no aliasing) and avoids allocating ~N fresh dim-length arrays during
   * cold startup. JS is single-threaded and these methods are synchronous (no `await`),
   * so concurrent serial callers can't interleave on the scratch.
   */
  private scratch: number[] = []

  constructor(readonly dimensions: number) {}

  /** Copy a Float32Array into the reused scratch number[] for hnswlib-node. */
  private toScratch(v: Float32Array): number[] {
    if (this.scratch.length !== v.length) this.scratch = new Array<number>(v.length)
    for (let i = 0; i < v.length; i++) this.scratch[i] = v[i]
    return this.scratch
  }

  /** Live-entry count (excludes tombstoned slots). */
  get size(): number {
    return this.strToNum.size
  }

  async init(): Promise<void> {
    const { HierarchicalNSW } = requireFromPlugins('hnswlib-node') as HnswlibModule
    const idx = new HierarchicalNSW(DISTANCE_METRIC, this.dimensions) as unknown as HnswlibIndex
    // allowReplaceDeleted=true is critical — without it, deleted slots are unreusable and
    // long-running vaults with churn hit MAX_ELEMENTS early.
    idx.initIndex(MAX_ELEMENTS, HNSW_M, HNSW_EF_CONSTRUCTION, HNSW_RANDOM_SEED, true)
    this.index = idx
    // Set ef explicitly so unfiltered queries always run at a known value (hnswlib's
    // library default is 10, lower than we want for 384-d chunk-keyed retrieval).
    // `filteredSearch` raises ef temporarily for the filtered call and restores this.
    this.setEf(DEFAULT_EF_SEARCH)
  }

  /** Returns the underlying hnswlib index; throws if `init()` hasn't run yet. */
  private getIndex(): HnswlibIndex {
    if (!this.index) throw new Error('HNSWIndex not initialised — call init() first')
    return this.index
  }

  /** Single mutator for `ef`. Mirrors the call in `currentEfValue` so the invariant is observable. */
  private setEf(ef: number): void {
    this.currentEfValue = ef
    this.getIndex().setEf(ef)
  }

  /** Current hnswlib `ef`. Always `DEFAULT_EF_SEARCH` outside an active `filteredSearch` call. */
  get currentEf(): number { return this.currentEfValue }

  add(id: string, vector: Float32Array): void {
    const numId = this.counter++
    this.numToStr.set(numId, id)
    this.strToNum.set(id, numId)
    this.indexMemento(id, numId)
    // replaceDeleted=true on the addPoint call lets hnswlib reuse a slot freed by markDelete.
    this.getIndex().addPoint(this.toScratch(vector), numId, true)
  }

  /** Add `numId` to its memento's chunk-id list. */
  private indexMemento(key: string, numId: number): void {
    const memId = mementoIdOf(key)
    const arr = this.mementoIdToNumIds.get(memId)
    if (arr) arr.push(numId)
    else this.mementoIdToNumIds.set(memId, [numId])
  }

  /** Drop `numId` from its memento's chunk-id list; remove the memento entry when empty. */
  private unindexMemento(key: string, numId: number): void {
    const memId = mementoIdOf(key)
    const arr = this.mementoIdToNumIds.get(memId)
    if (!arr) return
    const at = arr.indexOf(numId)
    if (at !== -1) arr.splice(at, 1)
    if (arr.length === 0) this.mementoIdToNumIds.delete(memId)
  }

  search(vector: Float32Array, k: number): SearchResult[] {
    const actual = Math.min(k, this.size)
    if (actual === 0) return []
    const { neighbors, distances } = this.getIndex().searchKnn(this.toScratch(vector), actual)
    return this.mapResults(neighbors, distances)
  }

  /**
   * Translate hnswlib's numeric labels back into our string keys. A missing entry is a
   * structural invariant violation (the search returned a label we never added), so we
   * throw rather than silently using `!` — same cost as the assertion, plus a real error
   * if the invariant ever breaks.
   */
  private mapResults(neighbors: number[], distances: number[]): SearchResult[] {
    return neighbors.map((numId, i) => {
      const id = this.numToStr.get(numId)
      if (id === undefined) throw new Error(`HNSWIndex: label ${numId} returned by searchKnn is not in numToStr (state mismatch)`)
      return { id, distance: distances[i] }
    })
  }

  /**
   * Exact filtered top-k. All distance work stays in C++: hnswlib walks the graph and
   * for each visited node calls our JS predicate (set-membership, microseconds). PR #430
   * (in hnswlib 0.7.0+, our pinned 3.0.0 includes it) means traversal keeps expanding
   * until `ef` passing candidates are gathered — no under-k early termination.
   *
   * `ef` is sized adaptively from selectivity: a filter passing fraction `p` needs roughly
   * `k / p` candidates visited to gather k passing. `FILTERED_EF_SAFETY` (1.5×) absorbs
   * graph-clustering non-uniformity. `FILTERED_MAX_EF` caps worst-case latency; selective
   * queries that hit the cap may under-recall (HNSW graph-holes — matching nodes in
   * regions the traversal doesn't reach). Documented as the accepted trade-off in DESIGN.
   *
   * `ef` is restored to `DEFAULT_EF_SEARCH` in `finally` so concurrent unfiltered queries
   * aren't left running at the elevated value.
   *
   * Selectivity is approximated from memento count, not exact chunk count — a 1.5× safety
   * margin already absorbs the typical ~1.x chunks-per-memento ratio.
   */
  filteredSearch(vector: Float32Array, k: number, allowedMementoIds: ReadonlySet<string>): SearchResult[] {
    if (allowedMementoIds.size === 0 || this.size === 0) return []

    // Union each allowed memento's chunk numeric-ids into a single set. Mementos we don't
    // know about (sync races, etc.) contribute nothing — the .get is just undefined.
    const allowedNumIds = new Set<number>()
    for (const memId of allowedMementoIds) {
      const numIds = this.mementoIdToNumIds.get(memId)
      if (numIds) for (const n of numIds) allowedNumIds.add(n)
    }
    if (allowedNumIds.size === 0) return []

    const selectivity = allowedNumIds.size / this.size
    const ef = Math.min(
      FILTERED_MAX_EF,
      Math.max(DEFAULT_EF_SEARCH, Math.ceil(k / selectivity * FILTERED_EF_SAFETY)),
    )
    const actual = Math.min(k, allowedNumIds.size)

    this.setEf(ef)
    try {
      const { neighbors, distances } = this.getIndex().searchKnn(
        this.toScratch(vector),
        actual,
        (label: number) => allowedNumIds.has(label),
      )
      return this.mapResults(neighbors, distances)
    } finally {
      this.setEf(DEFAULT_EF_SEARCH)
    }
  }

  /** Tombstone the entry (slot retained for reuse). Idempotent for unknown ids. */
  remove(id: string): void {
    const numId = this.strToNum.get(id)
    if (numId === undefined) return
    this.getIndex().markDelete(numId)
    this.strToNum.delete(id)
    this.numToStr.delete(numId)
    this.unindexMemento(id, numId)
  }

  async serialize(): Promise<Buffer> {
    // hnswlib only does file I/O; the tmp file holds plaintext vectors, cleaned up on exit.
    return withTempFile('hnsw', async tmp => {
      await this.getIndex().writeIndex(tmp)
      const indexBytes = await readFile(tmp)
      const meta = Buffer.from(JSON.stringify({
        counter: this.counter,
        numToStr: Array.from(this.numToStr.entries()),
      }))
      return frameIndex(meta, indexBytes)
    })
  }

  async load(data: Buffer): Promise<void> {
    const { meta: metaBuf, index: indexBytes } = unframeIndex(data)
    const meta = JSON.parse(metaBuf.toString()) as {
      counter: number
      numToStr: [number, string][]
    }
    this.counter = meta.counter
    this.numToStr = new Map(meta.numToStr)
    this.strToNum = new Map(meta.numToStr.map(([n, s]) => [s, n]))
    this.mementoIdToNumIds = new Map()
    for (const [numId, key] of meta.numToStr) this.indexMemento(key, numId)

    await withTempFile('hnsw', async tmp => {
      await writeFile(tmp, indexBytes)
      const { HierarchicalNSW } = requireFromPlugins('hnswlib-node') as HnswlibModule
      const idx = new HierarchicalNSW(DISTANCE_METRIC, this.dimensions) as unknown as HnswlibIndex
      // The second arg to readIndex is allowReplaceDeleted — must match init() so slot reuse
      // continues to work after restoring from cache.
      await idx.readIndex(tmp, true)
      this.index = idx
      // Restore the known ef explicitly — readIndex may reset to hnswlib's lower library
      // default, and unfiltered queries should run at the same ef as a fresh-init index.
      this.setEf(DEFAULT_EF_SEARCH)
    })
  }
}

// Local typing for hnswlib-node v3 — the package's published types are loose.
interface HnswlibIndex {
  initIndex(maxElements: number, m?: number, efConstruction?: number, randomSeed?: number, allowReplaceDeleted?: boolean): void
  addPoint(vector: number[], id: number, replaceDeleted?: boolean): void
  searchKnn(vector: number[], k: number, filter?: (label: number) => boolean): { neighbors: number[]; distances: number[] }
  setEf(ef: number): void
  markDelete(id: number): void
  writeIndex(path: string): Promise<boolean>
  readIndex(path: string, allowReplaceDeleted?: boolean): Promise<boolean>
}

interface HnswlibModule {
  HierarchicalNSW: new (space: string, dim: number) => HnswlibIndex
}
