/**
 * Vault-level `search` integration — the `search` MCP tool / `mementos search` path.
 *
 * Covers the wiring `searchers.test.ts` cannot: the searcher fed by `registerMemento` on
 * write, the tag/chronicle filter resolving to a candidate set, the formatted output, the
 * regex/RE2 guard surfaced as a message, and a sync delta updating results.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest'

// Mock the plugins module so the RE2-missing surface ("regex needs RE2") is testable
// regardless of whether the optional `re2` package is installed in the current env.
vi.mock('../core/plugins.js', () => ({
  requireFromPlugins: (name: string) => {
    if (name === 're2') throw new Error('mocked-missing-re2')
    throw new Error(`Unexpected requireFromPlugins call for: ${name}`)
  },
  ensurePackage: vi.fn().mockResolvedValue(undefined),
  ensurePluginSetup: () => async () => {},
  pluginsDir: () => '/tmp/mock-mementos-plugins',
}))

import { Vault } from '../core/vault/index.js'
import { LocalBackend } from '../storage/local/index.js'
import { MnemonicKeyProvider } from '../keys/mnemonic/index.js'
import { FakeEmbedder, BruteForceIndex, FAKE_DIMS } from './helpers/fake.js'
import { SemanticRetriever } from '../retrievers/semantic/index.js'
import { ScanSearcher } from '../searchers/scan/index.js'
import { TrigramSearcher } from '../searchers/trigram/index.js'
import type { Searcher } from '../searchers/interface.js'
import { renderSearch } from '../core/render.js'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'

let dir: string
let vault: Vault

async function makeVault(tmpDir: string, searcher: Searcher): Promise<Vault> {
  const index = new BruteForceIndex(FAKE_DIMS)
  const v = new Vault({
    storage: new LocalBackend(tmpDir),
    embedder: new FakeEmbedder(),
    index,
    keys: new MnemonicKeyProvider(MNEMONIC),
    retriever: new SemanticRetriever(index),
    searcher,
    lockPath: tmpDir,
  })
  await v.startup()
  return v
}

/** Run a vault search and render it to text, exactly as the MCP `search` tool does (k=5). */
const searchText = async (v: Vault, ...args: Parameters<Vault['search']>): Promise<string> =>
  renderSearch(await v.search(...args), 5)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mementos-vsearch-'))
  vault = await makeVault(dir, new ScanSearcher())
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('vault.search', () => {
  it('finds a literal substring and reports a count', async () => {
    await vault.writeMemento({ text: 'the staged migration backup model' })
    await vault.writeMemento({ text: 'an unrelated note about embeddings' })
    const out = await searchText(vault, 'backup')
    expect(out).toContain('Found 1 match in 1 memento')
    expect(out).toContain('«backup»')
  })

  it('reports "No matches found." when nothing matches', async () => {
    await vault.writeMemento({ text: 'hello world' })
    expect(await searchText(vault, 'zzzznope')).toBe('No matches found.')
  })

  it('pluralises and counts across mementos', async () => {
    await vault.writeMemento({ text: 'alpha token here' })
    await vault.writeMemento({ text: 'beta token there' })
    const out = await searchText(vault, 'token')
    expect(out).toContain('Found 2 matches in 2 mementos')
  })

  it('reports the missing RE2 engine for a regex query instead of throwing', async () => {
    // RE2 is mocked-missing at the top of the file. Regex search must surface an actionable
    // message — never crash the tool, and never fall back to the ReDoS-prone native engine.
    await vault.writeMemento({ text: 'errors 404 and 503 today' })
    const out = await searchText(vault, '\\d{3}', 48, true)
    expect(out).toMatch(/RE2 engine/)
  })

  it('restricts the search to a tag filter', async () => {
    await vault.writeMemento({ text: 'shared keyword in a decision', tags: ['decision'] })
    await vault.writeMemento({ text: 'shared keyword in a pitfall', tags: ['pitfall'] })
    const out = await searchText(vault, 'keyword', 48, false, true, undefined, ['decision'])
    expect(out).toContain('Found 1 match in 1 memento')
  })

  it('reflects a delete', async () => {
    const { id } = await vault.writeMemento({ text: 'deletable haystack needle' })
    expect(await searchText(vault, 'needle')).toContain('Found 1 match')
    await vault.deleteMemento(id)
    expect(await searchText(vault, 'needle')).toBe('No matches found.')
  })

  it('rejects an empty query', async () => {
    expect(await searchText(vault, '')).toBe('Empty query.')
  })

  it('rejects a too-short literal query', async () => {
    await vault.writeMemento({ text: 'anything at all here' })
    expect(await searchText(vault, 'ab')).toContain('at least 3 characters')
  })

  it('does not reject a short query in regex mode for length', async () => {
    // A 1-char regex like `\d` is deliberate — the ≥3-char floor is literal-only. (The
    // query then hits the RE2-engine guard in this env, but never the length rejection.)
    await vault.writeMemento({ text: 'abc 12 def' })
    const out = await searchText(vault, '\\d', 48, true)
    expect(out).not.toContain('at least 3 characters')
  })

  it('renderSearch follow-up hint is overridable for the CLI vs MCP context', async () => {
    // MCP path (default): hint names the get_memento tool the AI calls.
    // CLI path (opts.followUp): hint names the `mementos get` command the user types.
    await vault.writeMemento({ text: 'find this stuff' })
    const result = await vault.search('stuff', 48, false, true)

    const mcpOut = renderSearch(result, 5)
    expect(mcpOut).toContain('get_memento')

    const cliOut = renderSearch(result, 5, { followUp: 'Run `mementos get <id>` for full text.' })
    expect(cliOut).toContain('mementos get')
    expect(cliOut).not.toContain('get_memento')
  })

  it('works end-to-end with the trigram searcher', async () => {
    const triDir = await mkdtemp(join(tmpdir(), 'mementos-vsearch-tri-'))
    try {
      const triVault = await makeVault(triDir, new TrigramSearcher())
      await triVault.writeMemento({ text: 'the trigram indexed memento backup' })
      await triVault.writeMemento({ text: 'another memento entirely' })
      expect(await searchText(triVault, 'backup')).toContain('Found 1 match in 1 memento')
    } finally {
      await rm(triDir, { recursive: true, force: true })
    }
  })
})
