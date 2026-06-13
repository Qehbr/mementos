/**
 * `mementos start` / `mementos stop` — the persistent daemon that holds the
 * vault in memory for the lifetime of multiple sessions.
 *
 *   `start`        → bind the HTTP API port (`127.0.0.1:47899` by default),
 *                    hold the vault, exit on SIGTERM. `--foreground` keeps
 *                    stdio attached for debugging; otherwise double-fork
 *                    into the background. **Returns as soon as the child
 *                    has spawned + survived a 1.5s sanity check** — the
 *                    actual vault load (cold ONNX + decrypt of every `.mem`)
 *                    can take minutes on large vaults, and there is no
 *                    point blocking the user's terminal on it. The daemon
 *                    advertises its state via `~/.config/mementos/daemon.state`;
 *                    AI clients auto-wait for `ready`, `mementos doctor`
 *                    reports the live state.
 *   `stop`         → read the PID out of the state file, send SIGTERM, wait
 *                    for the port to free up.
 *   `ensureDaemonRunning()` → helper for the auto-start paths (`mementos mcp`,
 *                    hook subprocesses). Spawns the daemon if needed, then
 *                    polls the state file for `ready`. The mcp shim passes
 *                    `timeoutMs: null` (wait forever); hooks keep the default
 *                    5s budget so they stay fail-soft.
 *
 * The listening port is the single-instance mutex (`assertPortFree` inside
 * `startHttpApi`); the state file is best-effort diagnostic info that the
 * port-bind makes race-safe (only the winning daemon ever writes it).
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runDaemon } from '../../daemon/runner.js'
import { getDaemonState } from '../../daemon/api-client.js'
import {
  readDaemonStateFile, deleteDaemonStateFile, isProcessAlive,
} from '../../daemon/state.js'
import {
  DAEMON_URL, SPAWN_SANITY_CHECK_MS, AUTOSTART_POLL_INTERVAL_MS,
} from '../../daemon/constants.js'
import { parseFlag } from '../_utils/flags.js'

/** Default budget for `ensureDaemonRunning` callers that need a bound. Hooks. */
const DEFAULT_ENSURE_TIMEOUT_MS = 5_000

/**
 * `mementos start [--foreground]` — run the daemon. Without `--foreground`,
 * double-forks and returns as soon as the child has survived a brief
 * sanity check (no hanging while the vault loads).
 */
export async function runStart(): Promise<void> {
  const state = await getDaemonState()
  if (state === 'ready') {
    console.error(`mementos daemon already running at ${DAEMON_URL}.`)
    process.exit(1)
  }
  if (state === 'initializing') {
    const file = await readDaemonStateFile()
    const ago = file ? secondsSince(file.startedAt) : '?'
    console.error(`mementos daemon already initializing (PID ${file?.pid}, started ${ago}s ago).`)
    console.error('Wait for it to finish — large vaults take a minute or two on first start —')
    console.error('or run `mementos stop` to abort and retry.')
    process.exit(1)
  }

  const foreground = parseFlag('foreground') !== undefined
  if (foreground) {
    await runDaemon()
    return
  }

  // Detached background mode. Spawn, sanity-check, return. The daemon's own
  // startup may take minutes on large vaults; we don't wait for `ready` here.
  const pid = spawnDaemonDetached()

  await delay(SPAWN_SANITY_CHECK_MS)
  if (!isProcessAlive(pid)) {
    console.error(`mementos start: daemon process (PID ${pid}) exited within ${SPAWN_SANITY_CHECK_MS}ms.`)
    console.error('Run `mementos start --foreground` to see the startup error.')
    process.exit(1)
  }

  console.log(`mementos daemon spawning (PID ${pid}).`)
  console.log('Large vaults take a minute or two on first start (cold embedder load + decrypt).')
  console.log('AI clients auto-wait. Check status with: mementos doctor')
}

/**
 * `mementos stop` — read the PID out of the state file, send SIGTERM, wait
 * for the port to release. Tolerates stale state files (PID dead).
 */
export async function runStop(): Promise<void> {
  const file = await readDaemonStateFile()
  if (!file) {
    // Either no state file at all OR the file's PID is dead. Either way:
    // no daemon to stop. Clean up any stale file and exit informatively.
    await deleteDaemonStateFile()
    console.error('mementos stop: no daemon running.')
    process.exit(1)
  }

  try {
    process.kill(file.pid, 'SIGTERM')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
      // Process died between readDaemonStateFile and kill — race-tolerant cleanup.
      await deleteDaemonStateFile()
      console.error(`mementos stop: PID ${file.pid} no longer running (cleaned up).`)
      process.exit(1)
    }
    throw e
  }

  // Wait for the daemon to flip the state file to absent. If it doesn't
  // within the timeout, we still report success — the SIGTERM was delivered.
  const deadline = Date.now() + DEFAULT_ENSURE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if ((await getDaemonState()) === 'absent') {
      console.log(`mementos daemon stopped (PID ${file.pid}).`)
      return
    }
    await delay(AUTOSTART_POLL_INTERVAL_MS)
  }
  console.log(`mementos stop: SIGTERM sent to PID ${file.pid}; daemon may still be flushing.`)
}

/**
 * Spawn a daemon if none is running, then wait for it to be `ready`. Used by
 * `mementos mcp` (the stdio MCP shim AI clients launch) and by hook
 * subprocesses. Idempotent — if a daemon is already up, returns immediately.
 *
 * `timeoutMs`:
 *   - `undefined` (default) → 5s budget. Hooks pass this; if startup is
 *     genuinely slow, fail-soft and skip the hook this turn.
 *   - `null`                → wait forever. The mcp shim passes this; tool
 *     calls are what the AI client wants, blocking is correct.
 *   - a number              → custom budget (mostly for tests).
 *
 * Throws when the budget expires (callers decide whether to surface that).
 */
export async function ensureDaemonRunning(
  opts: { timeoutMs?: number | null } = {},
): Promise<void> {
  const initialState = await getDaemonState()
  if (initialState === 'ready') return

  // Capture the spawned PID so `waitForReady` can detect a spawn that died
  // (PID-liveness is an exact signal — no timing guess about how long
  // buildVault should take). If `initialState` was `initializing`, someone
  // else is already coming up; we just observe and don't spawn a second one.
  const spawnedPid = initialState === 'absent' ? spawnDaemonDetached() : undefined

  const budget = opts.timeoutMs === undefined ? DEFAULT_ENSURE_TIMEOUT_MS : opts.timeoutMs
  const ok = await waitForReady(budget, spawnedPid)
  if (!ok) {
    throw new Error(
      'mementos daemon failed to start — try `mementos start --foreground` to see the startup error. ' +
      'Common causes: a pending migration manifest (run `mementos migrate` or `--abort`), ' +
      'a broken config, or an unreachable key provider.',
    )
  }
}

function spawnDaemonDetached(): number {
  const cliEntry = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'index.js')
  const child = spawn(process.execPath, [cliEntry, 'start', '--foreground'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  // `child.pid` is set synchronously after a successful `spawn()`. Cast is
  // safe — Node only returns undefined when the spawn failed to launch, in
  // which case the next line in runStart's poll path would catch the dead PID.
  return child.pid as number
}

/**
 * Poll the state file until `ready` (or we conclude the spawn died).
 *
 * `timeoutMs: null` means wait forever for a slow `initializing` daemon
 * — the mcp shim passes this because tool calls genuinely want to block.
 * The failure-detection signal in that mode is `spawnedPid`: if state is
 * `absent` AND the spawned PID is dead, the daemon's buildVault failed
 * (stale manifest after kill mid-migration, the migration-fence path,
 * broken config, …) and no further waiting will help.
 *
 * Using PID liveness instead of a timing window means we never
 * false-positive on a legitimately-slow buildVault (cold dynamic imports,
 * slow disk, big plugin set) where the state file just hasn't been
 * written yet — the PID is still alive, so we keep waiting.
 *
 * The bounded-budget case still throws on budget expiry as before.
 */
async function waitForReady(timeoutMs: number | null, spawnedPid?: number): Promise<boolean> {
  const deadline = timeoutMs === null ? null : Date.now() + timeoutMs
  while (deadline === null || Date.now() < deadline) {
    const state = await getDaemonState()
    if (state === 'ready') return true
    // Wait-forever-mode failure detection: the spawned PID is dead AND
    // the state file is absent — buildVault threw before writing state.
    // (If state is `initializing`, daemonState already verified the
    // state-file's PID is alive; if that PID dies later, the next poll
    // would return `absent` and the same check fires.)
    if (timeoutMs === null && state === 'absent'
        && spawnedPid !== undefined && !isProcessAlive(spawnedPid)) {
      return false
    }
    await delay(AUTOSTART_POLL_INTERVAL_MS)
  }
  return false
}

function secondsSince(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return '?'
  return String(Math.max(0, Math.round((Date.now() - then) / 1000)))
}
