/**
 * Shared utility — NOT a KeyProvider implementation.
 *
 * All KeyProviders converge on the same pipeline: 32 bytes of *entropy* → HKDF-SHA256 →
 * 32-byte AES-256 key. Differences between providers are only about HOW they store the
 * entropy (BIP39 mnemonic in OS keychain vs base64 in an env var); the AES key derivation
 * is identical so cross-provider transfer is trivial — same entropy, same AES key, regardless
 * of where the entropy was persisted.
 *
 * Centralised here so the providers can't drift on the constants — drift would silently
 * lock users out.
 *
 * No buffer-zeroing: V8's GC, the bip39 lib's internal copy of the entropy, and the
 * mnemonic string itself all hold the same secret in heap. Zeroing one local copy is
 * cosmetic — a heap dump captures the others. Kept honest by not pretending otherwise.
 */
import { hkdfSync } from 'node:crypto'
import { KDF_SALT, KDF_INFO, KEY_BYTES } from './constants.js'
import { loadBip39 } from '../bip39.js'

/** HKDF-SHA256 over raw 32 bytes of entropy. Same constants as the mnemonic path. */
export function deriveKeyFromEntropy(entropy: Buffer): Buffer {
  if (entropy.byteLength !== 32) {
    throw new Error(`entropy must be exactly 32 bytes (got ${entropy.byteLength})`)
  }
  return Buffer.from(hkdfSync('sha256', entropy, KDF_SALT, KDF_INFO, KEY_BYTES))
}

/** Decode a BIP39 mnemonic to its raw entropy bytes (256 bits for a 24-word phrase). */
export async function mnemonicToEntropyBytes(mnemonic: string): Promise<Buffer> {
  const { mnemonicToEntropy, wordlist } = await loadBip39()
  return Buffer.from(mnemonicToEntropy(mnemonic, wordlist))
}

/** Encode raw entropy bytes back into a BIP39 mnemonic. Inverse of `mnemonicToEntropyBytes`. */
export async function entropyToMnemonicString(entropy: Buffer): Promise<string> {
  const { entropyToMnemonic, wordlist } = await loadBip39()
  return entropyToMnemonic(entropy, wordlist)
}

/** Convenience: mnemonic → entropy → HKDF. Same AES key as `deriveKeyFromEntropy(mnemonicToEntropyBytes(m))`. */
export async function deriveKeyFromMnemonic(mnemonic: string): Promise<Buffer> {
  return deriveKeyFromEntropy(await mnemonicToEntropyBytes(mnemonic))
}
