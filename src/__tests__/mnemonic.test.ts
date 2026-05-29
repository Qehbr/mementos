import { describe, it, expect } from 'vitest'
import { MnemonicKeyProvider } from '../keys/mnemonic/index.js'
import { generateMnemonic } from '../keys/_utils/mnemonic.js'

describe('generateMnemonic', () => {
  it('returns a 24-word string', async () => {
    const m = await generateMnemonic()
    expect(m.split(' ')).toHaveLength(24)
  })

  it('produces different mnemonics on each call', async () => {
    const a = await generateMnemonic()
    const b = await generateMnemonic()
    expect(a).not.toBe(b)
  })
})

describe('MnemonicKeyProvider', () => {
  it('getKey returns a 32-byte buffer', async () => {
    const m = await generateMnemonic()
    const key = await new MnemonicKeyProvider(m).getKey()
    expect(key.byteLength).toBe(32)
  })

  it('same mnemonic always yields the same key', async () => {
    const m = await generateMnemonic()
    const k1 = await new MnemonicKeyProvider(m).getKey()
    const k2 = await new MnemonicKeyProvider(m).getKey()
    expect(k1).toEqual(k2)
  })

  it('different mnemonics yield different keys', async () => {
    const m1 = await generateMnemonic()
    const m2 = await generateMnemonic()
    const k1 = await new MnemonicKeyProvider(m1).getKey()
    const k2 = await new MnemonicKeyProvider(m2).getKey()
    expect(k1).not.toEqual(k2)
  })
})
