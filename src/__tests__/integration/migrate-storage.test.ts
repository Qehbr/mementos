/**
 * End-to-end storage migration: init a vault at one local path, write a memory, run
 * `mementos migrate` against a different target path, then assert the target has the
 * full vault contents, the machine config now points at the target, and the manifest
 * is gone. Plus a `--abort` scenario that verifies the target dir is removed and the
 * source stays untouched.
 *
 * Test isolation contract — same posture as the destroy tests:
 *   - HOME is per-test tmpdir
 *   - @napi-rs/keyring is mocked to a no-op so the real OS keychain is never touched
 *   - @inquirer/prompts is mocked so prompts don't hang on stdin
 *   - The integration registry is mocked to nothing so real `claude` config can't be hit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, stat, readFile } from 'node:fs/promises'
import { setFakeHome } from '../_utils/fake-home.js'
import { setFakeTTY } from '../_utils/fake-tty.js'
import { TMP_ROOT } from './_helpers.js'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const mockSelect = vi.fn<(...args: unknown[]) => Promise<string>>()
const mockInput = vi.fn<(...args: unknown[]) => Promise<string>>()
const mockConfirm = vi.fn<(...args: unknown[]) => Promise<boolean>>()
const mockCheckbox = vi.fn<(...args: unknown[]) => Promise<string[]>>().mockResolvedValue([])

vi.mock('@inquirer/prompts', () => ({
  select: (opts: unknown) => mockSelect(opts),
  input: (opts: { validate?: (v: string) => true | string }) =>
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

// No real integrations should ever run. None are needed for migration, but the init
// path that sets up the source vault would normally touch them.
vi.mock('../../integrations/registry.js', () => ({
  loadIntegrations: async (): Promise<Map<string, unknown>> => new Map(),
}))

class ProcessExitError extends Error {
  constructor(public code: number) { super(`process.exit(${code})`); this.name = 'ProcessExitError' }
}

describe('mementos migrate (storage)', () => {
  let homeDir: string
  let restoreHome: () => void
  let origKey: string | undefined
  let origArgv: string[]
  let exitSpy: ReturnType<typeof vi.spyOn>

  let restoreTTY: () => void

  beforeEach(async () => {
    // These tests mock @inquirer/prompts to stand in for a user at the wizard; the
    // prompt helpers also require a terminal, which vitest's stdin is not.
    restoreTTY = setFakeTTY(true)
    // Repo-local fake home (not os.tmpdir()): requireFromPlugins' walk-up must
    // reach the repo's node_modules, else init's hnsw setup runs a real npm
    // install (network + C++ toolchain) inside the test.
    await mkdir(TMP_ROOT, { recursive: true })
    homeDir = await mkdtemp(join(TMP_ROOT, 'migrate-storage-'))
    origKey = process.env['MEMENTOS_RAW_KEY']
    origArgv = process.argv
    restoreHome = setFakeHome(homeDir)
    process.env['MEMENTOS_RAW_KEY'] = randomBytes(32).toString('base64')
    vi.resetModules()

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0)
    }) as (code?: number) => never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    mockSelect.mockReset()
    mockInput.mockReset()
    mockConfirm.mockReset()
  })

  afterEach(async () => {
    restoreTTY()
    exitSpy.mockRestore()
    vi.restoreAllMocks()
    process.argv = origArgv
    restoreHome()
    if (origKey === undefined) delete process.env['MEMENTOS_RAW_KEY']
    else process.env['MEMENTOS_RAW_KEY'] = origKey
    await rm(homeDir, { recursive: true, force: true })
  })

  it('copies vault.json + .mem files to the target path and swaps the machine config', async () => {
    const sourcePath = join(homeDir, 'source-vault')
    const targetPath = join(homeDir, 'target-vault')

    // Set up the source vault.
    await runInit(['--backend=local', '--embedder=minilm', '--index=hnsw', '--key=env',
      '--integrations=none', `--vault-path=${sourcePath}`])

    // Write a memory so we have an actual .mem file to copy.
    const { buildVault } = await import('../../cli/_utils/vault.js')
    const v = await buildVault()
    await v.startup()
    await v.writeMemento({ text: 'a test memory to migrate', tags: ['tag1'] })

    // Now migrate. select calls fire for: migration type, target backend (within
    // promptChoice).
    mockSelect.mockResolvedValueOnce('storage')  // top-level type
    // promptChoice for target backend uses select too with default='git' — the test
    // wants local → local at a different path, so we resolve to 'local'.
    mockSelect.mockResolvedValueOnce('local')
    // promptPath for target vault path — uses input
    mockInput.mockResolvedValueOnce(targetPath)

    process.argv = ['node', 'mementos', 'migrate']
    const { runMigrate } = await import('../../cli/commands/migrate.js')
    await runMigrate()

    // Target has vault.json + the .mem file
    const targetVaultJson = await readFile(join(targetPath, 'vault.json'), 'utf8')
    expect(JSON.parse(targetVaultJson)).toMatchObject({ embedder: 'minilm' })
    const targetEntries = await import('node:fs/promises').then(m => m.readdir(targetPath))
    expect(targetEntries.filter(f => f.endsWith('.mem'))).toHaveLength(1)

    // Machine config swapped — points at target now.
    const machineRaw = await readFile(join(homeDir, '.config', 'mementos', 'config.json'), 'utf8')
    expect(JSON.parse(machineRaw)).toMatchObject({ vaultPath: targetPath, backend: 'local' })

    // Manifest is gone
    const manifestExists = await stat(join(homeDir, '.config', 'mementos', 'migration-pending.json'))
      .then(() => true).catch(() => false)
    expect(manifestExists).toBe(false)

    // Source is untouched — still has its original files
    const sourceEntries = await import('node:fs/promises').then(m => m.readdir(sourcePath))
    expect(sourceEntries).toContain('vault.json')
    expect(sourceEntries.filter(f => f.endsWith('.mem'))).toHaveLength(1)
  }, 120_000)

  it('--abort removes the target dir and the manifest, leaves source untouched', async () => {
    const sourcePath = join(homeDir, 'source-vault')
    const targetPath = join(homeDir, 'aborted-target')

    // Set up source + write a memory
    await runInit(['--backend=local', '--embedder=minilm', '--index=hnsw', '--key=env',
      '--integrations=none', `--vault-path=${sourcePath}`])
    const { buildVault } = await import('../../cli/_utils/vault.js')
    const v = await buildVault()
    await v.startup()
    await v.writeMemento({ text: 'memory before abort', tags: ['tag1'] })

    // Start migration but answer "no" at the resume prompt to abort. To get to the
    // resume prompt we need a manifest on disk — write one directly.
    const { writeManifest } = await import('../../cli/_utils/migration-manifest.js')
    await writeManifest({
      type: 'storage',
      startedAt: '2026-05-12T18:00:00Z',
      targetBackend: 'local',
      targetVaultPath: targetPath,
    })
    // Pre-create the target dir with a stray file so we can verify it's wiped.
    await import('node:fs/promises').then(m => m.mkdir(targetPath, { recursive: true }))
    await import('node:fs/promises').then(m => m.writeFile(join(targetPath, 'stray.mem'), 'leftover'))

    // Resume prompt → "Continue? [Y/n]" → user picks no
    mockConfirm.mockResolvedValueOnce(false)

    process.argv = ['node', 'mementos', 'migrate']
    const { runMigrate } = await import('../../cli/commands/migrate.js')
    await runMigrate()

    // Target dir is gone
    const targetGone = await stat(targetPath).then(() => false).catch(() => true)
    expect(targetGone).toBe(true)

    // Manifest is gone
    const manifestGone = await stat(join(homeDir, '.config', 'mementos', 'migration-pending.json'))
      .then(() => false).catch(() => true)
    expect(manifestGone).toBe(true)

    // Source vault is untouched
    const sourceEntries = await import('node:fs/promises').then(m => m.readdir(sourcePath))
    expect(sourceEntries).toContain('vault.json')
    expect(sourceEntries.filter(f => f.endsWith('.mem'))).toHaveLength(1)
  }, 60_000)

  it('refuses with a clear message when no machine config exists', async () => {
    // Fresh tmp HOME — no machine config.
    process.argv = ['node', 'mementos', 'migrate']
    const { runMigrate } = await import('../../cli/commands/migrate.js')
    await expect(runMigrate()).rejects.toBeInstanceOf(ProcessExitError)
  })

  it('refuses fast and friendly when the env key is missing (pre-flight check)', async () => {
    // Set up a vault using env provider, then UNSET the env var to simulate the
    // common "user opened a new shell and forgot to export MEMENTOS_RAW_KEY" case.
    // Migration should refuse BEFORE creating any target artifacts.
    const sourcePath = join(homeDir, 'source-vault')
    const targetPath = join(homeDir, 'target-vault')
    await runInit(['--backend=local', '--embedder=minilm', '--index=hnsw', '--key=env',
      '--integrations=none', `--vault-path=${sourcePath}`])

    delete process.env['MEMENTOS_RAW_KEY']

    // No need to set up select responses — we expect to exit before any prompt fires.
    process.argv = ['node', 'mementos', 'migrate', `--vault-path=${targetPath}`]
    const { runMigrate } = await import('../../cli/commands/migrate.js')
    await expect(runMigrate()).rejects.toBeInstanceOf(ProcessExitError)

    // The error should mention the missing key in a way the user can act on.
    const errorOutput = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join('\n')
    expect(errorOutput).toMatch(/vault key|MEMENTOS_RAW_KEY/)

    // Critically, no target dir was touched and no manifest was written.
    const targetExists = await stat(targetPath).then(() => true).catch(() => false)
    expect(targetExists).toBe(false)
    const manifestExists = await stat(join(homeDir, '.config', 'mementos', 'migration-pending.json'))
      .then(() => true).catch(() => false)
    expect(manifestExists).toBe(false)
  }, 60_000)

  it('resumes an interrupted migration: pre-existing manifest + partial target → completes copy', async () => {
    // Set up source vault and write two memories so we have content worth half-copying.
    const sourcePath = join(homeDir, 'source-vault')
    const targetPath = join(homeDir, 'resume-target')

    await runInit(['--backend=local', '--embedder=minilm', '--index=hnsw', '--key=env',
      '--integrations=none', `--vault-path=${sourcePath}`])
    const { buildVault } = await import('../../cli/_utils/vault.js')
    const v = await buildVault()
    await v.startup()
    await v.writeMemento({ text: 'memory one', tags: ['tag1'] })
    await v.writeMemento({ text: 'memory two', tags: ['tag2'] })

    // Simulate a previously-interrupted migration: the manifest is on disk and the
    // target dir already has SOME files copied (just vault.json), but no .mem files yet.
    const { writeManifest } = await import('../../cli/_utils/migration-manifest.js')
    await writeManifest({
      type: 'storage',
      startedAt: '2026-05-12T18:00:00Z',
      targetBackend: 'local',
      targetVaultPath: targetPath,
    })
    const fs = await import('node:fs/promises')
    await fs.mkdir(targetPath, { recursive: true })
    // Copy ONLY vault.json from source to simulate partial progress.
    const sourceVaultJson = await fs.readFile(join(sourcePath, 'vault.json'))
    await fs.writeFile(join(targetPath, 'vault.json'), sourceVaultJson)

    // Run migrate — should detect the manifest and prompt "Continue?". Answer yes.
    mockConfirm.mockResolvedValueOnce(true)

    process.argv = ['node', 'mementos', 'migrate']
    const { runMigrate } = await import('../../cli/commands/migrate.js')
    await runMigrate()

    // Target should now have vault.json + both .mem files
    const targetEntries = await fs.readdir(targetPath)
    expect(targetEntries).toContain('vault.json')
    expect(targetEntries.filter(f => f.endsWith('.mem'))).toHaveLength(2)

    // Machine config swapped
    const machineRaw = await fs.readFile(join(homeDir, '.config', 'mementos', 'config.json'), 'utf8')
    expect(JSON.parse(machineRaw)).toMatchObject({ vaultPath: targetPath })

    // Manifest gone
    const manifestGone = await stat(join(homeDir, '.config', 'mementos', 'migration-pending.json'))
      .then(() => false).catch(() => true)
    expect(manifestGone).toBe(true)
  }, 120_000)
})

/**
 * Invoke runInit with the given flags. Auto-injects --mode=new so the new mode prompt
 * doesn't fire. Doesn't auto-inject --vault-path because these tests set them
 * explicitly to control source/target locations.
 */
async function runInit(flags: string[]): Promise<void> {
  const has = (n: string): boolean => flags.some(f => f === `--${n}` || f.startsWith(`--${n}=`))
  const allFlags = [...flags]
  if (!has('retriever')) allFlags.push('--retriever=semantic')
  if (!has('searcher')) allFlags.push('--searcher=none')
  process.argv = ['node', 'mementos', 'init', '--mode=new', ...allFlags]
  const { runInit: r } = await import('../../cli/commands/init.js')
  await r()
}
