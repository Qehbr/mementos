/**
 * End-to-end: `mementos init` (local backend) → write a memory → retrieve it.
 *
 * This is the test that would have caught the v2 #18 regression (OpenAI dim mismatch
 * birthing a broken vault) at integration time. Today after the v3 fix dimensions is
 * owned by the embedder; this test confirms the seam between init's config-write and
 * buildVault's component-construction stays intact.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setupTestEnv, runInitWithFlags, type IntegrationContext } from './_helpers.js'
import { renderRecall } from '../../core/render.js'

describe('init → buildVault → write → retrieve (local backend)', () => {
  let ctx: IntegrationContext

  beforeEach(async () => { ctx = await setupTestEnv() })
  afterEach(async () => { await ctx.cleanup() })

  it('writes machine config, vault config, and round-trips a memory', async () => {
    await runInitWithFlags([
      '--backend=local',
      '--embedder=local',
      '--index=hnsw',
      '--key=env',
      '--integrations=none',
    ])

    // Machine config landed at the test HOME, not the user's real ~/.mementos
    const machineRaw = await readFile(join(ctx.homeDir, '.config', 'mementos', 'config.json'), 'utf8')
    const machine = JSON.parse(machineRaw) as Record<string, unknown>
    expect(machine).toMatchObject({
      vaultPath: ctx.vaultPath,
      backend: 'local',
      vectorIndex: 'hnsw',
      keyProvider: 'env',
    })

    // Vault config has the embedder, NOT a separate dimensions field: a stored dimensions
    // would mismatch the embedder's actual dims on a future write — the embedder owns it.
    const vaultRaw = await readFile(join(ctx.vaultPath, 'vault.json'), 'utf8')
    const vault = JSON.parse(vaultRaw) as Record<string, unknown>
    expect(vault).toEqual({ embedder: 'local' })
    expect(vault).not.toHaveProperty('dimensions')

    // Now exercise the seam — buildVault must construct a working Vault from the
    // freshly-written configs, and write→retrieve must round-trip through the real
    // ONNX embedder + real HNSW index.
    const { buildVault } = await import('../../cli/_utils/vault.js')
    const v = await buildVault()
    await v.startup()

    const writeResult = await v.writeMemento({ text: 'the user prefers tabs over spaces', tags: ['preferences'] })
    expect(writeResult.id).toMatch(/^[0-9a-f-]{36}$/)

    // Exact-match query — guarantees retrieval distance is ~0 regardless of how the
    // embedder happens to score related-but-not-identical text. The integration concern
    // here is that the seam works (init → buildVault → write → retrieve roundtrips
    // through real components), not "is the embedder semantically smart."
    const retrieveResult = renderRecall(await v.recall('the user prefers tabs over spaces'))
    expect(retrieveResult).toContain('tabs over spaces')
    expect(retrieveResult).toContain('preferences')

    // .mem file actually landed in the vault directory (not somewhere else)
    const entries = await import('node:fs/promises').then(m => m.readdir(ctx.vaultPath))
    const memFiles = entries.filter(f => f.endsWith('.mem'))
    expect(memFiles).toHaveLength(1)

    // The write only marks the index cache dirty; close() flushes it to disk (the cache
    // is otherwise persisted by the periodic timer / on shutdown, not per-write).
    await v.close()

    // Cache file too — lives at ~/.config/mementos/cache/index.hnsw.enc (NOT inside the
    // vault) so that cloud-synced vault folders don't propagate per-machine state. Use
    // the same homedir() resolution the indexCacheFile helper uses; HOME is overridden
    // to ctx.homeDir for this test.
    const { indexCacheFile } = await import('../../core/config.js')
    const cacheStat = await stat(indexCacheFile()).catch(() => null)
    expect(cacheStat?.isFile()).toBe(true)
    // And critically: NOT in the vault directory anymore.
    const oldLocation = await stat(join(ctx.vaultPath, '_index.hnsw.enc')).catch(() => null)
    expect(oldLocation).toBeNull()

    // A write must register the file's REAL on-disk mtime, not Date.now() — otherwise the
    // cache just flushed fails its own per-file mtime check and the next startup silently
    // cold-rebuilds. Restart the vault and assert the cache was a HIT: a hit leaves the
    // cache file byte-identical (nothing re-flushed); a cold rebuild re-encrypts and
    // rewrites it. (`cacheBefore` is read before the restart, after the close above.)
    const cacheBefore = await readFile(indexCacheFile())
    const v2 = await buildVault()
    await v2.startup()
    expect(renderRecall(await v2.recall('the user prefers tabs over spaces'))).toContain('tabs over spaces')
    await v2.close()
    const cacheAfter = await readFile(indexCacheFile())
    expect(cacheAfter.equals(cacheBefore)).toBe(true)
  }, 120_000)  // ONNX model download on first run is slow; cached afterwards
})
