import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { EnvKeyProvider } from '../keys/env/index.js'
import { MnemonicKeyProvider } from '../keys/mnemonic/index.js'
import {
  deriveKeyFromEntropy, entropyToMnemonicString,
} from '../keys/_utils/derivation/index.js'

const ENV_VAR = 'MEMENTOS_RAW_KEY'
/** A fresh base64-encoded 32-byte raw key for tests. */
const rawKey = (): string => randomBytes(32).toString('base64')

beforeEach(() => { delete process.env[ENV_VAR] })
afterEach(() => { delete process.env[ENV_VAR] })

describe('EnvKeyProvider', () => {
  it('getKey returns a 32-byte buffer when env var is set', async () => {
    process.env[ENV_VAR] = rawKey()
    const key = await new EnvKeyProvider().getKey()
    expect(key.byteLength).toBe(32)
  })

  it('getKey throws when env var is missing', async () => {
    await expect(new EnvKeyProvider().getKey()).rejects.toThrow(ENV_VAR)
  })

  it('getKey throws when value is not 32 bytes', async () => {
    process.env[ENV_VAR] = Buffer.from('tooshort').toString('base64')
    await expect(new EnvKeyProvider().getKey()).rejects.toThrow('32')
  })

  it('same env var always yields the same key', async () => {
    process.env[ENV_VAR] = rawKey()
    const k1 = await new EnvKeyProvider().getKey()
    const k2 = await new EnvKeyProvider().getKey()
    expect(k1).toEqual(k2)
  })

  it('accepts a custom env var name', async () => {
    process.env['MY_CUSTOM_KEY'] = rawKey()
    const key = await new EnvKeyProvider('MY_CUSTOM_KEY').getKey()
    expect(key.byteLength).toBe(32)
    delete process.env['MY_CUSTOM_KEY']
  })

  it('runs HKDF on the env value rather than returning it as-is', async () => {
    // Lock the unification: the AES key returned by getKey() is NOT the raw entropy
    // from the env var; it is HKDF(entropy). A regression that bypasses HKDF would
    // make this test fail.
    const entropy = Buffer.alloc(32, 0x42)  // deterministic non-zero pattern
    process.env[ENV_VAR] = entropy.toString('base64')
    const aesKey = await new EnvKeyProvider().getKey()
    expect(aesKey).not.toEqual(entropy)  // raw entropy ≠ derived AES key
    expect(aesKey).toEqual(deriveKeyFromEntropy(entropy))
  })

  it('same entropy yields the same AES key for env and mnemonic providers', async () => {
    // The core unification claim: a user can store their entropy as 32 base64 bytes
    // in MEMENTOS_RAW_KEY OR as a 24-word mnemonic in keychain, and both paths derive
    // the SAME AES key. Without this, cross-provider transfer wouldn't work.
    const entropy = Buffer.alloc(32, 0)  // all-zero → "abandon abandon … art"
    const mnemonic = await entropyToMnemonicString(entropy)

    process.env[ENV_VAR] = entropy.toString('base64')
    const envKey = await new EnvKeyProvider().getKey()
    const mnemonicKey = await new MnemonicKeyProvider(mnemonic).getKey()

    expect(envKey).toEqual(mnemonicKey)
  })
})
