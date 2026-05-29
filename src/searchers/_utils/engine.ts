/**
 * Shared match engine for the lexical searchers (`scan`, `trigram`).
 *
 * Two pieces, both used by every non-`none` searcher:
 *   - `compileMatcher` — turns a query into a "find all match ranges in this string"
 *     function. Literal mode is a plain `indexOf` scan (immune to ReDoS by construction).
 *     Regex mode compiles with Google RE2 — linear-time matching, so catastrophic
 *     backtracking is impossible. RE2 is REQUIRED for regex search: if the optional `re2`
 *     package is not installed, a regex query throws rather than silently falling back to
 *     the native `RegExp` engine, which would reintroduce the ReDoS hang RE2 exists to
 *     prevent. Literal search needs no engine and works regardless.
 *   - `runTextSearch` — walks a sequence of `[mementoId, text, lower]` triples, applies
 *     the matcher, and extracts capped snippets. `scan` feeds it its whole text map;
 *     `trigram` feeds it only the candidate mementos its index narrowed to. Searchers
 *     pre-compute `lower` (ASCII-lowercased `text`) at add time so the literal matcher
 *     doesn't re-lowercase every memento on every case-insensitive query — that was
 *     measurable on a `scan` over a large vault.
 */
import { requireFromPlugins } from '../../core/plugins.js'
import type { SearchOptions, SearchOutcome, SearchSnippet } from '../interface.js'

/** A compiled regex exposing the `RegExp` subset we use — satisfied by both RE2 and RegExp. */
interface ExecRegex {
  exec(s: string): { index: number; 0: string } | null
  lastIndex: number
}

export interface Matcher {
  /**
   * Every match in `haystack` as half-open `[start, end)` index pairs, in order. For the
   * literal matcher, `haystack` must already be ASCII-lowercased when the matcher was
   * built with `ignoreCase: true` — the searcher caches the lowered form. asciiLower is
   * length-preserving, so the returned ranges are equally valid into the un-lowered text
   * the caller slices for snippets. For the regex matcher, `haystack` is the raw text
   * (RE2's `i` flag handles case internally).
   */
  matchRanges(haystack: string): Array<[number, number]>
}

/** Hard ceiling on matches collected from a single memento — a runaway-pattern guard. */
const MAX_RANGES_PER_TEXT = 100_000

/**
 * Lowercase ASCII A–Z only. Unlike `String.prototype.toLowerCase`, this is guaranteed
 * length-preserving — some Unicode characters (Turkish `İ`, certain ligatures) lowercase
 * to a *different number* of code units, which would shift match offsets relative to the
 * original text and corrupt the extracted snippet. Case-insensitive literal/trigram search
 * is therefore ASCII-only by design; regex mode (which matches the original directly via
 * the `i` flag) is unaffected.
 */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, c => c.toLowerCase())
}

/** Load Google RE2 from the plugins dir; returns null if it isn't installed — `compileMatcher`
 *  then throws for a regex query (there is no native-engine fallback). */
function loadRE2(): (new (src: string, flags: string) => ExecRegex) | null {
  try {
    return requireFromPlugins('re2') as new (src: string, flags: string) => ExecRegex
  } catch {
    return null
  }
}

/** Literal substring matcher — `indexOf` scan, no regex engine, ReDoS-immune. */
class LiteralMatcher implements Matcher {
  private readonly needle: string
  constructor(query: string, ignoreCase: boolean) {
    this.needle = ignoreCase ? asciiLower(query) : query
  }
  matchRanges(haystack: string): Array<[number, number]> {
    const out: Array<[number, number]> = []
    const len = this.needle.length
    if (len === 0) return out
    let from = 0
    for (;;) {
      const idx = haystack.indexOf(this.needle, from)
      if (idx === -1) break
      out.push([idx, idx + len])
      from = idx + len
      if (out.length >= MAX_RANGES_PER_TEXT) break
    }
    return out
  }
}

/**
 * Regex matcher over a compiled `ExecRegex`, global flag assumed. The range-extraction
 * loop here is engine-agnostic — `compileMatcher` always feeds it RE2, but it is exported
 * so the loop can be unit-tested directly against a native `RegExp` (which structurally
 * satisfies `ExecRegex`), without needing the optional `re2` package installed.
 */
export class RegexMatcher implements Matcher {
  constructor(private readonly re: ExecRegex) {}
  matchRanges(text: string): Array<[number, number]> {
    this.re.lastIndex = 0
    const out: Array<[number, number]> = []
    let m: { index: number; 0: string } | null
    while ((m = this.re.exec(text)) !== null) {
      const matched = m[0]
      out.push([m.index, m.index + matched.length])
      // Zero-width match (e.g. `a*`) → bump lastIndex so the loop terminates.
      if (matched.length === 0) this.re.lastIndex++
      if (out.length >= MAX_RANGES_PER_TEXT) break
    }
    return out
  }
}

/**
 * Compile a query into a Matcher. `regex=false` → literal substring (ReDoS-immune).
 * `regex=true` → Google RE2; throws if RE2 is unavailable, or if the pattern is invalid.
 * Both throws carry a user-facing message that `Vault.search` returns verbatim.
 */
export function compileMatcher(query: string, regex: boolean, ignoreCase: boolean): Matcher {
  if (!regex) return new LiteralMatcher(query, ignoreCase)
  const RE2 = loadRE2()
  if (!RE2) {
    throw new Error(
      "Regex search requires the RE2 engine, which isn't installed. Run 'mementos init --reinit' to install it, or use a literal (non-regex) search.",
    )
  }
  let re: ExecRegex
  try {
    re = new RE2(query, ignoreCase ? 'gi' : 'g')
  } catch (e) {
    throw new Error(`Invalid regular expression: ${(e as Error).message}`)
  }
  return new RegexMatcher(re)
}

/**
 * Run a compiled search over a sequence of `[mementoId, text, lower]` entries — the
 * shared core of every lexical searcher. `lower` is the ASCII-lowercased form of `text`
 * (searchers cache it once at `add` time so the literal matcher doesn't recompute it on
 * every query). `text` is what snippets are sliced from; `lower` is what the literal
 * matcher walks when `ignoreCase` is on. Counts matches across every memento, capped
 * per-memento at `MAX_RANGES_PER_TEXT` (a runaway-pattern guard — a degenerate single
 * memento matching `\s` 100k+ times contributes at most that cap to `totalMatches`).
 * Collects snippets capped per-memento and overall. Callers pass `entries`
 * most-recent-first, so the global cap keeps the most recent matches rather than whatever
 * was scanned first.
 */
export function runTextSearch(
  entries: Iterable<[string, string, string]>,
  query: string,
  opts: SearchOptions,
): SearchOutcome {
  const matcher = compileMatcher(query, opts.regex, opts.ignoreCase)
  // Literal case-insensitive scans use the pre-lowered haystack; regex mode runs the
  // engine directly on the original text (RE2 with the `i` flag handles case itself).
  const useLowered = !opts.regex && opts.ignoreCase
  let totalMatches = 0
  let totalMementos = 0
  const snippets: SearchSnippet[] = []

  for (const [id, text, lower] of entries) {
    const ranges = matcher.matchRanges(useLowered ? lower : text)
    if (ranges.length === 0) continue
    totalMatches += ranges.length
    totalMementos++

    let perMemento = 0
    for (const [start, end] of ranges) {
      if (perMemento >= opts.maxPerMemento || snippets.length >= opts.maxSnippets) break
      snippets.push({
        mementoId: id,
        before: text.slice(Math.max(0, start - opts.contextChars), start),
        match: text.slice(start, end),
        after: text.slice(end, end + opts.contextChars),
      })
      perMemento++
    }
  }

  return { totalMatches, totalMementos, snippets }
}
