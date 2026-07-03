/**
 * Daemon module constants. Implementation files hold logic; this file holds
 * knobs, per the project convention (`<module>/constants.ts`).
 *
 * **Architectural commitment: the daemon is local-only.** `DAEMON_HOST`
 * binds `127.0.0.1` unconditionally — there is no flag, env var, or config
 * path that exposes the API to the network. Plaintext mementos exist only
 * inside a process running on the user's device. Cloud storage (git,
 * Dropbox, iCloud, …) only ever sees ciphertext.
 *
 * If a fork wants to run mementos as a hosted multi-tenant service, the
 * change starts here: replace these constants AND add per-user token
 * issuance, TLS, isolation, etc. We don't ship that — it would contradict
 * the privacy guarantee mementos is built around.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Loopback address the daemon binds. Local-only by architectural commitment. */
export const DAEMON_HOST = '127.0.0.1'

/**
 * Port the daemon binds. Unprivileged (>1024) and picked to avoid common
 * conflicts: not Ollama (11434), not Postgres/Redis/Mongo/SSH/dev-server
 * ranges, not any IANA-registered service.
 */
export const DAEMON_PORT = 47899

/** Base URL of the daemon HTTP API. Clients append `/api/tools/<name>` etc. */
export const DAEMON_URL = `http://${DAEMON_HOST}:${DAEMON_PORT}`

/** Bytes of randomness in the bearer token (`hex` => 64 chars). 256 bits. */
export const TOKEN_BYTES = 32

/**
 * Daemon state file — JSON `{pid, state, startedAt}`. Written by `runDaemon`
 * AFTER the port-bind has succeeded (so the OS-level port mutex guarantees
 * exactly one writer); updated again when the vault has finished loading
 * (state `initializing` → `ready`); deleted on graceful shutdown.
 *
 * Replaces the older `daemon.pid` file, which only carried the PID. The
 * state file is the canonical source for "is a daemon up, and is it ready?"
 * checks — readers verify the PID is alive (`kill(pid, 0)`) before trusting
 * it, so a crash-leftover stale file is treated as "absent."
 *
 * A function, not a constant: `homedir()` must resolve at call time so tests
 * that fake HOME never read the machine's real daemon state (same lazy-path
 * convention as `vaultPath()` / `machineConfigFile()` in core/config.ts).
 */
export function daemonStateFile(): string {
  return join(homedir(), '.config', 'mementos', 'daemon.state')
}

/** Bearer-token file path — written `0600` by daemon at startup, read by clients.
 *  Lazy for the same test-isolation reason as `daemonStateFile()`. */
export function daemonTokenFile(): string {
  return join(homedir(), '.config', 'mementos', 'daemon.token')
}

/**
 * Brief sanity-check window after `mementos start` spawns a detached daemon —
 * if the child process hasn't survived this long, we declare it failed.
 * This catches immediate failures (missing config, port snatched between
 * probe and spawn). Slow-but-fine startups (cold ONNX load + decrypt of a
 * 100k-memento vault) stay alive past 1.5s and we return success — actual
 * "ready" is no longer waited on at `mementos start` time; callers check via
 * `mementos doctor` or simply use the AI client which auto-waits.
 */
export const SPAWN_SANITY_CHECK_MS = 1_500

/** Poll interval while waiting for the daemon to flip from `initializing` to `ready`. */
export const AUTOSTART_POLL_INTERVAL_MS = 50

/**
 * Cap on a single HTTP request body. The daemon is loopback-only and
 * bearer-token-gated, so only the same Unix user can reach it — DoS isn't a
 * realistic threat. But a buggy / looping client (or a stuck ingest) sending
 * unbounded bytes would OOM the daemon that holds the whole vault in RAM.
 * 64 MiB is well above any realistic legitimate body (the largest is the
 * ingest_chronicle batch; a 1000-turn chat at 5 KB/turn is ~5 MiB), so this
 * fails loud on bogus traffic without ever rejecting a real request.
 */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024
