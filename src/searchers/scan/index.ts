/**
 * ScanSearcher — full in-RAM linear scan over joined chunk text. Default searcher.
 * Resident cost is the decrypted text the Vault already holds; ~tens of ms per query at
 * personal-vault scale. Regex queries use RE2 (linear-time, ReDoS-proof) when installed.
 */
import type { Searcher, SearchOptions, SearchOutcome } from '../interface.js'
import type { SearcherImplementationModule } from '../registry.js'
import { ensurePluginSetup } from '../../core/plugins.js'
import { runTextSearch } from '../_utils/engine.js'
import { TextStore } from '../_utils/text-store.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'scan'
export function create(): Searcher {
  return new ScanSearcher()
}
// RE2 hardens regex-mode search against ReDoS — required, no fallback.
export const setupAtInit = ensurePluginSetup('re2')
const _shape: SearcherImplementationModule = { type, create, setupAtInit }

export class ScanSearcher implements Searcher {
  private store = new TextStore()

  add(id: string, decryptText: () => string): void {
    this.store.add(id, decryptText())
  }

  remove(id: string): void {
    this.store.remove(id)
  }

  search(query: string, opts: SearchOptions): SearchOutcome {
    const ids = opts.orderedIds ?? this.store.keys()
    return runTextSearch(this.store.orderedEntries(ids), query, opts)
  }
}
