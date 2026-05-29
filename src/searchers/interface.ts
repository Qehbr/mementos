/**
 * Searcher — abstracts exhaustive lexical lookup over the vault's memento text.
 *
 * Distinct from `Retriever`. A retriever answers "what is *relevant* to this query?" —
 * ranked, fuzzy, semantic; it backs `recall`. A searcher answers "*where* does this exact
 * string / pattern appear?" — exhaustive, exact, position-returning; it backs the `search`
 * tool. They are two different operations, not two settings of one: a searcher returns
 * match positions and surrounding snippets, never a relevance ranking, and it is chosen
 * independently of the retriever.
 *
 * The Vault drives a searcher exactly like a retriever — `add` once per memento at startup
 * and on every write/sync, `remove` on delete (and as the first half of an update). The
 * `decryptText` argument is a lazy thunk so `NoneSearcher` (search disabled) never pays the
 * AES-GCM decrypt cost.
 *
 * Concrete implementations:
 *   - `NoneSearcher`    — search disabled. No resident state; `search` returns nothing.
 *   - `ScanSearcher`    — full in-RAM linear scan. Low RAM, O(corpus) per query. Default.
 *   - `TrigramSearcher` — trigram-index candidate filter + verify. Faster, more RAM.
 */

/** One match: the matched text plus a window of context on each side, within one memento. */
export interface SearchSnippet {
  /** Memento the match was found in. */
  mementoId: string
  /** Up to `contextChars` characters immediately before the match. */
  before: string
  /** The exact matched substring. */
  match: string
  /** Up to `contextChars` characters immediately after the match. */
  after: string
}

/**
 * Result of one search. `snippets` is capped; counts are exhaustive across mementos but
 * capped per-memento at `MAX_RANGES_PER_TEXT` (a runaway-pattern guard for a single huge
 * memento). In practice only a degenerate case is affected — `\s` or a similar pattern
 * matching > 100k times inside one memento.
 */
export interface SearchOutcome {
  /**
   * Total matches across the whole (filtered) corpus — may exceed `snippets.length`. A
   * single memento contributes at most `MAX_RANGES_PER_TEXT` to this count (so the total is
   * a lower bound when any memento hits that per-memento cap).
   */
  totalMatches: number
  /** Number of distinct mementos that contained at least one match. */
  totalMementos: number
  /** Extracted snippets, capped at `maxSnippets` overall and `maxPerMemento` per memento. */
  snippets: SearchSnippet[]
}

/** Per-search knobs. Final `k` truncation is the Vault's job — see `vault.search`. */
export interface SearchOptions {
  /** Characters of context to include on each side of a match. */
  contextChars: number
  /** Treat `query` as a regular expression (RE2 when available) vs. a literal substring. */
  regex: boolean
  /** Case-insensitive matching. */
  ignoreCase: boolean
  /** Stop collecting snippets from one memento after this many (matches are still counted). */
  maxPerMemento: number
  /** Global cap on collected snippets (matches past it are still counted). */
  maxSnippets: number
  /**
   * The memento ids to search, in result-priority (most-recently-updated first) order.
   * The Vault has already applied any tag / chronicle filter and the recency sort, so the
   * searcher iterates exactly these, in this order — the snippet cap then keeps the most
   * recent matches instead of whatever happened to be scanned first. If omitted, the
   * searcher walks its full resident set in insertion order (tests only — the Vault always
   * supplies it).
   */
  orderedIds?: readonly string[]
}

export interface Searcher {
  /** Register a memento's full text. `decryptText` is lazy — `none` never calls it. */
  add(id: string, decryptText: () => string): void
  /** Drop a memento (delete, or the first half of an update). */
  remove(id: string): void
  /** Find matches for `query`. Synchronous — operates on resident state only. */
  search(query: string, opts: SearchOptions): SearchOutcome
}

/** Registry factory shape. */
export type SearcherFactory = () => Searcher
