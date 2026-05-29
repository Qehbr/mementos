/**
 * SemanticRetriever — pure ANN retrieval over the VectorIndex. Default retriever.
 * `add`/`remove` are no-ops because the Vault writes the VectorIndex directly for its
 * write-time dedup; mirroring would double-add.
 */
import type { Retriever } from '../interface.js'
import type { VectorIndex, SearchResult } from '../../vector/interface.js'
import type { RetrieverImplementationModule } from '../registry.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'semantic'
export function create(index: VectorIndex): Retriever {
  return new SemanticRetriever(index)
}
const _shape: RetrieverImplementationModule = { type, create }

export class SemanticRetriever implements Retriever {
  constructor(private readonly index: VectorIndex) {}

  add(_id: string, _decryptText: () => string): void {}
  remove(_id: string): void {}

  retrieve(_query: string, queryVector: Float32Array, k: number, allowed?: ReadonlySet<string>): SearchResult[] {
    return allowed === undefined
      ? this.index.search(queryVector, k)
      : this.index.filteredSearch(queryVector, k, allowed)
  }
}
