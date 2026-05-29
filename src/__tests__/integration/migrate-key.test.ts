/**
 * End-to-end key rotation: init a vault, write a memory, run `mementos migrate` of
 * type=key, verify the .mem file is re-encrypted under the new key, the keychain
 * carries the new mnemonic, the manifest is gone, and `buildVault` still works.
 *
 * Plus three crash-recovery flavors:
 *   - Resume with the SAME mnemonic finishes the migration
 *   - Resume with a DIFFERENT mnemonic refuses (key mismatch)
 *   - --abort while a manifest exists just deletes the manifest
 *
 * Test isolation contract — same as the other migrate / destroy tests:
 *   - HOME is per-test tmpdir
 *   - @napi-rs/keyring mocked so the OS keychain is never touched
 *   - @inquirer/prompts mocked so prompts don't hang
 *   - integrations registry mocked to empty so no real `claude` config is hit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, readdir, readFile, stat, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { stagingDirFor, backupDirFor } from '../../cli/_utils/migration-backup.js'

const mockSelect = vi.fn<(...args: unknown[]) => Promise<string>>()
const mockInput = vi.fn<(...args: unknown[]) => Promise<string>>()
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

class ProcessExitError extends Error {
  constructor(public code: number) { super(`process.exit(${code})`); this.name = 'ProcessExitError' }
}

/** All-zero entropy → "abandon abandon ... art" mnemonic. */
const ZERO_ENTROPY_MNEMONIC = Array(23).fill('abandon').concat(['art']).join(' ')

describe('mementos migrate (key)', () => {
  let homeDir: string
  let origHome: string | undefined
  let origKey: string | undefined
  let origArgv: string[]
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'migrate-key-'))
    origHome = process.env['HOME']
    origKey = process.env['MEMENTOS_RAW_KEY']
    origArgv = process.argv
    process.env['HOME'] = homeDir
    // Initial vault key — random base64 entropy.
    process.env['MEMENTOS_RAW_KEY'] = randomBytes(32).toString('base64')
    vi.resetModules()

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0)
    }) as (code?: number) => never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    mockSelect.mockReset()
    // Default mockInput resolves to '' — covers the "Press Enter to acknowledge"
    // prompts inside ctx.showSecret. Tests override with `.mockResolvedValueOnce(...)`
    // for the actual data prompts (mnemonic text, etc).
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

  it('re-encrypts every .mem file under the new key, swaps the stored key, deletes manifest', async () => {
    // Set up a fresh vault with two memories.
    await runInit([
      '--backend=local', '--embedder=local', '--index=hnsw', '--key=env',
      '--integrations=none', `--vault-path=${join(homeDir, '.mementos')}`,
    ])
    const { buildVault } = await import('../../cli/_utils/vault.js')
    const v = await buildVault()
    await v.startup()
    await v.writeMemento({ text: 'memory one', tags: ['t1'] })
    await v.writeMemento({ text: 'memory two', tags: ['t2'] })

    // Snapshot the .mem ciphertext bytes so we can prove they're different after rotation.
    const vaultDir = join(homeDir, '.mementos')
    const beforeFiles = (await readdir(vaultDir)).filter(f => f.endsWith('.mem'))
    expect(beforeFiles).toHaveLength(2)
    const beforeBytes: Record<string, string> = {}
    for (const f of beforeFiles) beforeBytes[f] = await readFile(join(vaultDir, f), 'utf8')

    // Drive the migrate command: type=key, then "type my own mnemonic". Double-entry
    // means the mnemonic prompt fires twice — supply the canonical all-abandons-then-art
    // phrase both times.
    mockSelect
      .mockResolvedValueOnce('key')   // migration type
      .mockResolvedValueOnce('type')  // how to provide new key
    mockInput
      .mockResolvedValueOnce(ZERO_ENTROPY_MNEMONIC)   // first entry
      .mockResolvedValueOnce(ZERO_ENTROPY_MNEMONIC)   // confirm entry

    process.argv = ['node', 'mementos', 'migrate']
    const { runMigrate } = await import('../../cli/commands/migrate.js')
    await runMigrate()

    // Manifest is gone.
    const manifestExists = await stat(join(homeDir, '.config', 'mementos', 'migration-pending.json'))
      .then(() => true).catch(() => false)
    expect(manifestExists).toBe(false)

    // A backup of the pre-rotation vault was kept (a `.mementos.backup-*` sibling).
    expect((await readdir(homeDir)).some(f => f.startsWith('.mementos.backup-'))).toBe(true)

    // Every .mem file's ciphertext changed (new IV/tag at minimum; new key in fact).
    const afterFiles = (await readdir(vaultDir)).filter(f => f.endsWith('.mem'))
    expect(afterFiles.sort()).toEqual(beforeFiles.sort())  // same id set, same count
    for (const f of afterFiles) {
      const after = await readFile(join(vaultDir, f), 'utf8')
      expect(after).not.toBe(beforeBytes[f])
    }

    // EnvKeyProvider can't mutate the parent shell's env, so the migration only PRINTS
    // the new MEMENTOS_RAW_KEY for the user to set. To prove the migration actually
    // re-encrypted under the new key, we set it ourselves and try to read the vault.
    process.env['MEMENTOS_RAW_KEY'] = Buffer.alloc(32, 0).toString('base64')

    vi.resetModules()
    const { buildVault: bv2 } = await import('../../cli/_utils/vault.js')
    const v2 = await bv2()
    // startup() decrypts every .mem to rebuild the index — succeeds only if all files
    // are readable under the new key. That's the end-to-end proof of key rotation.
    await v2.startup()
    expect(afterFiles).toHaveLength(2)
  }, 120_000)

  it('resume with the SAME mnemonic completes a partial key migration', async () => {
    // Build a vault, write a memory, simulate a partial key migration: leave a
    // manifest on disk + a .mem.new sibling (encrypted under the target mnemonic).
    await runInit([
      '--backend=local', '--embedder=local', '--index=hnsw', '--key=env',
      '--integrations=none', `--vault-path=${join(homeDir, '.mementos')}`,
    ])
    const { buildVault } = await import('../../cli/_utils/vault.js')
    const v = await buildVault()
    await v.startup()
    await v.writeMemento({ text: 'survives the rotation', tags: ['t1'] })

    // Simulate a previous attempt that crashed: a manifest in the 'staging' phase with an
    // empty staging area — resume re-stages everything, then commits.
    const { writeManifest } = await import('../../cli/_utils/migration-manifest.js')
    await writeManifest({
      type: 'key', startedAt: '2026-05-12T18:00:00Z',
      stagingPath: stagingDirFor(join(homeDir, '.mementos'), '2026-05-12T18:00:00Z'),
      backupPath: backupDirFor(join(homeDir, '.mementos'), '2026-05-12T18:00:00Z'),
      phase: 'staging',
    })

    // Drive the migrate command: detected manifest → confirm continue → re-prompt for
    // the new mnemonic (entered twice). Staging is empty, so any mnemonic is accepted and
    // resume re-stages + commits.
    mockConfirm.mockResolvedValueOnce(true)   // continue this migration
    mockSelect.mockResolvedValueOnce('type')  // type your own mnemonic
    mockInput
      .mockResolvedValueOnce(ZERO_ENTROPY_MNEMONIC)
      .mockResolvedValueOnce(ZERO_ENTROPY_MNEMONIC)

    process.argv = ['node', 'mementos', 'migrate']
    const { runMigrate } = await import('../../cli/commands/migrate.js')
    await runMigrate()

    // Manifest gone; .mem files rotated under the new key (verify by setting the env
    // var to the new entropy's base64 and reading the vault successfully).
    const manifestExists = await stat(join(homeDir, '.config', 'mementos', 'migration-pending.json'))
      .then(() => true).catch(() => false)
    expect(manifestExists).toBe(false)

    process.env['MEMENTOS_RAW_KEY'] = Buffer.alloc(32, 0).toString('base64')
    vi.resetModules()
    const { buildVault: bv2 } = await import('../../cli/_utils/vault.js')
    const v2 = await bv2()
    // startup() decrypts all .mem files — succeeds only if the rotation completed.
    await v2.startup()
  }, 120_000)

  it('resume with a WRONG mnemonic refuses cleanly when a staged file exists', async () => {
    // Build the vault.
    await runInit([
      '--backend=local', '--embedder=local', '--index=hnsw', '--key=env',
      '--integrations=none', `--vault-path=${join(homeDir, '.mementos')}`,
    ])
    const { buildVault } = await import('../../cli/_utils/vault.js')
    const v = await buildVault()
    await v.startup()
    await v.writeMemento({ text: 'first', tags: ['t1'] })
    await v.writeMemento({ text: 'second', tags: ['t2'] })

    // Simulate a partial migration: a staging directory holding ONE .mem already
    // re-encrypted under the original attempt's key (all-ones entropy). The live vault
    // itself is untouched (the staging model never writes to it before the commit).
    const vaultDir = join(homeDir, '.mementos')
    const memFiles = (await readdir(vaultDir)).filter(f => f.endsWith('.mem'))
    const stagingDir = stagingDirFor(join(homeDir, '.mementos'), '2026-05-12T18:00:00Z')
    const { deriveKeyFromEntropy } = await import('../../keys/_utils/derivation/index.js')
    const { reEncryptMem } = await import('../../core/vault/re-encrypt.js')
    const envKey = deriveKeyFromEntropy(Buffer.from(process.env['MEMENTOS_RAW_KEY']!, 'base64'))
    const attemptKey = deriveKeyFromEntropy(Buffer.alloc(32, 1))
    await mkdir(stagingDir, { recursive: true })
    const memBytes = await readFile(join(vaultDir, memFiles[0]!), 'utf8')
    await writeFile(
      join(stagingDir, memFiles[0]!),
      JSON.stringify(reEncryptMem(JSON.parse(memBytes), envKey, attemptKey)),
    )

    const { writeManifest } = await import('../../cli/_utils/migration-manifest.js')
    await writeManifest({
      type: 'key', startedAt: '2026-05-12T18:00:00Z',
      stagingPath: stagingDir,
      backupPath: backupDirFor(join(homeDir, '.mementos'), '2026-05-12T18:00:00Z'),
      phase: 'staging',
    })

    // User confirms continue, then provides the WRONG mnemonic (all zeros — not the
    // all-ones key the staged file is under), entered twice. The staging probe rejects it.
    mockConfirm.mockResolvedValueOnce(true)
    mockSelect.mockResolvedValueOnce('type')
    mockInput
      .mockResolvedValueOnce(ZERO_ENTROPY_MNEMONIC)
      .mockResolvedValueOnce(ZERO_ENTROPY_MNEMONIC)

    process.argv = ['node', 'mementos', 'migrate']
    const { runMigrate } = await import('../../cli/commands/migrate.js')
    await expect(runMigrate()).rejects.toBeInstanceOf(ProcessExitError)

    // Manifest is still in place — refuse should NOT touch it. User must explicitly
    // --abort or provide the right mnemonic.
    const manifestExists = await stat(join(homeDir, '.config', 'mementos', 'migration-pending.json'))
      .then(() => true).catch(() => false)
    expect(manifestExists).toBe(true)
  }, 120_000)

  it('--abort on an untouched vault finalizes cleanly and leaves the .mem files alone', async () => {
    await runInit([
      '--backend=local', '--embedder=local', '--index=hnsw', '--key=env',
      '--integrations=none', `--vault-path=${join(homeDir, '.mementos')}`,
    ])
    const { buildVault } = await import('../../cli/_utils/vault.js')
    const v = await buildVault()
    await v.startup()
    await v.writeMemento({ text: 'untouched by abort', tags: ['t1'] })

    const vaultDir = join(homeDir, '.mementos')
    const memFile = (await readdir(vaultDir)).find(f => f.endsWith('.mem'))!
    const before = await readFile(join(vaultDir, memFile), 'utf8')

    // A real backup directory + a manifest pointing at it — what a forward run leaves.
    const backupDir = backupDirFor(join(homeDir, '.mementos'), '2026-05-12T18:00:00Z')
    await cp(vaultDir, backupDir, { recursive: true })
    const { writeManifest } = await import('../../cli/_utils/migration-manifest.js')
    await writeManifest({
      type: 'key', startedAt: '2026-05-12T18:00:00Z',
      stagingPath: stagingDirFor(join(homeDir, '.mementos'), '2026-05-12T18:00:00Z'),
      backupPath: backupDir, phase: 'committing',
    })

    process.argv = ['node', 'mementos', 'migrate', '--abort']
    const { runMigrate } = await import('../../cli/commands/migrate.js')
    await runMigrate()

    // Nothing was rotated → the active key still opens every file → abort finalizes
    // without restoring. Manifest gone, backup consumed, .mem byte-identical.
    expect(await stat(join(homeDir, '.config', 'mementos', 'migration-pending.json'))
      .then(() => true).catch(() => false)).toBe(false)
    expect(await stat(backupDir).then(() => true).catch(() => false)).toBe(false)
    expect(await readFile(join(vaultDir, memFile), 'utf8')).toBe(before)
  }, 120_000)

  it('--abort restores the pre-migration vault from the backup (no mnemonic needed)', async () => {
    await runInit([
      '--backend=local', '--embedder=local', '--index=hnsw', '--key=env',
      '--integrations=none', `--vault-path=${join(homeDir, '.mementos')}`,
    ])
    const { buildVault } = await import('../../cli/_utils/vault.js')
    const v = await buildVault()
    await v.startup()
    await v.writeMemento({ text: 'first memory', tags: ['t1'] })
    await v.writeMemento({ text: 'second memory', tags: ['t2'] })

    const vaultDir = join(homeDir, '.mementos')
    // The backup a forward run takes before re-encrypting: a copy of the current vault.
    const backupDir = backupDirFor(join(homeDir, '.mementos'), '2026-05-12T18:00:00Z')
    await cp(vaultDir, backupDir, { recursive: true })

    // Simulate a half-done key migration: re-encrypt ONE .mem under a foreign key, so the
    // active (env) key can no longer open the whole vault.
    const memFiles = (await readdir(vaultDir)).filter(f => f.endsWith('.mem'))
    const { deriveKeyFromEntropy } = await import('../../keys/_utils/derivation/index.js')
    const { reEncryptMem } = await import('../../core/vault/re-encrypt.js')
    const envKey = deriveKeyFromEntropy(Buffer.from(process.env['MEMENTOS_RAW_KEY']!, 'base64'))
    const foreignKey = deriveKeyFromEntropy(Buffer.alloc(32, 7))
    const original = JSON.parse(await readFile(join(vaultDir, memFiles[0]!), 'utf8'))
    await writeFile(join(vaultDir, memFiles[0]!), JSON.stringify(reEncryptMem(original, envKey, foreignKey)))

    const { writeManifest } = await import('../../cli/_utils/migration-manifest.js')
    await writeManifest({
      type: 'key', startedAt: '2026-05-12T18:00:00Z',
      stagingPath: stagingDirFor(join(homeDir, '.mementos'), '2026-05-12T18:00:00Z'),
      backupPath: backupDir, phase: 'committing',
    })

    // --abort restores from the backup directory — no prompt, no mnemonic.
    process.argv = ['node', 'mementos', 'migrate', '--abort']
    const { runMigrate } = await import('../../cli/commands/migrate.js')
    await runMigrate()

    // Manifest gone, backup consumed; the whole vault is readable under the env key again.
    expect(await stat(join(homeDir, '.config', 'mementos', 'migration-pending.json'))
      .then(() => true).catch(() => false)).toBe(false)
    expect(await stat(backupDir).then(() => true).catch(() => false)).toBe(false)

    vi.resetModules()
    const { buildVault: bv2 } = await import('../../cli/_utils/vault.js')
    const v2 = await bv2()
    await v2.startup()  // succeeds only if every .mem was restored to the env key
  }, 120_000)

  it('typing mismatched mnemonic confirmations re-prompts, then completes on a match', async () => {
    await runInit([
      '--backend=local', '--embedder=local', '--index=hnsw', '--key=env',
      '--integrations=none', `--vault-path=${join(homeDir, '.mementos')}`,
    ])
    const { buildVault } = await import('../../cli/_utils/vault.js')
    const v = await buildVault()
    await v.startup()
    await v.writeMemento({ text: 'survives the rotation', tags: ['t1'] })

    // First confirmation pair does not match → double-entry re-prompts → second matches.
    const mismatch = Array(24).fill('zoo').join(' ')
    mockSelect.mockResolvedValueOnce('key').mockResolvedValueOnce('type')
    mockInput
      .mockResolvedValueOnce(ZERO_ENTROPY_MNEMONIC)  // attempt 1: first entry
      .mockResolvedValueOnce(mismatch)               // attempt 1: confirm — differs
      .mockResolvedValueOnce(ZERO_ENTROPY_MNEMONIC)  // attempt 2: first entry
      .mockResolvedValueOnce(ZERO_ENTROPY_MNEMONIC)  // attempt 2: confirm — matches

    process.argv = ['node', 'mementos', 'migrate']
    const { runMigrate } = await import('../../cli/commands/migrate.js')
    await runMigrate()

    // The migration completed once the two entries matched.
    expect(await stat(join(homeDir, '.config', 'mementos', 'migration-pending.json'))
      .then(() => true).catch(() => false)).toBe(false)
    process.env['MEMENTOS_RAW_KEY'] = Buffer.alloc(32, 0).toString('base64')
    vi.resetModules()
    const { buildVault: bv2 } = await import('../../cli/_utils/vault.js')
    await (await bv2()).startup()  // readable under the new (zero-entropy) key
  }, 120_000)
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
