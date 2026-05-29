import { join } from 'node:path'
import { homedir } from 'node:os'

/** OS-keychain service + account names under which the mnemonic is stored. */
export const SERVICE = 'mementos'
export const ACCOUNT = 'default'

// The fallback key file lives OUTSIDE ~/.config/mementos/ on purpose. That directory
// holds only regenerable machine state (config, HNSW cache, serve registry) and
// `mementos destroy` wipes it wholesale; a non-regenerable secret living inside it would
// be destroyed even when the user explicitly opts to keep the vault key. ~/.local/share
// is the XDG data location — separate from config, and not a destroy target.
export const FALLBACK_DIR = join(homedir(), '.local', 'share', 'mementos')
export const FALLBACK_FILE = join(FALLBACK_DIR, 'key')

/** Owner-only permissions — the fallback file holds the vault secret in plaintext. */
export const FALLBACK_DIR_MODE = 0o700
export const FALLBACK_FILE_MODE = 0o600
