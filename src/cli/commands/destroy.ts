/**
 * `mementos destroy` — interactive cleanup of this machine's mementos setup.
 *
 * Multi-select toggles for the things mementos owns on this machine:
 *
 *   [x] Machine config & state    the whole ~/.config/mementos/ directory — config,
 *                                 HNSW cache, serve registry, any migration manifest
 *   [x] Vault key                 via KeyProvider.clearStoredKey (provider-specific)
 *   [x] AI client integrations    MCP entries / skills / hooks (those installed)
 *
 * Vault data is NOT a destroy option. Removal semantics differ across backends —
 * LocalBackend's `rm -rf` is permanent; GitBackend's `rm -rf` only deletes the local
 * clone (the remote keeps every memory and is reachable from every other paired
 * device). Conflating those under one toggle leads to surprised users. So destroy
 * always preserves data and prints where it lives + a copy-pasteable removal command,
 * letting the user make that destructive decision deliberately and out-of-band.
 *
 * Exit codes:
 *   0  on success (including "nothing to do" if no machine config exists)
 *   1  if the user aborts the confirmation, or any individual removal fails
 */
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { checkbox, confirm as confirmPrompt } from '@inquirer/prompts'
import { WizardHeader } from '../_utils/prompts.js'
import { promptTheme, checkboxTheme, dim } from '../_utils/style.js'
import { readMachineConfigOrNull, machineConfigFile } from '../../core/config.js'
import { loadIntegrations } from '../../integrations/registry.js'
import { buildStorageAndKey } from '../_utils/vault.js'
import type { MachineConfig } from '../../core/types.js'
import type { ClientIntegration } from '../../integrations/interface.js'
import type { StorageBackend } from '../../storage/interface.js'
import type { KeyProvider } from '../../keys/interface.js'

type Target = 'config' | 'key' | 'integrations'

export async function runDestroy(): Promise<void> {
  const machine = await readMachineConfigOrNull()

  if (!machine) {
    console.log(`No mementos setup found on this machine (no ${machineConfigFile()}).`)
    console.log('Nothing to destroy.')
    return
  }

  const { storage, keyProvider: provider } = await buildStorageAndKey(machine)
  const installedIntegrations = await collectInstalledIntegrations()
  const dataSummary = await storage.describeStoredData()

  const header = new WizardHeader('mementos destroy', 2)
  header.show(1, console.log)
  // Every target ships UNCHECKED — destroy is destructive, opt-in only. Users
  // tick exactly what they mean to remove; blind Enter removes nothing.
  const chosen = await checkbox<Target>({
    message: `What should I remove?\n${dim('  Nothing is pre-selected — tick what you want gone. Vault data is preserved either way.')}`,
    choices: [
      {
        name: `Machine config & local state  ${dim(`(${dirname(machineConfigFile())}/)`)}`,
        value: 'config',
        checked: false,
      },
      {
        name: `Vault key  ${dim(`(${provider.describeStoredKey()})`)}`,
        value: 'key',
        checked: false,
      },
      {
        name: installedIntegrations.length > 0
          ? `AI client integrations  ${dim(`(${installedIntegrations.map(i => i.name).join(', ')})`)}`
          : `AI client integrations  ${dim('(none currently installed)')}`,
        value: 'integrations',
        checked: false,
        disabled: installedIntegrations.length === 0 ? '(nothing to remove)' : false,
      },
    ],
    theme: checkboxTheme,
  })

  if (chosen.length === 0) {
    console.log('Nothing selected — aborting.')
    return
  }

  console.log('')
  if (chosen.includes('key')) {
    console.log('WARNING: removing the key WITHOUT removing the data leaves the .mem files')
    console.log('orphaned — a future `mementos init` would generate a new, unrelated key')
    console.log("and the existing data can't be decrypted with it.")
    console.log('')
  }
  console.log(`Vault data location: ${dataSummary}`)
  console.log('(mementos does NOT remove vault data automatically — see below for manual removal.)')
  console.log('')

  header.show(2, console.log)
  const ok = await confirmPrompt({
    message: `Proceed with removing: ${chosen.join(', ')}?\n${dim('  This is irreversible for the selected items.')}`,
    default: false,
    theme: promptTheme,
  })
  if (!ok) {
    console.log('Aborted.')
    process.exit(1)
  }

  let hadFailure = false
  for (const target of chosen) {
    try {
      await runTarget(target, { storage, provider, installedIntegrations, machine, print: console.log })
    } catch (e) {
      console.error(`Failed to remove ${target}: ${(e as Error).message}`)
      hadFailure = true
    }
  }

  console.log('')
  console.log('Vault data was NOT removed. It is still at:')
  console.log(`  ${dataSummary}`)
  printRemovalRecipe(storage, machine, console.log)

  if (hadFailure) process.exit(1)
}

/**
 * Per-backend manual-removal recipe printed after `destroy` finishes. Each
 * backend declares its own lines via `describeManualRemoval` — git extends the
 * local `rm -rf` with the remote-side step so the user isn't misled into
 * thinking a local delete wiped their data.
 */
function printRemovalRecipe(
  storage: StorageBackend, machine: MachineConfig, print: (msg: string) => void,
): void {
  for (const line of storage.describeManualRemoval(machine.vaultPath)) print(line)
}

interface DestroyDeps {
  storage: StorageBackend
  provider: KeyProvider
  installedIntegrations: ClientIntegration[]
  machine: MachineConfig
  print: (msg: string) => void
}

async function runTarget(target: Target, deps: DestroyDeps): Promise<void> {
  switch (target) {
    case 'integrations':
      for (const integration of deps.installedIntegrations) {
        await integration.uninstall()
        deps.print(`Removed integration: ${integration.name}`)
      }
      return
    case 'key':
      await deps.provider.clearStoredKey(deps.print)
      return
    case 'config': {
      // Backend-specific cleanup before we nuke the config dir. Git removes a
      // per-vault SSH key WE auto-generated (user-owned keys are left alone);
      // other backends typically have nothing extra.
      await deps.storage.cleanupOnDestroy?.(deps.print)
      const configDir = dirname(machineConfigFile())
      await rm(configDir, { recursive: true, force: true })
      deps.print(`Removed ${configDir}/`)
      return
    }
  }
}

/** Filter the integration registry to those currently registered with their AI client. */
async function collectInstalledIntegrations(): Promise<ClientIntegration[]> {
  const integrationReg = await loadIntegrations()
  const installed: ClientIntegration[] = []
  for (const impl of integrationReg.values()) {
    const integration = impl.create()
    if (await integration.isInstalled().catch(() => false)) {
      installed.push(integration)
    }
  }
  return installed
}
