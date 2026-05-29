import { describe, it, expect } from 'vitest'
import { encrypt, decrypt } from '../core/vault/crypto.js'

const KEY = Buffer.alloc(32, 0xab)

describe('encrypt / decrypt', () => {
  it('roundtrips arbitrary bytes', () => {
    const plain = Buffer.from('hello world 🔐')
    const enc = encrypt(plain, KEY)
    expect(decrypt(enc, KEY)).toEqual(plain)
  })

  it('each call produces a different IV', () => {
    const enc1 = encrypt(Buffer.from('same'), KEY)
    const enc2 = encrypt(Buffer.from('same'), KEY)
    expect(enc1.iv).not.toBe(enc2.iv)
    expect(enc1.enc).not.toBe(enc2.enc)
  })

  it('throws on wrong key', () => {
    const enc = encrypt(Buffer.from('secret'), KEY)
    const wrongKey = Buffer.alloc(32, 0x00)
    expect(() => decrypt(enc, wrongKey)).toThrow()
  })

  it('throws on tampered ciphertext', () => {
    const enc = encrypt(Buffer.from('secret'), KEY)
    const tampered = { ...enc, enc: enc.enc.slice(0, -4) + 'AAAA' }
    expect(() => decrypt(tampered, KEY)).toThrow()
  })
})
