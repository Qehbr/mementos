/**
 * Tests for the `promptForExistingKey` helper (src/cli/_utils/existing-key.ts).
 *
 * The helper is invoked by the join branch of `mementos init` to gather the existing
 * vault key from the user in one of three forms (typed mnemonic / typed raw base64 /
 * LAN pair) and return the 32 bytes of entropy. These tests cover the typed paths plus
 * the validation refusals; the LAN-pair path is exercised by the manual receive-key
 * flow and end-to-end through init-git-cross-device.
 *
 * @inquirer/prompts is mocked so the helper can be driven without an interactive stdin.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockSelect = vi.fn<(...args: unknown[]) => Promise<string>>()
const mockInput = vi.fn<(...args: unknown[]) => Promise<string>>()
const mockConfirm = vi.fn<(...args: unknown[]) => Promise<boolean>>()

vi.mock('@inquirer/prompts', () => ({
  select: (opts: unknown) => mockSelect(opts),
  input: (opts: { validate?: (v: string) => true | string | Promise<true | string> }) =>
    mockInput(opts).then(async value => {
      // Exercise the helper's validate function the same way inquirer does. validate may
      // be sync OR async (collectMnemonic does its BIP39 checksum inside an async validate
      // so a typo re-prompts instead of aborting init).
      if (opts.validate) {
        const r = await opts.validate(value)
        if (r !== true) throw new Error(`validation: ${r}`)
      }
      return value
    }),
  confirm: (opts: unknown) => mockConfirm(opts),
}))

const fakeCtx = {
  print: vi.fn(),
  warn: vi.fn(),
  showSecret: vi.fn().mockResolvedValue(undefined),
  getFlag: vi.fn(),
  patchMachineConfig: vi.fn(),
  applyPatches: vi.fn(),
  close: vi.fn(),
} as unknown as Parameters<typeof import('../cli/_utils/existing-key.js').promptForExistingKey>[0]

describe('promptForExistingKey', () => {
  beforeEach(() => {
    mockSelect.mockReset()
    mockInput.mockReset()
    mockConfirm.mockReset()
  })

  it('returns 32 entropy bytes from a valid 24-word mnemonic', async () => {
    // The all-abandons-then-art mnemonic encodes 32 zero bytes — canonical BIP39 test
    // vector for "256 bits of zero entropy."
    mockSelect.mockResolvedValueOnce('mnemonic')
    mockInput.mockResolvedValueOnce(TEST_MNEMONIC)

    const { promptForExistingKey } = await import('../cli/_utils/existing-key.js')
    const entropy = await promptForExistingKey(fakeCtx)

    expect(entropy.byteLength).toBe(32)
    expect(entropy.equals(Buffer.alloc(32, 0))).toBe(true)
  })

  it('rejects a mnemonic with the wrong word count via the validate hook', async () => {
    mockSelect.mockResolvedValueOnce('mnemonic')
    mockInput.mockResolvedValueOnce('abandon abandon abandon')  // only 3 words

    const { promptForExistingKey } = await import('../cli/_utils/existing-key.js')
    await expect(promptForExistingKey(fakeCtx)).rejects.toThrow(/Expected 24 words/)
  })

  it('rejects a mnemonic whose BIP39 checksum is invalid', async () => {
    mockSelect.mockResolvedValueOnce('mnemonic')
    // Right word count, wrong checksum — every word "abandon" except the last is "zoo"
    // which doesn't satisfy the all-zero entropy checksum.
    const bad = Array(23).fill('abandon').concat(['zoo']).join(' ')
    mockInput.mockResolvedValueOnce(bad)

    const { promptForExistingKey } = await import('../cli/_utils/existing-key.js')
    await expect(promptForExistingKey(fakeCtx)).rejects.toThrow(/BIP39|checksum|invalid/i)
  })

  it('returns the decoded entropy bytes from a valid base64 32-byte input', async () => {
    mockSelect.mockResolvedValueOnce('raw')
    const original = Buffer.alloc(32, 0x42)  // deterministic non-zero pattern
    mockInput.mockResolvedValueOnce(original.toString('base64'))

    const { promptForExistingKey } = await import('../cli/_utils/existing-key.js')
    const entropy = await promptForExistingKey(fakeCtx)

    expect(entropy.equals(original)).toBe(true)
  })

  it('rejects a base64 value that decodes to the wrong length', async () => {
    mockSelect.mockResolvedValueOnce('raw')
    mockInput.mockResolvedValueOnce(Buffer.from('too-short').toString('base64'))

    const { promptForExistingKey } = await import('../cli/_utils/existing-key.js')
    await expect(promptForExistingKey(fakeCtx)).rejects.toThrow(/Expected 32 bytes/)
  })
})

const TEST_MNEMONIC = [
  'abandon', 'abandon', 'abandon', 'abandon',
  'abandon', 'abandon', 'abandon', 'abandon',
  'abandon', 'abandon', 'abandon', 'abandon',
  'abandon', 'abandon', 'abandon', 'abandon',
  'abandon', 'abandon', 'abandon', 'abandon',
  'abandon', 'abandon', 'abandon', 'art',
].join(' ')
