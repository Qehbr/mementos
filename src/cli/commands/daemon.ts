/**
 * `mementos start` / `mementos stop` — the persistent daemon that holds the
 * vault in memory for the lifetime of multiple sessions.
 *
 *   `start`        → bind the HTTP MCP port (`127.0.0.1:11434` by default),
 *                    hold the vault, exit on SIGTERM. `--foreground` keeps
 *                    stdio attached for debugging; otherwise double-fork
 *                    into the background.
 *   `stop`         → read the PID file, send SIGTERM, wait for the port to
 *                    free up. Refuses if no daemon is running.
 *   `ensureDaemonRunning()` → helper for the auto-start paths (`mementos mcp`,
 *                    hook subprocesses). Returns once the port is reachable.
 *
 * The PID file at `~/.config/mementos/daemon.pid` plus the listening port
 * together act as the mutex: any second `mementos start` invocation detects
 * the live port and refuses.
 */
import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runDaemon } from '../../daemon/runner.js'
import { isDaemonRunning } from '../../daemon/api-client.js'
import { pidFilePath, daemonUrl } from '../../daemon/endpoint.js'
import { parseFlag } from '../_utils/flags.js'

/** Time we'll wait for a freshly-spawned daemon to bind its socket before giving up. */
const AUTOSTART_TIMEOUT_MS = 5_000
const AUTOSTART_POLL_INTERVAL_MS = 50

/**
 * `mementos start [--foreground]` — run the daemon. Without `--foreground`,
 * double-forks so the user gets their shell back immediately. With it, blocks
 * on stdio for debugging (logs visible, Ctrl-C kills cleanly).
 */
export async function runStart(): Promise<void> {
  if (await isDaemonRunning()) {
    console.error(`mementos daemon already running at ${daemonUrl()}.`)
    process.exit(1)
  }

  const foreground = parseFlag('foreground') !== undefined
  if (foreground) {
    await runDaemon()
    return
  }

  // Detached background mode. Re-spawn ourselves with --foreground, then exit
  // so the user gets their shell back. The child inherits no stdio, so its
  // output doesn't bleed into the parent terminal — `mementos doctor` is how
  // the user checks "is it running?", not "did stdout say so?".
  const cliEntry = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'index.js')
  const child = spawn(process.execPath, [cliEntry, 'start', '--foreground'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()

  // Wait for the child to bind the port so the user knows it's actually up.
  // If it doesn't appear within the timeout, the child probably failed to start
  // (vault not initialised, key unreachable, …) — point at the foreground flag
  // for debugging instead of silently leaving them with no daemon.
  const ok = await waitForDaemon(AUTOSTART_TIMEOUT_MS)
  if (!ok) {
    console.error(`mementos start: daemon did not start within ${AUTOSTART_TIMEOUT_MS}ms.`)
    console.error('  Run `mementos start --foreground` to see the startup error.')
    process.exit(1)
  }
  console.log(`mementos daemon started (at ${daemonUrl()}).`)
}

/**
 * `mementos stop` — read the PID file, send SIGTERM, wait for the socket to
 * disappear, then unlink the PID file (the daemon's own shutdown also unlinks
 * it; this is the belt for if the daemon was killed -9).
 */
export async function runStop(): Promise<void> {
  let pid: number
  try {
    pid = Number((await readFile(pidFilePath(), 'utf8')).trim())
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error('mementos stop: no daemon running (no PID file).')
      process.exit(1)
    }
    throw e
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    console.error(`mementos stop: malformed PID file at ${pidFilePath()}.`)
    process.exit(1)
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
      console.error(`mementos stop: PID ${pid} no longer running (stale PID file).`)
      process.exit(1)
    }
    throw e
  }

  // Wait for the daemon to release the port. If it doesn't within the
  // timeout, we still report success — the SIGTERM was delivered.
  const deadline = Date.now() + AUTOSTART_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!await isDaemonRunning()) {
      console.log(`mementos daemon stopped (PID ${pid}).`)
      return
    }
    await delay(AUTOSTART_POLL_INTERVAL_MS)
  }
  console.log(`mementos stop: SIGTERM sent to PID ${pid}, but the daemon is still live (may be flushing).`)
}

/**
 * Spawn a daemon if none is running, then wait for the port to be reachable.
 * Used by `mementos mcp` (the stdio MCP shim AI clients launch) and by hook
 * subprocesses. Idempotent — if a daemon is already up, returns immediately.
 *
 * If the daemon can't start within the timeout, throws — the caller decides
 * whether to surface the failure (hooks: fail-soft; mcp: AI client sees it).
 */
export async function ensureDaemonRunning(): Promise<void> {
  if (await isDaemonRunning()) return
  spawnDaemonDetached()
  const ok = await waitForDaemon(AUTOSTART_TIMEOUT_MS)
  if (!ok) throw new Error(`mementos daemon did not start within ${AUTOSTART_TIMEOUT_MS}ms — try \`mementos start --foreground\` to see the error.`)
}

/**
 * Fire-and-forget variant for hooks. If no daemon is running, spawn one
 * detached and return immediately — the hook does its own work without
 * waiting for the daemon to be ready. The daemon comes up in the background
 * so subsequent CLI/MCP traffic on this machine has a target.
 */
export async function spawnDaemonIfMissing(): Promise<void> {
  if (await isDaemonRunning()) return
  spawnDaemonDetached()
}

function spawnDaemonDetached(): void {
  const cliEntry = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'index.js')
  const child = spawn(process.execPath, [cliEntry, 'start', '--foreground'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
}

async function waitForDaemon(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isDaemonRunning()) return true
    await delay(AUTOSTART_POLL_INTERVAL_MS)
  }
  return false
}

// Used by `mementos stop` to verify the PID file references the right thing.
export async function pidFileExists(): Promise<boolean> {
  try { await stat(pidFilePath()); return true } catch { return false }
}
