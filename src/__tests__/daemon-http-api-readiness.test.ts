/**
 * Tests for the HTTP API's `initializing` → `ready` gate.
 *
 * **Why this matters**: the state file is the coordination + visibility
 * layer; this 503 gate is the **absolute correctness layer**. Even if every
 * client misreads the state file, the daemon must NEVER route a request to
 * a vault that hasn't finished `vault.startup()`. The test creates a real
 * HTTP server via `startHttpApi`, asserts requests get 503 before
 * `markReady()`, asserts they route normally after. If this regresses, a
 * half-loaded vault could serve real requests — wrong answers, potentially
 * crashes inside the chunk-key code that assumes metaById is populated.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { startHttpApi, type HttpApiServer } from '../daemon/http-api.js'
import { DAEMON_HOST } from '../daemon/constants.js'
import type { Vault } from '../core/vault/index.js'

const TOKEN = 'test-token-deadbeef-deadbeef-deadbeef-deadbeef-deadbeef-deadbeef-de'

/** Minimal Vault stand-in. Every method throws so we KNOW a routed request
 *  would explode — if the test passes, it's because the 503 gate caught it
 *  before any vault method ran. */
function explodingVault(): Vault {
  const explode = (): never => { throw new Error('vault accessed during initializing — gate broken!') }
  return new Proxy({} as Vault, {
    get(_, _name) { return explode },
  })
}

let api: HttpApiServer

// `port: 0` = OS-assigned ephemeral port, so the suite never collides with a
// real daemon running on the developer's machine (contributors are users).
const bindEphemeral = (opts: { searchEnabled: boolean }): Promise<HttpApiServer> =>
  startHttpApi(explodingVault(), { ...opts, token: TOKEN, port: 0 })
const apiUrl = (path: string): string => `http://${DAEMON_HOST}:${api.port}${path}`

afterEach(async () => {
  // Always close the API even if a test failed; otherwise the port stays
  // bound and leaks across tests.
  if (api) await api.close()
})

describe('startHttpApi readiness gate (503 until markReady)', () => {
  beforeEach(() => {
    // Vitest re-runs the test file's setup between tests; each `api` starts
    // unset and gets bound here.
  })

  it('returns 503 with {error: "daemon initializing"} for ANY request before markReady', async () => {
    api = await bindEphemeral({ searchEnabled: false })

    // Try every shape of request — none should reach the vault.
    const probes = [
      { url: '/api/_meta/info', method: 'GET' as const },
      { url: '/api/tools/get_tags', method: 'POST' as const, body: '{}' },
      { url: '/api/hooks/ingest_chronicle', method: 'POST' as const, body: '{}' },
      { url: '/api/tools/__proto__', method: 'POST' as const, body: '{}' },  // even prototype-pollution attempt
      { url: '/api/whatever-route-does-not-exist', method: 'GET' as const },
    ]

    for (const probe of probes) {
      const res = await fetch(apiUrl(probe.url), {
        method: probe.method,
        headers: { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        ...(probe.body !== undefined ? { body: probe.body } : {}),
      })
      expect(res.status).toBe(503)
      const body = await res.json() as { error: string; state: string }
      expect(body.error).toMatch(/initializing/i)
      expect(body.state).toBe('initializing')
    }
  })

  it('returns 503 even WITHOUT a token (the gate fires before auth)', async () => {
    api = await bindEphemeral({ searchEnabled: false })

    // A missing token would normally yield 401 — but during init we return
    // 503 first, because the 401 would mislead the user into thinking the
    // token is wrong when the daemon just hasn't loaded yet.
    const res = await fetch(apiUrl('/api/_meta/info'))
    expect(res.status).toBe(503)
  })

  it('routes normally after markReady is called', async () => {
    api = await bindEphemeral({ searchEnabled: true })

    // Confirm we're still gated before markReady
    const before = await fetch(apiUrl('/api/_meta/info'), {
      headers: { 'authorization': `Bearer ${TOKEN}` },
    })
    expect(before.status).toBe(503)

    api.markReady()

    // Now the route should reach the real handler — /api/_meta/info doesn't
    // touch the vault, so the exploding vault is safe to leave in place.
    const after = await fetch(apiUrl('/api/_meta/info'), {
      headers: { 'authorization': `Bearer ${TOKEN}` },
    })
    expect(after.status).toBe(200)
    const body = await after.json() as { version: string; searchEnabled: boolean }
    expect(body.searchEnabled).toBe(true)
    expect(typeof body.version).toBe('string')
  })

  it('returns Retry-After header on 503 so well-behaved clients back off correctly', async () => {
    api = await bindEphemeral({ searchEnabled: false })

    const res = await fetch(apiUrl('/api/_meta/info'))
    expect(res.status).toBe(503)
    // Per RFC 9110: Retry-After is the polite way to tell a client when to come back.
    expect(res.headers.get('retry-after')).toBe('1')
  })
})
