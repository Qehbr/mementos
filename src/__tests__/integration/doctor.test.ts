/**
 * End-to-end `mementos doctor` against:
 *   - a healthy fresh vault (all green)
 *   - a vault with no machine config (Config fails, everything downstream skips)
 *   - a vault where the env key has been removed (Key fails, Decrypt probe skips)
 *
 * Test isolation contract — same posture as the migrate / destroy tests: HOME is
 * per-test tmpdir, @napi-rs/keyring is mocked to a no-op, @inquirer/prompts is mocked,
 * integration registry is mocked empty so real `claude mcp` is never invoked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { setFakeHome } from '../_utils/fake-home.js'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  input: vi.fn().mockResolvedValue(''),
  confirm: vi.fn().mockResolvedValue(false),
  checkbox: vi.fn().mockResolvedValue([]),
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

describe('mementos doctor', () => {
  let homeDir: string
  let restoreHome: () => void
  let origKey: string | undefined
  let origArgv: string[]
  let exitSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'doctor-'))
    origKey = process.env['MEMENTOS_RAW_KEY']
    origArgv = process.argv
    restoreHome = setFakeHome(homeDir)
    process.env['MEMENTOS_RAW_KEY'] = randomBytes(32).toString('base64')
    vi.resetModules()

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0)
    }) as (code?: number) => never)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    exitSpy.mockRestore()
    logSpy.mockRestore()
    errSpy.mockRestore()
    process.argv = origArgv
    restoreHome()
    if (origKey === undefined) delete process.env['MEMENTOS_RAW_KEY']
    else process.env['MEMENTOS_RAW_KEY'] = origKey
    await rm(homeDir, { recursive: true, force: true })
  })

  it('reports all green for a healthy fresh vault', async () => {
    // Init a vault with one memory so the decrypt probe has something to chew on.
    await runInit([
      '--backend=local', '--embedder=minilm', '--index=hnsw', '--key=env',
      '--integrations=none', `--vault-path=${join(homeDir, '.mementos')}`,
    ])
    const { buildVault } = await import('../../cli/_utils/vault.js')
    const v = await buildVault()
    await v.startup()
    await v.writeMemento({ text: 'a memory the doctor will probe', tags: ['t1'] })

    process.argv = ['node', 'mementos', 'doctor']
    const { runDoctor } = await import('../../cli/commands/doctor.js')
    await runDoctor()  // should NOT throw — exit code 0 = no process.exit call

    const output = logSpy.mock.calls.flat().join('\n')
    // Every check should show the ✓ symbol; no ✗
    expect(output).not.toContain('✗')
    expect(output).toContain('All checks passed.')
    // Spot-check key sections
    expect(output).toMatch(/Config\s+✓/)
    expect(output).toMatch(/Vault path\s+✓/)
    expect(output).toMatch(/Key\s+✓/)
    expect(output).toMatch(/Storage\s+✓/)
    expect(output).toMatch(/Vault config\s+✓/)
    expect(output).toMatch(/Decrypt probe\s+✓/)
    expect(output).toMatch(/Embedder\s+✓/)
  }, 120_000)

  it('reports Config fail and skips downstream checks when no machine config exists', async () => {
    // Fresh tmp HOME, never ran init.
    process.argv = ['node', 'mementos', 'doctor']
    const { runDoctor } = await import('../../cli/commands/doctor.js')
    await expect(runDoctor()).rejects.toBeInstanceOf(ProcessExitError)

    const output = logSpy.mock.calls.flat().join('\n')
    // Config check should fail with the "not found" detail
    expect(output).toMatch(/Config\s+✗/)
    // Downstream checks should appear as skipped, not failed
    expect(output).toMatch(/Vault path\s+⊘.*machine config unavailable/)
    expect(output).toMatch(/Key\s+⊘.*machine config unavailable/)
    expect(output).toContain('Run: mementos init')
  })

  it('reports Key fail and skips decrypt probe when env var was removed', async () => {
    // Healthy init, then unset the env var to simulate "user opened a new shell."
    await runInit([
      '--backend=local', '--embedder=minilm', '--index=hnsw', '--key=env',
      '--integrations=none', `--vault-path=${join(homeDir, '.mementos')}`,
    ])
    delete process.env['MEMENTOS_RAW_KEY']

    process.argv = ['node', 'mementos', 'doctor']
    const { runDoctor } = await import('../../cli/commands/doctor.js')
    await expect(runDoctor()).rejects.toBeInstanceOf(ProcessExitError)

    const output = logSpy.mock.calls.flat().join('\n')
    expect(output).toMatch(/Key\s+✗/)
    expect(output).toMatch(/Decrypt probe\s+⊘.*key unavailable/)
    expect(output).toContain('MEMENTOS_RAW_KEY')
  }, 120_000)

  it('handles an empty vault (no .mem files yet) without a Decrypt probe failure', async () => {
    // Init but skip writing any memory.
    await runInit([
      '--backend=local', '--embedder=minilm', '--index=hnsw', '--key=env',
      '--integrations=none', `--vault-path=${join(homeDir, '.mementos')}`,
    ])

    process.argv = ['node', 'mementos', 'doctor']
    const { runDoctor } = await import('../../cli/commands/doctor.js')
    await runDoctor()  // empty vault is OK

    const output = logSpy.mock.calls.flat().join('\n')
    expect(output).not.toContain('✗')
    expect(output).toContain('no memories to probe')

    // Vault dir was created by init; confirm doctor saw it
    const vaultExists = await stat(join(homeDir, '.mementos')).then(() => true).catch(() => false)
    expect(vaultExists).toBe(true)
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
