/**
 * `mementos status` — the cheap "what's going on?" readout.
 *
 * Complements `mementos doctor` rather than duplicating it. Doctor *verifies*: it
 * unlocks the key, lists storage (a network round-trip on remote backends), decrypts a
 * memento, loads the embedder and probes every integration — well over a second on a
 * real vault — and exits non-zero so it can gate a script. Status only *reports* what
 * is already recorded on disk, so it stays fast enough to run on a whim.
 *
 * It therefore touches: the machine config, the vault directory listing, `vault.json`,
 * the daemon state file, and the daemon port. Nothing that unlocks, decrypts, loads a
 * model or talks to a remote.
 *
 * Always exits 0, including when nothing is initialised — "not set up yet" is a status
 * worth reporting, not a failure. Anything that needs an exit code wants `doctor`.
 */
import { readdir } from 'node:fs/promises'
import { readMachineConfigOrNull, readVaultConfig } from '../../core/config.js'
import { MEM_EXTENSION } from '../../core/vault/constants.js'
import { getDaemonState, isDaemonPortBound } from '../../daemon/api-client.js'
import { readDaemonStateFile } from '../../daemon/state.js'
import { DAEMON_PORT } from '../../daemon/constants.js'
import { packageVersion } from '../_utils/version.js'
import { secondsSince, formatUptime } from '../_utils/time.js'

const LABEL_WIDTH = 10

export async function runStatus(): Promise<void> {
  console.log(`mementos ${packageVersion()}\n`)

  const machine = await readMachineConfigOrNull()
  if (!machine) {
    line('Vault', 'not initialised on this machine')
    console.log('\nRun `mementos init` to set one up.')
    return
  }

  line('Daemon', await describeDaemon())
  line('Vault', await describeVault(machine.vaultPath, machine.backend))
  line('Embedder', await describeEmbedder(machine.vaultPath))

  console.log('\nRun `mementos doctor` for a full health check.')
}

/**
 * The daemon's state file and the port can disagree. When they do — the port held with
 * no readable state — that is the single most useful thing this command can say, since
 * it is the condition that makes `mementos start` fail and `mementos stop` powerless.
 */
async function describeDaemon(): Promise<string> {
  const state = await getDaemonState()

  if (state === 'absent') {
    if (await isDaemonPortBound()) {
      return `✗  port ${DAEMON_PORT} bound but no readable daemon state — an orphaned process is holding it\n`
        + `${' '.repeat(LABEL_WIDTH + 2)}find it with \`ss -ltnp | grep ${DAEMON_PORT}\` (or \`lsof -i :${DAEMON_PORT}\`) and kill that PID`
    }
    return 'not running — AI clients start it on demand, or run `mementos start`'
  }

  const file = await readDaemonStateFile()
  if (state === 'initializing') {
    return `initializing (PID ${file?.pid ?? '?'}, started ${file ? secondsSince(file.startedAt) : '?'}s ago) — loading the vault`
  }
  return `running (PID ${file?.pid ?? '?'}, up ${file ? formatUptime(file.startedAt) : '?'})`
}

/**
 * Errors are rendered, not thrown: a status readout is most valuable precisely when
 * something is broken, so one unreadable piece must not suppress the rest. The message
 * is shown in full — nothing is swallowed.
 */
async function describeVault(path: string, backend: string): Promise<string> {
  try {
    const entries = await readdir(path)
    const count = entries.filter(f => f.endsWith(MEM_EXTENSION)).length
    return `${path} — ${count} memento${count === 1 ? '' : 's'}, ${backend} backend`
  } catch (e) {
    return `${path} — unreadable: ${(e as Error).message}`
  }
}

async function describeEmbedder(vaultPath: string): Promise<string> {
  try {
    return (await readVaultConfig(vaultPath)).embedder
  } catch (e) {
    return `unknown — vault.json unreadable: ${(e as Error).message}`
  }
}

function line(label: string, detail: string): void {
  console.log(`  ${label.padEnd(LABEL_WIDTH)}${detail}`)
}
