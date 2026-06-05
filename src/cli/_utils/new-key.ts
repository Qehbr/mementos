/**
 * Prompt the user for a new vault key during `mementos migrate --type=key`.
 *
 * Two paths:
 *   1. Generate fresh — `generateMnemonic()` produces a 24-word BIP39 phrase, the user
 *      sees it via `ctx.showSecret` so they can write it down, and we hand back the
 *      entropy bytes for re-encryption.
 *   2. Type my own — user provides their own 24-word mnemonic; validated via BIP39
 *      checksum AND entered twice to catch a silent typo (a new key has no recovery
 *      path — a mistyped mnemonic would encrypt the vault under a key nobody can
 *      reproduce; the checksum rejects most typos, double-entry catches the rest).
 *
 * Returns the entropy bytes (32) only. The mnemonic itself is shown to the user once
 * inside this function and then forgotten — the caller keeps just the entropy in
 * memory for the duration of the migration. After the migration succeeds, the new
 * mnemonic is persisted by `provider.storeEntropy(entropy, ctx)`, which re-encodes
 * the entropy back into a mnemonic and shows it again for confirmation.
 */
import { input, select } from '@inquirer/prompts'
import {
  mnemonicToEntropyBytes,
} from '../../keys/_utils/derivation/index.js'
import { generateMnemonic } from '../../keys/_utils/mnemonic.js'
import { parseFlag } from './flags.js'
import { promptTheme } from './style.js'
import type { CliInitContext } from '../init-context.js'

type Source = 'generate' | 'type'

export async function promptForNewKey(ctx: CliInitContext): Promise<{ entropy: Buffer }> {
  // Flag override for scripted use: `--new-mnemonic="word word ... word"` skips the
  // prompt and uses the supplied mnemonic. Validation still applies.
  const flag = parseFlag('new-mnemonic')
  if (flag !== undefined && flag !== '') {
    return { entropy: await collectMnemonic(flag) }
  }

  const source = await select<Source>({
    message: 'How will you provide the new vault key?',
    choices: [
      { name: 'Generate a fresh 24-word mnemonic  (recommended)', value: 'generate' },
      { name: 'Type my own 24-word mnemonic', value: 'type' },
    ],
    default: 'generate',
    theme: promptTheme,
  })

  if (source === 'generate') {
    const mnemonic = await generateMnemonic()
    await ctx.showSecret('Your NEW vault key (24-word mnemonic)', mnemonic)
    return { entropy: await mnemonicToEntropyBytes(mnemonic) }
  }

  // Type-your-own — entered twice and required to match. A new key is unrecoverable, so
  // a silent typo is permanent data loss; double-entry is the safety net the BIP39
  // checksum can't fully provide (a typo onto another checksum-valid phrase slips past it).
  const countOK = (value: string): true | string => {
    const count = value.trim().split(/\s+/).filter(Boolean).length
    return count === 24 ? true : `Expected 24 words, got ${count}.`
  }
  const normalize = (s: string): string => s.trim().split(/\s+/).join(' ')
  for (let attempt = 1; attempt <= 3; attempt++) {
    const first = await input({ message: 'New mnemonic (24 words separated by spaces):', validate: countOK, theme: promptTheme })
    const second = await input({ message: 'Re-enter the new mnemonic to confirm:', validate: countOK, theme: promptTheme })
    if (normalize(first) === normalize(second)) {
      return { entropy: await collectMnemonic(first) }
    }
    ctx.warn('The two entries did not match — type the same 24-word mnemonic both times.')
  }
  throw new Error('New mnemonic confirmation failed three times. Re-run `mementos migrate` when ready.')
}

/** Decode a mnemonic to its entropy bytes, throwing a clear error on BIP39 failure. */
async function collectMnemonic(words: string): Promise<Buffer> {
  const normalized = words.trim().split(/\s+/).join(' ')
  try {
    return await mnemonicToEntropyBytes(normalized)
  } catch (e) {
    throw new Error(`Invalid mnemonic — BIP39 validation failed: ${(e as Error).message}`)
  }
}
