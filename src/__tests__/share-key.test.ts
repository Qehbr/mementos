/**
 * Tests for `mementos share-key`.
 *
 * Covers the three branches:
 *   - TTY refusal: piped/redirected stdout aborts BEFORE reading the keychain
 *   - Keychain provider: canonical secret is a mnemonic; user can show it as-is or
 *     converted (HKDF) to a base64 raw key for env-provider receivers
 *   - Env provider: canonical secret is a raw base64 key; only one format is offered
 *
 * `@inquirer/prompts` is mocked at the top so we don't need a real stdin. The mocks
 * return whatever the test sets via `mockSelect` / `mockInput` before calling runShareKey.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const mockSelect = vi.fn<(...args: unknown[]) => Promise<string>>()
const mockInput = vi.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('')

vi.mock('@inquirer/prompts', () => ({
  select: (opts: unknown) => mockSelect(opts),
  input: (opts: unknown) => mockInput(opts),
}))

// Force the keychain branch to fall through to the file fallback. Otherwise these tests
// would read whatever real `mementos / default` entry exists on the developer's machine —
// which would silently pick the wrong mnemonic and look like a test failure.
vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    getPassword(): string | null { return null }
    setPassword(_v: string): void {}
    deletePassword(): void {}
  },
}))

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`)
    this.name = 'ProcessExitError'
  }
}

describe('share-key', () => {
  let homeDir: string
  let origHome: string | undefined
  let origKey: string | undefined
  let origIsTTY: boolean | undefined
  let exitSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'share-key-'))
    origHome = process.env['HOME']
    origKey = process.env['MEMENTOS_RAW_KEY']
    origIsTTY = process.stdout.isTTY
    process.env['HOME'] = homeDir
    process.stdout.isTTY = true

    // KeychainKeyProvider caches its FALLBACK_FILE path at module load time using
    // homedir(). Reset modules between tests so each test sees its own HOME (otherwise
    // the first test to load the module fixes the path for the rest of the suite).
    vi.resetModules()

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0)
    }) as (code?: number) => never)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    mockSelect.mockReset()
    mockInput.mockReset().mockResolvedValue('')
  })

  afterEach(async () => {
    exitSpy.mockRestore()
    logSpy.mockRestore()
    errSpy.mockRestore()
    if (origHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = origHome
    if (origKey === undefined) delete process.env['MEMENTOS_RAW_KEY']
    else process.env['MEMENTOS_RAW_KEY'] = origKey
    process.stdout.isTTY = origIsTTY
    await rm(homeDir, { recursive: true, force: true })
  })

  it('refuses when stdout is not a TTY', async () => {
    process.stdout.isTTY = false
    const { runShareKey } = await import('../cli/commands/share-key.js')
    await expect(runShareKey()).rejects.toBeInstanceOf(ProcessExitError)
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/requires an interactive terminal/))
    // Critically, we must NOT have read the keychain or written anything before refusing.
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('refuses with a clear message when no machine config exists', async () => {
    // HOME points at an empty tmpdir — readMachineConfig hits ENOENT.
    const { runShareKey } = await import('../cli/commands/share-key.js')
    await expect(runShareKey()).rejects.toBeInstanceOf(ProcessExitError)
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/No vault configured/))
  })

  it('shows raw entropy unchanged when env user picks raw format', async () => {
    // Set up a vault that uses env provider, with known entropy bytes.
    const entropy = randomBytes(32).toString('base64')
    process.env['MEMENTOS_RAW_KEY'] = entropy
    await writeMachineConfig(homeDir, { backend: 'local', keyProvider: 'env', vectorIndex: 'hnsw' })

    // Two selects: mode (show), then format (raw)
    mockSelect.mockResolvedValueOnce('show').mockResolvedValueOnce('raw')

    const { runShareKey } = await import('../cli/commands/share-key.js')
    await runShareKey()

    expect(mockSelect).toHaveBeenCalledTimes(2)
    expect(logSpy.mock.calls.flat().join('\n')).toContain(entropy)
  })

  it('converts env entropy to mnemonic when env user picks mnemonic format', async () => {
    // All-zero entropy — its 24-word encoding is the well-known "abandon abandon … art" phrase.
    const entropy = Buffer.alloc(32, 0).toString('base64')
    process.env['MEMENTOS_RAW_KEY'] = entropy
    await writeMachineConfig(homeDir, { backend: 'local', keyProvider: 'env', vectorIndex: 'hnsw' })

    mockSelect.mockResolvedValueOnce('show').mockResolvedValueOnce('mnemonic')

    const { runShareKey } = await import('../cli/commands/share-key.js')
    await runShareKey()

    const output = logSpy.mock.calls.flat().join('\n')
    expect(output).toContain(TEST_MNEMONIC)
  })

  it('shows the mnemonic verbatim when keychain user picks mnemonic format', async () => {
    const mnemonic = TEST_MNEMONIC
    await writeMachineConfig(homeDir, { backend: 'local', keyProvider: 'keychain', vectorIndex: 'hnsw' })
    // Bypass the keychain backend by pre-writing the file-fallback used when the OS
    // keychain is unavailable. KeychainKeyProvider.getMnemonic reads this on failure.
    await writeFallbackKey(homeDir, mnemonic)

    mockSelect.mockResolvedValueOnce('show').mockResolvedValueOnce('mnemonic')

    const { runShareKey } = await import('../cli/commands/share-key.js')
    await runShareKey()

    expect(mockSelect).toHaveBeenCalledTimes(2)
    const output = logSpy.mock.calls.flat().join('\n')
    expect(output).toContain(mnemonic)
  })

  it('converts mnemonic to base64 entropy when keychain user picks raw format', async () => {
    const mnemonic = TEST_MNEMONIC
    await writeMachineConfig(homeDir, { backend: 'local', keyProvider: 'keychain', vectorIndex: 'hnsw' })
    await writeFallbackKey(homeDir, mnemonic)

    mockSelect.mockResolvedValueOnce('show').mockResolvedValueOnce('raw')

    // All-abandon-then-art = 32 zero bytes of entropy = AAAA…AAA= in base64
    const expectedEntropy = Buffer.alloc(32, 0).toString('base64')

    const { runShareKey } = await import('../cli/commands/share-key.js')
    await runShareKey()

    const output = logSpy.mock.calls.flat().join('\n')
    expect(output).toContain(expectedEntropy)
    // Mnemonic words must NOT be in the displayed output when user picked raw format.
    expect(output).not.toContain(mnemonic)
  })
})

/** Valid BIP39 phrase — bip39 derivation validates checksum, so a random 24-word string won't work. */
const TEST_MNEMONIC = [
  'abandon', 'abandon', 'abandon', 'abandon',
  'abandon', 'abandon', 'abandon', 'abandon',
  'abandon', 'abandon', 'abandon', 'abandon',
  'abandon', 'abandon', 'abandon', 'abandon',
  'abandon', 'abandon', 'abandon', 'abandon',
  'abandon', 'abandon', 'abandon', 'art',
].join(' ')

/** Pre-write the keychain file-fallback at its `~/.local/share/mementos/key` location. */
async function writeFallbackKey(homeDir: string, mnemonic: string): Promise<void> {
  const keyDir = join(homeDir, '.local', 'share', 'mementos')
  await mkdir(keyDir, { recursive: true })
  await writeFile(join(keyDir, 'key'), mnemonic + '\n', 'utf8')
}

async function writeMachineConfig(
  homeDir: string,
  config: { backend: string; keyProvider: string; vectorIndex: string },
): Promise<void> {
  const configDir = join(homeDir, '.config', 'mementos')
  await mkdir(configDir, { recursive: true })
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      vaultPath: join(homeDir, '.mementos'),
      backend: config.backend,
      keyProvider: config.keyProvider,
      vectorIndex: config.vectorIndex,
    }),
    'utf8',
  )
}
