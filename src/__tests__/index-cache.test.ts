/**
 * Regression test for the encrypted HNSW index cache — specifically that a memento
 * written / updated / ingested in one process yields a CACHE HIT on the next startup,
 * not a cold rebuild.
 *
 * The bug this guards (audit finding #1): the write paths once registered `Date.now()` as
 * a memento's `mtimeMs` instead of the file's real on-disk mtime. `tryLoadIndexCache`
 * validates with an exact per-file `mtimeMs` equality check, so a wall-clock value (never
 * equal to the file's sub-millisecond stat mtime) silently invalidated the cache — every
 * restart after a local write did a full cold rebuild. The fix records the real
 * `storage.stat` mtime; this test fails if that regresses.
 *
 * Observability: a cache HIT restores the index via `VectorIndex.load()` and never
 * re-`add()`s a chunk; a cold rebuild calls `add()` once per chunk and never `load()`s.
 * `CountingIndex` records both, so the two paths are directly distinguishable. HOME is
 * pointed at a temp dir because the cache file lives under `~/.config/mementos/cache/`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setFakeHome } from './_utils/fake-home.js'
import { randomUUID } from 'node:crypto'
import { Vault } from '../core/vault/index.js'
import { LocalBackend } from '../storage/local/index.js'
import { MnemonicKeyProvider } from '../keys/mnemonic/index.js'
import { FakeEmbedder, BruteForceIndex, FAKE_DIMS } from './helpers/fake.js'
import { SemanticRetriever } from '../retrievers/semantic/index.js'
import { ScanSearcher } from '../searchers/scan/index.js'
import type { VectorIndex } from '../vector/interface.js'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'

/**
 * A BruteForceIndex that counts `load` vs `add`. On a cache hit `startup` calls `load`
 * once and never `add`; on a cold rebuild it calls `add` per chunk and never `load`.
 */
class CountingIndex extends BruteForceIndex {
  loadCalls = 0
  addCalls = 0

  override async load(data: Buffer): Promise<void> {
    this.loadCalls++
    await super.load(data)
  }

  override add(id: string, vector: Float32Array): void {
    this.addCalls++
    super.add(id, vector)
  }
}

let dir: string
let fakeHome: string
let restoreHome: () => void

function makeVault(index: VectorIndex): Vault {
  return new Vault({
    storage: new LocalBackend(dir),
    embedder: new FakeEmbedder(),
    index,
    keys: new MnemonicKeyProvider(MNEMONIC),
    retriever: new SemanticRetriever(index),
    searcher: new ScanSearcher(),
    lockPath: dir,
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mementos-cache-'))
  // The index cache lives under ~/.config/mementos/cache/ — isolate HOME so the test
  // neither reads a real cache nor writes into the developer's config dir.
  fakeHome = await mkdtemp(join(tmpdir(), 'mementos-cache-home-'))
  restoreHome = setFakeHome(fakeHome)
})

afterEach(async () => {
  restoreHome()
  await rm(dir, { recursive: true, force: true })
  await rm(dir + '.lock', { recursive: true, force: true })
  await rm(fakeHome, { recursive: true, force: true })
})

describe('index cache hit after a local write', () => {
  it('a written memento yields a cache hit on the next startup', async () => {
    const v1 = makeVault(new BruteForceIndex(FAKE_DIMS))
    await v1.startup()
    await v1.writeMemento({ text: 'a fact worth caching across restarts' })
    await v1.close()  // flushes the encrypted index cache

    const index2 = new CountingIndex(4)
    const v2 = makeVault(index2)
    await v2.startup()
    // Cache hit: the index was restored via load(), no chunk was re-added.
    expect(index2.loadCalls).toBe(1)
    expect(index2.addCalls).toBe(0)
    await v2.close()
  })

  it('an updated memento yields a cache hit on the next startup', async () => {
    const v1 = makeVault(new BruteForceIndex(FAKE_DIMS))
    await v1.startup()
    const { id } = await v1.writeMemento({ text: 'the original text' })
    await v1.updateMemento(id, 'the revised text, meaningfully different')
    await v1.close()

    const index2 = new CountingIndex(4)
    const v2 = makeVault(index2)
    await v2.startup()
    expect(index2.loadCalls).toBe(1)
    expect(index2.addCalls).toBe(0)
    await v2.close()
  })

  it('ingested mementos yield a cache hit on the next startup', async () => {
    const v1 = makeVault(new BruteForceIndex(FAKE_DIMS))
    await v1.startup()
    await v1.ingest(randomUUID(), [
      { mementoId: randomUUID(), text: 'turn one of an ingested chronicle' },
      { mementoId: randomUUID(), text: 'turn two of an ingested chronicle' },
    ])
    await v1.close()

    const index2 = new CountingIndex(4)
    const v2 = makeVault(index2)
    await v2.startup()
    expect(index2.loadCalls).toBe(1)
    expect(index2.addCalls).toBe(0)
    await v2.close()
  })

  // Audit-6 regression: close() must await the timer's in-flight flush before its own,
  // otherwise close()'s flush hits ELOCKED → .catch swallows → close returns → the
  // shutdown handler's process.exit(0) kills the timer's writeFile mid-flush → truncated
  // cache file on disk (next startup pays a cold rebuild). The behavior we assert: with
  // an inFlightFlush set to a pending promise, close() blocks until that promise resolves.
  // If a future change removes `await this.inFlightFlush`, close() resolves immediately
  // and this test fails.
  it('close() awaits the timer\'s in-flight flush before its own', async () => {
    const v = makeVault(new BruteForceIndex(FAKE_DIMS))
    await v.startup()

    let resolveFlush: () => void = () => {}
    const pendingFlush = new Promise<void>(r => { resolveFlush = r })
    // Simulate the timer's bookkeeping — the production code sets inFlightFlush from the
    // setInterval callback; here we set it directly so the race doesn't depend on timing.
    ;(v as unknown as { inFlightFlush: Promise<void> }).inFlightFlush = pendingFlush

    const closeP = v.close()
    // Race: close MUST block on pendingFlush. If close resolves first, the await is gone.
    const winner = await Promise.race([
      closeP.then(() => 'close'),
      new Promise<string>(r => setTimeout(() => r('timeout'), 80)),
    ])
    expect(winner).toBe('timeout')

    // Let the simulated flush resolve; close() can now complete cleanly.
    resolveFlush()
    await closeP
  })

  it('a memento changed on disk after the flush forces a cold rebuild (negative control)', async () => {
    const v1 = makeVault(new BruteForceIndex(FAKE_DIMS))
    await v1.startup()
    await v1.writeMemento({ text: 'a fact that will be tampered with on disk' })
    await v1.close()

    // Bump the .mem file's mtime — an on-disk change the cached mtime cannot match.
    const memFiles = (await new LocalBackend(dir).list()).filter(f => f.endsWith('.mem'))
    const future = new Date(Date.now() + 60_000)
    await utimes(join(dir, memFiles[0]), future, future)

    const index2 = new CountingIndex(4)
    const v2 = makeVault(index2)
    await v2.startup()
    // Stale cache: validation fails, the index is rebuilt from .mem files.
    expect(index2.loadCalls).toBe(0)
    expect(index2.addCalls).toBeGreaterThan(0)
    await v2.close()
  })
})
