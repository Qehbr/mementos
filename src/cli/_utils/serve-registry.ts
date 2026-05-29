/**
 * Serve registry — tracks which `mementos serve` processes are currently running.
 *
 * Each running server writes a marker file named by its PID under
 * `~/.config/mementos/serve/` and removes it on exit. `mementos migrate` reads the
 * directory to refuse migrating while a server is live — a running server holds a stale
 * key / machine config / embedder in memory, and a migration rewrites all three on disk.
 *
 * Many servers run at once: every MCP client (Claude Code, Cursor, …) spawns its own
 * `mementos serve` subprocess. So this is a DIRECTORY of per-PID files, not one shared
 * file — concurrent registers never race, and a crash leaves at most one stale marker,
 * which the next `listLiveServes` prunes via a liveness check.
 */
import { mkdir, readdir, writeFile, unlink } from 'node:fs/promises'
import { unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'

/** Directory of per-PID marker files. HOME-relative so integration tests can override it. */
function serveDir(): string {
  return join(homedir(), '.config', 'mementos', 'serve')
}

function pidFile(pid: number): string {
  return join(serveDir(), String(pid))
}

/**
 * Register the current process as a running server, and arrange for the marker to be
 * removed on process exit. Call once, after the vault has started — a server that failed
 * to start should leave no marker.
 *
 * NB: only the synchronous `'exit'` listener is installed here, not signal listeners.
 * `runServe` installs its own SIGINT/SIGTERM/SIGHUP shutdown that awaits `vault.close()`
 * (flushing the index cache); a signal listener here would race that and — because Node
 * fires listeners in registration order and ours was registered first — `process.exit(0)`
 * would terminate the process before the async flush could run. Letting `runServe`'s
 * shutdown call `process.exit(0)` triggers `'exit'`, which removes the marker.
 */
export async function registerServe(): Promise<void> {
  const file = pidFile(process.pid)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, '', 'utf8')
  // 'exit' handlers must be synchronous, hence unlinkSync. Idempotent on ENOENT.
  process.once('exit', () => {
    try { unlinkSync(file) } catch { /* already gone — fine */ }
  })
}

/**
 * PIDs of currently-running servers. Marker files whose process is gone are pruned as a
 * side effect, so a crashed server self-heals on the next call.
 */
export async function listLiveServes(): Promise<number[]> {
  const entries = await readdir(serveDir()).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return [] as string[]
    throw e
  })
  const live: number[] = []
  for (const name of entries) {
    const pid = Number(name)
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (isAlive(pid)) live.push(pid)
    else await unlink(pidFile(pid)).catch(() => { /* raced another pruner — fine */ })
  }
  return live.sort((a, b) => a - b)
}

/** Is a process with this PID alive? `kill(pid, 0)` is a no-op signal used as a probe. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // ESRCH → no such process. EPERM → it exists but isn't ours to signal — still alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
