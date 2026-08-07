/**
 * Plain HTTP client for the daemon's API.
 *
 * Used by CLI commands, the MCP shim, and hook subprocesses. Every call:
 *   1. Reads the bearer token from `~/.config/mementos/daemon.token`
 *   2. POSTs the JSON body to `<daemonUrl>/<path>` with the Authorization header
 *   3. Parses the JSON response
 *   4. Returns the parsed body on 2xx, throws on anything else
 *
 * `DaemonUnavailableError` distinguishes "no daemon listening" from "daemon
 * said no" so callers can either auto-start (hooks, MCP shim) or print a
 * clean error (CLI commands).
 *
 * No third-party HTTP library — Node's built-in `fetch` (since v18) speaks
 * plain HTTP to a localhost port without dispatcher tricks. Future hosted
 * mode just changes the URL.
 */
import { DAEMON_URL } from './constants.js'
import { readToken } from './token.js'

export class DaemonUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'DaemonUnavailableError' }
}

export class DaemonApiError extends Error {
  constructor(message: string) { super(message); this.name = 'DaemonApiError' }
}

/**
 * Rich daemon liveness — distinguishes `ready` / `initializing` / `absent`.
 * Use when you need to wait for an initializing daemon to become ready
 * (mcp shim) or tell the user precisely what state the daemon is in
 * (`mementos doctor`).
 */
export async function getDaemonState(): Promise<'ready' | 'initializing' | 'absent'> {
  const { daemonState } = await import('./state.js')
  return daemonState()
}

/**
 * POST one of the `/api/tools/<name>` routes. Returns the rendered text the
 * tool produced. Throws `DaemonUnavailableError` if no daemon listening,
 * `DaemonApiError` for non-2xx responses (with the daemon's error message).
 */
export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const body = (await postJson(`/api/tools/${name}`, args)) as { text?: string }
  return body.text ?? ''
}

/**
 * POST `/api/hooks/ingest_chronicle`. Returns the daemon's `{ added, skipped }`
 * result. Used by `mementos snapshot` and `mementos ingest`.
 */
export async function ingestChronicle(args: {
  chronicle_id: string
  mementos: Array<{ mementoId: string; text: string; parentMementoId?: string; createdAt?: string }>
  tags?: string[]
  createdAt?: string
}): Promise<{ added: number; skipped: number }> {
  return (await postJson('/api/hooks/ingest_chronicle', args)) as { added: number; skipped: number }
}

/**
 * GET `/api/_meta/info` — `{ version, searchEnabled }`. Used by the MCP shim
 * at startup: `version` becomes the MCP server's reported version, and
 * `searchEnabled` flips whether the `search` tool is registered. The shim
 * derives the tool list locally via `activeTools({searchEnabled})` — both
 * sides import the same registry, so a duplicated `tools` field would just be
 * a drift surface.
 */
export async function getDaemonInfo(): Promise<{ version: string; searchEnabled: boolean }> {
  return (await fetchJson('GET', '/api/_meta/info')) as { version: string; searchEnabled: boolean }
}

async function postJson(path: string, body: Record<string, unknown>): Promise<unknown> {
  return fetchJson('POST', path, body)
}

async function fetchJson(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<unknown> {
  // Read the token first — its absence is the cheapest, most reliable signal
  // that no daemon is up. (Skipping the previous `isDaemonRunning()` TCP
  // pre-probe: it was wasted work — fetch already attempts the connection —
  // AND the probe-then-fetch window was a real race where the daemon could
  // die between the two, surfacing a raw `fetch failed` instead of our typed
  // `DaemonUnavailableError`.)
  let token: string
  try { token = await readToken() }
  catch { throw new DaemonUnavailableError('no mementos daemon running (start it with `mementos start`)') }

  const url = DAEMON_URL + path
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: {
        'authorization': `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    // Network-level failure — `fetch failed` (ECONNREFUSED/ECONNRESET). The
    // daemon either isn't listening at all or died mid-request. Either way
    // the caller should see this as "no daemon" so callAndPrint can print
    // the standard "Run mementos start" hint instead of a raw fetch error.
    throw new DaemonUnavailableError('no mementos daemon running (start it with `mementos start`)')
  }
  const text = await res.text()
  let parsed: unknown
  try { parsed = text.length > 0 ? JSON.parse(text) : {} }
  catch { throw new DaemonApiError(`daemon returned malformed JSON: ${text.slice(0, 200)}`) }
  if (!res.ok) {
    const msg = (parsed as { error?: unknown } | undefined)?.error
    throw new DaemonApiError(typeof msg === 'string' ? msg : `HTTP ${res.status}`)
  }
  return parsed
}
