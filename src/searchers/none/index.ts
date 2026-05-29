/**
 * NoneSearcher — search disabled.
 *
 * Selected via `mementos init --searcher=none` for RAM-constrained setups. Holds no
 * resident state: `add` / `remove` are no-ops — the `decryptText` thunk is never called,
 * so no memento text is decrypted into RAM on its account — and `search` returns nothing.
 * When this searcher is active the CLI and MCP layers omit the `search` command/tool
 * entirely, so this implementation's `search` is never actually reached in normal use.
 */
import type { Searcher, SearchOutcome } from '../interface.js'
import type { SearcherImplementationModule } from '../registry.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'none'
export function create(): Searcher {
  return new NoneSearcher()
}
const _shape: SearcherImplementationModule = { type, create }

export class NoneSearcher implements Searcher {
  add(): void {}
  remove(): void {}
  search(): SearchOutcome {
    return { totalMatches: 0, totalMementos: 0, snippets: [] }
  }
}
