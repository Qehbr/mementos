/**
 * Unit tests for `vault.getMementos({ start, end, query, k, tags })` — the
 * unified listing path that backs the `list_mementos` MCP tool and the
 * `mementos list` CLI. Modes covered: (1) recency-only when no args / only
 * `k`; (2) date-window via `start` / `end`; (3) semantic ranking via `query`;
 * (4) combinations (tags coverage in vault.test.ts).
 *
 * The helper operates on the in-memory `metaById` map and then decrypts the
 * matching `.mem` files, so we exercise the full read-and-format pipeline
 * against a real LocalBackend with fake embedder + brute-force index — same
 * shape as vault.test.ts.
 *
 * The sort key is `updated_at` (NOT `created_at`) — a memento edited today
 * sorts above one written yesterday and never touched, and the date-window
 * filter matches on `updated_at` too. Tests that only write (created==updated)
 * wouldn't catch a regression back to `created_at`; the update-driven tests at
 * the end of each describe block do. `updated_at` is set by the Vault
 * internally (Date.now()), so to test ordering we write / update one at a
 * time with a small wait between them to force distinct timestamps.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Vault } from '../core/vault/index.js'
import { LocalBackend } from '../storage/local/index.js'
import { MnemonicKeyProvider } from '../keys/mnemonic/index.js'
import { FakeEmbedder, BruteForceIndex, FAKE_DIMS } from './helpers/fake.js'
import { SemanticRetriever } from '../retrievers/semantic/index.js'
import { ScanSearcher } from '../searchers/scan/index.js'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'

let dir: string
let vault: Vault

async function makeVault(tmpDir: string): Promise<Vault> {
  const index = new BruteForceIndex(FAKE_DIMS)
  const v = new Vault({
    storage: new LocalBackend(tmpDir),
    embedder: new FakeEmbedder(),
    index,
    keys: new MnemonicKeyProvider(MNEMONIC),
    retriever: new SemanticRetriever(index),
    searcher: new ScanSearcher(),
    lockPath: tmpDir,
  })
  await v.startup()
  return v
}

/** Sleep just long enough to push `Date.now()` to the next millisecond. */
const tick = () => new Promise<void>(r => setTimeout(r, 2))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mementos-range-'))
  vault = await makeVault(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(dir + '.lock', { recursive: true, force: true })
})

/** Texts of a MementoSummary[] result, in order. */
const texts = (results: { text: string }[]): string[] => results.map(r => r.text)

// `getMementos()` with no args is the "give me the most-recent k by
// updated_at" path. The describe below covers the recency contract; the
// next describe covers the date/query/tags filter modes.
describe('getMementos — recency mode (no args)', () => {
  it('returns an empty array on an empty vault', async () => {
    expect(await vault.getMementos({ k: 5 })).toEqual([])
  })

  it('returns memories in reverse chronological order', async () => {
    await vault.writeMemento({ text: 'oldest' })
    await tick()
    await vault.writeMemento({ text: 'middle' })
    await tick()
    await vault.writeMemento({ text: 'newest' })

    expect(texts(await vault.getMementos({ k: 3 }))).toEqual(['newest', 'middle', 'oldest'])
  })

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await vault.writeMemento({ text: `memory number ${i}` })
      await tick()
    }
    expect(await vault.getMementos({ k: 2 })).toHaveLength(2)
  })

  it('results carry the created_at timestamp', async () => {
    await vault.writeMemento({ text: 'with timestamp' })
    const results = await vault.getMementos({ k: 1 })
    expect(results[0]?.createdAt).toMatch(/^20\d\d-\d\d-\d\dT/)
  })

  // Regression for the updated_at recency contract — a test that only writes (created
  // == updated for every memento) would pass identically if the sort key were reverted
  // to created_at. This one wouldn't: A is written FIRST, B SECOND, then A is updated;
  // by-created_at would yield [B, A], by-updated_at yields [A, B].
  it('an updated memento jumps to the head of the recency order (updated_at, not created_at)', async () => {
    const { id: idA } = await vault.writeMemento({ text: 'memory A' })
    await tick()
    await vault.writeMemento({ text: 'memory B' })
    await tick()
    await vault.updateMemento(idA, 'memory A — edited')

    expect(texts(await vault.getMementos({ k: 2 }))).toEqual(['memory A — edited', 'memory B'])
  })
})

describe('getMementos — date / query / tag filters', () => {
  it('returns an empty array on an empty vault', async () => {
    expect(await vault.getMementos()).toEqual([])
  })

  it('filters by start date inclusive', async () => {
    await vault.writeMemento({ text: 'before the window' })
    await tick()
    const cutoff = new Date().toISOString()
    await tick()
    await vault.writeMemento({ text: 'inside the window' })

    const result = texts(await vault.getMementos({ start: cutoff }))
    expect(result).toContain('inside the window')
    expect(result).not.toContain('before the window')
  })

  it('filters by end date inclusive', async () => {
    await vault.writeMemento({ text: 'inside the window' })
    await tick()
    const cutoff = new Date().toISOString()
    await tick()
    await vault.writeMemento({ text: 'after the window' })

    const result = texts(await vault.getMementos({ end: cutoff }))
    expect(result).toContain('inside the window')
    expect(result).not.toContain('after the window')
  })

  it('ranks by query when one is supplied', async () => {
    // FakeEmbedder is hash-based — identical text produces identical vectors. So a query
    // exactly matching one of the stored memories will score it as nearest.
    await vault.writeMemento({ text: 'alpha bravo charlie' })
    await tick()
    await vault.writeMemento({ text: 'delta echo foxtrot' })

    const result = texts(await vault.getMementos({ query: 'alpha bravo charlie', k: 1 }))
    expect(result).toContain('alpha bravo charlie')
    expect(result).not.toContain('delta echo foxtrot')
  })

  it('returns an empty array when the window is empty', async () => {
    await vault.writeMemento({ text: 'any memory' })
    // Future range — nothing yet written that far ahead.
    expect(await vault.getMementos({ start: '2099-01-01', end: '2099-12-31' })).toEqual([])
  })

  it('cold query (no relevance match) still returns the in-range memory — query reorders, never filters', async () => {
    await vault.writeMemento({ text: 'apple banana cherry' })
    // Contract: `query` is a presentation hint, not a filter. Even when the
    // query is semantically unrelated to every memento in `allowed`, the
    // listing must not shrink — non-matching members fall through in
    // recency order. (This is the behavior `recall` correctly does NOT have:
    // cold queries to recall return [], because recall is relevance-filtered
    // semantic search.)
    const result = texts(await vault.getMementos({ query: 'zebra zebra zebra zebra' }))
    expect(result).toEqual(['apple banana cherry'])
  })

  it('query reorders the listing without dropping non-matching mementos', async () => {
    // Write order: pasta (oldest) → cake → soup (newest).
    // Pure recency would yield [soup, cake, pasta]; an exact-match query on
    // "pasta carbonara" must surface it FIRST while still returning the
    // other two (the listing's tag/date filter set is { pasta, cake, soup }
    // — query can only reorder, not winnow).
    await vault.writeMemento({ text: 'pasta carbonara', tags: ['recipes'] })
    await tick()
    await vault.writeMemento({ text: 'chocolate cake', tags: ['recipes'] })
    await tick()
    await vault.writeMemento({ text: 'tomato soup', tags: ['recipes'] })

    expect(texts(await vault.getMementos({ tags: ['recipes'], k: 3 })))
      .toEqual(['tomato soup', 'chocolate cake', 'pasta carbonara'])

    // Same filter set, query="pasta carbonara". Pasta is the oldest, so a
    // bare recency sort would put it last; the query pulls it to the front.
    // The other two still appear, behind it, in their own recency order.
    expect(texts(await vault.getMementos({ tags: ['recipes'], query: 'pasta carbonara', k: 3 })))
      .toEqual(['pasta carbonara', 'tomato soup', 'chocolate cake'])

    // Cold query against the same filter set — full set returned, all by recency.
    expect(texts(await vault.getMementos({ tags: ['recipes'], query: 'irrelevant zebra noise', k: 3 })))
      .toEqual(['tomato soup', 'chocolate cake', 'pasta carbonara'])
  })

  // Regression for the updated_at window contract — see the parallel test in
  // the recency-mode tests above. A memento written BEFORE a window but edited INSIDE it must
  // be returned (because updated_at is in range). By-created_at filtering would exclude it.
  it('an updated memento moves into a date window opened after its creation (updated_at filter)', async () => {
    const { id } = await vault.writeMemento({ text: 'old fact' })
    await tick()
    const windowStart = new Date().toISOString()
    await tick()
    await vault.updateMemento(id, 'old fact — refreshed')

    const result = texts(await vault.getMementos({ start: windowStart }))
    expect(result).toContain('old fact — refreshed')
  })
})
