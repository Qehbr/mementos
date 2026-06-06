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

/** PID file path — written by daemon at startup, read by `mementos stop`. */
export const DAEMON_PID_FILE = join(homedir(), '.config', 'mementos', 'daemon.pid')

/** Bearer-token file path — written `0600` by daemon at startup, read by clients. */
export const DAEMON_TOKEN_FILE = join(homedir(), '.config', 'mementos', 'daemon.token')

/** How long the auto-start paths (`mementos mcp`, hooks) wait for the daemon to come up. */
export const AUTOSTART_TIMEOUT_MS = 5_000

/** Poll interval while waiting for the daemon to bind its port. */
export const AUTOSTART_POLL_INTERVAL_MS = 50
