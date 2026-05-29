/**
 * AES-256-GCM authenticated encryption — the only cryptographic primitive in the project.
 *
 * Each `Encrypted` envelope holds a 12-byte random IV and a 16-byte GCM auth tag, so each
 * call to `encrypt` produces a unique nonce and the ciphertext is independently authenticated.
 * Optional AAD (Additional Authenticated Data) binds the ciphertext to associated metadata —
 * see `memAad` and `cacheAad` in vault.ts for the canonical mementos AAD schemes.
 *
 * On decryption failure (auth tag mismatch — tampering or wrong key), `decrypt` throws a
 * typed `AuthenticationError` so callers can distinguish cryptographic failures from
 * routine errors (e.g. malformed input).
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

/**
 * On-disk envelope for one encrypted blob. Base64 strings are used for portability across
 * JSON serialization (.mem files, the index cache).
 */
export interface Encrypted {
  enc: string   // ciphertext, base64
  iv: string    // 12-byte nonce, base64
  tag: string   // 16-byte GCM auth tag, base64
}

/**
 * Thrown when AES-GCM authentication fails. Distinct from generic decryption errors so
 * callers can react specifically — e.g. logging a tampering warning vs. silently rebuilding
 * a corrupt cache.
 */
export class AuthenticationError extends Error {
  constructor(message = 'AES-GCM authentication failed (possible tampering or wrong key)') {
    super(message)
    this.name = 'AuthenticationError'
  }
}

/**
 * Encrypt a buffer with AES-256-GCM. The IV is generated fresh per call.
 *
 * @param plaintext - Bytes to encrypt.
 * @param key       - 32-byte AES-256 key.
 * @param aad       - Optional Additional Authenticated Data. Not encrypted, but bound to the
 *                    auth tag — modifying the AAD between encrypt and decrypt fails authentication.
 */
export function encrypt(plaintext: Buffer, key: Buffer, aad?: Buffer): Encrypted {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  if (aad) cipher.setAAD(aad)
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    enc: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

/**
 * Decrypt an AES-256-GCM envelope. Throws `AuthenticationError` if the auth tag does not
 * verify — possible causes: tampering with the ciphertext, IV, tag, or AAD; wrong key;
 * AAD mismatch (e.g. swapping ciphertexts between fields with field-bound AAD).
 *
 * @param e   - The envelope produced by `encrypt`.
 * @param key - 32-byte AES-256 key (must be the same key used to encrypt).
 * @param aad - Same AAD bytes used at encryption time, or omit if none was used.
 * @returns Decrypted plaintext bytes.
 * @throws  {AuthenticationError} on auth-tag failure.
 */
export function decrypt(e: Encrypted, key: Buffer, aad?: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'))
  if (aad) decipher.setAAD(aad)
  decipher.setAuthTag(Buffer.from(e.tag, 'base64'))
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(e.enc, 'base64')),
      decipher.final(),
    ])
  } catch (err) {
    // GCM auth failure surfaces from decipher.final(). Node's exact error wording has
    // changed across versions and OpenSSL builds, so we classify any final()-stage error
    // as an authentication failure rather than parsing the message text.
    throw new AuthenticationError(err instanceof Error ? err.message : undefined)
  }
}
