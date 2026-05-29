/**
 * Key derivation constants.
 *
 * ⚠️  LOAD-BEARING: do NOT change `KDF_SALT` or `KDF_INFO` without a migration plan.
 * The same mnemonic derives a different AES key under a different salt/info pair, so any
 * change irreversibly locks every existing vault — they can't be decrypted with the new
 * key. The version tag in the salt (`v1`) is the intended forward-compatibility knob:
 * if rotation ever becomes necessary, bump to `mementos-v2` and ship a migration tool that
 * decrypts under v1 and re-encrypts under v2.
 */

/** Domain-separation salt for HKDF. The version tag is a future-rotation knob. */
export const KDF_SALT = 'mementos-v1'

/** HKDF info string. Binds the derivation purpose ("the AES-256-GCM key for mementos"). */
export const KDF_INFO = 'aes-256-gcm-key'

/** Output length: AES-256 expects 32 bytes. */
export const KEY_BYTES = 32
