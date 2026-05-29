/**
 * BIP39 mnemonic generation utility.
 *
 * Lives at this level — not under any one provider — because both `KeychainKeyProvider`
 * (during init, to generate the secret it stores) and `MnemonicKeyProvider` (in tests)
 * use it. Sibling providers shouldn't import from each other for utilities; that's what
 * `_utils/` is for.
 */

import { loadBip39 } from './bip39.js'

/** Generate a fresh 24-word BIP39 mnemonic (256 bits of entropy). */
export async function generateMnemonic(): Promise<string> {
  const { generateMnemonic: bip39Generate, wordlist } = await loadBip39()
  return bip39Generate(wordlist, 256)
}
