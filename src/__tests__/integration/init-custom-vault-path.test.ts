/**
 * `mementos init --vault-path=<custom>` lands the vault at that explicit path,
 * not the default `~/.mementos`. Covers the NFS / external-disk use case where
 * the user wants the .mem files somewhere other than the home directory.
 *
 * Also covers the empty-dir guard: new-vault init refuses if the chosen path is
 * non-empty (the user should clean it, pick a different path, or use --mode=join).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setupTestEnv, runInitWithFlags, ProcessExitError, type IntegrationContext } from './_helpers.js'

describe('init with --vault-path=<custom>', () => {
  let ctx: IntegrationContext

  beforeEach(async () => { ctx = await setupTestEnv() })
  afterEach(async () => { await ctx.cleanup() })

  it('writes vault.json at the custom path, machine config records it', async () => {
    const customVault = join(ctx.homeDir, 'somewhere-else', 'my-vault')

    await runInitWithFlags([
      '--backend=local',
      '--embedder=local',
      '--index=hnsw',
      '--key=env',
      '--integrations=none',
      `--vault-path=${customVault}`,
    ])

    // Machine config points at the explicit path (NOT <HOME>/.mementos)
    const machineRaw = await readFile(join(ctx.homeDir, '.config', 'mementos', 'config.json'), 'utf8')
    const machine = JSON.parse(machineRaw) as Record<string, unknown>
    expect(machine.vaultPath).toBe(customVault)

    // vault.json actually landed at the custom path (storage.init mkdir'd recursively)
    const vaultStat = await stat(join(customVault, 'vault.json'))
    expect(vaultStat.isFile()).toBe(true)

    // The default ~/.mementos was NOT created — the prompt's default did not leak.
    const defaultStat = await stat(join(ctx.homeDir, '.mementos')).catch(() => null)
    expect(defaultStat).toBeNull()
  })

  it('refuses --mode=new when the chosen vault path is non-empty', async () => {
    // Pre-populate the vault path with a file that has nothing to do with mementos.
    // New-vault init must refuse rather than mix mementos data with the user's stuff —
    // and point them at --mode=join in case they actually meant to attach.
    const vaultPath = join(ctx.homeDir, 'has-stuff')
    await mkdir(vaultPath, { recursive: true })
    await writeFile(join(vaultPath, 'something.txt'), 'pre-existing user file')

    await expect(
      runInitWithFlags([
        '--backend=local',
        '--embedder=local',
        '--index=hnsw',
        '--key=env',
        '--integrations=none',
        `--vault-path=${vaultPath}`,
      ]),
    ).rejects.toBeInstanceOf(ProcessExitError)

    // The pre-existing file is still there — refuse means no side effects.
    const fileExists = await stat(join(vaultPath, 'something.txt')).then(() => true).catch(() => false)
    expect(fileExists).toBe(true)

    // No machine config was written — the refuse fired before that point.
    const configExists = await stat(join(ctx.homeDir, '.config', 'mementos', 'config.json')).then(() => true).catch(() => false)
    expect(configExists).toBe(false)
  })
})
