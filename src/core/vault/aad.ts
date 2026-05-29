/**
 * AAD (Additional Authenticated Data) construction and AAD-bound payload encryption.
 *
 * AAD is plaintext bytes bound to a ciphertext via the GCM auth tag — modifying the AAD
 * between encrypt and decrypt fails authentication. Used here to:
 *   - bind each encrypted payload to its memento id (prevents moving a ciphertext into
 *     another id's `.mem` file)
 *   - bind each payload to its field name (prevents chunks↔meta swaps)
 *   - bind the index cache to its id-set (catches rollback to an older valid cache)
 *
 * # On-disk schema — only `id` is plaintext
 *
 * A `.mem` file holds just `{ id, chunks, meta }`: `id` is plaintext because it is the
 * filename (you cannot encrypt a name you must `list()` and locate by — and it is a random
 * UUID, so it leaks nothing). EVERYTHING else — `created_at`, `updated_at`, `chronicle_id`,
 * `parent_memento_id`, `tags` — lives inside the encrypted `meta` payload. Keeping that
 * metadata encrypted rather than cleartext costs nothing (the Vault decrypts every file at
 * startup regardless) and avoids leaking the creation timeline and the conversation/fork
 * structure to anyone with disk access.
 *
 * `memAad` and `cacheAad` produce deterministic byte strings — encrypt and decrypt sides
 * MUST produce byte-identical AAD for authentication to succeed.
 *
 * Determinism here comes from these helpers being the only producers: V8's `JSON.stringify`
 * emits keys in insertion order (not lexicographic), which is fine because the same source
 * code on both sides constructs the same object literal. Do NOT reorder keys in either
 * helper "for clarity" — that would silently invalidate every existing vault. If we ever
 * accept AAD input from outside this module, switch to a canonical encoder.
 *
 * `encryptMemPayloads` is the matching write-side helper: encrypt chunks/meta in one call,
 * each under its own field-bound AAD. Centralised here so that any change to the AAD
 * schema or per-field encoding lands in one place.
 */
import type { Encrypted } from './crypto.js'
import { encrypt, decrypt } from './crypto.js'
import type { MemFile, MemChunk, MemMeta } from './types.js'

export type MemField = 'chunks' | 'meta'

/**
 * AAD for one of the two encrypted payloads inside a `.mem` file.
 *
 * Binds:
 *   - field name (chunks/meta) — prevents swapping the two ciphertexts within a file
 *   - the memento `id` — prevents lifting a ciphertext into a different `.mem` file
 *
 * Nothing else needs binding: every other field lives *inside* the encrypted `meta`
 * payload, so the GCM tag authenticates it directly — confidentiality and integrity in
 * one, no separate plaintext-metadata binding required.
 *
 * No schema-version stamp: encrypt and decrypt sides must produce byte-equal AAD anyway,
 * so a version field couldn't decide anything — when the shape changes, the bytes change.
 */
export function memAad(id: string, field: MemField): Buffer {
  return Buffer.from(JSON.stringify({ field, id }), 'utf8')
}

/**
 * AAD for the encrypted HNSW cache. Binds the ciphertext to its sorted id-set: replaying
 * an older valid cache (different id-set, same key) fails authentication.
 */
export function cacheAad(ids: string[]): Buffer {
  return Buffer.from(JSON.stringify({ kind: 'index-cache', ids: [...ids].sort() }), 'utf8')
}

/**
 * Encrypt the two payloads of a memento file under their field-bound AADs in one call.
 *
 * Both payloads are passed as `Buffer` — already JSON-encoded by the caller:
 *   - `chunks` — `JSON.stringify(MemChunk[])` UTF-8 encoded. The whole memory: every
 *     chunk's text and its embedding vector (vectors as plain `number[]`).
 *   - `meta`   — `JSON.stringify(MemMeta)` UTF-8 encoded: `created_at`, `updated_at`,
 *     optional `chronicle_id` / `parent_memento_id`, and the `tags` array.
 */
export function encryptMemPayloads(
  id: string, k: Buffer,
  plain: { chunks: Buffer; meta: Buffer },
): Record<MemField, Encrypted> {
  return {
    chunks: encrypt(plain.chunks, k, memAad(id, 'chunks')),
    meta: encrypt(plain.meta, k, memAad(id, 'meta')),
  }
}

/**
 * Decrypt + parse a `.mem` file's `chunks` payload. The format rule — JSON-over-UTF-8 of
 * `MemChunk[]` under `memAad(id, 'chunks')` — lives here next to the encrypt-side helper so
 * any future format change (msgpack, magic prefix, envelope, …) lands in one file instead
 * of fanning out to every reader. Callers requiring structural validation (Vault) run their
 * own `assertCorrupt` checks on the result; migrate and test readers don't need it.
 */
export function decryptMemChunks(mem: MemFile, key: Buffer): MemChunk[] {
  return JSON.parse(decrypt(mem.chunks, key, memAad(mem.id, 'chunks')).toString('utf8')) as MemChunk[]
}

/** Decrypt + parse a `.mem` file's `meta` payload. Same rationale as `decryptMemChunks`. */
export function decryptMemMeta(mem: MemFile, key: Buffer): MemMeta {
  return JSON.parse(decrypt(mem.meta, key, memAad(mem.id, 'meta')).toString('utf8')) as MemMeta
}
