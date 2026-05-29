# `Searcher` — exact lexical search

A separate abstraction from `Retriever`, for a different question. A retriever ranks by *meaning* (backs the `recall` MCP tool); a searcher finds *exact* literal or regex matches with positions (backs the `search` tool). They are two different operations, not two settings of one: a searcher returns match positions and surrounding snippets, never a relevance ranking.

```typescript
interface Searcher {
  add(id: string, decryptText: () => string): void
  remove(id: string): void
  search(query: string, opts: SearchOptions): SearchOutcome
}
```

Selected at init via `--searcher=`, independent of `--retriever=`. `decryptText` is lazy — `NoneSearcher` (search disabled) never pays the AES-GCM decrypt cost.

Adding a new searcher is one folder under `src/searchers/<name>/` — see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Implementations

| | Description |
|---|---|
| **`ScanSearcher`** | Full in-RAM linear scan of memento text. ~15 MB resident per 10k mementos, single-digit-ms queries. **Default.** |
| **`TrigramSearcher`** | Adds an inverted trigram index — narrows a selective query to its candidate mementos before scanning (~180× faster on a rare term, see [BENCHMARKS.md](../../BENCHMARKS.md)), at ~4–5× the RAM. Opt-in for large or search-heavy vaults. |
| **`NoneSearcher`** | Search disabled — no resident state, `add`/`remove` no-op, the `search` MCP tool isn't exposed. For RAM-constrained setups. |

The trigram acceleration applies only to literal queries with ≥3 characters (one full n-gram); regex and 1–2 char literals fall back to scan. The trigram index is a *correctness-preserving* filter or it is nothing — filtering a regex wrong would silently drop real matches.

## The shared match engine

Both `scan` and `trigram` use the same `compileMatcher` + `runTextSearch` from [_utils/engine.ts](_utils/engine.ts):

- **Literal mode** — plain `indexOf` scan, immune to ReDoS by construction.
- **Regex mode** — Google **RE2** (linear-time matching, no catastrophic backtracking). RE2 is **REQUIRED** for regex search: if the optional `re2` package isn't installed, a regex query throws rather than silently falling back to the native `RegExp` engine, which would reintroduce the ReDoS hang RE2 exists to prevent.

Case-insensitive literal matching walks the ASCII-lowercased haystack (cached at `add` time so the matcher doesn't re-lowercase per query); the returned ranges slice into the original text for snippets. `asciiLower` is length-preserving — unlike `String.prototype.toLowerCase`, which would shift offsets for some Unicode chars (e.g. Turkish `İ`).

## Recency-aware result cap

Snippets are capped per-memento (`SEARCH_MAX_PER_MEMENTO = 3`) and globally (`SEARCH_MAX_SNIPPETS = 200`). The Vault hands `orderedIds` to the searcher most-recently-updated first, so the global cap keeps the most recent matches rather than whatever happened to be scanned first.

`totalMatches` and `totalMementos` are exhaustive across the (filtered) corpus, capped per-memento at `MAX_RANGES_PER_TEXT = 100,000` — a runaway-pattern guard for a degenerate single memento matching `\s` 100k+ times.
