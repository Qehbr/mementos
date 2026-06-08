/**
 * Integration tests for `mementos snapshot` — the PreCompact-hook subprocess.
 *
 * Snapshot's job: receive a JSON payload (Claude Code PreCompact format), pull the
 * `transcript_path`, route through the matching Ingestor, and call `vault.ingest`.
 * Tests bypass stdin by passing the payload directly to `runSnapshot(payload)`.
 *
 * What we verify:
 *   - A normal session lands in the vault with correct chronicle_id / memento id / parent
 *   - Re-running on the same transcript is idempotent (no duplicates)
 *   - Snapshot fired mid-session followed by another fire with more turns adds only the
 *     new turns (the "continuation" scenario PreCompact actually produces)
 *   - Missing transcript_path exits with error
 *   - Path with no matching ingestor exits silently (not a fatal hook failure)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setupTestEnv, runInitWithFlags, type IntegrationContext } from './_helpers.js'
import { decryptMemMeta } from '../../core/vault/aad.js'
import { deriveKeyFromEntropy } from '../../keys/_utils/derivation/index.js'
import type { MemFile, MemMeta } from '../../core/vault/types.js'
import type { Vault } from '../../core/vault/index.js'

// Snapshot now POSTs to the daemon's /api/hooks/ingest_chronicle. In tests
// we don't start a daemon — we mock the api-client + ensureDaemonRunning so
// the POST is short-circuited into a direct `vault.ingest` call against a
// vault built in-process. The test still verifies snapshot's parse → ingest
// pipeline end-to-end, just without the network hop.
vi.mock('../../daemon/api-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../daemon/api-client.js')>('../../daemon/api-client.js')
  return { ...actual, ingestChronicle: vi.fn() }
})
vi.mock('../../cli/commands/daemon.js', async () => {
  const actual = await vi.importActual<typeof import('../../cli/commands/daemon.js')>('../../cli/commands/daemon.js')
  return { ...actual, ensureDaemonRunning: vi.fn().mockResolvedValue(undefined) }
})

describe('mementos snapshot', () => {
  let ctx: IntegrationContext

  /** Read a `.mem` file and decrypt its `meta` payload — v3 keeps all metadata encrypted. */
  async function readMeta(id: string): Promise<MemMeta> {
    const key = deriveKeyFromEntropy(Buffer.from(process.env['MEMENTOS_RAW_KEY']!, 'base64'))
    const mem = JSON.parse(await readFile(join(ctx.vaultPath, `${id}.mem`), 'utf8')) as MemFile
    return decryptMemMeta(mem, key)
  }

  let vault: Vault | null = null

  beforeEach(async () => {
    ctx = await setupTestEnv()
    await runInitWithFlags([
      '--backend=local', '--embedder=minilm', '--index=hnsw',
      '--key=env', '--integrations=none',
    ])
    // Build a real in-process vault to back the mocked ingestChronicle —
    // snapshot's POST is shorted to vault.ingest, .mem files are real.
    const { buildVault } = await import('../../cli/_utils/vault.js')
    vault = await buildVault()
    await vault.startup()
    const { ingestChronicle } = await import('../../daemon/api-client.js')
    vi.mocked(ingestChronicle).mockImplementation(async ({ chronicle_id, mementos, tags, createdAt }) => {
      return vault!.ingest(chronicle_id, mementos, { tags, createdAt })
    })
    // Silence log output from snapshot to keep test output readable.
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (vault) { await vault.close(); vault = null }
    await ctx.cleanup()
  })

  const SESSION = '11111111-2222-4333-8444-555555555555'
  const T1 = 'aaaaaaaa-1111-4111-8111-111111111111'
  const T2 = 'aaaaaaaa-2222-4222-8222-222222222222'
  const T3 = 'aaaaaaaa-3333-4333-8333-333333333333'

  async function writeTranscript(uuid: string, lines: object[]): Promise<string> {
    const dir = join(ctx.homeDir, '.claude', 'projects', 'proj')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${uuid}.jsonl`)
    await writeFile(path, lines.map(o => JSON.stringify(o)).join('\n'), 'utf8')
    return path
  }

  async function callSnapshot(payload: Record<string, unknown>): Promise<void> {
    const { runSnapshot } = await import('../../cli/commands/snapshot.js')
    await runSnapshot(payload)
  }

  it('ingests the transcript at transcript_path into the vault', async () => {
    const file = await writeTranscript(SESSION, [
      {
        type: 'user', uuid: T1, timestamp: '2026-05-01T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      },
      {
        type: 'assistant', uuid: T2, parentUuid: T1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi back' }] },
      },
    ])

    await callSnapshot({ transcript_path: file })

    const memFiles = (await readdir(ctx.vaultPath)).filter(f => f.endsWith('.mem'))
    expect(memFiles).toHaveLength(2)
    const ids = await Promise.all(memFiles.map(async f =>
      (JSON.parse(await readFile(join(ctx.vaultPath, f), 'utf8')) as MemFile).id))
    expect(new Set(ids)).toEqual(new Set([T1, T2]))
    const chronicleIds = await Promise.all(ids.map(async id => (await readMeta(id)).chronicle_id))
    expect(chronicleIds.every(c => c === SESSION)).toBe(true)
  })

  it('continuation: second snapshot fire with new turns appends them, existing ones skip', async () => {
    const file = await writeTranscript(SESSION, [
      { type: 'user', uuid: T1, message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
      { type: 'assistant', uuid: T2, parentUuid: T1, message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } },
    ])
    await callSnapshot({ transcript_path: file })

    // Now the session grows — append a third turn to the JSONL and snapshot again.
    await writeFile(file,
      (await readFile(file, 'utf8')) + '\n' +
      JSON.stringify({ type: 'user', uuid: T3, parentUuid: T2, message: { role: 'user', content: [{ type: 'text', text: 'third' }] } }),
      'utf8',
    )
    await callSnapshot({ transcript_path: file })

    const memFiles = (await readdir(ctx.vaultPath)).filter(f => f.endsWith('.mem'))
    expect(memFiles).toHaveLength(3)
    const mems = await Promise.all(memFiles.map(async f =>
      JSON.parse(await readFile(join(ctx.vaultPath, f), 'utf8')) as MemFile,
    ))
    expect(new Set(mems.map(m => m.id))).toEqual(new Set([T1, T2, T3]))
  })

  it('idempotent: re-firing snapshot on an unchanged transcript writes nothing', async () => {
    const file = await writeTranscript(SESSION, [
      { type: 'user', uuid: T1, message: { role: 'user', content: [{ type: 'text', text: 'only' }] } },
    ])
    await callSnapshot({ transcript_path: file })
    const before = (await readdir(ctx.vaultPath)).filter(f => f.endsWith('.mem'))
    await callSnapshot({ transcript_path: file })
    const after = (await readdir(ctx.vaultPath)).filter(f => f.endsWith('.mem'))
    expect(after).toEqual(before)
  })

  it('missing transcript_path → silent return (fail-soft hook posture)', async () => {
    // Snapshot is fail-soft same as runSessionStart: a malformed payload
    // never bubbles a non-zero exit / surfaces stderr to the AI client, or
    // it would interrupt the user's conversation for an op that's strictly
    // a background convenience. MEMENTOS_DEBUG gates the debug log.
    await expect(callSnapshot({})).resolves.toBeUndefined()
  })

  it('unknown source (no ingestor claims the path) → silent return', async () => {
    const file = join(ctx.homeDir, 'random.jsonl')
    await writeFile(file, '{"unrelated":"format"}', 'utf8')
    // No ingestor's `detects` accepts a path outside `.claude/projects` — snapshot
    // silently returns (no stderr unless MEMENTOS_DEBUG) so the Claude Code hook
    // doesn't surface a failure.
    await expect(callSnapshot({ transcript_path: file })).resolves.toBeUndefined()
  })
})
