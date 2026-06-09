/**
 * Daemon HTTP API — the single surface every other process talks to.
 *
 * Three families of routes:
 *
 *   POST /api/tools/<name>       — one route per Vault operation (the entries
 *                                  in `core/tools.ts::activeTools()`). JSON in,
 *                                  JSON out (`{ text }` on success). The MCP
 *                                  shim and the CLI commands both hit these.
 *
 *   POST /api/hooks/ingest_chronicle — batch-write a chronicle of mementos.
 *                                  Used by the snapshot/ingest hook subprocesses
 *                                  so they don't have to build their own vault.
 *                                  Not exposed as an MCP tool — internal API.
 *
 *   GET  /api/_meta/info          — `{ version, searchEnabled }`. The shim hits
 *                                  this at startup to decide which tools to
 *                                  register with the MCP SDK.
 *
 * Every request requires `Authorization: Bearer <token>`. The token is the
 * one written by `writeTokenFile()` at daemon startup. Failures: 401
 * (missing/invalid token), 400 (bad JSON / schema), 404 (unknown tool), 500
 * (handler threw).
 *
 * Plain HTTP — no MCP, no JSON-RPC, no SDK on the daemon side. The wire
 * format is whatever's natural for each operation (request body = args
 * object; response body = result). curl-debuggable end to end.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http'
import { createConnection } from 'node:net'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { z } from 'zod'
import type { Vault } from '../core/vault/index.js'
import { activeTools, type ToolDef } from '../core/tools.js'
import { tokensMatch } from './token.js'
import { DAEMON_HOST, DAEMON_PORT, MAX_REQUEST_BODY_BYTES } from './constants.js'
export interface HttpApiServer {
  /** Stop accepting new connections; resolve once the OS releases the port. */
  close(): Promise<void>
  /**
   * Flip the server from `initializing` to `ready`. Until called, every
   * request (including `/api/_meta/info`) returns 503 with a
   * `{error: "daemon initializing"}` body. `runDaemon` calls this once
   * `vault.startup()` resolves.
   */
  markReady(): void
}

const INGEST_BODY = z.object({
  chronicle_id: z.string(),
  mementos: z.array(z.object({
    mementoId: z.string(),
    text: z.string(),
    parentMementoId: z.string().optional(),
    createdAt: z.string().optional(),
  })),
  tags: z.array(z.string()).optional(),
  createdAt: z.string().optional(),
})

interface StartOpts {
  searchEnabled: boolean
  token: string
}

export async function startHttpApi(vault: Vault, opts: StartOpts): Promise<HttpApiServer> {
  await assertPortFree(DAEMON_HOST, DAEMON_PORT)

  const tools = activeTools({ searchEnabled: opts.searchEnabled })
  const version = packageVersion()

  // Initially false — every request returns 503 until `markReady()` flips it.
  // The runner binds the port BEFORE calling vault.startup(), so the
  // initializing window is the slow vault-load window.
  let ready = false

  const server: HttpServer = createHttpServer((req, res) => {
    // Gate every request on `ready` first, before auth even. Auth requires
    // the token file to have been written, and the token file is only
    // written AFTER vault.startup() completes — so during init the auth
    // check would always fail with 401, which is wrong (it's a state
    // problem, not an auth problem). 503 with a clear message + Retry-After
    // is the honest answer.
    if (!ready) {
      res.writeHead(503, {
        'content-type': 'application/json',
        'retry-after': '1',
      })
      res.end(JSON.stringify({ error: 'daemon initializing', state: 'initializing' }))
      return
    }
    void handle(req, res, vault, tools, opts, version).catch(e => {
      if (process.env['MEMENTOS_DEBUG']) console.error('[daemon] handler:', (e as Error).stack ?? (e as Error).message)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: (e as Error).message }))
      } else {
        res.end()
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(DAEMON_PORT, DAEMON_HOST, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  return {
    markReady: () => { ready = true },
    close: () => new Promise<void>(resolve => {
      // `server.close()` stops accepting new connections and waits for
      // every existing one to end — including IDLE keep-alive sockets,
      // which Node's HTTP server holds open by default (~5s
      // keepAliveTimeout). The MCP shim talks to the daemon via undici's
      // pooled `fetch`, so a connected AI client typically owns one idle
      // keep-alive socket between tool calls. Without dropping idle
      // sockets explicitly, the daemon's `close()` blocks ~5s on every
      // shutdown, the cache flush (gated on it) is delayed by the same
      // amount, and `mementos stop`'s 5s wait-loop races its own
      // deadline. `closeIdleConnections()` is Node ≥18.2 and drops the
      // idle pool immediately; in-flight requests still drain via the
      // outer `close(cb)`.
      server.close(() => resolve())
      server.closeIdleConnections()
    }),
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  vault: Vault,
  tools: Record<string, ToolDef>,
  opts: StartOpts,
  version: string,
): Promise<void> {
  // ── Auth: every route requires the bearer token. ───────────────────────────
  if (!checkAuth(req, opts.token)) {
    return writeJson(res, 401, { error: 'unauthorized' })
  }

  const url = req.url ?? ''

  // ── Meta: shim startup probe. ──────────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/_meta/info') {
    return writeJson(res, 200, { version, searchEnabled: opts.searchEnabled })
  }

  // ── Tools: POST /api/tools/<name>. ─────────────────────────────────────────
  if (req.method === 'POST' && url.startsWith('/api/tools/')) {
    const name = url.slice('/api/tools/'.length)
    // `Object.hasOwn` not `name in tools` — names like `__proto__` /
    // `constructor` are inherited from Object.prototype and would resolve to a
    // truthy non-tool object, falling through to the schema parse and 500-ing.
    const tool: ToolDef | undefined = Object.hasOwn(tools, name) ? tools[name] : undefined
    if (!tool) return writeJson(res, 404, { error: `unknown tool: ${name}` })
    let body: Record<string, unknown>
    try { body = await readJsonBody(req) }
    catch (e) { return writeJson(res, 400, { error: `bad JSON: ${(e as Error).message}` }) }
    const validation = z.object(tool.inputSchema).safeParse(body)
    if (!validation.success) return writeJson(res, 400, { error: validation.error.message })
    const text = await tool.handler(vault, validation.data)
    return writeJson(res, 200, { text })
  }

  // ── Hooks: snapshot/ingest batch path. ─────────────────────────────────────
  if (req.method === 'POST' && url === '/api/hooks/ingest_chronicle') {
    let body: Record<string, unknown>
    try { body = await readJsonBody(req) }
    catch (e) { return writeJson(res, 400, { error: `bad JSON: ${(e as Error).message}` }) }
    const validation = INGEST_BODY.safeParse(body)
    if (!validation.success) return writeJson(res, 400, { error: validation.error.message })
    const r = await vault.ingest(
      validation.data.chronicle_id,
      validation.data.mementos,
      { tags: validation.data.tags, createdAt: validation.data.createdAt },
    )
    return writeJson(res, 200, r)
  }

  writeJson(res, 404, { error: `unknown route: ${req.method} ${url}` })
}

function checkAuth(req: IncomingMessage, expected: string): boolean {
  const h = req.headers['authorization']
  if (typeof h !== 'string') return false
  if (!h.startsWith('Bearer ')) return false
  return tokensMatch(h.slice('Bearer '.length).trim(), expected)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const c of req) {
    const buf = typeof c === 'string' ? Buffer.from(c) : c as Buffer
    total += buf.length
    if (total > MAX_REQUEST_BODY_BYTES) {
      // Fail loud: a request this large is either a bug in the client loop
      // or a stuck ingest. The daemon holds the whole vault in RAM; refusing
      // before we materialise N MiB of buffers is what keeps it alive.
      throw new Error(`request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte cap`)
    }
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw.length === 0) return {}
  const parsed = JSON.parse(raw) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected a JSON object')
  }
  return parsed as Record<string, unknown>
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function assertPortFree(host: string, port: number): Promise<void> {
  const alive = await new Promise<boolean>(resolve => {
    const probe = createConnection({ host, port })
    probe.once('connect', () => { probe.destroy(); resolve(true) })
    probe.once('error', () => resolve(false))
  })
  if (alive) throw new Error(`mementos daemon already running at ${host}:${port}. Use \`mementos stop\` to shut it down first.`)
}

function packageVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')
  return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version
}

