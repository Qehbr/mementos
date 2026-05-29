/**
 * KeyProvider — abstracts where the AES-256 vault key comes from.
 *
 * The Vault holds the returned key in memory for the process lifetime. Implementations
 * decide where the underlying secret lives (OS keychain, file, env var, mnemonic phrase)
 * and how it's converted to a 32-byte key (raw bytes, HKDF derivation, etc.).
 *
 * Concrete implementations:
 *   - KeychainKeyProvider — OS keychain with chmod-600 file fallback (default)
 *   - MnemonicKeyProvider — direct mnemonic input, used by tests
 *   - EnvKeyProvider      — base64 raw key from an env var (CI/headless deployments)
 */
import type { InitContext } from '../core/init-context/interface.js'

/**
 * The user-visible form of a provider's stored secret. Two shapes:
 *   - `mnemonic` — 24-word BIP39 phrase (KeychainKeyProvider). The AES key is derived
 *     from this via HKDF-SHA256.
 *   - `raw` — base64-encoded 32-byte AES key (EnvKeyProvider). Used directly with no
 *     derivation step.
 *
 * Conversion direction: mnemonic → raw is one-way (HKDF), so a keychain provider can
 * emit either form; an env provider can only emit raw.
 */
export interface CanonicalSecret {
  format: 'mnemonic' | 'raw'
  value: string
}

export interface KeyProvider {
  /** Resolve the 32-byte AES-256 key for this vault. May read keychain / disk / env / etc. */
  getKey(): Promise<Buffer>

  /**
   * Verify the key source is reachable from a future unattended subprocess (specifically
   * the auto-retrieval hook). Called by `mementos integration hook enable` so we fail fast at install
   * time instead of silently at every Claude-Code message.
   *
   * Optional. The contract for implementers:
   *   - Throw if the source is fatally unreachable AND running `mementos init` would fix
   *     it (e.g. keychain says "no key set"). Caller exits with this Error's message.
   *   - Throw if the source is fatally unreachable but init would DESTROY data (e.g.
   *     keychain backend down — key may still exist behind it). Include "Do NOT run
   *     mementos init" in the message; caller will print and exit.
   *   - Print a `console.error` warning and return cleanly when the source is conditionally
   *     reachable (e.g. env var unset in current shell but might be set in the AI client's
   *     launch environment — install should proceed).
   *
   * If a provider has no environmental constraints to check, omit the method.
   */
  checkReachable?(): Promise<void>

  /**
   * Return the canonical stored secret for share-key / migrate / recovery flows.
   * KeychainKeyProvider returns `{ format: 'mnemonic', value: <24 words> }`;
   * EnvKeyProvider returns `{ format: 'raw', value: <base64 32 bytes> }`. share-key
   * is responsible for cross-format display (mnemonic → HKDF → base64 for keychain
   * users who need an env value on the receiving machine).
   *
   * Optional: test-only providers that don't persist a stable secret may omit it.
   */
  getCanonicalSecret?(): Promise<CanonicalSecret>

  /**
   * Tear down the persisted key material for this provider. Called by `mementos destroy`.
   *
   * Each provider decides what removal means:
   *   - KeychainKeyProvider: deletes the OS keychain entry and the chmod-600 fallback file
   *   - EnvKeyProvider: nothing to remove on disk; prints instructions for the user to
   *     unset the env var in their shell profile
   *
   * Status output goes through `print` so the caller controls log routing.
   */
  clearStoredKey(print: (msg: string) => void): Promise<void>

  /**
   * One-line summary of where this provider's key lives. Used in the destroy prompt
   * label so the user knows what `clearStoredKey()` will do for their setup.
   */
  describeStoredKey(): string

  /**
   * Persist 32 bytes of entropy as this provider's vault key. Shared by both setup
   * paths:
   *   - `setupAtInit` calls this with freshly-generated entropy on new-vault init
   *   - The join branch calls this with entropy the user typed (mnemonic / raw) or
   *     received via LAN pairing
   *
   * Each provider decides how to persist:
   *   - KeychainKeyProvider: encodes the entropy as a 24-word BIP39 mnemonic and stores
   *     it in the OS keychain (or chmod-600 fallback file)
   *   - EnvKeyProvider: shows the user the base64 form via `ctx.showSecret` and prints
   *     instructions to set `MEMENTOS_RAW_KEY` — there's no persistable on-disk state
   *
   * Always displays the stored value through `ctx.showSecret` so the user can write it
   * down for backup (relevant especially on join via LAN pair, where they never saw
   * the mnemonic during the handshake).
   */
  storeEntropy(entropy: Buffer, ctx: InitContext): Promise<void>

  /**
   * Whether this provider already has a working key persisted. The join flow uses this
   * to skip the "type your existing key" prompt when the user has already set up the
   * key out-of-band (e.g. exported MEMENTOS_RAW_KEY before running `init --mode=join`,
   * or the keychain entry already exists from a previous mementos install).
   */
  isAlreadyConfigured(): Promise<boolean>
}
