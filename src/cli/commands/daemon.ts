/**
 * `mementos start` / `mementos stop` — the persistent daemon that holds the
 * vault in memory for the lifetime of multiple sessions.
 *
 *   `start`        → bind the HTTP API port (`127.0.0.1:47899` by default),
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
import { readFile } from 'node:fs/promises'
import { safeUnlink } from '../../core/_utils/fs.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runDaemon } from '../../daemon/runner.js'
import { isDaemonRunning } from '../../daemon/api-client.js'
import { DAEMON_PID_FILE, DAEMON_URL, AUTOSTART_TIMEOUT_MS, AUTOSTART_POLL_INTERVAL_MS } from '../../daemon/constants.js'
import { parseFlag } from '../_utils/flags.js'


/**
 * `mementos start [--foreground]` — run the daemon. Without `--foreground`,
 * double-forks so the user gets their shell back immediately. With it, blocks
 * on stdio for debugging (logs visible, Ctrl-C kills cleanly).
 */
export async function runStart(): Promise<void> {
  if (await isDaemonRunning()) {
    console.error(`mementos daemon already running at ${DAEMON_URL}.`)
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
  spawnDaemonDetached()

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
  console.log(`mementos daemon started (at ${DAEMON_URL}).`)
}

/**
 * `mementos stop` — read the PID file, send SIGTERM, wait for the socket to
 * disappear, then unlink the PID file (the daemon's own shutdown also unlinks
 * it; this is the belt for if the daemon was killed -9).
 */
export async function runStop(): Promise<void> {
  let pid: number
  try {
    pid = Number((await readFile(DAEMON_PID_FILE, 'utf8')).trim())
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error('mementos stop: no daemon running (no PID file).')
      process.exit(1)
    }
    throw e
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    console.error(`mementos stop: malformed PID file at ${DAEMON_PID_FILE}.`)
    process.exit(1)
  }

  // Probe the daemon port BEFORE killing — `isDaemonRunning` is the
  // authoritative liveness signal (the daemon binds the port for its full
  // lifetime, releases it on graceful shutdown). The PID file alone is not
  // enough: the daemon unlinks its own PID on graceful shutdown, so a stale
  // PID file means the daemon was killed -9 OR crashed AND the OS may have
  // since recycled the PID to an unrelated process. Sending SIGTERM to that
  // recycled PID would kill the wrong program. The port probe closes the
  // dangerous case for free — no daemon listening, PID file is stale, clean
  // it up and exit.
  if (!await isDaemonRunning()) {
    await safeUnlink(DAEMON_PID_FILE)
    console.error('mementos stop: no daemon running (PID file was stale; cleaned up).')
    process.exit(1)
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
      console.error(`mementos stop: PID ${pid} no longer running (stale PID file).`)
      await safeUnlink(DAEMON_PID_FILE)
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

