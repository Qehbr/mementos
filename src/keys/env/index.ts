/**
 * EnvKeyProvider — reads 32 bytes of entropy (base64-encoded) from an env var, runs the
 * same HKDF-SHA256 derivation as KeychainKeyProvider, and yields the AES-256 key.
 *
 * Intended for CI / headless / containerised deployments where neither the OS keychain
 * nor an interactive prompt is available. The env var carries entropy, not the final AES
 * key directly — which means the same 256 bits can be expressed equivalently as a 24-word
 * BIP39 mnemonic. Cross-provider transfer is trivial: keychain stores the mnemonic,
 * env stores the base64 entropy, both derive the same AES key.
 */
import { randomBytes } from 'node:crypto'
import type { KeyProvider, CanonicalSecret } from '../interface.js'
import type { InitContext } from '../../core/init-context/interface.js'
import type { KeyProviderImplementationModule } from '../registry.js'
import { deriveKeyFromEntropy } from '../_utils/derivation/index.js'
import { ENV_VAR } from './constants.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'env'
export function create(): KeyProvider {
  return new EnvKeyProvider()
}

/**
 * Init-time setup. Idempotent: if MEMENTOS_RAW_KEY is already set in the environment,
 * print a notice and keep it — DON'T print a freshly generated one and tempt the user
 * to overwrite their working setup. Generation only happens on first init.
 *
 * Defense against re-running init (accidentally, or by an AI assistant) on an existing
 * vault: a regenerated key wouldn't decrypt any of the existing `.mem` files.
 */
export async function setupAtInit(ctx: InitContext): Promise<void> {
  if (process.env[ENV_VAR]) {
    ctx.print(`${ENV_VAR} is already set in the environment — keeping the existing key.`)
    return
  }
  // Fresh 32 bytes of entropy → go through the shared persistence path used by both
  // new-vault and join flows. storeEntropy shows the value and the env-var instructions.
  await new EnvKeyProvider().storeEntropy(randomBytes(32), ctx)
}

const _shape: KeyProviderImplementationModule = { type, create, setupAtInit }

export class EnvKeyProvider implements KeyProvider {
  /** @param envVar - Env var name to read. Defaults to `MEMENTOS_RAW_KEY`. */
  constructor(private readonly envVar = ENV_VAR) {}

  async getKey(): Promise<Buffer> {
    return deriveKeyFromEntropy(this.readEntropy())
  }

  /**
   * Read the env var and decode it to 32 entropy bytes. Shared by getKey (which then
   * runs HKDF) and getCanonicalSecret (which returns the base64 form to the user as-is).
   * Tolerates trailing whitespace from shells that add it (e.g. `export VAR=$(cat secret)`).
   */
  private readEntropy(): Buffer {
    const raw = process.env[this.envVar]
    if (!raw) throw new Error(`${this.envVar} env var is not set`)
    const buf = Buffer.from(raw.trim(), 'base64')
    if (buf.byteLength !== 32) {
      throw new Error(`${this.envVar} must be base64-encoded 32 bytes of entropy (got ${buf.byteLength} bytes)`)
    }
    return buf
  }

  /**
   * Canonical secret = the env var's base64 entropy. share-key shows this as-is when the
   * user picks raw; if they pick mnemonic, share-key runs entropyToMnemonic() to encode
   * the same 256 bits as 24 words.
   */
  async getCanonicalSecret(): Promise<CanonicalSecret> {
    return { format: 'raw', value: this.readEntropy().toString('base64') }
  }

  describeStoredKey(): string {
    return `${this.envVar} environment variable (set in your shell)`
  }

  async isAlreadyConfigured(): Promise<boolean> {
    return !!process.env[this.envVar]
  }

  /**
   * "Storing" for env means displaying the value and telling the user to set the env var
   * in their shell. There's no on-disk state we can write — mementos can't mutate the
   * parent process's environment. Used by both new-vault setupAtInit (with freshly
   * generated entropy) and the join branch (with entropy from user input or LAN pair).
   */
  async storeEntropy(entropy: Buffer, ctx: InitContext): Promise<void> {
    const value = entropy.toString('base64')
    await ctx.showSecret(`Your vault key (base64-encoded 32-byte entropy — set as ${this.envVar})`, value)
    // Deliberately don't re-emit `value` in the warnings: `showSecret` clears scrollback,
    // and re-printing it would defeat that and re-expose the key in terminal history.
    ctx.warn(`Set ${this.envVar} in every environment where mementos runs.`)
    ctx.warn('mementos does NOT store this. You are responsible for keeping it available.')
  }

  /**
   * Nothing to remove on disk — the secret lives in the user's shell environment, which
   * a subprocess can't unset for the parent. Surface the manual remediation.
   */
  async clearStoredKey(print: (msg: string) => void): Promise<void> {
    print(`Vault key removal: unset ${this.envVar} in your shell profile`)
    print('  (and remove it from any launcher env). mementos has nothing to remove on disk.')
  }

  /**
   * Pre-flight check. Unlike the keychain provider, a missing env-var is NOT fatal — the
   * var may be unset in the user's current shell but set where the AI client launches
   * mementos. Warn and let install proceed; the hook subprocess will fail loudly at first
   * use if the var is unreachable everywhere.
   */
  async checkReachable(): Promise<void> {
    if (!process.env[this.envVar]) {
      console.error(`Warning: ${this.envVar} is not set in the current environment.`)
      console.error('Make sure it is set in the environment from which the AI client launches mementos,')
      console.error('otherwise the hook will silently fail on every user message.')
    }
  }
}
