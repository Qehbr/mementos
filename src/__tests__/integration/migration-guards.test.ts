/**
 * Integration tests for the migration-safety guards:
 *
 *   1. `buildVault` refuses to operate while a migration manifest is pending — so other
 *      commands fail with a clear message instead of a cryptic decrypt error.
 *   2. `mementos migrate` refuses while the daemon (`mementos start`) is running —
 *      a live daemon holds a stale key/config/embedder and would corrupt a migration.
 *      Liveness is the TCP probe in `assertNoServerRunning` → `isDaemonRunning`.
 *   3. `mementos migrate --abort` restores the vault from the backup when a key/embedder
 *      commit was interrupted mid-flight.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFile, readFile, mkdir, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setupTestEnv, runInitWithFlags, ProcessExitError, type IntegrationContext } from './_helpers.js'
import { stagingDirFor, backupDirFor } from '../../cli/_utils/migration-backup.js'

describe('migration guards', () => {
  let ctx: IntegrationContext

  beforeEach(async () => {
    ctx = await setupTestEnv()
    await runInitWithFlags([
      '--backend=local', '--embedder=minilm', '--index=hnsw',
      '--key=env', '--integrations=none',
    ])
  })

  afterEach(async () => { await ctx.cleanup() })

  it('buildVault refuses to operate while a migration is pending', async () => {
    const { writeManifest } = await import('../../cli/_utils/migration-manifest.js')
    await writeManifest({
      type: 'key', startedAt: '2026-05-16T10:00:00Z',
      stagingPath: join(ctx.homeDir, '.mementos.migrating-test'),
      backupPath: join(ctx.homeDir, '.mementos.backup-test'),
      phase: 'staging',
    })

    const { buildVault } = await import('../../cli/_utils/vault.js')
    await expect(buildVault()).rejects.toThrow(/unfinished/)
  }, 90_000)

  // Closes the race the audit flagged: `mementos migrate` does its
  // `assertNoServerRunning` check up front, then prompts the user — possibly
  // for minutes. Without the preflight fence, an auto-started daemon during
  // that window would cache the old key and race the commit. The fence is a
  // minimal manifest written BEFORE any prompt that fails `buildVault` in
  // any spawning daemon.
  it('preflight fence makes buildVault refuse — closes the migrate-prompt race', async () => {
    const { withMigrationFence } = await import('../../cli/_utils/migration-manifest.js')
    const { buildVault } = await import('../../cli/_utils/vault.js')

    let buildResult: 'should-not-reach' | 'rejected' = 'should-not-reach'
    await withMigrationFence(async () => {
      // While `fn` is running (= the prompts in the real migrate path), a
      // racing daemon would call buildVault — assert it refuses.
      try { await buildVault(); buildResult = 'should-not-reach' }
      catch (e) {
        if ((e as Error).message.includes('unfinished')) buildResult = 'rejected'
        else throw e
      }
    })
    expect(buildResult).toBe('rejected')

    // After the fence completes cleanly, no manifest is left behind — the
    // next migrate / daemon-start sees a clear slate.
    const { readManifest } = await import('../../cli/_utils/migration-manifest.js')
    expect(await readManifest()).toBeNull()
  }, 90_000)

  // If the fence's `fn` throws (e.g. inquirer's ExitPromptError from a Ctrl-C
  // during a prompt), the manifest is still cleaned up.
  it('preflight fence cleans up after a throw inside fn', async () => {
    const { withMigrationFence, readManifest } = await import('../../cli/_utils/migration-manifest.js')
    await expect(
      withMigrationFence(async () => { throw new Error('simulated Ctrl-C') })
    ).rejects.toThrow(/simulated Ctrl-C/)
    expect(await readManifest()).toBeNull()
  }, 90_000)

  it('migrate refuses while the daemon is running', async () => {
    // Pretend a daemon is up. `assertNoServerRunning` reads its signal from
    // `isDaemonRunning()` (a TCP probe of the daemon port); spying on the
    // module export gives us a synchronous "true" without needing to start
    // a real daemon in the test process.
    const apiClient = await import('../../daemon/api-client.js')
    const spy = vi.spyOn(apiClient, 'isDaemonRunning').mockResolvedValue(true)
    try {
      process.argv = ['node', 'mementos', 'migrate']
      const { runMigrate } = await import('../../cli/commands/migrate.js')
      await expect(runMigrate()).rejects.toBeInstanceOf(ProcessExitError)
    } finally { spy.mockRestore() }
  }, 90_000)

  // restore writes through plain storage.putBatch outside the vault lock, so a live
  // daemon would race byte-level with the writes AND keep stale in-RAM state. The shared
  // assertNoServerRunning helper must refuse — same posture as migrate.
  it('restore refuses while the daemon is running', async () => {
    const apiClient = await import('../../daemon/api-client.js')
    const spy = vi.spyOn(apiClient, 'isDaemonRunning').mockResolvedValue(true)
    try {
      const { runRestore } = await import('../../cli/commands/backup.js')
      // Path doesn't have to exist — the guard fires before the directory check.
      await expect(runRestore('/tmp/nonexistent-backup-dir')).rejects.toBeInstanceOf(ProcessExitError)
    } finally { spy.mockRestore() }
  }, 90_000)

  // destroy removes ~/.config/mementos/ — which holds the daemon's PID + token
  // files. Under a live daemon that leaves the daemon running but
  // un-authenticatable (token gone) and un-stoppable (PID gone). The guard
  // must refuse BEFORE the interactive checkbox is shown.
  it('destroy refuses while the daemon is running', async () => {
    const apiClient = await import('../../daemon/api-client.js')
    const spy = vi.spyOn(apiClient, 'isDaemonRunning').mockResolvedValue(true)
    try {
      const { runDestroy } = await import('../../cli/commands/destroy.js')
      await expect(runDestroy()).rejects.toBeInstanceOf(ProcessExitError)
    } finally { spy.mockRestore() }
  }, 90_000)

  it('migrate --abort restores the vault from the backup after an interrupted embedder commit', async () => {
    const { deriveKeyFromEntropy } = await import('../../keys/_utils/derivation/index.js')
    const { encryptMemPayloads, memAad } = await import('../../core/vault/aad.js')
    const { decrypt } = await import('../../core/vault/crypto.js')
    const key = deriveKeyFromEntropy(Buffer.from(process.env['MEMENTOS_RAW_KEY']!, 'base64'))

    const id = randomUUID()
    const now = new Date().toISOString()
    const memFile = (chunks: Array<{ text: string; vector: number[] }>) => ({
      id,
      ...encryptMemPayloads(id, key, {
        chunks: Buffer.from(JSON.stringify(chunks), 'utf8'),
        meta: Buffer.from(JSON.stringify({ created_at: now, updated_at: now, tags: [] }), 'utf8'),
      }),
    })

    // The backup directory: the memento as it was BEFORE the migration — a 384-dim
    // vector (the MiniLM embedder), plus the vault.json the migration would restore.
    const backupDir = backupDirFor(ctx.vaultPath, '2026-05-16T10:00:00Z')
    await mkdir(backupDir, { recursive: true })
    await writeFile(join(backupDir, `${id}.mem`),
      JSON.stringify(memFile([{ text: 'a note', vector: Array(384).fill(0.1) }])))
    await copyFile(join(ctx.vaultPath, 'vault.json'), join(backupDir, 'vault.json'))

    // The live vault: the SAME memento mid-commit — swapped to a wrong (7) dimension.
    await writeFile(join(ctx.vaultPath, `${id}.mem`),
      JSON.stringify(memFile([{ text: 'a note', vector: [1, 2, 3, 4, 5, 6, 7] }])))

    const { writeManifest, readManifest } = await import('../../cli/_utils/migration-manifest.js')
    await writeManifest({
      type: 'embedder', startedAt: '2026-05-16T10:00:00Z', targetEmbedder: 'openai',
      stagingPath: stagingDirFor(ctx.vaultPath, '2026-05-16T10:00:00Z'),
      backupPath: backupDir, phase: 'committing',
    })

    process.argv = ['node', 'mementos', 'migrate', '--abort']
    const { runMigrate } = await import('../../cli/commands/migrate.js')
    await runMigrate()

    // The live vault was mid-commit (a 7-dim file ≠ vault.json's local/384) → abort
    // restored it from the backup. Manifest gone, the file back to 384 dimensions.
    expect(await readManifest()).toBeNull()
    const restored = JSON.parse(await readFile(join(ctx.vaultPath, `${id}.mem`), 'utf8'))
    const chunks = JSON.parse(decrypt(restored.chunks, key, memAad(id, 'chunks')).toString('utf8'))
    expect(chunks[0].vector.length).toBe(384)
  }, 120_000)
})
