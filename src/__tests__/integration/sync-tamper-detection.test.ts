/**
 * Sync's content-swap detection (regression for v3 #2).
 *
 * Pre-v3, doSync's per-file body re-implemented the .mem load inline (parse JSON,
 * decrypt vector, add to index) WITHOUT the filename↔mem.id check that startup's
 * loadAndAuthenticate did. That meant an attacker (or a botched cp) could replace
 * A.mem's content with a valid B.mem, and sync would silently absorb it: index gets
 * a duplicate B-keyed entry, metaById ends up with stale A-keyed metadata pointing
 * at the new B-content. Startup caught it; sync didn't.
 *
 * v3 fix: doSync now goes through loadAndAuthenticate. This test rotates two real
 * .mem files between disk locations and confirms sync logs the id-mismatch warning
 * and refuses to add the wrong-id content to the index.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFile, writeFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { setupTestEnv, runInitWithFlags, forceSyncEveryRead, type IntegrationContext } from './_helpers.js'

describe('sync detects file-content swap (regression for v3 #2)', () => {
  let ctx: IntegrationContext

  beforeEach(async () => { ctx = await setupTestEnv() })
  afterEach(async () => { await ctx.cleanup() })

  it('logs id-mismatch warning when a.mem holds b.mem content; doesn\'t corrupt index', async () => {
    await runInitWithFlags([
      '--backend=local',
      '--embedder=minilm',
      '--index=hnsw',
      '--key=env',
      '--integrations=none',
    ])

    // Write two memories so we have two .mem files to play with
    const { buildVault } = await import('../../cli/_utils/vault.js')
    const vault1 = await buildVault()
    forceSyncEveryRead(vault1)  // catch the tamper immediately on next read
    await vault1.startup()

    const { id: idA } = await vault1.writeMemento({ text: 'memory A about cats', tags: ['cats'] })
    const { id: idB } = await vault1.writeMemento({ text: 'memory B about dogs', tags: ['dogs'] })

    // Swap the file contents on disk: make a.mem hold b.mem's content.
    // (Both .mem files are valid envelopes — AAD authenticates because the inner
    // mem.id and metadata are b's. The filename gives away that something's wrong:
    // a.mem ≠ b inside.)
    const aPath = join(ctx.vaultPath, `${idA}.mem`)
    const bPath = join(ctx.vaultPath, `${idB}.mem`)
    const bContent = await readFile(bPath)
    await writeFile(aPath, bContent)
    // Bump mtime so doSync sees the file as updated (otherwise it skips re-load)
    const future = new Date(Date.now() + 60_000)
    await utimes(aPath, future, future)

    // Spy on stderr to capture the tampering warning. Reading via vault triggers
    // syncIfStale → doSync → loadAndAuthenticate → throws "id mismatch" → caught
    // and logged.
    const warnings: string[] = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation((msg: string) => {
      warnings.push(msg)
    })

    try {
      // Trigger a sync via any RAM-only read entry point — getTags walks the
      // in-RAM tag index without decrypting individual .mem files. The swap
      // is caught inside doSync (loadAndAuthenticate throws → caught + logged),
      // and the in-RAM metadata for idA is left untouched.
      await vault1.getTags()
    } finally {
      errSpy.mockRestore()
    }

    expect(warnings.some(w => w.includes('id mismatch') && w.includes(idA))).toBe(true)

    // The whole guarantee is doSync's order: loadAndAuthenticate throws on the swap
    // BEFORE unregister/register mutate the index, so the tampered file is refused and
    // idA's RAM state is intact. Verify directly via metaById (no decrypt path) — a
    // future reorder that dropped or grafted idA here would still log the warning but
    // lose data on the next read.
    const aMeta = (vault1 as unknown as { metaById: { get(id: string): { tags: string[] } | undefined } }).metaById.get(idA)
    expect(aMeta?.tags).toEqual(['cats'])
  }, 90_000)
})
