/**
 * Unit tests for Vault.ingest — the idempotent bulk-import primitive that powers
 * `mementos ingest` and the `mementos snapshot` PreCompact hook.
 *
 * Focus areas:
 *   - One memento per input → one `.mem` file, carrying the chronicle id
 *   - A long memento chunks internally — still one file
 *   - Idempotency: a memento whose `mementoId` already exists is skipped
 *   - Intra-input dedup: the same `mementoId` twice in one call writes once
 *   - `createdAt` (per-memento and option-level) stamps the file
 *   - One backend `putBatch` call across the whole input — verified via a counter wrapper
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Vault } from '../core/vault/index.js'
import { LocalBackend } from '../storage/local/index.js'
import { MnemonicKeyProvider } from '../keys/mnemonic/index.js'
import { FakeEmbedder, BruteForceIndex, FAKE_DIMS } from './helpers/fake.js'
import { SemanticRetriever } from '../retrievers/semantic/index.js'
import { ScanSearcher } from '../searchers/scan/index.js'
import { decryptMemMeta } from '../core/vault/aad.js'
import { renderRecall } from '../core/render.js'
import type { StorageBackend } from '../storage/interface.js'
import type { MemFile, MemMeta } from '../core/vault/types.js'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'

/** Read a `.mem` file and decrypt its `meta` payload — v3 keeps all metadata encrypted. */
async function readMeta(id: string): Promise<MemMeta> {
  const key = await new MnemonicKeyProvider(MNEMONIC).getKey()
  const mem = JSON.parse(await readFile(join(dir, `${id}.mem`), 'utf8')) as MemFile
  return decryptMemMeta(mem, key)
}

/**
 * Thin wrapper over LocalBackend that counts how many times `putBatch` / `put` ran.
 * Lets us verify "one batch per ingest" without snooping on git or fake-mocking storage.
 */
function makeCountingBackend(dir: string): { backend: StorageBackend; calls: { putBatch: number; put: number } } {
  const inner = new LocalBackend(dir)
  const calls = { putBatch: 0, put: 0 }
  const backend: StorageBackend = {
    init: () => inner.init(),
    sync: () => inner.sync(),
    get: p => inner.get(p),
    put: (p, d, o) => { calls.put++; return inner.put(p, d, o) },
    putBatch: f => { calls.putBatch++; return inner.putBatch(f) },
    list: () => inner.list(),
    stat: p => inner.stat(p),
    delete: p => inner.delete(p),
    describeStoredData: () => inner.describeStoredData(),
    migrate: (fn, msg) => inner.migrate(fn, msg),
  }
  return { backend, calls }
}

let dir: string
let vault: Vault
let calls: { putBatch: number; put: number }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mementos-ingest-'))
  const c = makeCountingBackend(dir)
  calls = c.calls
  const index = new BruteForceIndex(FAKE_DIMS)
  vault = new Vault({
    storage: c.backend,
    embedder: new FakeEmbedder(),
    index,
    keys: new MnemonicKeyProvider(MNEMONIC),
    retriever: new SemanticRetriever(index),
    searcher: new ScanSearcher(),
    lockPath: dir,
  })
  await vault.startup()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(dir + '.lock', { recursive: true, force: true })
})

describe('Vault.ingest', () => {
  it('writes one .mem file per memento, each carrying the chronicle id', async () => {
    const chronicleId = randomUUID()
    const mementos = [
      { mementoId: randomUUID(), text: 'turn one' },
      { mementoId: randomUUID(), text: 'turn two' },
      { mementoId: randomUUID(), text: 'turn three' },
    ]
    const r = await vault.ingest(chronicleId, mementos)
    expect(r).toEqual({ added: 3, skipped: 0 })

    for (const m of mementos) {
      const raw = await readFile(join(dir, `${m.mementoId}.mem`), 'utf8')
      const mem = JSON.parse(raw) as MemFile
      expect(mem.id).toBe(m.mementoId)
      expect((await readMeta(m.mementoId)).chronicle_id).toBe(chronicleId)
    }
  })

  it('stores parent_memento_id when supplied', async () => {
    const chronicleId = randomUUID()
    const first = randomUUID()
    const second = randomUUID()
    await vault.ingest(chronicleId, [
      { mementoId: first, text: 'the first turn' },
      { mementoId: second, parentMementoId: first, text: 'the reply' },
    ])
    expect((await readMeta(second)).parent_memento_id).toBe(first)
  })

  it('a long memento chunks internally but stays one file', async () => {
    const chronicleId = randomUUID()
    const mementoId = randomUUID()
    const longText = ('Each sentence adds to the total character count of this memory. ').repeat(40)
    await vault.ingest(chronicleId, [{ mementoId, text: longText }])
    const files = await new LocalBackend(dir).list()
    expect(files.filter(f => f.endsWith('.mem'))).toHaveLength(1)
  })

  it('is idempotent — re-ingesting the same mementos skips them', async () => {
    const chronicleId = randomUUID()
    const mementos = [
      { mementoId: randomUUID(), text: 'first turn' },
      { mementoId: randomUUID(), text: 'second turn' },
    ]
    const first = await vault.ingest(chronicleId, mementos)
    expect(first).toEqual({ added: 2, skipped: 0 })
    const second = await vault.ingest(chronicleId, mementos)
    expect(second).toEqual({ added: 0, skipped: 2 })
  })

  it('mixes new and existing in one call — only the new ones are added', async () => {
    const chronicleId = randomUUID()
    const existing = { mementoId: randomUUID(), text: 'already ingested' }
    await vault.ingest(chronicleId, [existing])
    const r = await vault.ingest(chronicleId, [
      existing,
      { mementoId: randomUUID(), text: 'a brand new turn' },
    ])
    expect(r).toEqual({ added: 1, skipped: 1 })
  })

  it('intra-input dedup: the same mementoId twice in one call writes once', async () => {
    const chronicleId = randomUUID()
    const dupId = randomUUID()
    const r = await vault.ingest(chronicleId, [
      { mementoId: dupId, text: 'turn A' },
      { mementoId: dupId, text: 'turn A again' },
    ])
    expect(r).toEqual({ added: 1, skipped: 1 })
  })

  it('createdAt: opts.createdAt stamps mementos without their own; per-memento overrides', async () => {
    const chronicleId = randomUUID()
    const optWhen = '2024-01-15T10:00:00.000Z'
    const ownWhen = '2023-06-01T08:00:00.000Z'
    const a = randomUUID()
    const b = randomUUID()
    await vault.ingest(chronicleId, [
      { mementoId: a, text: 'inherits the option timestamp' },
      { mementoId: b, text: 'has its own timestamp', createdAt: ownWhen },
    ], { createdAt: optWhen })

    expect((await readMeta(a)).created_at).toBe(optWhen)
    expect((await readMeta(b)).created_at).toBe(ownWhen)
  })

  it('uses ONE storage.putBatch across all mementos (not N)', async () => {
    const before = calls.putBatch
    await vault.ingest(randomUUID(), [
      { mementoId: randomUUID(), text: 'entry one' },
      { mementoId: randomUUID(), text: 'entry two' },
      { mementoId: randomUUID(), text: 'entry three' },
    ])
    expect(calls.putBatch).toBe(before + 1)
    expect(calls.put).toBe(0)
  })

  it('empty mementos array is a no-op that does not touch storage', async () => {
    const before = calls.putBatch
    const r = await vault.ingest(randomUUID(), [])
    expect(r).toEqual({ added: 0, skipped: 0 })
    expect(calls.putBatch).toBe(before)
  })

  it('rejects an invalid chronicleId or mementoId (validateId enforces UUID v4 shape)', async () => {
    await expect(
      vault.ingest('not-a-uuid', [{ mementoId: randomUUID(), text: 'x' }]),
    ).rejects.toThrow(/Invalid id/)
    await expect(
      vault.ingest(randomUUID(), [{ mementoId: 'not-a-uuid', text: 'x' }]),
    ).rejects.toThrow(/Invalid id/)
  })

  it('ingested mementos surface through recall scoped by chronicle', async () => {
    const chronicleId = randomUUID()
    await vault.ingest(chronicleId, [
      { mementoId: randomUUID(), text: 'lookup-keyword-alpha question' },
    ], { tags: ['conversation'] })

    const retrieved = renderRecall(await vault.recall('lookup-keyword-alpha question', 5, chronicleId))
    expect(retrieved).toContain('lookup-keyword-alpha question')
    expect(retrieved).toContain(`chronicle=${chronicleId}`)
  })
})
