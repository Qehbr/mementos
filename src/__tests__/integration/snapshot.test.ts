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
import { setupTestEnv, runInitWithFlags, ProcessExitError, type IntegrationContext } from './_helpers.js'
import { decryptMemMeta } from '../../core/vault/aad.js'
import { deriveKeyFromEntropy } from '../../keys/_utils/derivation/index.js'
import type { MemFile, MemMeta } from '../../core/vault/types.js'

describe('mementos snapshot', () => {
  let ctx: IntegrationContext

  /** Read a `.mem` file and decrypt its `meta` payload — v3 keeps all metadata encrypted. */
  async function readMeta(id: string): Promise<MemMeta> {
    const key = deriveKeyFromEntropy(Buffer.from(process.env['MEMENTOS_RAW_KEY']!, 'base64'))
    const mem = JSON.parse(await readFile(join(ctx.vaultPath, `${id}.mem`), 'utf8')) as MemFile
    return decryptMemMeta(mem, key)
  }

  beforeEach(async () => {
    ctx = await setupTestEnv()
    await runInitWithFlags([
      '--backend=local', '--embedder=local', '--index=hnsw',
      '--key=env', '--integrations=none',
    ])
    // Silence log output from snapshot to keep test output readable.
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
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

  it('missing transcript_path → exit code 1', async () => {
    await expect(callSnapshot({})).rejects.toBeInstanceOf(ProcessExitError)
  })

  it('unknown source (no ingestor claims the path) → silent exit, no error to caller', async () => {
    const file = join(ctx.homeDir, 'random.jsonl')
    await writeFile(file, '{"unrelated":"format"}', 'utf8')
    // No ingestor's `detects` accepts a path outside `.claude/projects` — snapshot logs
    // a stderr note and exits 0 so the Claude Code hook doesn't surface a failure.
    await expect(callSnapshot({ transcript_path: file })).rejects.toMatchObject({ code: 0 })
  })
})
