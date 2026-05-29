/**
 * Integration tests for the migration-safety guards:
 *
 *   1. `buildVault` refuses to operate while a migration manifest is pending — so other
 *      commands fail with a clear message instead of a cryptic decrypt error.
 *   2. `mementos migrate` refuses while a `mementos serve` process is alive — a live
 *      server holds a stale key/config/embedder and would corrupt a migration.
 *   3. `mementos migrate --abort` restores the vault from the backup when a key/embedder
 *      commit was interrupted mid-flight.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
      '--backend=local', '--embedder=local', '--index=hnsw',
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

  it('migrate refuses while a mementos server is running', async () => {
    // Register THIS process as a running server — it is unquestionably alive.
    const { registerServe } = await import('../../cli/_utils/serve-registry.js')
    await registerServe()

    process.argv = ['node', 'mementos', 'migrate']
    const { runMigrate } = await import('../../cli/commands/migrate.js')
    await expect(runMigrate()).rejects.toBeInstanceOf(ProcessExitError)
  }, 90_000)

  // restore writes through plain storage.putBatch outside the vault lock, so a live
  // server would race byte-level with the writes AND keep stale in-RAM state. The shared
  // assertNoServerRunning helper must refuse — same posture as migrate.
  it('restore refuses while a mementos server is running', async () => {
    const { registerServe } = await import('../../cli/_utils/serve-registry.js')
    await registerServe()

    const { runRestore } = await import('../../cli/commands/backup.js')
    // Path doesn't have to exist — the guard fires before the directory check.
    await expect(runRestore('/tmp/nonexistent-backup-dir')).rejects.toBeInstanceOf(ProcessExitError)
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
    // vector (the local embedder), plus the vault.json the migration would restore.
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
