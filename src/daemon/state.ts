/**
 * Daemon state file lifecycle.
 *
 * One file at `~/.config/mementos/daemon.state` carries the daemon's PID and
 * current state:
 *
 *   { "pid": 12345, "state": "initializing" | "ready", "startedAt": "ISO" }
 *
 * **Race-safety** comes from the OS-level port mutex, not from the file. The
 * runner binds the daemon port FIRST (`assertPortFree` inside `startHttpApi`)
 * and only writes this file AFTER the bind succeeds. A losing daemon-start
 * race exits at port-bind without ever touching the state file, so a
 * second writer is structurally impossible. Crashes leave a stale file —
 * readers verify `kill(pid, 0)` and treat a dead PID as "absent."
 *
 * **States**:
 *   - `initializing` — port is bound, but `vault.startup()` is still loading
 *     (cold ONNX, decrypt of N `.mem` files, HNSW build). The HTTP handler
 *     returns 503 for every request during this window.
 *   - `ready` — vault is loaded; the handler accepts requests normally.
 *
 * Clients that need "is the daemon ready?" call `daemonState()`; the answer
 * is honest — `ready` only after the vault has finished loading.
 */
import { readFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { atomicWriteFile } from '../core/_utils/fs.js'
import { daemonStateFile } from './constants.js'

export type DaemonStateValue = 'initializing' | 'ready'

export interface DaemonStateFile {
  pid: number
  state: DaemonStateValue
  startedAt: string
}

/**
 * Coarse-grained daemon state for clients. `absent` covers both "no file"
 * and "file is stale (PID dead)" — the difference doesn't matter to readers.
 */
export type DaemonState = 'absent' | 'initializing' | 'ready'

/**
 * Read + parse the state file. Returns null if absent or the recorded PID
 * is no longer alive (stale; treat as absent).
 */
export async function readDaemonStateFile(): Promise<DaemonStateFile | null> {
  let raw: string
  try {
    raw = await readFile(daemonStateFile(), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch { return null }  // corrupt — treat as absent; next start will overwrite

  if (
    !parsed || typeof parsed !== 'object'
    || typeof (parsed as DaemonStateFile).pid !== 'number'
    || typeof (parsed as DaemonStateFile).state !== 'string'
    || typeof (parsed as DaemonStateFile).startedAt !== 'string'
  ) return null

  const file = parsed as DaemonStateFile
  if (file.state !== 'initializing' && file.state !== 'ready') return null
  if (!isProcessAlive(file.pid)) return null
  return file
}

/** Coarse state — used by all the daemon-up checks. */
export async function daemonState(): Promise<DaemonState> {
  const file = await readDaemonStateFile()
  return file === null ? 'absent' : file.state
}

/**
 * Write the state file atomically (tmp+rename). Only called from `runDaemon`
 * and only AFTER `startHttpApi` has bound the port — see the race-safety
 * note in the module docstring.
 */
export async function writeDaemonStateFile(state: DaemonStateValue, startedAt: string): Promise<void> {
  await mkdir(dirname(daemonStateFile()), { recursive: true }).catch(() => { /* parent may exist */ })
  await atomicWriteFile(
    daemonStateFile(),
    JSON.stringify({ pid: process.pid, state, startedAt }, null, 2),
  )
}

/** Remove the state file. Daemon calls this on graceful shutdown. */
export async function deleteDaemonStateFile(): Promise<void> {
  await unlink(daemonStateFile()).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e
  })
}

/** True if `pid` references a live process owned by this user. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = process exists but we can't signal it. We still treat that as
    // "alive" — the daemon runs as the same user as its clients, so EPERM
    // means something weird (sudo'd? container?), not "dead."
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
