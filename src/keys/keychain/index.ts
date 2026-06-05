/**
 * KeychainKeyProvider — stores the user's 24-word mnemonic in the OS-native secret store
 * (macOS Keychain / Linux libsecret / Windows Credential Manager) via `@napi-rs/keyring`,
 * falling back to a chmod-600 file (`~/.local/share/mementos/key`) on headless Linux.
 *
 * The mnemonic is what's persisted, not the derived key — so a user who loses their
 * machine can recover from their written-down backup. HKDF derivation (salt "mementos-v1",
 * info "aes-256-gcm-key") matches MnemonicKeyProvider.
 *
 * Error policy: a missing key throws `KeyNotFoundError` (caller can suggest `init`); a
 * broken keychain backend throws generic `Error` (caller MUST NOT suggest `init`, which
 * would overwrite a valid key behind a temporarily-broken backend).
 *
 * See DESIGN.md for the security trade-offs.
 */
import { randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir, chmod, unlink } from 'node:fs/promises'
import type { KeyProvider, CanonicalSecret } from '../interface.js'
import { deriveKeyFromMnemonic, entropyToMnemonicString } from '../_utils/derivation/index.js'
import type { InitContext } from '../../core/init-context/interface.js'
import type { KeyProviderImplementationModule } from '../registry.js'
import {
  SERVICE, ACCOUNT, FALLBACK_DIR, FALLBACK_FILE, FALLBACK_DIR_MODE, FALLBACK_FILE_MODE,
} from './constants.js'

/**
 * Thrown when no vault key is configured at all (neither keychain nor fallback file).
 * Distinguishes "user hasn't run init" from any other failure so callers don't blindly
 * re-init and clobber an existing key.
 */
export class KeyNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'KeyNotFoundError' }
}

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'keychain'
export function create(): KeyProvider {
  return new KeychainKeyProvider()
}

/**
 * Init-time setup. Idempotent: if a key already exists in the keychain (or fallback
 * file), keep it — DON'T overwrite. Generation only happens on first init.
 *
 * This is the primary defense against re-running `mementos init` (accidentally, or by
 * an AI assistant) on an existing vault: a new mnemonic would derive a different AES
 * key, making every existing `.mem` file undecryptable.
 *
 * If `getMnemonic()` throws a non-`KeyNotFoundError` (e.g. the keychain backend is
 * temporarily broken), we abort rather than generating a new key — the existing key
 * may still be there behind a flaky backend, and overwriting it would be data loss.
 */
export async function setupAtInit(ctx: InitContext): Promise<void> {
  const provider = new KeychainKeyProvider()
  try {
    await provider.getMnemonic()
    ctx.print('Vault key already configured on this machine — keeping the existing key.')
    return
  } catch (e) {
    if (!(e instanceof KeyNotFoundError)) throw e // broken backend — never overwrite
  }

  await provider.storeEntropy(randomBytes(32), ctx)
}

const _shape: KeyProviderImplementationModule = { type, create, setupAtInit }

/**
 * Try to persist the mnemonic to the OS keychain. Returns true on success, false if the
 * keychain backend is unavailable / non-functional (so the caller can decide whether to
 * fall back to the chmod-600 file).
 *
 * Uses a sentinel-probe to verify the backend actually persists: write a random value to a
 * separate `__probe__` account, read it back, delete it. A no-op setPassword (e.g. on a
 * misconfigured Linux without secret-service) returns the value of the just-set call
 * rather than what was actually persisted; the random sentinel defeats that.
 */
async function tryStoreInKeychain(mnemonic: string): Promise<boolean> {
  try {
    const { Entry } = await import('@napi-rs/keyring')

    const probeEntry = new Entry(SERVICE, '__probe__')
    const sentinel = randomBytes(16).toString('hex')
    probeEntry.setPassword(sentinel)
    const seen = probeEntry.getPassword()
    try { probeEntry.deletePassword() } catch { /* tolerated */ }
    if (seen !== sentinel) return false

    const entry = new Entry(SERVICE, ACCOUNT)
    entry.setPassword(mnemonic)
    return true
  } catch {
    return false
  }
}

/** Write the mnemonic to `~/.local/share/mementos/key` with chmod 600. */
async function storeMnemonicInFile(mnemonic: string): Promise<void> {
  // Pre-create the directory and file with strict modes; passing { mode } to writeFile
  // applies the mode at create time (no race window between writeFile and chmod).
  await mkdir(FALLBACK_DIR, { recursive: true, mode: FALLBACK_DIR_MODE })
  await chmod(FALLBACK_DIR, FALLBACK_DIR_MODE).catch(() => {})  // pre-existing dirs keep their prior perms otherwise
  await writeFile(FALLBACK_FILE, mnemonic, { encoding: 'utf8', mode: FALLBACK_FILE_MODE })
  await chmod(FALLBACK_FILE, FALLBACK_FILE_MODE).catch(() => {})  // same for pre-existing files
}

/**
 * Decide whether to fall back to the chmod-600 file when the OS keychain is unavailable.
 *
 *   --keychain-fallback=allow   → silent fallback (the historical default; scripted / CI)
 *   --keychain-fallback=refuse  → throw; user must install a keychain backend
 *   --keychain-fallback=ask     → interactive prompt (default); refused fallback throws
 *
 * The interactive default means a regular `mementos init` on a headless / misconfigured
 * Linux box no longer silently downgrades from at-rest OS-encrypted key storage to a
 * chmod-600 plaintext file — the user is told what's happening and chooses.
 */
export async function confirmFallbackOrThrow(ctx: InitContext): Promise<void> {
  const policy = ctx.getFlag('keychain-fallback') ?? 'ask'

  if (policy === 'allow') return

  if (policy === 'refuse') {
    throw new Error(
      `OS keychain unavailable and --keychain-fallback=refuse. Install a keychain backend ` +
      `(Linux: \`sudo apt install libsecret-1-0\` or distro equivalent) and re-run, or ` +
      `pass --keychain-fallback=allow to accept the chmod-600 file fallback.`,
    )
  }

  // policy === 'ask' (or anything else — treat unknowns as ask)
  ctx.warn('')
  ctx.warn('OS keychain is not available on this machine.')
  ctx.warn('')
  ctx.warn(`Falling back would store the vault key at ${FALLBACK_FILE} with chmod 600.`)
  ctx.warn('Anyone with root or your user account can read it. The OS keychain encrypts')
  ctx.warn('the key behind the OS lock screen; this fallback file does not.')
  ctx.warn('')
  ctx.warn('On Linux, install a keychain backend with:')
  ctx.warn('  sudo apt install libsecret-1-0       (Debian / Ubuntu)')
  ctx.warn('  sudo dnf install libsecret           (Fedora)')
  ctx.warn('Then re-run `mementos init`.')
  ctx.warn('')

  const { confirm } = await import('@inquirer/prompts')
  const proceed = await confirm({
    message: 'Continue with the chmod-600 fallback?',
    default: false,
  })
  if (!proceed) {
    throw new Error('Aborted at user request — install a keychain backend and re-run, or pass --keychain-fallback=allow.')
  }
}

export class KeychainKeyProvider implements KeyProvider {
  async getKey(): Promise<Buffer> {
    const mnemonic = await this.getMnemonic()
    return deriveKeyFromMnemonic(mnemonic)
  }

  /**
   * Encode entropy as a 24-word BIP39 mnemonic, persist to keychain (or fallback file),
   * and show the mnemonic to the user via showSecret so they can write it down. Used by
   * both new-vault setupAtInit (with freshly-generated entropy) and the join branch
   * (with entropy from user input or LAN pair).
   */
  async storeEntropy(entropy: Buffer, ctx: InitContext): Promise<void> {
    const mnemonic = await entropyToMnemonicString(entropy)
    await ctx.showSecret('Your vault key (24-word mnemonic)', mnemonic)

    if (await tryStoreInKeychain(mnemonic)) {
      ctx.print('Key stored in OS keychain.')
      return
    }

    // Keychain failed — ask before silently downgrading to chmod-600 file.
    await confirmFallbackOrThrow(ctx)
    await storeMnemonicInFile(mnemonic)
    ctx.print(`Key stored in ${FALLBACK_FILE} (chmod 600). No OS keychain available.`)
  }

  /**
   * Resolve the mnemonic. Tries the OS keychain first, then the chmod-600 fallback file.
   *
   * @throws {KeyNotFoundError} when no key is configured anywhere — caller should suggest `init`.
   * @throws {Error} when the keychain backend itself failed (libsecret down, etc.) — caller
   *                 should NOT suggest `init`, as that would overwrite any existing valid key.
   */
  async getMnemonic(): Promise<string> {
    let keychainErr: Error | undefined
    try {
      const fromKeychain = await this.readKeychain()
      if (fromKeychain) return fromKeychain
    } catch (e) {
      keychainErr = e instanceof Error ? e : new Error(String(e))
    }

    try {
      return (await readFile(FALLBACK_FILE, 'utf8')).trim()
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }

    if (keychainErr) throw new Error(
      `Keychain read failed (${keychainErr.message}) and no fallback file at ${FALLBACK_FILE}. ` +
      `Diagnose the keychain before running init — init would overwrite an existing key.`
    )
    throw new KeyNotFoundError(
      `No vault key found. Run 'mementos init' to set up, or place a 24-word mnemonic in ${FALLBACK_FILE}`
    )
  }

  /**
   * Canonical secret = the mnemonic we persisted at init. share-key uses this; from the
   * mnemonic it can derive the raw AES key on the fly for env-format display.
   */
  async getCanonicalSecret(): Promise<CanonicalSecret> {
    return { format: 'mnemonic', value: await this.getMnemonic() }
  }

  /**
   * Pre-flight check that the hook subprocess will be able to read the key when it fires.
   * Throws on fatal unreachability with a remediation-aware message.
   */
  async checkReachable(): Promise<void> {
    try {
      await this.getMnemonic()
    } catch (e) {
      if (e instanceof KeyNotFoundError) {
        throw new Error('No vault key found. Run `mementos init` first.')
      }
      throw new Error(
        `Keychain check failed: ${(e as Error).message}\n` +
        `Do NOT run \`mementos init\` — that would overwrite any existing key.`
      )
    }
  }

  describeStoredKey(): string {
    return 'OS keychain entry + chmod-600 fallback file (if present)'
  }

  describeKeyLocation(): string {
    return 'OS keychain (or chmod-600 fallback)'
  }

  describeDoctorHint(): string {
    return `Check that the OS keychain is unlocked. Do NOT 'mementos init --reinit' before verifying — that would generate a new key.`
  }

  async isAlreadyConfigured(): Promise<boolean> {
    try {
      await this.getMnemonic()
      return true
    } catch (e) {
      if (e instanceof KeyNotFoundError) return false
      // Keychain backend broken — treat as "configured" to avoid overwriting a key that
      // might still be there behind the temporarily-broken backend.
      return true
    }
  }

  /**
   * Best-effort removal of the keychain entry and the fallback file — called by
   * `mementos destroy`. Errors during the keychain delete are swallowed because the worst
   * case (entry already gone, backend down) is identical to "nothing to do."
   */
  async clearStoredKey(print: (msg: string) => void): Promise<void> {
    let keychainCleared = false
    try {
      const { Entry } = await import('@napi-rs/keyring')
      const entry = new Entry(SERVICE, ACCOUNT)
      entry.deletePassword()
      keychainCleared = true
    } catch { /* tolerated */ }
    const fileExisted = await unlink(FALLBACK_FILE).then(() => true).catch(() => false)
    if (keychainCleared || fileExisted) {
      print(`Vault key cleared from ${[keychainCleared && 'OS keychain', fileExisted && 'fallback file'].filter(Boolean).join(' and ')}.`)
    } else {
      print('Vault key: no keychain entry or fallback file found — nothing to remove.')
    }
  }

  private async readKeychain(): Promise<string | null> {
    const { Entry } = await import('@napi-rs/keyring')
    const entry = new Entry(SERVICE, ACCOUNT)
    return entry.getPassword()
  }
}
