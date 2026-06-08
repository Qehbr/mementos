/**
 * Live-read filename↔id binding (regression for the readMemento id-mismatch hole).
 *
 * `readMemento` (backing get_memento / recall / get_chronicle / range / update) decrypts a
 * `.mem` blob under AAD derived from the file's OWN `mem.id`. Without an explicit
 * `mem.id === id` check it would happily serve B's content out of A.mem: the AAD
 * authenticates against B (the blob's claimed id), and nothing verified that B is what was
 * asked for. `loadAndAuthenticate` enforced this at startup/sync, but the live read path
 * (sync throttled by the staleness window) did not.
 *
 * This swaps A.mem's bytes for B.mem's and confirms a direct read of A now THROWS rather
 * than returning B's plaintext labeled as A.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setupTestEnv, runInitWithFlags, type IntegrationContext } from './_helpers.js'

describe('readMemento rejects a file whose content was swapped for another memento', () => {
  let ctx: IntegrationContext

  beforeEach(async () => { ctx = await setupTestEnv() })
  afterEach(async () => { await ctx.cleanup() })

  it('throws id-mismatch when a.mem holds b.mem content (no sync in between)', async () => {
    await runInitWithFlags([
      '--backend=local',
      '--embedder=minilm',
      '--index=hnsw',
      '--key=env',
      '--integrations=none',
    ])

    const { buildVault } = await import('../../cli/_utils/vault.js')
    const vault = await buildVault()
    // NB: do NOT forceSyncEveryRead — startup sets lastSyncAt=now, so the read below stays
    // inside the staleness window and hits readMemento directly (the path under test), not doSync.
    await vault.startup()

    const { id: idA } = await vault.writeMemento({ text: 'memory A about cats', tags: ['cats'] })
    const { id: idB } = await vault.writeMemento({ text: 'memory B about dogs', tags: ['dogs'] })

    // Graft B's (valid, self-authenticating) envelope into A's filename on disk.
    const bContent = await readFile(join(ctx.vaultPath, `${idB}.mem`))
    await writeFile(join(ctx.vaultPath, `${idA}.mem`), bContent)

    // A direct read of A must refuse — it must not return B's plaintext as A.
    await expect(vault.getMemento(idA)).rejects.toThrow(/id mismatch/)

    await vault.close()
  }, 90_000)

  it('the query-ranked getMementos branch also refuses a swapped file', async () => {
    await runInitWithFlags([
      '--backend=local',
      '--embedder=minilm',
      '--index=hnsw',
      '--key=env',
      '--integrations=none',
    ])

    const { buildVault } = await import('../../cli/_utils/vault.js')
    const vault = await buildVault()
    await vault.startup()

    const { id: idA } = await vault.writeMemento({ text: 'memory A about cats', tags: ['cats'] })
    const { id: idB } = await vault.writeMemento({ text: 'memory B about dogs', tags: ['dogs'] })

    // Graft B's envelope into A's filename. A's vector is still in the in-RAM index, so a
    // query close to A's text ranks idA in — and loading it must hit the swapped bytes.
    const bContent = await readFile(join(ctx.vaultPath, `${idB}.mem`))
    await writeFile(join(ctx.vaultPath, `${idA}.mem`), bContent)

    // Range with a query → the ranked branch (the one that used to .catch(() => null)).
    await expect(
      vault.getMementos({ query: 'memory A about cats' }),
    ).rejects.toThrow(/id mismatch/)

    await vault.close()
  }, 90_000)
})
