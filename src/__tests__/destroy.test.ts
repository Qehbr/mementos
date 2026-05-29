/**
 * Tests for `mementos destroy`.
 *
 * Test isolation contract — these tests MUST NOT touch the developer's real mementos
 * setup or AI client integrations. Achieved by:
 *
 *   - HOME is overridden to a per-test tmpdir (mkdtemp under os.tmpdir())
 *   - `@napi-rs/keyring` is mocked to a no-op so the OS keychain is never touched
 *   - `@inquirer/prompts` is mocked so no stdin is required
 *   - `../integrations/registry.js` is mocked to return ONLY a fake test integration —
 *     `claude` is never spawned, real Claude Code / Desktop configs are never read or
 *     written, even if they exist
 *
 * Coverage:
 *   - ENOENT machine config → "nothing to destroy", exit 0
 *   - User aborts at the final confirm → exit 1, no files touched
 *   - User picks no targets → returns early without prompting confirm
 *   - Config removal → file actually gone
 *   - Vault data is NEVER removed → location surfaced in output instead
 *   - Key removal on keychain provider → fallback file actually gone
 *   - Key removal on env provider → prints unset instructions
 *   - "remove key but not data" → orphan warning fires before final confirm
 *   - Integration removal → integration.uninstall() actually invoked
 *   - Combined run (config + key + integrations) → all three side effects happen
 *   - Partial failure → other targets still run, exit code is 1
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mockCheckbox = vi.fn<(...args: unknown[]) => Promise<string[]>>()
const mockConfirm = vi.fn<(...args: unknown[]) => Promise<boolean>>()

vi.mock('@inquirer/prompts', () => ({
  checkbox: (opts: unknown) => mockCheckbox(opts),
  confirm: (opts: unknown) => mockConfirm(opts),
}))

// Force the keychain provider's getMnemonic to fall through to its file fallback —
// otherwise tests running on a developer machine with a real `mementos / default`
// keychain entry would see that entry instead of the per-test state we set up.
vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    getPassword(): string | null { return null }
    setPassword(_v: string): void {}
    deletePassword(): void {}
  },
}))

// Mock the integration registry so real Claude Code / Claude Desktop integration code
// NEVER runs in tests. Even though HOME is overridden, those integrations call out to
// `claude mcp remove` via execFile which can hit the user's real CLI — we don't want
// any path that could touch the dev machine's actual MCP setup.
const mockIntegration = {
  name: 'fake-test-integration',
  install: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  uninstall: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  isInstalled: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
  isClientPresent: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
}
vi.mock('../integrations/registry.js', () => ({
  loadIntegrations: async (): Promise<Map<string, { type: string; create: () => typeof mockIntegration }>> => {
    return new Map([['fake', { type: 'fake', create: () => mockIntegration }]])
  },
}))

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`)
    this.name = 'ProcessExitError'
  }
}

describe('destroy', () => {
  let homeDir: string
  let origHome: string | undefined
  let exitSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'destroy-'))
    origHome = process.env['HOME']
    process.env['HOME'] = homeDir
    vi.resetModules()

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0)
    }) as (code?: number) => never)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    mockCheckbox.mockReset()
    mockConfirm.mockReset()
    mockIntegration.install.mockReset().mockResolvedValue(undefined)
    mockIntegration.uninstall.mockReset().mockResolvedValue(undefined)
    mockIntegration.isInstalled.mockReset().mockResolvedValue(false)
    mockIntegration.isClientPresent.mockReset().mockResolvedValue(false)
  })

  afterEach(async () => {
    exitSpy.mockRestore()
    logSpy.mockRestore()
    errSpy.mockRestore()
    if (origHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = origHome
    await rm(homeDir, { recursive: true, force: true })
  })

  it('prints "nothing to destroy" when no machine config exists', async () => {
    const { runDestroy } = await import('../cli/commands/destroy.js')
    await runDestroy()
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/nothing to destroy/i)
    expect(mockCheckbox).not.toHaveBeenCalled()
  })

  it('removes the machine config file when the user picks it', async () => {
    await writeMachineConfig(homeDir, { keyProvider: 'env' })
    mockCheckbox.mockResolvedValue(['config'])
    mockConfirm.mockResolvedValue(true)

    const { runDestroy } = await import('../cli/commands/destroy.js')
    await runDestroy()

    const exists = await stat(machineConfigPath(homeDir)).then(() => true).catch(() => false)
    expect(exists).toBe(false)
  })

  it('never removes vault data — surfaces its location instead', async () => {
    const vaultPath = join(homeDir, '.mementos')
    await mkdir(vaultPath, { recursive: true })
    await writeFile(join(vaultPath, 'fake.mem'), 'doesnt-matter')
    await writeMachineConfig(homeDir, { keyProvider: 'env', vaultPath })
    mockCheckbox.mockResolvedValue(['config'])  // remove only config
    mockConfirm.mockResolvedValue(true)

    const { runDestroy } = await import('../cli/commands/destroy.js')
    await runDestroy()

    // Data dir + .mem file must still exist — mementos destroys nothing under vaultPath.
    const dirExists = await stat(vaultPath).then(() => true).catch(() => false)
    const memExists = await stat(join(vaultPath, 'fake.mem')).then(() => true).catch(() => false)
    expect(dirExists).toBe(true)
    expect(memExists).toBe(true)

    // And the user should be told where their data is so they can remove manually.
    const output = logSpy.mock.calls.flat().join('\n')
    expect(output).toMatch(/Vault data was NOT removed/)
    expect(output).toContain(vaultPath)
  })

  it('removes the keychain fallback file via the provider abstraction', async () => {
    // KeychainKeyProvider's clearStoredKey() deletes the chmod-600 fallback file at
    // ~/.local/share/mementos/key. Set one up, run destroy, assert it's gone.
    const fallbackFile = join(homeDir, '.local', 'share', 'mementos', 'key')
    await mkdir(join(homeDir, '.local', 'share', 'mementos'), { recursive: true })
    await writeFile(fallbackFile, 'pretend-mnemonic', 'utf8')
    await writeMachineConfig(homeDir, { keyProvider: 'keychain' })
    mockCheckbox.mockResolvedValue(['key'])
    mockConfirm.mockResolvedValue(true)

    const { runDestroy } = await import('../cli/commands/destroy.js')
    await runDestroy()

    const exists = await stat(fallbackFile).then(() => true).catch(() => false)
    expect(exists).toBe(false)
  })

  it('keeps the key file when the user removes config but NOT the key', async () => {
    // The fallback key file lives at ~/.local/share/mementos/key — deliberately outside
    // the ~/.config/mementos/ directory that the `config` target wipes wholesale. A user
    // who unchecks "Vault key" to keep it must not lose it to the config removal.
    const fallbackFile = join(homeDir, '.local', 'share', 'mementos', 'key')
    await mkdir(join(homeDir, '.local', 'share', 'mementos'), { recursive: true })
    await writeFile(fallbackFile, 'pretend-mnemonic', 'utf8')
    await writeMachineConfig(homeDir, { keyProvider: 'keychain' })
    mockCheckbox.mockResolvedValue(['config'])  // config only — key deliberately kept
    mockConfirm.mockResolvedValue(true)

    const { runDestroy } = await import('../cli/commands/destroy.js')
    await runDestroy()

    const configExists = await stat(machineConfigPath(homeDir)).then(() => true).catch(() => false)
    const keyExists = await stat(fallbackFile).then(() => true).catch(() => false)
    expect(configExists).toBe(false)  // config removed
    expect(keyExists).toBe(true)      // key preserved
  })

  it('prints unset instructions when env provider clears its key', async () => {
    await writeMachineConfig(homeDir, { keyProvider: 'env' })
    mockCheckbox.mockResolvedValue(['key'])
    mockConfirm.mockResolvedValue(true)

    const { runDestroy } = await import('../cli/commands/destroy.js')
    await runDestroy()

    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/unset MEMENTOS_RAW_KEY/)
  })

  it('aborts with exit code 1 if user declines final confirm', async () => {
    await writeMachineConfig(homeDir, { keyProvider: 'env' })
    mockCheckbox.mockResolvedValue(['config'])
    mockConfirm.mockResolvedValue(false)

    const { runDestroy } = await import('../cli/commands/destroy.js')
    await expect(runDestroy()).rejects.toBeInstanceOf(ProcessExitError)

    // Config file must still be present — abort means no side effects.
    const exists = await stat(machineConfigPath(homeDir)).then(() => true).catch(() => false)
    expect(exists).toBe(true)
  })

  it('returns early without confirming when user selects nothing', async () => {
    await writeMachineConfig(homeDir, { keyProvider: 'env' })
    mockCheckbox.mockResolvedValue([])

    const { runDestroy } = await import('../cli/commands/destroy.js')
    await runDestroy()

    expect(mockConfirm).not.toHaveBeenCalled()
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/nothing selected/i)
  })

  it('warns about orphaned data when key is selected but data is not', async () => {
    await writeMachineConfig(homeDir, { keyProvider: 'env' })
    mockCheckbox.mockResolvedValue(['key'])
    mockConfirm.mockResolvedValue(false)  // abort so we don't need to mock all the side effects

    const { runDestroy } = await import('../cli/commands/destroy.js')
    await expect(runDestroy()).rejects.toBeInstanceOf(ProcessExitError)

    const log = logSpy.mock.calls.flat().join('\n')
    expect(log).toMatch(/orphaned/i)
  })

  it('calls integration.uninstall() when integrations target is selected', async () => {
    await writeMachineConfig(homeDir, { keyProvider: 'env' })
    mockIntegration.isInstalled.mockResolvedValue(true)
    mockCheckbox.mockResolvedValue(['integrations'])
    mockConfirm.mockResolvedValue(true)

    const { runDestroy } = await import('../cli/commands/destroy.js')
    await runDestroy()

    expect(mockIntegration.uninstall).toHaveBeenCalledTimes(1)
  })

  it('runs all three targets when the user picks config + key + integrations', async () => {
    // Set up state that proves each branch executed: config file exists, fallback key
    // file exists, integration is "installed".
    const fallbackFile = join(homeDir, '.local', 'share', 'mementos', 'key')
    await mkdir(join(homeDir, '.local', 'share', 'mementos'), { recursive: true })
    await writeFile(fallbackFile, 'pretend-mnemonic', 'utf8')
    await writeMachineConfig(homeDir, { keyProvider: 'keychain' })
    mockIntegration.isInstalled.mockResolvedValue(true)
    mockCheckbox.mockResolvedValue(['config', 'key', 'integrations'])
    mockConfirm.mockResolvedValue(true)

    const { runDestroy } = await import('../cli/commands/destroy.js')
    await runDestroy()

    const configExists = await stat(machineConfigPath(homeDir)).then(() => true).catch(() => false)
    const fallbackExists = await stat(fallbackFile).then(() => true).catch(() => false)
    expect(configExists).toBe(false)
    expect(fallbackExists).toBe(false)
    expect(mockIntegration.uninstall).toHaveBeenCalledTimes(1)
  })

  it('continues other targets and exits 1 when one target throws', async () => {
    // Make integration uninstall reject. Config + key should still run.
    await writeMachineConfig(homeDir, { keyProvider: 'env' })
    mockIntegration.isInstalled.mockResolvedValue(true)
    mockIntegration.uninstall.mockRejectedValue(new Error('simulated integration failure'))
    mockCheckbox.mockResolvedValue(['config', 'key', 'integrations'])
    mockConfirm.mockResolvedValue(true)

    const { runDestroy } = await import('../cli/commands/destroy.js')
    await expect(runDestroy()).rejects.toBeInstanceOf(ProcessExitError)

    // Config target still ran despite integration failure.
    const configExists = await stat(machineConfigPath(homeDir)).then(() => true).catch(() => false)
    expect(configExists).toBe(false)
    // Integration was attempted but failed — error was surfaced to stderr.
    expect(errSpy.mock.calls.flat().join('\n')).toMatch(/simulated integration failure/)
  })

  // The git-SSH flow auto-generates a key at ~/.ssh/mementos_vault_<8-hex-of-remote>.
  // destroy must clean it up when removing config — otherwise an orphan keypair sits in
  // ~/.ssh forever after `mementos destroy` + `npm uninstall -g mementos`.
  it('removes the auto-generated per-vault SSH key when its path matches defaultSshKeyPath', async () => {
    const remote = 'git@github.com:alice/vault.git'
    const { defaultSshKeyPath } = await import('../storage/git/index.js')
    const keyPath = defaultSshKeyPath(remote)
    await mkdir(join(homeDir, '.ssh'), { recursive: true, mode: 0o700 })
    await writeFile(keyPath, 'fake-private', 'utf8')
    await writeFile(`${keyPath}.pub`, 'fake-public', 'utf8')
    await writeMachineConfig(homeDir, {
      keyProvider: 'env',
      backend: 'git',
      backendConfig: { remote, sshKeyPath: keyPath },
    })
    mockCheckbox.mockResolvedValue(['config'])
    mockConfirm.mockResolvedValue(true)

    const { runDestroy } = await import('../cli/commands/destroy.js')
    await runDestroy()

    expect(await stat(keyPath).then(() => true).catch(() => false)).toBe(false)
    expect(await stat(`${keyPath}.pub`).then(() => true).catch(() => false)).toBe(false)
  })

  it('leaves a user-supplied SSH key alone (path does not match defaultSshKeyPath)', async () => {
    const remote = 'git@github.com:alice/vault.git'
    const userKey = join(homeDir, '.ssh', 'my_own_key')
    await mkdir(join(homeDir, '.ssh'), { recursive: true, mode: 0o700 })
    await writeFile(userKey, 'user-owned-private', 'utf8')
    await writeFile(`${userKey}.pub`, 'user-owned-public', 'utf8')
    await writeMachineConfig(homeDir, {
      keyProvider: 'env',
      backend: 'git',
      backendConfig: { remote, sshKeyPath: userKey },
    })
    mockCheckbox.mockResolvedValue(['config'])
    mockConfirm.mockResolvedValue(true)

    const { runDestroy } = await import('../cli/commands/destroy.js')
    await runDestroy()

    // User's own key is untouched even though destroy ran with --config.
    expect(await stat(userKey).then(() => true).catch(() => false)).toBe(true)
    expect(await stat(`${userKey}.pub`).then(() => true).catch(() => false)).toBe(true)
  })
})

function machineConfigPath(homeDir: string): string {
  return join(homeDir, '.config', 'mementos', 'config.json')
}

async function writeMachineConfig(
  homeDir: string,
  partial: {
    keyProvider: string
    vaultPath?: string
    backend?: 'local' | 'git'
    backendConfig?: Record<string, unknown>
  },
): Promise<void> {
  const path = machineConfigPath(homeDir)
  await mkdir(join(homeDir, '.config', 'mementos'), { recursive: true })
  await writeFile(
    path,
    JSON.stringify({
      vaultPath: partial.vaultPath ?? join(homeDir, '.mementos'),
      backend: partial.backend ?? 'local',
      ...(partial.backendConfig ? { backendConfig: partial.backendConfig } : {}),
      keyProvider: partial.keyProvider,
      vectorIndex: 'hnsw',
    }),
    'utf8',
  )
}
