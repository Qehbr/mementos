/**
 * Regression test for the cache-hit / disk-state divergence bug.
 *
 * The bug (Fable 5 audit finding): the encrypted HNSW cache restores every
 * memento's chunks into the index BEFORE any .mem file is re-authenticated.
 * If a .mem then fails authentication during the cache-hit `loadAndRegister`
 * (silent bit-rot, or on-disk tampering with mtime preserved via touch -r),
 * `registerMemento` is skipped — but the chunks the cache loaded into the
 * index remain. `metaById` doesn't have the id; the index does.
 *
 * Concrete failure: `recall(query)` → `rankSemantic` → `index.search` returns
 * the orphan id → `readMemento(id)` re-authenticates the on-disk .mem →
 * throws → tool handler doesn't catch → HTTP 500. One bad file takes down
 * recall for the daemon's whole lifetime.
 *
 * The existing tamper tests in vault.test.ts don't catch this because they
 * run on the cache-MISS path (each test uses a fresh temp HOME, so the
 * shared `~/.config/mementos/cache/index.hnsw.enc` path never matches).
 * This test exercises the cache-HIT path specifically.
 *
 * The fix: at startup, track ids whose .mem failed authentication during
 * the cache-hit phase and call `index.removeMemento(id)` for each, so the
 * "index ↔ metaById in lockstep" invariant holds.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
let fakeHome: string
let realHome: string | undefined

function makeVault(): Vault {
  const index = new BruteForceIndex(FAKE_DIMS)
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
  dir = await mkdtemp(join(tmpdir(), 'mementos-orphan-'))
  fakeHome = await mkdtemp(join(tmpdir(), 'mementos-orphan-home-'))
  realHome = process.env['HOME']
  process.env['HOME'] = fakeHome
})

afterEach(async () => {
  if (realHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = realHome
  await rm(dir, { recursive: true, force: true })
  await rm(dir + '.lock', { recursive: true, force: true })
  await rm(fakeHome, { recursive: true, force: true })
})

/**
 * Corrupt one byte inside the .mem's encrypted chunks payload while leaving
 * filesize and mtime unchanged. Simulates either silent bit-rot (no write
 * syscall, so mtime is genuinely unchanged) or an attacker who used
 * `touch -r` after tampering.
 *
 * Shell `touch -r` is used rather than Node's `utimes` because the latter
 * routes through JS Number precision and loses sub-microsecond bits when
 * converting `mtimeMs` to (sec, nsec); `tryLoadIndexCache` compares
 * mtimeMs strictly equal, so any precision loss fails the freshness gate
 * and the test silently falls through to the cache-MISS path (which
 * doesn't exhibit the bug). `touch -r` reads stat directly in the kernel
 * and preserves nanosecond mtime exactly. Sync calls because execFileSync
 * is sync — keeps the helper readable.
 */
function corruptMemPreservingMtime(memPath: string): void {
  const refPath = memPath + '.mtime-ref'
  execFileSync('cp', ['-a', memPath, refPath])
  const raw = readFileSync(memPath, 'utf8')
  const parsed = JSON.parse(raw) as { chunks: { tag: string } }
  // Flip a byte inside the GCM auth tag. base64-decode → XOR one byte →
  // re-encode. Guarantees `decipher.final()` throws on next read regardless
  // of Node/OpenSSL version. Filesize unchanged because base64 length is
  // determined by the binary length.
  const tag = Buffer.from(parsed.chunks.tag, 'base64')
  tag[0] ^= 0xff
  parsed.chunks.tag = tag.toString('base64')
  writeFileSync(memPath, JSON.stringify(parsed))
  execFileSync('touch', ['-r', refPath, memPath])
  execFileSync('rm', [refPath])
}

describe('cache-hit startup: a corrupt .mem with preserved mtime', () => {
  it('does not leave an orphan in the index — recall returns clean instead of crashing', async () => {
    // Phase 1: write two mementos and flush the cache.
    const v1 = makeVault()
    await v1.startup()
    const { id: idA } = await v1.writeMemento({ text: 'alpha — the one we will corrupt' })
    await v1.writeMemento({ text: 'beta — the one that stays healthy' })
    await v1.close()  // flushes the encrypted HNSW cache

    // Phase 2: corrupt idA's .mem while keeping its mtime, simulating
    // either bit-rot or an attacker who reset mtime via touch -r.
    corruptMemPreservingMtime(join(dir, `${idA}.mem`))

    // Phase 3: a fresh vault boots against the existing cache. The cache
    // restores both mementos' chunks into the index. loadAndRegister
    // re-authenticates each .mem: alpha fails (corrupt), beta succeeds.
    // The reconciliation must tombstone alpha's chunks from the index so
    // it doesn't surface in recall.
    const v2 = makeVault()
    await v2.startup()

    // The contract under audit: recall must not throw, and the corrupt
    // id must not surface — even for a query that targets its
    // (still-valid) cached vector.
    const alphaQuery = await v2.recall('alpha — the one we will corrupt', 5)
    expect(alphaQuery.some(r => r.id === idA)).toBe(false)

    // Beta is still healthy and recallable — corruption was isolated.
    const betaQuery = await v2.recall('beta — the one that stays healthy', 5)
    expect(betaQuery.some(r => r.text.includes('beta'))).toBe(true)

    await v2.close()
  })

  it('does not leave an orphan when a .mem is DELETED during the startup window (ENOENT)', async () => {
    // Cross-device sync flavor: between cache validation (stats every file
    // → all present) and loadAndAuthenticate (re-reads each file), an OS
    // sync client (Dropbox / iCloud) delivers a deletion that was made on
    // another device. storage.get ENOENTs. The previous shape of the fix
    // skipped ENOENT under the "vanished file is benign" rule from the
    // cache-MISS path — but the cache-HIT path already restored that
    // file's chunks into the index from the cached blob. Without
    // tombstoning, those chunks survive every future restart (saveIndexCache
    // re-serialises the index AS-IS; the entries it writes come from
    // metaById which never knew about the file).
    const v1 = makeVault()
    await v1.startup()
    const { id: idA } = await v1.writeMemento({ text: 'delta — about to vanish' })
    await v1.writeMemento({ text: 'epsilon — the survivor' })
    await v1.close()

    // Simulate the cross-device delete arriving between cache validation
    // and per-file authentication. We pre-delete here; the cache freshness
    // gate's stat will fail for this file → tryLoadIndexCache returns null
    // → cache-MISS path runs, which doesn't exercise the orphan bug.
    //
    // To exercise the cache-HIT path, we delete AFTER the cache validates:
    // the simplest way to make that deterministic is to spy on storage.get
    // so the validation's stat sees the file, but the loadAndAuthenticate's
    // read returns ENOENT.
    const v2 = makeVault()
    const storage = (v2 as unknown as { deps: { storage: { get: (p: string) => Promise<{ data: Buffer; etag: string }> } } }).deps.storage
    const realGet = storage.get.bind(storage)
    storage.get = async (path: string) => {
      if (path === `${idA}.mem`) {
        const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException
        throw err
      }
      return realGet(path)
    }
    await v2.startup()

    // Stronger contract: findDuplicate uses index.search; an identical
    // text would produce an identical FakeEmbedder vector, so if the
    // orphan is still in the index the duplicate guard returns idA
    // (now ENOENT'd) and writeMemento throws DuplicateMementoError. With
    // the orphan tombstoned, the new write succeeds with a fresh id.
    const result = await v2.writeMemento({ text: 'delta — about to vanish' })
    expect(result.id).not.toBe(idA)

    await v2.close()
  })

  it('write_memento cannot rank the orphan as a duplicate', async () => {
    // Same setup as above. The duplicate check uses `index.search(vector, 1)`
    // bypassing rankSemantic, so it's a separate audit surface for the
    // same orphan-in-index bug.
    const v1 = makeVault()
    await v1.startup()
    const { id: idA } = await v1.writeMemento({ text: 'gamma — destined for corruption' })
    await v1.close()

    corruptMemPreservingMtime(join(dir, `${idA}.mem`))

    const v2 = makeVault()
    await v2.startup()

    // Writing a near-duplicate must not crash with "this duplicates idA"
    // (which would then leak via getMemento — also broken). With the
    // orphan tombstoned, findDuplicate sees nothing in the index for
    // this id, so the write proceeds normally.
    const result = await v2.writeMemento({ text: 'gamma — another fresh memento' })
    expect(result.id).toBeDefined()
    expect(result.id).not.toBe(idA)

    await v2.close()
  })
})
