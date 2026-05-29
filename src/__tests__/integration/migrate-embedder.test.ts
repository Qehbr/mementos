/**
 * End-to-end embedder migration with mocked embedder registry. Uses two fake
 * embedders (different dimensions) so we can prove the migration actually re-embeds:
 * source produces 4-dim vectors, target produces 8-dim vectors. After migration,
 * every .mem's vector blob should decrypt to a vector of length 8.
 *
 * Also covers:
 *   - vault.json updated with new embedder name
 *   - HNSW cache file removed (will rebuild from new vectors on next startup)
 *   - Resume after a simulated crash (manifest exists, partial state)
 *   - Refuse fast when target embedder has same dimensions as current
 *
 * Test isolation contract — same posture as the other migrate tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { stagingDirFor, backupDirFor } from '../../cli/_utils/migration-backup.js'

const mockSelect = vi.fn<(...args: unknown[]) => Promise<string>>()
const mockInput = vi.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('')
const mockConfirm = vi.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(false)
const mockCheckbox = vi.fn<(...args: unknown[]) => Promise<string[]>>().mockResolvedValue([])

vi.mock('@inquirer/prompts', () => ({
  select: (opts: unknown) => mockSelect(opts),
  input: (opts: { validate?: (v: string) => true | string; default?: string }) =>
    mockInput(opts).then(value => {
      if (opts.validate) {
        const r = opts.validate(value)
        if (r !== true) throw new Error(`validation: ${r}`)
      }
      return value
    }),
  confirm: (opts: unknown) => mockConfirm(opts),
  checkbox: (opts: unknown) => mockCheckbox(opts),
}))

vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    getPassword(): string | null { return null }
    setPassword(_v: string): void {}
    deletePassword(): void {}
  },
}))

vi.mock('../../integrations/registry.js', () => ({
  loadIntegrations: async (): Promise<Map<string, unknown>> => new Map(),
}))

// Two fake embedders with different vector shapes so the migration can be observed.
// Both yield deterministic vectors so tests can also assert the new content if needed.
function makeFakeEmbedder(dimensions: number, valueBase: number): {
  type: string
  create: () => { dimensions: number; embed: (s: string) => Promise<Float32Array>; embedBatch: (texts: string[]) => Promise<Float32Array[]> }
  setupAtInit?: undefined
} {
  // Deterministic pseudo-random vector per text — FNV-1a hash → LCG sequence. Two
  // different texts produce essentially uncorrelated vectors (cosine sim near 0), so
  // they don't trip Vault's duplicate-detection check. valueBase makes the two fake
  // embedders distinguishable from each other beyond just dimensions.
  const embedOne = (text: string): Float32Array => {
    let h = 0x811c9dc5
    for (let j = 0; j < text.length; j++) {
      h = (h ^ text.charCodeAt(j)) * 0x01000193
      h = h & 0xffffffff
    }
    let state = (h >>> 0) ^ valueBase
    const result = new Float32Array(dimensions)
    for (let i = 0; i < dimensions; i++) {
      state = ((state * 1103515245) + 12345) & 0x7fffffff
      result[i] = (state / 0x7fffffff) * 2 - 1
    }
    return result
  }
  return {
    // Include valueBase so two fakes with the same dimensions don't collide on type and
    // dedup each other out of the registry Map. The same-dim test depends on having two
    // distinct 4-d embedders both reachable.
    type: `fake-${dimensions}d-v${valueBase}`,
    create: () => ({
      dimensions,
      embed: async (text: string) => embedOne(text),
      embedBatch: async (texts: string[]) => texts.map(embedOne),
    }),
  }
}

const fakeSource = makeFakeEmbedder(4, 1)
const fakeTarget = makeFakeEmbedder(8, 100)
const fakeTargetSameDim = makeFakeEmbedder(4, 999)

vi.mock('../../embeddings/registry.js', () => ({
  loadEmbedders: async () => new Map<string, ReturnType<typeof makeFakeEmbedder>>([
    [fakeSource.type, fakeSource],
    [fakeTarget.type, fakeTarget],
    [fakeTargetSameDim.type, fakeTargetSameDim],
  ]),
}))

class ProcessExitError extends Error {
  constructor(public code: number) { super(`process.exit(${code})`); this.name = 'ProcessExitError' }
}

describe('mementos migrate (embedder)', () => {
  let homeDir: string
  let origHome: string | undefined
  let origKey: string | undefined
  let origArgv: string[]
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'migrate-embedder-'))
    origHome = process.env['HOME']
    origKey = process.env['MEMENTOS_RAW_KEY']
    origArgv = process.argv
    process.env['HOME'] = homeDir
    process.env['MEMENTOS_RAW_KEY'] = randomBytes(32).toString('base64')
    vi.resetModules()

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0)
    }) as (code?: number) => never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    mockSelect.mockReset()
    mockInput.mockReset().mockResolvedValue('')
    mockConfirm.mockReset().mockResolvedValue(false)
    mockCheckbox.mockReset().mockResolvedValue([])
  })

  afterEach(async () => {
    exitSpy.mockRestore()
    vi.restoreAllMocks()
    process.argv = origArgv
    if (origHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = origHome
    if (origKey === undefined) delete process.env['MEMENTOS_RAW_KEY']
    else process.env['MEMENTOS_RAW_KEY'] = origKey
    await rm(homeDir, { recursive: true, force: true })
  })

  it('re-embeds every memory under the new embedder and updates vault.json', async () => {
    const vaultPath = join(homeDir, '.mementos')
    await runInit(['--backend=local', `--embedder=${fakeSource.type}`, '--index=hnsw',
      '--key=env', '--integrations=none', `--vault-path=${vaultPath}`])

    // Write a couple of memories — produces vectors of dim 4 (fakeSource).
    const { buildVault } = await import('../../cli/_utils/vault.js')
    const v = await buildVault()
    await v.startup()
    await v.writeMemento({ text: 'first memory', tags: ['t1'] })
    await v.writeMemento({ text: 'second memory', tags: ['t2'] })

    // Drive the migrate command: type=embedder, target=fakeTarget (dim 8).
    mockSelect
      .mockResolvedValueOnce('embedder')      // top-level migration type
      .mockResolvedValueOnce(fakeTarget.type)  // target embedder

    process.argv = ['node', 'mementos', 'migrate']
    const { runMigrate } = await import('../../cli/commands/migrate.js')
    await runMigrate()

    // vault.json now records the new embedder.
    const vaultJsonRaw = await readFile(join(vaultPath, 'vault.json'), 'utf8')
    expect(JSON.parse(vaultJsonRaw)).toEqual({ embedder: fakeTarget.type })

    // Every .mem's chunk vectors now have the target embedder's dimensions. Decrypt the
    // chunks payload of one and check the first chunk's vector length.
    const { decryptMemChunks } = await import('../../core/vault/aad.js')
    const { deriveKeyFromEntropy } = await import('../../keys/_utils/derivation/index.js')
    const key = deriveKeyFromEntropy(Buffer.from(process.env['MEMENTOS_RAW_KEY']!, 'base64'))

    const memFiles = (await readdir(vaultPath)).filter(f => f.endsWith('.mem'))
    expect(memFiles).toHaveLength(2)
    for (const f of memFiles) {
      const memBytes = await readFile(join(vaultPath, f), 'utf8')
      const mem = JSON.parse(memBytes)
      const chunks = decryptMemChunks(mem, key)
      expect(chunks[0].vector.length).toBe(fakeTarget.create().dimensions)
    }

    // HNSW cache was dropped — will rebuild on next startup. Cache lives at
    // ~/.config/mementos/cache/index.hnsw.enc, not in the vault directory.
    const { indexCacheFile } = await import('../../core/config.js')
    const cacheExists = await stat(indexCacheFile()).then(() => true).catch(() => false)
    expect(cacheExists).toBe(false)

    // Manifest is gone.
    const manifestExists = await stat(join(homeDir, '.config', 'mementos', 'migration-pending.json'))
      .then(() => true).catch(() => false)
    expect(manifestExists).toBe(false)
  }, 60_000)

  it('refuses when source and target embedder have the same dimensions', async () => {
    const vaultPath = join(homeDir, '.mementos')
    await runInit(['--backend=local', `--embedder=${fakeSource.type}`, '--index=hnsw',
      '--key=env', '--integrations=none', `--vault-path=${vaultPath}`])

    const { buildVault } = await import('../../cli/_utils/vault.js')
    const v = await buildVault()
    await v.startup()
    await v.writeMemento({ text: 'memory', tags: ['t1'] })

    mockSelect
      .mockResolvedValueOnce('embedder')
      .mockResolvedValueOnce(fakeTargetSameDim.type)  // same dim (4) as source

    process.argv = ['node', 'mementos', 'migrate']
    const { runMigrate } = await import('../../cli/commands/migrate.js')
    await expect(runMigrate()).rejects.toBeInstanceOf(ProcessExitError)

    // Manifest was written (for type-and-target tracking) but the migration didn't
    // run — vault.json still records the source embedder, vector still has source dim.
    const vaultJsonRaw = await readFile(join(vaultPath, 'vault.json'), 'utf8')
    expect(JSON.parse(vaultJsonRaw)).toEqual({ embedder: fakeSource.type })
  }, 60_000)

  it('resumes embedder migration from an existing manifest', async () => {
    const vaultPath = join(homeDir, '.mementos')
    await runInit(['--backend=local', `--embedder=${fakeSource.type}`, '--index=hnsw',
      '--key=env', '--integrations=none', `--vault-path=${vaultPath}`])

    const { buildVault } = await import('../../cli/_utils/vault.js')
    const v = await buildVault()
    await v.startup()
    await v.writeMemento({ text: 'survives the resume', tags: ['t1'] })

    // Simulate a previous in-progress migration: a manifest in the 'staging' phase with
    // an empty staging area — resume re-stages everything, then commits.
    const { writeManifest } = await import('../../cli/_utils/migration-manifest.js')
    await writeManifest({
      type: 'embedder',
      startedAt: '2026-05-12T18:00:00Z',
      targetEmbedder: fakeTarget.type,
      stagingPath: stagingDirFor(vaultPath, '2026-05-12T18:00:00Z'),
      backupPath: backupDirFor(vaultPath, '2026-05-12T18:00:00Z'),
      phase: 'staging',
    })

    // Resume prompt → user confirms continue.
    mockConfirm.mockResolvedValueOnce(true)

    process.argv = ['node', 'mementos', 'migrate']
    const { runMigrate } = await import('../../cli/commands/migrate.js')
    await runMigrate()

    // Migration finished using the manifest's target.
    const vaultJsonRaw = await readFile(join(vaultPath, 'vault.json'), 'utf8')
    expect(JSON.parse(vaultJsonRaw)).toEqual({ embedder: fakeTarget.type })

    const manifestExists = await stat(join(homeDir, '.config', 'mementos', 'migration-pending.json'))
      .then(() => true).catch(() => false)
    expect(manifestExists).toBe(false)
  }, 60_000)

  it('--abort with embedder manifest deletes the manifest, leaves vault untouched', async () => {
    const vaultPath = join(homeDir, '.mementos')
    await runInit(['--backend=local', `--embedder=${fakeSource.type}`, '--index=hnsw',
      '--key=env', '--integrations=none', `--vault-path=${vaultPath}`])

    const { buildVault } = await import('../../cli/_utils/vault.js')
    const v = await buildVault()
    await v.startup()
    await v.writeMemento({ text: 'untouched by abort', tags: ['t1'] })

    const { writeManifest } = await import('../../cli/_utils/migration-manifest.js')
    await writeManifest({
      type: 'embedder',
      startedAt: '2026-05-12T18:00:00Z',
      targetEmbedder: fakeTarget.type,
      stagingPath: stagingDirFor(vaultPath, '2026-05-12T18:00:00Z'),
      backupPath: backupDirFor(vaultPath, '2026-05-12T18:00:00Z'),
      phase: 'staging',
    })

    const beforeVaultJson = await readFile(join(vaultPath, 'vault.json'), 'utf8')

    process.argv = ['node', 'mementos', 'migrate', '--abort']
    const { runMigrate } = await import('../../cli/commands/migrate.js')
    await runMigrate()

    // Manifest gone, vault.json untouched.
    const manifestExists = await stat(join(homeDir, '.config', 'mementos', 'migration-pending.json'))
      .then(() => true).catch(() => false)
    expect(manifestExists).toBe(false)
    const afterVaultJson = await readFile(join(vaultPath, 'vault.json'), 'utf8')
    expect(afterVaultJson).toBe(beforeVaultJson)
  }, 60_000)
})

async function runInit(flags: string[]): Promise<void> {
  const has = (n: string): boolean => flags.some(f => f === `--${n}` || f.startsWith(`--${n}=`))
  const allFlags = [...flags]
  if (!has('retriever')) allFlags.push('--retriever=semantic')
  if (!has('searcher')) allFlags.push('--searcher=none')
  process.argv = ['node', 'mementos', 'init', '--mode=new', ...allFlags]
  const { runInit: r } = await import('../../cli/commands/init.js')
  await r()
}

// silence unused warning on writeFile — referenced for potential future test fixtures
void writeFile
