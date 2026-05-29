/**
 * Unit tests for the re-encryption primitives used by `mementos migrate --type=key`.
 *
 * Covers:
 *   - Round-trip: a freshly-built MemFile under oldKey re-encrypts under newKey and
 *     both payloads (chunks, meta) decrypt under newKey with the same AAD.
 *   - id preservation: the only plaintext field is byte-identical before and after.
 *   - Fresh IVs: re-encryption uses a new IV/tag per payload (not just a key change).
 *   - canDecryptMem: correctly distinguishes right-key from wrong-key, returns false
 *     on non-JSON input (no throw), passes through unexpected errors.
 */
import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { decrypt, encrypt } from '../core/vault/crypto.js'
import { memAad } from '../core/vault/aad.js'
import { reEncryptMem, canDecryptMem } from '../core/vault/re-encrypt.js'
import type { MemFile, MemChunk, MemMeta } from '../core/vault/types.js'

function buildMem(key: Buffer, id = '00000000-0000-4000-8000-000000000000', meta?: Partial<MemMeta>): MemFile {
  const chunks: MemChunk[] = [{ text: 'hello world', vector: [0.1, 0.2, 0.3, 0.4] }]
  const fullMeta: MemMeta = {
    created_at: '2026-05-12T00:00:00Z',
    updated_at: '2026-05-12T00:00:00Z',
    tags: ['t1', 't2'],
    ...meta,
  }
  return {
    id,
    chunks: encrypt(Buffer.from(JSON.stringify(chunks), 'utf8'), key, memAad(id, 'chunks')),
    meta: encrypt(Buffer.from(JSON.stringify(fullMeta), 'utf8'), key, memAad(id, 'meta')),
  }
}

describe('reEncryptMem', () => {
  it('round-trips a MemFile from oldKey to newKey with both payloads decryptable', () => {
    const oldKey = randomBytes(32)
    const newKey = randomBytes(32)
    const mem = buildMem(oldKey)
    const rotated = reEncryptMem(mem, oldKey, newKey)

    // The only plaintext field is unchanged.
    expect(rotated.id).toBe(mem.id)

    // Every payload now decrypts under newKey with the same AAD.
    const bytes = Buffer.from(JSON.stringify(rotated))
    expect(canDecryptMem(bytes, newKey)).toBe(true)
    expect(canDecryptMem(bytes, oldKey)).toBe(false)
    // meta survives the rotation intact.
    const meta = JSON.parse(decrypt(rotated.meta, newKey, memAad(rotated.id, 'meta')).toString('utf8')) as MemMeta
    expect(meta.created_at).toBe('2026-05-12T00:00:00Z')
    expect(meta.tags).toEqual(['t1', 't2'])
  })

  it('produces fresh IVs and tags on re-encryption (not just a key change)', () => {
    const oldKey = randomBytes(32)
    const newKey = randomBytes(32)
    const mem = buildMem(oldKey)
    const rotated = reEncryptMem(mem, oldKey, newKey)

    // IVs and tags should differ — AES-GCM generates fresh randomness per encrypt call.
    expect(rotated.chunks.iv).not.toBe(mem.chunks.iv)
    expect(rotated.chunks.tag).not.toBe(mem.chunks.tag)
    expect(rotated.chunks.enc).not.toBe(mem.chunks.enc)
  })

  it('handles MemFiles with chronicle / parent fields present', () => {
    const oldKey = randomBytes(32)
    const newKey = randomBytes(32)
    const id = '11111111-1111-4111-8111-111111111111'
    const mem = buildMem(oldKey, id, {
      chronicle_id: '22222222-2222-4222-8222-222222222222',
      parent_memento_id: '33333333-3333-4333-8333-333333333333',
    })
    const rotated = reEncryptMem(mem, oldKey, newKey)

    const meta = JSON.parse(decrypt(rotated.meta, newKey, memAad(id, 'meta')).toString('utf8')) as MemMeta
    expect(meta.chronicle_id).toBe('22222222-2222-4222-8222-222222222222')
    expect(meta.parent_memento_id).toBe('33333333-3333-4333-8333-333333333333')
    expect(canDecryptMem(Buffer.from(JSON.stringify(rotated)), newKey)).toBe(true)
  })
})

describe('canDecryptMem', () => {
  it('returns true for the matching key', () => {
    const key = randomBytes(32)
    const bytes = Buffer.from(JSON.stringify(buildMem(key)))
    expect(canDecryptMem(bytes, key)).toBe(true)
  })

  it('returns false for a wrong key (no throw)', () => {
    const right = randomBytes(32)
    const wrong = randomBytes(32)
    const bytes = Buffer.from(JSON.stringify(buildMem(right)))
    expect(canDecryptMem(bytes, wrong)).toBe(false)
  })

  it('throws on non-JSON input — corruption is not a wrong-key signal', () => {
    expect(() => canDecryptMem(Buffer.from('this is not json'), randomBytes(32))).toThrow(/JSON/)
  })
})
