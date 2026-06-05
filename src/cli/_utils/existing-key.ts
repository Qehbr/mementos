/**
 * Prompt the join-flow user for an existing vault key and return the underlying 32 bytes
 * of entropy. The caller (runInitJoin) hands the entropy to the chosen KeyProvider's
 * `storeEntropy()` for persistence.
 *
 * Three input methods, asked via a single select:
 *   1. Type the 24-word BIP39 mnemonic — validated against the BIP39 checksum
 *   2. Type the base64-encoded 32-byte entropy — validated for length after decode
 *   3. Receive via LAN pairing — runs the ECDH+SAS handshake from share-key's wire
 *      protocol; expects the same `{ format, value }` payload share-key sends
 *
 * Each method converges on the same 32-byte buffer regardless of input shape, because
 * mnemonic and raw entropy are isomorphic representations of the same secret (BIP39 is
 * fully invertible; HKDF happens later in the provider's `getKey()`).
 */
import { input, select, confirm as confirmPrompt } from '@inquirer/prompts'
import { mnemonicToEntropyBytes } from '../../keys/_utils/derivation/index.js'
import { receiveKey, type DiscoveredPeer } from '../_transfer/index.js'
import { promptTheme } from './style.js'
import type { CliInitContext } from '../init-context.js'

type Source = 'mnemonic' | 'raw' | 'lan'

export async function promptForExistingKey(ctx: CliInitContext): Promise<Buffer> {
  const source = await select<Source>({
    message: 'How will you provide the existing vault key?',
    choices: [
      { name: 'Type the 24-word mnemonic phrase', value: 'mnemonic' },
      { name: 'Type the raw 32-byte entropy (base64)', value: 'raw' },
      { name: 'Receive via LAN pairing (another mementos device running `share-key`)', value: 'lan' },
    ],
    theme: promptTheme,
  })

  switch (source) {
    case 'mnemonic': return await collectMnemonic()
    case 'raw':      return await collectRaw()
    case 'lan':      return await collectViaLan(ctx)
  }
}

async function collectMnemonic(): Promise<Buffer> {
  // BIP39 checksum lives inside `validate` so a typo (incorrect word, swapped order,
  // checksum-failing combo) re-prompts JUST the mnemonic — the rest of init's prompts
  // (backend, vault path, git remote URL…) are NOT lost. Without this, a single mis-typed
  // word aborts the whole flow and the user has to re-do every prior prompt.
  let entropy: Buffer | undefined
  await input({
    message: 'Mnemonic (24 words separated by spaces):',
    theme: promptTheme,
    validate: async (value: string) => {
      const trimmed = value.trim()
      if (!trimmed) return 'Mnemonic cannot be empty.'
      const count = trimmed.split(/\s+/).length
      if (count !== 24) return `Expected 24 words, got ${count}.`
      try {
        entropy = await mnemonicToEntropyBytes(trimmed.split(/\s+/).join(' '))
        return true
      } catch (e) {
        return `Invalid mnemonic — ${(e as Error).message}. Check each word and try again.`
      }
    },
  })
  if (!entropy) throw new Error('Mnemonic prompt returned without entropy — internal error')
  return entropy
}

async function collectRaw(): Promise<Buffer> {
  const value = (await input({
    message: 'Base64-encoded 32-byte entropy:',
    theme: promptTheme,
    validate: (v: string) => {
      const trimmed = v.trim()
      if (!trimmed) return 'Cannot be empty.'
      const buf = Buffer.from(trimmed, 'base64')
      if (buf.byteLength !== 32) return `Expected 32 bytes after base64-decode, got ${buf.byteLength}.`
      return true
    },
  })).trim()
  return Buffer.from(value, 'base64')
}

async function collectViaLan(ctx: CliInitContext): Promise<Buffer> {
  const payload = await receiveKey(
    msg => ctx.print(msg),
    async (sas) => {
      ctx.print('')
      ctx.print(`Verify this number matches on BOTH screens:  ${sas}`)
      return await confirmPrompt({ message: 'Match?', default: false, theme: promptTheme })
    },
    pickPeer,
  )

  // share-key wraps `{ format, value }` as JSON so the receiver knows whether the bytes
  // are a mnemonic phrase or the base64 entropy form. Convert either way to raw entropy.
  let parsed: { format: string; value: string }
  try {
    parsed = JSON.parse(payload) as { format: string; value: string }
  } catch {
    throw new Error(`Received malformed payload (not JSON): ${payload}`)
  }

  if (parsed.format === 'mnemonic') {
    return await mnemonicToEntropyBytes(parsed.value)
  }
  if (parsed.format === 'raw') {
    const buf = Buffer.from(parsed.value, 'base64')
    if (buf.byteLength !== 32) {
      throw new Error(`Received raw payload of wrong length: expected 32 bytes, got ${buf.byteLength}.`)
    }
    return buf
  }
  throw new Error(`Received unknown payload format: ${parsed.format}`)
}

async function pickPeer(peers: DiscoveredPeer[]): Promise<DiscoveredPeer | null> {
  if (peers.length === 1) {
    const [only] = peers
    return only ?? null
  }
  return await select({
    message: 'Multiple senders found — which one?',
    choices: peers.map(p => ({ name: `${p.name}  (${p.host}:${p.port})`, value: p })),
    theme: promptTheme,
  })
}
