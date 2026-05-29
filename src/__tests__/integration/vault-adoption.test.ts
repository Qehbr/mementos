/**
 * Init's adopt-vs-overwrite logic for `vault.json`.
 *
 * After `storage.init()`, init checks whether `vault.json` is already present in
 * storage (machine B's clone of an existing remote vault, or a re-init on machine A).
 * Two scenarios:
 *
 *   - Embedder matches: adopt the existing config. Don't overwrite.
 *   - Embedder differs: refuse — different embedders → incompatible vector spaces.
 *
 * The "matches" case is exercised in init-git-cross-device. This file covers the
 * "differs" refuse path, plus the local-backend pre-populated-dir case (someone
 * dropped a vault into a directory and points init at it).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setupTestEnv, runInitWithFlags, ProcessExitError, type IntegrationContext } from './_helpers.js'

describe('init adopts existing vault.json from storage', () => {
  let ctx: IntegrationContext

  beforeEach(async () => { ctx = await setupTestEnv() })
  afterEach(async () => { await ctx.cleanup() })

  it('adopts a pre-existing local vault.json without overwriting', async () => {
    // Pre-populate the vault dir as if someone had a vault there already (e.g.
    // restored from backup, or a Dropbox folder synced before mementos init ran).
    await mkdir(ctx.vaultPath, { recursive: true })
    await writeFile(
      join(ctx.vaultPath, 'vault.json'),
      JSON.stringify({ embedder: 'minilm' }),
      'utf8',
    )

    await runInitWithFlags([
      '--mode=join',  // pre-populated vault → joining, not creating
      '--backend=local',
      '--index=hnsw',
      '--key=env',
      '--integrations=none',
    ])

    // The pre-populated vault.json is preserved (init "Adopted" it rather than
    // overwriting). Same content as we put there.
    const adoptedRaw = await readFile(join(ctx.vaultPath, 'vault.json'), 'utf8')
    expect(JSON.parse(adoptedRaw)).toEqual({ embedder: 'minilm' })

    // Machine config was written too — adoption doesn't skip the rest of init.
    const machineRaw = await readFile(join(ctx.homeDir, '.config', 'mementos', 'config.json'), 'utf8')
    expect(JSON.parse(machineRaw)).toMatchObject({ backend: 'local', keyProvider: 'env' })
  }, 60_000)

  it('refuses to adopt when chosen embedder differs from existing vault.json', async () => {
    // Pre-existing vault used 'minilm' embedder
    await mkdir(ctx.vaultPath, { recursive: true })
    await writeFile(
      join(ctx.vaultPath, 'vault.json'),
      JSON.stringify({ embedder: 'minilm' }),
      'utf8',
    )

    // User runs init --mode=join asking for 'openai' — incompatible vector space.
    // The join flow reads vault.json from storage and refuses if --embedder= conflicts
    // with what's already there.
    await expect(
      runInitWithFlags([
        '--mode=join',
        '--backend=local',
        '--embedder=openai',  // <-- mismatch
        '--index=hnsw',
        '--key=env',
        '--integrations=none',
      ]),
    ).rejects.toBeInstanceOf(ProcessExitError)

    // Pre-existing vault.json was NOT overwritten by the failed init
    const stillRaw = await readFile(join(ctx.vaultPath, 'vault.json'), 'utf8')
    expect(JSON.parse(stillRaw)).toEqual({ embedder: 'minilm' })
  }, 60_000)
})
