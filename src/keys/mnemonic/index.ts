/**
 * MnemonicKeyProvider — direct BIP39 mnemonic → AES-256 key.
 *
 * Takes a 24-word phrase in the constructor and runs it through the shared HKDF derivation
 * (see `_utils/derivation/`). Used directly by tests for deterministic vault setup without
 * touching the OS keychain.
 *
 * Not registered for runtime discovery (no `type`/`create` exports) — there's no realistic
 * runtime source for the mnemonic argument that doesn't overlap with another provider:
 *   - mnemonic-via-env-var: identical concept to EnvKeyProvider
 *   - mnemonic-via-keychain: that's KeychainKeyProvider
 *   - mnemonic-in-source: tests only
 *
 * For BIP39 generation in production code, use `generateMnemonic()` from `_utils/mnemonic.ts`.
 */
import type { KeyProvider } from '../interface.js'
import type { InitContext } from '../../core/init-context/interface.js'
import { deriveKeyFromMnemonic } from '../_utils/derivation/index.js'

export class MnemonicKeyProvider implements KeyProvider {
  constructor(private readonly mnemonic: string) {}

  async getKey(): Promise<Buffer> {
    return deriveKeyFromMnemonic(this.mnemonic)
  }

  /** Test-only provider — the mnemonic lives in the test code, not on disk. No-op. */
  async clearStoredKey(_print: (msg: string) => void): Promise<void> {
    // intentionally empty
  }

  describeStoredKey(): string {
    return 'test-only mnemonic (no persisted state)'
  }

  /** Test-only provider — entropy goes nowhere; the mnemonic in the constructor is the source of truth. */
  async storeEntropy(_entropy: Buffer, _ctx: InitContext): Promise<void> {
    // intentionally empty
  }

  /** Test-only — the mnemonic is always provided in the constructor, so always configured. */
  async isAlreadyConfigured(): Promise<boolean> {
    return true
  }
}
