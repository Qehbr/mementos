/**
 * End-to-end: machine A inits git backend → writes a memory; machine B inits against
 * the same remote → reads A's memory.
 *
 * This is the regression test for the v3 #1 bug where `vault.json` was written via
 * direct `fs.writeFile`, never staged/committed/pushed by GitBackend, and machine B's
 * clone came up without it. Pre-fix, step 4 here would fail with "no vault found" on
 * machine B because `vault.json` was missing from the clone.
 *
 * Both machines share `MEMENTOS_RAW_KEY` (set once in setupTestEnv) — that's how the
 * vault key travels in env-mode. In keychain mode the user would re-enter the same
 * mnemonic on machine B; in env mode we use the same env var.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  setupTestEnv, runInitWithFlags, mkTmpSubdir, initBareRepo,
  type IntegrationContext,
} from './_helpers.js'
import { renderRecall } from '../../core/render.js'

describe('git backend cross-device sync (regression for v3 #1)', () => {
  let ctxA: IntegrationContext
  let bareRepo: string

  beforeEach(async () => {
    ctxA = await setupTestEnv()
    bareRepo = await mkTmpSubdir('bare-repo')
    initBareRepo(bareRepo)
  })

  afterEach(async () => {
    await ctxA.cleanup()
    // bareRepo cleanup not needed — each test gets a fresh one and the parent
    // test-tmp dir is wiped by the suite-level helper if we ever add one.
  })

  it('machine A pushes vault.json, machine B clones and reads A\'s memory', async () => {
    // ─── Machine A: fresh init, write memory ────────────────────────────────
    await runInitWithFlags([
      '--backend=git',
      `--git-remote=${bareRepo}`,
      '--embedder=minilm',
      '--index=hnsw',
      '--key=env',
      '--integrations=none',
    ])

    // vault.json was committed to the bare repo (the v3 fix). Pre-fix it would have
    // landed only on disk and machine B's clone would come up empty.
    const vaultJsonInBare = execSync(
      `git -C ${JSON.stringify(bareRepo)} show main:vault.json`,
      { encoding: 'utf8' },
    )
    expect(JSON.parse(vaultJsonInBare)).toEqual({ embedder: 'minilm' })

    // Write a memory on A
    const { buildVault } = await import('../../cli/_utils/vault.js')
    const vaultA = await buildVault()
    await vaultA.startup()
    const { id: idA } = await vaultA.writeMemento({ text: 'the user prefers tabs over spaces', tags: ['preferences'] })

    // The .mem file got pushed to the bare repo too
    const memInBare = execSync(
      `git -C ${JSON.stringify(bareRepo)} ls-tree main`,
      { encoding: 'utf8' },
    )
    expect(memInBare).toContain('vault.json')
    expect(memInBare).toContain(`${idA}.mem`)

    // ─── Switch to Machine B: same key (env), different HOME ─────────────────
    // Save A's MEMENTOS_RAW_KEY — machine B uses the same key so it can decrypt.
    const sharedKey = ctxA.rawKey
    await ctxA.cleanup()
    const ctxB = await setupTestEnv()
    process.env['MEMENTOS_RAW_KEY'] = sharedKey  // override the new random key with A's

    try {
      await runInitWithFlags([
        '--mode=join',  // machine B clones A's remote and adopts the vault
        '--backend=git',
        `--git-remote=${bareRepo}`,
        '--index=hnsw',
        '--key=env',
        '--integrations=none',
      ])

      // Machine B adopted the existing vault.json from the clone — config matches A's.
      // Pre-v3-fix, vault.json wouldn't be in the clone and init would have written
      // a fresh one. The integration concern is "do we adopt vs overwrite."
      const vaultRawB = await readFile(join(ctxB.vaultPath, 'vault.json'), 'utf8')
      expect(JSON.parse(vaultRawB)).toEqual({ embedder: 'minilm' })

      // Machine B can read A's memory — the .mem arrived via clone, the AES key matches,
      // and the embedder dimensions match (both machines use 'minilm').
      const vaultB = await buildVault()
      await vaultB.startup()
      const retrieveResult = renderRecall(await vaultB.recall('the user prefers tabs over spaces'))
      expect(retrieveResult).toContain('tabs over spaces')
      expect(retrieveResult).toContain(`id=${idA}`)
    } finally {
      await ctxB.cleanup()
    }

    // Re-set ctxA so afterEach's cleanup is a no-op
    ctxA = { ...ctxA, cleanup: async () => {} }
  }, 180_000)  // git clone + ONNX startup on two machines is the slow part
})
