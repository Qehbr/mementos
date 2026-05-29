/**
 * `mementos share-key` — transfer the vault key to a new device, two ways:
 *   1. Show on screen — print the mnemonic / raw key for the user to type elsewhere.
 *   2. Send via LAN pairing — mDNS + ECDH + 6-digit SAS handshake; see _transfer/protocol.ts.
 *
 * CLI-only (never exposed via MCP — an AI calling this automatically would be catastrophic)
 * and TTY-only (refuses piped/redirected stdout, same posture as `sudo`).
 */
import { select, confirm as confirmPrompt } from '@inquirer/prompts'
import { machineConfigFile } from '../../core/config.js'
import {
  mnemonicToEntropyBytes, entropyToMnemonicString,
} from '../../keys/_utils/derivation/index.js'
import type { CanonicalSecret } from '../../keys/interface.js'
import { CliInitContext } from '../init-context.js'
import { buildKeyProvider, readMachineConfigOrExit } from '../_utils/vault.js'
import { sendKey } from '../_transfer/index.js'

export async function runShareKey(): Promise<void> {
  // Refuse non-TTY before touching the keychain so a `mementos share-key > file` redirect
  // does NOT trigger an OS auth prompt — a denied prompt may itself be informative to an
  // attacker, and an accepted one would write the mnemonic to the file.
  if (!process.stdout.isTTY) {
    console.error('share-key requires an interactive terminal (TTY). Refusing to write a key into a pipe or file.')
    process.exit(1)
  }

  const machine = await readMachineConfigOrExit()

  if (!machine.keyProvider) {
    console.error(`MachineConfig is missing 'keyProvider' — fix ${machineConfigFile()} or re-run 'mementos init --reinit'.`)
    process.exit(1)
  }

  const provider = await buildKeyProvider(machine)

  if (!provider.getCanonicalSecret) {
    console.error(`The '${machine.keyProvider}' key provider does not support key export.`)
    process.exit(1)
  }

  const ctx = new CliInitContext()
  ctx.print('mementos — share key\n')
  ctx.print('This will transfer the vault key to another device. WARNING: anyone with')
  ctx.print('this key can decrypt EVERY memory in this vault — past, present, and future,')
  ctx.print('including snapshots taken at any point in its history. Treat it like a')
  ctx.print('master password.')
  ctx.print('')

  // Read canonical secret. On macOS/Linux with a working OS keychain, this triggers the
  // OS's own auth prompt (Touch ID / password / libsecret unlock) for keychain provider.
  // We intentionally do NOT add a mementos-side password prompt on top of that.
  let canonical: CanonicalSecret
  try {
    canonical = await provider.getCanonicalSecret()
  } catch (e) {
    console.error(`Failed to read key: ${(e as Error).message}`)
    process.exit(1)
  }

  type Mode = 'show' | 'lan'
  const mode = await select<Mode>({
    message: 'How would you like to share the key?',
    choices: [
      { name: 'Show on screen (copy/write down for backup or manual entry on the new device)', value: 'show' },
      { name: 'Send via LAN pairing (another mementos device on this network)', value: 'lan' },
    ],
  })

  if (mode === 'show') {
    await runShowFlow(ctx, canonical)
  } else {
    await runLanSendFlow(ctx, canonical)
  }
}

/**
 * Show-on-screen flow. Since both providers store the same 32-byte entropy (keychain
 * encodes as BIP39 words, env encodes as base64), the user can pick either display form
 * regardless of which provider this machine uses — BIP39 is fully invertible.
 */
async function runShowFlow(ctx: CliInitContext, canonical: CanonicalSecret): Promise<void> {
  type Format = 'mnemonic' | 'raw'
  const chosenFormat = await select<Format>({
    message: 'Show as:',
    choices: [
      { name: '24-word mnemonic phrase (for keychain provider on new device)', value: 'mnemonic' },
      { name: 'Raw 32-byte entropy, base64 (for env provider / MEMENTOS_RAW_KEY)', value: 'raw' },
    ],
  })

  const displayValue = await convertCanonical(canonical, chosenFormat)
  const label = chosenFormat === 'mnemonic'
    ? 'Vault key (24-word mnemonic)'
    : 'Vault key (32-byte entropy, base64)'
  await ctx.showSecret(label, displayValue)
}

/** Convert a canonical secret into either form, going through entropy bytes as needed. */
async function convertCanonical(canonical: CanonicalSecret, target: 'mnemonic' | 'raw'): Promise<string> {
  if (canonical.format === target) return canonical.value
  if (target === 'raw') {
    // mnemonic → entropy → base64
    return (await mnemonicToEntropyBytes(canonical.value)).toString('base64')
  }
  // raw → entropy → mnemonic
  const entropy = Buffer.from(canonical.value, 'base64')
  return entropyToMnemonicString(entropy)
}

/**
 * LAN pairing flow. Wraps the canonical secret as JSON so the receiver knows whether
 * what arrived is a mnemonic or a raw key. The protocol layer is content-agnostic;
 * format-tagging is a share-key/receive-key contract.
 */
async function runLanSendFlow(ctx: CliInitContext, canonical: CanonicalSecret): Promise<void> {
  const payload = JSON.stringify({ format: canonical.format, value: canonical.value })
  // Pre-print: without this, the user sees only "Listening on port N…" and a silent
  // 5-min wait, with no indication that the receiver-side device has to run a specific
  // command.
  ctx.print('On the OTHER device, run:  mementos init --mode=join')
  ctx.print('and pick "Receive via LAN pairing" when prompted for the existing key.')
  ctx.print('(Waiting up to 5 minutes for the receiver to connect.)')
  await sendKey(
    payload,
    msg => ctx.print(msg),
    async (sas) => {
      ctx.print('')
      ctx.print(`Verify this number matches on BOTH screens:  ${sas}`)
      return await confirmPrompt({ message: 'Match?', default: false })
    },
  )
}
