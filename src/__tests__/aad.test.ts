/**
 * AAD (Additional Authenticated Data) binding regression tests.
 *
 * `memAad` tests live in the crypto roundtrip suite via `encryptMemPayloads`
 * usage. This file pins the `cacheAad` contract that the encrypted HNSW
 * cache depends on for rollback resistance.
 *
 * The bug this guards: `cacheAad` once bound only the sorted id-set. That
 * caught adds and deletes (the id-set changed), but NOT in-place updates:
 * an attacker with disk write could swap an old cache + HNSW back, forge
 * the plaintext `entries[i].mtimeMs` in the cache file to match the on-disk
 * file's current mtime (the freshness check trusts the unauthenticated
 * plaintext mtimes), and authentication still passed — id-set was unchanged
 * → AAD was unchanged → GCM tag still valid → stale HNSW restored. Recall
 * would then rank the updated memento by its pre-update embedding, making
 * the update semantically unfindable. Binding mtimes into the AAD too means
 * any forged mtime fails authentication and the cache rebuilds.
 */
import { describe, it, expect } from 'vitest'
import { cacheAad } from '../core/vault/aad.js'
import { encrypt, decrypt, AuthenticationError } from '../core/vault/crypto.js'

const KEY = Buffer.alloc(32, 0xab)

describe('cacheAad', () => {
  it('produces different bytes when an mtime changes (with the id-set held constant)', () => {
    // The whole point of this fix: if cacheAad ignored mtimes, these would be
    // byte-equal and the rollback attack would work. They must differ.
    const a = cacheAad([{ id: 'x', mtimeMs: 1000 }])
    const b = cacheAad([{ id: 'x', mtimeMs: 2000 }])
    expect(a.equals(b)).toBe(false)
  })

  it('is canonical under input order (sorts by id internally)', () => {
    // Encrypt and decrypt sides build their entries arrays from different
    // walks — `tryLoadIndexCache` builds it from `cache.entries`, `saveIndexCache`
    // from a different ordering. Canonicalisation has to live in the AAD
    // helper, not the call sites, or the two sides will produce different
    // bytes and authentication will fail spuriously.
    const a = cacheAad([{ id: 'b', mtimeMs: 2 }, { id: 'a', mtimeMs: 1 }])
    const b = cacheAad([{ id: 'a', mtimeMs: 1 }, { id: 'b', mtimeMs: 2 }])
    expect(a.equals(b)).toBe(true)
  })

  it('encrypt+decrypt roundtrips when entries match exactly', () => {
    const entries = [
      { id: 'a', mtimeMs: 100 },
      { id: 'b', mtimeMs: 200 },
    ]
    const plain = Buffer.from('hnsw blob bytes')
    const enc = encrypt(plain, KEY, cacheAad(entries))
    expect(decrypt(enc, KEY, cacheAad(entries))).toEqual(plain)
  })

  it('decrypt FAILS when a single mtime is forged on the read side (the attack)', () => {
    // The attack: bytes on disk are encrypt(plain, key, cacheAad([{id:'a',
    // mtimeMs:100}])), but the attacker has rewritten the plaintext entries
    // in the cache file to claim mtimeMs=999 (matching the on-disk file's
    // new mtime). On load, the freshness check passes (every per-id mtime
    // matches the on-disk stat), and the call site constructs the AAD from
    // the FORGED entries. Authentication must fail — that's the property
    // making the rollback attack infeasible.
    const realEntries = [{ id: 'a', mtimeMs: 100 }]
    const forgedEntries = [{ id: 'a', mtimeMs: 999 }]
    const enc = encrypt(Buffer.from('stale hnsw'), KEY, cacheAad(realEntries))
    expect(() => decrypt(enc, KEY, cacheAad(forgedEntries)))
      .toThrow(AuthenticationError)
  })

  it('decrypt FAILS when the id-set changes (the original adds/deletes guarantee)', () => {
    // Sanity: the earlier behaviour (id-set binding catches adds/deletes)
    // must NOT regress while we tighten to mtimes too.
    const oldEntries = [{ id: 'a', mtimeMs: 100 }]
    const newEntries = [{ id: 'a', mtimeMs: 100 }, { id: 'b', mtimeMs: 100 }]
    const enc = encrypt(Buffer.from('stale hnsw'), KEY, cacheAad(oldEntries))
    expect(() => decrypt(enc, KEY, cacheAad(newEntries)))
      .toThrow(AuthenticationError)
  })
})
