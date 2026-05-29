/**
 * Integration tests for `mementos backup` / `mementos restore` — export the vault to a
 * plain directory and import it back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setupTestEnv, runInitWithFlags, ProcessExitError, type IntegrationContext } from './_helpers.js'
import { renderRecall } from '../../core/render.js'

describe('mementos backup / restore', () => {
  let ctx: IntegrationContext

  beforeEach(async () => {
    ctx = await setupTestEnv()
    await runInitWithFlags([
      '--backend=local', '--embedder=minilm', '--index=hnsw',
      '--key=env', '--integrations=none',
    ])
  })

  afterEach(async () => { await ctx.cleanup() })

  it('backup exports the vault; restore writes it back and the memory survives', async () => {
    const { buildVault } = await import('../../cli/_utils/vault.js')
    const v = await buildVault()
    await v.startup()
    await v.writeMemento({ text: 'a durable fact worth keeping', tags: ['t1'] })
    const memFiles = (await readdir(ctx.vaultPath)).filter(f => f.endsWith('.mem'))
    expect(memFiles).toHaveLength(1)

    // Export to a directory.
    const backupDir = join(ctx.homeDir, 'my-backup')
    const { runBackup, runRestore } = await import('../../cli/commands/backup.js')
    await runBackup(backupDir)
    expect((await readdir(backupDir)).filter(f => f.endsWith('.mem'))).toHaveLength(1)
    expect(await stat(join(backupDir, 'vault.json')).then(() => true).catch(() => false)).toBe(true)

    // Delete the memory from the live vault, then restore it from the backup.
    await rm(join(ctx.vaultPath, memFiles[0]!))
    await runRestore(backupDir)
    expect((await readdir(ctx.vaultPath)).filter(f => f.endsWith('.mem'))).toHaveLength(1)

    // The restored memory is readable end-to-end.
    const v2 = await buildVault()
    await v2.startup()
    expect(renderRecall(await v2.recall('a durable fact worth keeping'))).toContain('a durable fact worth keeping')
  }, 90_000)

  it('backup refuses while a migration is in progress', async () => {
    const { writeManifest } = await import('../../cli/_utils/migration-manifest.js')
    await writeManifest({
      type: 'key', startedAt: '2026-05-16T10:00:00Z',
      stagingPath: join(ctx.homeDir, '.mementos.migrating-test'),
      backupPath: join(ctx.homeDir, '.mementos.backup-test'),
      phase: 'staging',
    })
    const { runBackup } = await import('../../cli/commands/backup.js')
    await expect(runBackup(join(ctx.homeDir, 'b'))).rejects.toBeInstanceOf(ProcessExitError)
  }, 90_000)
})
