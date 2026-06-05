/**
 * CLI implementation of InitContext.
 *
 * Holds the staged MachineConfig patches and centralises the scrollback-clear-after-secret
 * logic. Stdin interaction goes through `@inquirer/prompts` everywhere — mixing readline
 * and inquirer's raw-mode stdin handling hangs after the first confirm/select.
 */
import { input } from '@inquirer/prompts'
import type { InitContext } from '../core/init-context/interface.js'
import type { MachineConfig } from '../core/types.js'
import { parseFlag } from './_utils/flags.js'
import { promptTheme } from './_utils/style.js'

export class CliInitContext implements InitContext {
  private machinePatches: Partial<MachineConfig>[] = []

  async showSecret(label: string, value: string): Promise<void> {
    console.log(`${label}:\n`)
    console.log(`  ${value}\n`)
    console.log('Write this down and store it safely. You cannot recover it if lost.\n')
    // "Press Enter to continue" — inquirer's `input` with no validation: any input
    // (including empty) advances. Goes through inquirer so we don't mix readline
    // with the rest of init's stdin handling (which is already inquirer-driven).
    await input({ message: 'Press Enter once you have saved it', default: '', theme: promptTheme })
    // Clear screen + scrollback so the secret doesn't linger in terminal history. Gated on
    // TTY — emitting raw escape sequences to a pipe would just leak garbage.
    if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
    console.log('mementos — encrypted AI memory vault\n')
    console.log('(Secret cleared from screen. Scrollback above may still contain it — clear it manually if your terminal preserves history.)\n')
  }

  print(message: string): void {
    console.log(message)
  }

  warn(message: string): void {
    console.error(message)
  }

  getFlag(name: string): string | undefined {
    return parseFlag(name)
  }

  patchMachineConfig(patch: Partial<MachineConfig>): void {
    this.machinePatches.push(patch)
  }

  /** Merge all staged patches into the given MachineConfig. Called by runInit at the end. */
  applyPatches(machine: MachineConfig): void {
    for (const p of this.machinePatches) Object.assign(machine, p)
  }
}
