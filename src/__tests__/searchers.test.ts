/**
 * Searcher unit tests — `scan`, `trigram`, `none`.
 *
 * The load-bearing test is the trigram/scan parity sweep: the trigram index is only a
 * candidate *filter*, so `TrigramSearcher` must return exactly what `ScanSearcher` does
 * for every query. A filter that ever drops a real match is silent data loss.
 *
 * Regex search requires the RE2 engine (see `engine.ts`). To exercise the "RE2 missing"
 * guard deterministically regardless of whether `re2` is installed in the current env,
 * the plugins module is mocked here to throw for `re2`. The engine-agnostic
 * range-extraction loop is covered directly via `RegexMatcher`.
 */
import { vi, describe, it, expect } from 'vitest'

vi.mock('../core/plugins.js', () => ({
  requireFromPlugins: (name: string) => {
    if (name === 're2') throw new Error('mocked-missing-re2')
    throw new Error(`Unexpected requireFromPlugins call for: ${name}`)
  },
  ensurePackage: vi.fn().mockResolvedValue(undefined),
  ensurePluginSetup: () => async () => {},
  pluginsDir: () => '/tmp/mock-mementos-plugins',
}))

import { ScanSearcher } from '../searchers/scan/index.js'
import { TrigramSearcher } from '../searchers/trigram/index.js'
import { NoneSearcher } from '../searchers/none/index.js'
import { compileMatcher, RegexMatcher } from '../searchers/_utils/engine.js'
import type { Searcher, SearchOptions } from '../searchers/interface.js'

const OPTS: SearchOptions = {
  contextChars: 10,
  regex: false,
  ignoreCase: true,
  maxPerMemento: 5,
  maxSnippets: 100,
}

function load(s: Searcher, docs: Record<string, string>): void {
  for (const [id, text] of Object.entries(docs)) s.add(id, () => text)
}

describe('ScanSearcher', () => {
  it('finds literal substring matches and counts them', () => {
    const s = new ScanSearcher()
    load(s, { a: 'the quick brown fox', b: 'fox news today', c: 'no animals here' })
    const r = s.search('fox', OPTS)
    expect(r.totalMatches).toBe(2)
    expect(r.totalMementos).toBe(2)
    expect(r.snippets.map(x => x.match)).toEqual(['fox', 'fox'])
  })

  it('extracts before/after context around a match', () => {
    const s = new ScanSearcher()
    load(s, { a: 'aaaaaXYZbbbbb' })
    const r = s.search('XYZ', { ...OPTS, contextChars: 3 })
    expect(r.snippets[0]).toMatchObject({ mementoId: 'a', before: 'aaa', match: 'XYZ', after: 'bbb' })
  })

  it('is case-insensitive by default and case-sensitive when asked', () => {
    const s = new ScanSearcher()
    load(s, { a: 'Hello World' })
    expect(s.search('hello', OPTS).totalMatches).toBe(1)
    expect(s.search('hello', { ...OPTS, ignoreCase: false }).totalMatches).toBe(0)
  })

  it('counts every match but caps snippets per memento', () => {
    const s = new ScanSearcher()
    load(s, { a: 'x x x x x' })
    const r = s.search('x', { ...OPTS, maxPerMemento: 2 })
    expect(r.totalMatches).toBe(5)
    expect(r.snippets.length).toBe(2)
  })

  it('searches exactly the ids in orderedIds, in that order', () => {
    const s = new ScanSearcher()
    load(s, { a: 'fox', b: 'fox' })
    const r = s.search('fox', { ...OPTS, orderedIds: ['a'] })
    expect(r.totalMementos).toBe(1)
    expect(r.snippets[0].mementoId).toBe('a')
  })

  it('collects snippets in orderedIds order — the cap keeps the listed-first mementos', () => {
    const s = new ScanSearcher()
    load(s, { old1: 'fox', old2: 'fox', recent: 'fox' })
    // maxSnippets=1: only the first memento in orderedIds gets a snippet.
    const r = s.search('fox', { ...OPTS, maxSnippets: 1, orderedIds: ['recent', 'old1', 'old2'] })
    expect(r.totalMementos).toBe(3)        // all counted
    expect(r.snippets).toHaveLength(1)     // but only one snippet kept
    expect(r.snippets[0].mementoId).toBe('recent')
  })

  it('regex search without the RE2 engine throws the missing-engine error', () => {
    const s = new ScanSearcher()
    load(s, { a: 'error 404 and error 500' })
    // RE2 is mocked-missing at the top of the file — regex must refuse, not fall back to
    // the ReDoS-prone native engine.
    expect(() => s.search('error \\d+', { ...OPTS, regex: true })).toThrow(/RE2 engine/)
  })

  it('drops a memento after remove', () => {
    const s = new ScanSearcher()
    load(s, { a: 'fox', b: 'fox' })
    s.remove('a')
    expect(s.search('fox', OPTS).totalMementos).toBe(1)
  })
})

describe('NoneSearcher', () => {
  it('returns an empty outcome', () => {
    const s = new NoneSearcher()
    s.add('a', () => 'fox')
    expect(s.search('fox', OPTS)).toEqual({ totalMatches: 0, totalMementos: 0, snippets: [] })
  })

  it('never invokes the decryptText thunk', () => {
    const s = new NoneSearcher()
    let called = false
    s.add('a', () => { called = true; return 'x' })
    expect(called).toBe(false)
  })
})

describe('TrigramSearcher returns identical results to ScanSearcher', () => {
  const docs: Record<string, string> = {
    m1: 'the staged migration converged after refuse reverse backup',
    m2: 'backup and restore the vault directory',
    m3: 'a completely unrelated memento about embeddings',
    m4: 'BACKUP in capitals plus backup lowercase',
  }

  // Mix of: common word, 3-char word, multi-word phrase, no-match, sub-trigram literal.
  for (const q of ['backup', 'the', 'vault', 'migration converged', 'xyz', 'a']) {
    it(`literal query "${q}"`, () => {
      const scan = new ScanSearcher(); load(scan, docs)
      const tri = new TrigramSearcher(); load(tri, docs)
      const rs = scan.search(q, OPTS)
      const rt = tri.search(q, OPTS)
      expect(rt.totalMatches).toBe(rs.totalMatches)
      expect(rt.totalMementos).toBe(rs.totalMementos)
      expect(new Set(rt.snippets.map(x => x.mementoId)))
        .toEqual(new Set(rs.snippets.map(x => x.mementoId)))
    })
  }

  it('drops a memento from the trigram index after remove', () => {
    const tri = new TrigramSearcher(); load(tri, docs)
    tri.remove('m2')
    const r = tri.search('backup', OPTS)
    expect(r.snippets.every(x => x.mementoId !== 'm2')).toBe(true)
    expect(r.totalMementos).toBe(2) // m1 and m4 still match
  })
})

// The regex range-extraction loop is engine-agnostic — exercise it directly against a
// native RegExp, so this coverage holds without the optional `re2` package installed.
describe('RegexMatcher (engine-agnostic range extraction)', () => {
  it('extracts every match range in document order', () => {
    const m = new RegexMatcher(new RegExp('error \\d+', 'g'))
    expect(m.matchRanges('error 404 and error 500')).toEqual([[0, 9], [14, 23]])
  })

  it('terminates on a zero-width match instead of looping forever', () => {
    const m = new RegexMatcher(new RegExp('x*', 'g'))
    expect(m.matchRanges('abc').length).toBeGreaterThan(0)
  })
})

describe('compileMatcher', () => {
  it('refuses a regex query when the RE2 engine is unavailable', () => {
    expect(() => compileMatcher('foo', true, false)).toThrow(/RE2 engine/)
  })

  it('compiles a literal matcher with no engine needed', () => {
    expect(compileMatcher('foo', false, false).matchRanges('foo bar foo')).toEqual([[0, 3], [8, 11]])
  })
})
