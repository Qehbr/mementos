/**
 * Pins the "_index tag is reserved for exactly one memento" invariant
 * across every write path — not just write_memento.
 *
 * The bug (Fable 5 audit finding): doWriteMemento's ReservedIndexTagError
 * guard was the only enforcer. doUpdateMemento's tags-replace and
 * doIngest's opts.tags both stamped INDEX_TAG without checking, letting
 * an AI attach _index to arbitrary mementos. findIndexMementoId picks
 * the lowest-sorted carrier, and the next update_memory_index call
 * silently rewrites that memento's body — destroying the user content
 * the AI thought it was tagging. On LocalBackend this is unrecoverable.
 *
 * The fix:
 *   - doUpdateMemento refuses INDEX_TAG when the target isn't already
 *     the current index memento.
 *   - doIngest refuses INDEX_TAG outright (bulk write, no "the one you
 *     meant to update" pivot makes sense).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setFakeHome } from './_utils/fake-home.js'
import { randomUUID } from 'node:crypto'
import { Vault, ReservedIndexTagError } from '../core/vault/index.js'
import { LocalBackend } from '../storage/local/index.js'
import { MnemonicKeyProvider } from '../keys/mnemonic/index.js'
import { FakeEmbedder, BruteForceIndex, FAKE_DIMS } from './helpers/fake.js'
import { SemanticRetriever } from '../retrievers/semantic/index.js'
import { ScanSearcher } from '../searchers/scan/index.js'
import { INDEX_TAG } from '../core/vault/constants.js'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'

let dir: string
let fakeHome: string
let restoreHome: () => void

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
  dir = await mkdtemp(join(tmpdir(), 'mementos-index-tag-'))
  fakeHome = await mkdtemp(join(tmpdir(), 'mementos-index-tag-home-'))
  restoreHome = setFakeHome(fakeHome)
})

afterEach(async () => {
  restoreHome()
  await rm(dir, { recursive: true, force: true })
  await rm(dir + '.lock', { recursive: true, force: true })
  await rm(fakeHome, { recursive: true, force: true })
})

describe('_index tag singleton — enforced on every write path', () => {
  it('updateMemento refuses to attach _index to a memento that is not the current index', async () => {
    const v = makeVault()
    await v.startup()

    // Seed the singleton index memento.
    const { id: indexId } = await v.writeMemento({ text: 'curated index', tags: [INDEX_TAG] })
    // Create an ordinary user memento.
    const { id: userId } = await v.writeMemento({ text: 'user content the AI must not clobber' })

    // The bug shape: the AI calls update_memento(userId, text, tags=[_index, "topic"]).
    // Without the guard this silently attaches _index to userId, and the next
    // update_memory_index resolves the singleton to userId (or indexId,
    // whichever sorts lower) and overwrites userId's text. With the guard,
    // the update is rejected pointing at the existing index.
    await expect(
      v.updateMemento(userId, 'something new', [INDEX_TAG, 'topic'])
    ).rejects.toBeInstanceOf(ReservedIndexTagError)

    // And the actionable error names the real index id so the AI can pivot.
    await v.updateMemento(userId, 'something new', [INDEX_TAG, 'topic']).catch((e: Error) => {
      expect(e.message).toContain(indexId)
    })

    await v.close()
  })

  it('updateMemento permits updating the EXISTING index memento with _index in its tags', async () => {
    // The legitimate path: update_memory_index calls updateMemento(indexId, ..., [INDEX_TAG]).
    // The guard must NOT block this — same-id is fine.
    const v = makeVault()
    await v.startup()
    const { id: indexId } = await v.writeMemento({ text: 'curated index', tags: [INDEX_TAG] })

    await expect(
      v.updateMemento(indexId, 'revised index body', [INDEX_TAG])
    ).resolves.toBeDefined()

    await v.close()
  })

  it('ingest refuses opts.tags containing _index outright', async () => {
    const v = makeVault()
    await v.startup()

    // The bug shape: hook ingests N chronicle turns and (deliberately or by
    // mistake) passes _index as a tag. N mementos would carry _index after
    // a single call, irreversibly breaking the singleton on LocalBackend.
    const mementos = [
      { mementoId: randomUUID(), text: 'turn one' },
      { mementoId: randomUUID(), text: 'turn two' },
    ]
    await expect(
      v.ingest(randomUUID(), mementos, { tags: [INDEX_TAG, 'source:test'] })
    ).rejects.toBeInstanceOf(ReservedIndexTagError)

    await v.close()
  })

  it('ingest with non-reserved tags works normally', async () => {
    // Sanity: the new check must not break the common case.
    const v = makeVault()
    await v.startup()
    const result = await v.ingest(randomUUID(), [
      { mementoId: randomUUID(), text: 'turn one' },
      { mementoId: randomUUID(), text: 'turn two' },
    ], { tags: ['source:test', 'topic'] })
    expect(result.added).toBe(2)
    await v.close()
  })
})
