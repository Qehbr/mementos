/**
 * Unit tests for Vault.getChronicle — returns a chronicle's mementos as an ordered
 * `ChronicleEntry[]` (empty `[]` for an unknown chronicle).
 *
 * Chronicles are created by `vault.ingest`, so each test ingests a small conversation and
 * then reads it back. `created_at` is passed explicitly per memento so ordering is
 * deterministic. A `parent_memento_id` shared by 2+ mementos is a fork point — getChronicle
 * sets `forkFrom` on those mementos, and `renderChronicle` annotates it inline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Vault } from '../core/vault/index.js'
import { LocalBackend } from '../storage/local/index.js'
import { MnemonicKeyProvider } from '../keys/mnemonic/index.js'
import { FakeEmbedder, BruteForceIndex, FAKE_DIMS } from './helpers/fake.js'
import { SemanticRetriever } from '../retrievers/semantic/index.js'
import { ScanSearcher } from '../searchers/scan/index.js'
import { renderChronicle, renderChronicleList } from '../core/render.js'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'

let dir: string
let vault: Vault

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mementos-chronicle-'))
  const index = new BruteForceIndex(FAKE_DIMS)
  vault = new Vault({
    storage: new LocalBackend(dir),
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

describe('getChronicle', () => {
  it('returns an empty array for an unknown chronicle', async () => {
    expect(await vault.getChronicle(randomUUID())).toEqual([])
  })

  it('returns entries ordered by created_at, each with id and full text', async () => {
    const chronicleId = randomUUID()
    const first = randomUUID()
    const second = randomUUID()
    // Ingested out of chronological order — getChronicle must sort by created_at.
    await vault.ingest(chronicleId, [
      { mementoId: second, text: 'the reply turn', createdAt: '2026-02-01T10:00:00.000Z' },
      { mementoId: first, text: 'the opening turn', createdAt: '2026-01-01T10:00:00.000Z' },
    ])

    const entries = await vault.getChronicle(chronicleId)
    expect(entries.map(e => e.id)).toEqual([first, second])
    expect(entries.map(e => e.text)).toEqual(['the opening turn', 'the reply turn'])
    expect(entries[0].createdAt).toBe('2026-01-01T10:00:00.000Z')
  })

  it('only returns mementos of the requested chronicle', async () => {
    const a = randomUUID()
    const b = randomUUID()
    await vault.ingest(a, [{ mementoId: randomUUID(), text: 'belongs to A' }])
    await vault.ingest(b, [{ mementoId: randomUUID(), text: 'belongs to B' }])

    const entries = await vault.getChronicle(a)
    expect(entries.map(e => e.text)).toEqual(['belongs to A'])
  })

  it('does not set forkFrom for a parent referenced only once', async () => {
    const chronicleId = randomUUID()
    const parent = randomUUID()
    const child = randomUUID()
    await vault.ingest(chronicleId, [
      { mementoId: parent, text: 'the question', createdAt: '2026-01-01T10:00:00.000Z' },
      { mementoId: child, parentMementoId: parent, text: 'the answer', createdAt: '2026-01-01T10:01:00.000Z' },
    ])

    const entries = await vault.getChronicle(chronicleId)
    expect(entries.every(e => e.forkFrom === undefined)).toBe(true)
  })

  it('sets forkFrom on mementos that share a parent (a fork point)', async () => {
    const chronicleId = randomUUID()
    const parent = randomUUID()
    const branchA = randomUUID()
    const branchB = randomUUID()
    // Two replies to the same parent turn — the user re-rolled the response.
    await vault.ingest(chronicleId, [
      { mementoId: parent, text: 'the prompt', createdAt: '2026-01-01T10:00:00.000Z' },
      { mementoId: branchA, parentMementoId: parent, text: 'first response', createdAt: '2026-01-01T10:01:00.000Z' },
      { mementoId: branchB, parentMementoId: parent, text: 're-rolled response', createdAt: '2026-01-01T10:02:00.000Z' },
    ])

    const byId = new Map((await vault.getChronicle(chronicleId)).map(e => [e.id, e]))
    expect(byId.get(parent)?.forkFrom).toBeUndefined()
    expect(byId.get(branchA)?.forkFrom).toBe(parent)
    expect(byId.get(branchB)?.forkFrom).toBe(parent)
  })

  it('renderChronicle annotates a fork point inline', async () => {
    const chronicleId = randomUUID()
    const parent = randomUUID()
    await vault.ingest(chronicleId, [
      { mementoId: parent, text: 'the prompt', createdAt: '2026-01-01T10:00:00.000Z' },
      { mementoId: randomUUID(), parentMementoId: parent, text: 'response one', createdAt: '2026-01-01T10:01:00.000Z' },
      { mementoId: randomUUID(), parentMementoId: parent, text: 'response two', createdAt: '2026-01-01T10:02:00.000Z' },
    ])

    const rendered = renderChronicle(await vault.getChronicle(chronicleId), chronicleId)
    expect(rendered).toContain(`(fork from ${parent})`)
  })

  it('renderChronicle truncates long mementos and includes a get_memento follow-up hint', async () => {
    // The tool description tells the AI "call get_memento for the full text of any turn"
    // when previews are truncated. The renderer has to actually emit the per-row hint with
    // the correct id, or the AI will answer from previews and never fetch the rest. Mirrors
    // renderRecall's "matched chunk M/N — call get_memento(...)" disclosure.
    const chronicleId = randomUUID()
    const longId = randomUUID()
    const shortId = randomUUID()
    const longText = 'x'.repeat(500)  // > CHRONICLE_PREVIEW_CHARS (200)
    await vault.ingest(chronicleId, [
      { mementoId: longId, text: longText, createdAt: '2026-01-01T10:00:00.000Z' },
      { mementoId: shortId, text: 'short turn', createdAt: '2026-01-01T10:01:00.000Z' },
    ])

    const rendered = renderChronicle(await vault.getChronicle(chronicleId), chronicleId)

    // Long memento: truncated with the ellipsis AND carries the follow-up hint with its id.
    expect(rendered).toContain('…')
    expect(rendered).toContain(`call get_memento("${longId}") for the full text`)
    expect(rendered).not.toContain(longText)  // the full 500-char text is NOT present

    // Short memento: rendered inline, no follow-up hint (nothing to fetch).
    const shortLine = rendered.split('\n').find(l => l.includes(shortId)) ?? ''
    expect(shortLine).toContain('"short turn"')
    expect(shortLine).not.toContain('get_memento')
  })

  it('renderChronicle reports an unknown chronicle as not found, with a list_chronicles hint', async () => {
    const chronicleId = randomUUID()
    const rendered = renderChronicle(await vault.getChronicle(chronicleId), chronicleId)
    expect(rendered).toContain(`No mementos found for chronicle ${chronicleId}`)
    // The hint points the AI at the recoverable next step — same template as the
    // truncation hint in the populated case.
    expect(rendered).toContain('list_chronicles()')
  })
})

describe('listChronicles', () => {
  it('returns an empty array when no chronicles exist', async () => {
    expect(await vault.listChronicles()).toEqual([])
  })

  it('ignores direct-write mementos that belong to no chronicle', async () => {
    await vault.writeMemento({ text: 'a directly written memory' })
    expect(await vault.listChronicles()).toEqual([])
  })

  it('reports each chronicle with its count and earliest timestamp, newest first', async () => {
    const older = randomUUID()
    const newer = randomUUID()
    await vault.ingest(older, [
      { mementoId: randomUUID(), text: 'old turn one', createdAt: '2026-01-01T10:00:00.000Z' },
      { mementoId: randomUUID(), text: 'old turn two', createdAt: '2026-01-02T10:00:00.000Z' },
    ])
    await vault.ingest(newer, [
      { mementoId: randomUUID(), text: 'recent turn', createdAt: '2026-03-01T10:00:00.000Z' },
    ])

    expect(await vault.listChronicles()).toEqual([
      { chronicleId: newer, mementoCount: 1, earliest: '2026-03-01T10:00:00.000Z' },
      { chronicleId: older, mementoCount: 2, earliest: '2026-01-01T10:00:00.000Z' },
    ])
  })

  it('renderChronicleList reports an empty vault as not stored', async () => {
    expect(renderChronicleList(await vault.listChronicles())).toBe('No chronicles stored.')
  })
})
