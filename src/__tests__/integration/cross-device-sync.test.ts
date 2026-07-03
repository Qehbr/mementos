/**
 * Passive cross-device sync — A writes/deletes after both machines are already
 * initialized; B's next read picks up the change via `syncIfStale → doSync`.
 *
 * `init-git-cross-device.test.ts` covers the *initial clone* case: B inits and
 * immediately sees A's already-pushed memory. This file covers ongoing operation:
 * A and B are both running, A makes changes, B sees them on next read without a
 * restart. That's the path that runs the set-difference reconciliation in `doSync`.
 *
 * Both writes and deletes go through. A delete on A removes the .mem file from
 * the bare repo; B's `storage.list()` no longer returns that id; the for-loop in
 * doSync detects the missing id, calls `index.remove()` and `metaById.delete()`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { vi, type MockInstance } from 'vitest'
import {
  TMP_ROOT, runInitWithFlags, mkTmpSubdir, initBareRepo, forceSyncEveryRead,
  ProcessExitError,
} from './_helpers.js'
import { renderRecall } from '../../core/render.js'

describe('cross-device passive sync (after both machines initialized)', () => {
  let homeA: string
  let homeB: string
  let bareRepo: string
  let sharedKey: string
  let exitSpy: MockInstance

  // Save originals so afterEach restores them — same shape as setupTestEnv but with
  // two HOMEs we flip between. USERPROFILE mirrors HOME throughout: os.homedir()
  // reads it on Windows, so flipping HOME alone would leave that platform on the
  // real home directory.
  let origHome: string | undefined
  let origProfile: string | undefined
  let origKey: string | undefined
  let origArgv: string[]

  beforeEach(async () => {
    await mkdir(TMP_ROOT, { recursive: true })
    homeA = await mkdtemp(join(TMP_ROOT, 'home-A-'))
    homeB = await mkdtemp(join(TMP_ROOT, 'home-B-'))
    bareRepo = await mkTmpSubdir('bare-repo')
    initBareRepo(bareRepo)

    sharedKey = randomBytes(32).toString('base64')
    origHome = process.env['HOME']
    origProfile = process.env['USERPROFILE']
    origKey = process.env['MEMENTOS_RAW_KEY']
    origArgv = process.argv
    process.env['MEMENTOS_RAW_KEY'] = sharedKey

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0)
    }) as (code?: number) => never)
  })

  afterEach(async () => {
    exitSpy.mockRestore()
    process.argv = origArgv
    if (origHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = origHome
    if (origProfile === undefined) delete process.env['USERPROFILE']
    else process.env['USERPROFILE'] = origProfile
    if (origKey === undefined) delete process.env['MEMENTOS_RAW_KEY']
    else process.env['MEMENTOS_RAW_KEY'] = origKey
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  })

  function useHome(home: string): void {
    process.env['HOME'] = home
    process.env['USERPROFILE'] = home
  }

  async function initOn(home: string): Promise<void> {
    useHome(home)
    await runInitWithFlags([
      '--backend=git',
      `--git-remote=${bareRepo}`,
      '--embedder=minilm',
      '--index=hnsw',
      '--key=env',
      '--integrations=none',
    ])
  }

  it('B sees a new memory A wrote after B was already initialized', async () => {
    // Both machines come online
    await initOn(homeA)
    await initOn(homeB)

    const { buildVault } = await import('../../cli/_utils/vault.js')

    useHome(homeA)
    const vaultA = await buildVault()
    await vaultA.startup()

    useHome(homeB)
    const vaultB = await buildVault()
    forceSyncEveryRead(vaultB)  // production throttle is 10 min; tests need every-read sync
    await vaultB.startup()

    // B starts empty (no memories pushed before B initialized)
    let onB = renderRecall(await vaultB.recall('the user prefers tabs'))
    expect(onB).toBe('No memories found.')

    // A writes a memory — git commit + push to bare repo
    useHome(homeA)
    const { id: idA } = await vaultA.writeMemento({ text: 'the user prefers tabs over spaces', tags: ['preferences'] })

    // B's next read triggers syncIfStale → doSync → git pull → set-difference picks
    // up the new .mem file → loadAndAuthenticate → index.add → metaById.set.
    onB = renderRecall(await vaultB.recall('the user prefers tabs over spaces'))
    expect(onB).toContain('tabs over spaces')
    expect(onB).toContain(`id=${idA}`)
  }, 180_000)

  it('B drops a memory A deleted after B already saw it', async () => {
    await initOn(homeA)
    await initOn(homeB)

    const { buildVault } = await import('../../cli/_utils/vault.js')

    useHome(homeA)
    const vaultA = await buildVault()
    await vaultA.startup()
    const { id: idA } = await vaultA.writeMemento({ text: 'the user uses Redux', tags: ['stack'] })

    // B picks up A's memory on initial sync
    useHome(homeB)
    const vaultB = await buildVault()
    forceSyncEveryRead(vaultB)
    await vaultB.startup()
    let onB = renderRecall(await vaultB.recall('the user uses Redux'))
    expect(onB).toContain('Redux')

    // A deletes it — `git rm` + commit + push
    useHome(homeA)
    await vaultA.deleteMemento(idA)

    // B's next read: doSync's set-difference (onDiskIds.has(id) === false for the
    // deleted one) drives `index.remove(id)` + `metaById.delete(id)`. After that,
    // recall doesn't find it. Pre-fix this would either ENOENT in the
    // read loop, or stale-show the deleted memory until restart.
    useHome(homeB)
    onB = renderRecall(await vaultB.recall('the user uses Redux'))
    expect(onB).toBe('No memories found.')
  }, 180_000)
})
