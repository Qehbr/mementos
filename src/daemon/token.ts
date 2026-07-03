/**
 * Bearer-token auth for the daemon's HTTP API.
 *
 * **Generated** once at daemon startup (random 256-bit hex), **written to**
 * `~/.config/mementos/daemon.token` with `0600` perms, and **read by** every
 * client (CLI, MCP shim, hook subprocesses) before each request. The token
 * regenerates on every daemon restart — a token leaked yesterday is dead today.
 *
 * **Security boundary**: the token file's `0600` permission is what stops
 * other local users from reading it. The Authorization header is what stops
 * them from forging requests to the daemon. Together they ensure only the
 * owning Unix user can talk to the daemon, even though the port is bound to
 * `127.0.0.1` (which alone would let any local user POST).
 *
 * The daemon is **local-only by architectural commitment** (see
 * `daemon/constants.ts`) — there is no hosted/multi-user mode in mementos.
 * Per-user token issuance, OAuth flows, and the rest of that machinery don't
 * apply here.
 */
import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { daemonTokenFile, TOKEN_BYTES } from './constants.js'

/**
 * Generate a fresh token in memory. Does NOT touch disk — `mementos start`
 * calls this BEFORE binding the port so a racing daemon that loses the bind
 * doesn't overwrite the winner's token file. The winner calls `writeTokenFile`
 * with the same value only after `startHttpApi` succeeds.
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex')
}

/** Write `token` to the shared file with `0600` perms. */
export async function writeTokenFile(token: string): Promise<void> {
  await mkdir(dirname(daemonTokenFile()), { recursive: true }).catch(() => { /* parent may exist */ })
  await writeFile(daemonTokenFile(), token, { encoding: 'utf8', mode: 0o600 })
}

/** Read the token file. Throws if missing — clients use that to detect "no daemon". */
export async function readToken(): Promise<string> {
  return (await readFile(daemonTokenFile(), 'utf8')).trim()
}

/** Remove the token file. Daemon calls on graceful shutdown. */
export async function deleteToken(): Promise<void> {
  await unlink(daemonTokenFile()).catch(() => { /* already gone — fine */ })
}

/**
 * Constant-time string compare. Prevents timing side-channels on token check
 * (per-byte loops that early-bail leak the prefix length). Used by the daemon
 * server on every authenticated request.
 */
export function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
