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
 * **Future hosted mode** (multi-user server): same shape, different storage
 * — per-user tokens issued at sign-in, persisted in a real auth store. The
 * Authorization-header validation code stays identical.
 */
import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'

const TOKEN_BYTES = 32  // 256 bits

export function tokenFilePath(): string {
  return join(homedir(), '.config', 'mementos', 'daemon.token')
}

/** Generate, write `0600`, return the new token. Used by `mementos start`. */
export async function generateAndWriteToken(): Promise<string> {
  const path = tokenFilePath()
  await mkdir(dirname(path), { recursive: true }).catch(() => { /* parent may exist */ })
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  await writeFile(path, token, { encoding: 'utf8', mode: 0o600 })
  return token
}

/** Read the token file. Throws if missing — clients use that to detect "no daemon". */
export async function readToken(): Promise<string> {
  return (await readFile(tokenFilePath(), 'utf8')).trim()
}

/** Remove the token file. Daemon calls on graceful shutdown. */
export async function deleteToken(): Promise<void> {
  await unlink(tokenFilePath()).catch(() => { /* already gone — fine */ })
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
