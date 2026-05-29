import { asciiLower } from './engine.js'

/**
 * Resident decrypted-text store shared by the searchers: `id → { text, lower }`. The
 * ASCII-lowered form is computed once at `add` so case-insensitive search never re-lowers
 * per query (asciiLower is length-preserving, so ranges into `lower` are valid into `text`).
 */
export class TextStore {
  private byId = new Map<string, { text: string; lower: string }>()

  /** Returns the lowered form so callers needing it (e.g. TrigramSearcher) don't re-lower. */
  add(id: string, text: string): string {
    const lower = asciiLower(text)
    this.byId.set(id, { text, lower })
    return lower
  }

  remove(id: string): void {
    this.byId.delete(id)
  }

  keys(): string[] {
    return [...this.byId.keys()]
  }

  /** `[id, text, lower]` triples for `ids`, in order; skips non-resident ids and any not in `only`. */
  *orderedEntries(ids: readonly string[], only?: Set<string>): Iterable<[string, string, string]> {
    for (const id of ids) {
      if (only && !only.has(id)) continue
      const e = this.byId.get(id)
      if (e !== undefined) yield [id, e.text, e.lower]
    }
  }
}
