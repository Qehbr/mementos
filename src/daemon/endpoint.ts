/**
 * Where the daemon binds and clients connect. TCP port on `127.0.0.1` —
 * **localhost-only** by default (the OS rejects packets from outside),
 * standard `fetch()` works, no platform variance (Linux/macOS/Windows
 * identical), and the same code path is the foundation for a future
 * hosted/remote-server mode (just bind `0.0.0.0` and add auth in front of it).
 *
 * The port is overridable via `MEMENTOS_PORT` so users running multiple
 * vault setups (rare) or doing local testing can avoid conflicts. The URL is
 * overridable via `MEMENTOS_URL` so a CLI command can be pointed at a remote
 * server — the building block for connecting to a hosted mementos.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Default port mementos binds and connects to. Unprivileged (>1024) and
 * picked to avoid common conflicts: not the Ollama port (11434), not the
 * Postgres/Redis/Mongo/SSH/dev-server ranges, not any IANA-registered
 * service. `MEMENTOS_PORT` overrides if a user hits a collision on their
 * machine.
 */
const DEFAULT_PORT = 47899

export function daemonHost(): string {
  // Always bind localhost-only for the embedded daemon. A future hosted mode
  // would pass `0.0.0.0` explicitly via a separate flag, never this default.
  return '127.0.0.1'
}

export function daemonPort(): number {
  const env = process.env['MEMENTOS_PORT']
  if (env) {
    const n = Number(env)
    if (Number.isInteger(n) && n > 0 && n < 65536) return n
  }
  return DEFAULT_PORT
}

/**
 * Base URL of the daemon HTTP API. Clients append `/api/tools/<name>` or
 * `/api/hooks/<name>` themselves. `MEMENTOS_URL` overrides everything —
 * point at a remote server when one exists (no trailing slash, no path).
 */
export function daemonUrl(): string {
  const env = process.env['MEMENTOS_URL']
  if (env) return env.replace(/\/+$/, '')
  return `http://${daemonHost()}:${daemonPort()}`
}

/** PID file the daemon writes on startup, used by `mementos stop`. */
export function pidFilePath(): string {
  return join(homedir(), '.config', 'mementos', 'daemon.pid')
}
