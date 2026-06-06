/**
 * Integration tests for `mementos ingest`.
 *
 * Each test takes the scripted path (explicit positional + `--tag=` flag) so the
 * interactive checkbox + tag-loop UI never fires. What we verify:
 *   - Claude Code JSONL → one memento per turn, all sharing chronicle_id == the session
 *     UUID, memento id == per-message uuid, parent_memento_id chain preserved, per-turn
 *     createdAt preserved.
 *   - Re-ingest is idempotent: rerunning the same file is reported as "already present"
 *     and adds nothing.
 *   - `--dry-run` writes nothing.
 *   - Directory walking finds every supported file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setupTestEnv, runInitWithFlags, type IntegrationContext } from './_helpers.js'
import { decryptMemMeta } from '../../core/vault/aad.js'
import { deriveKeyFromEntropy } from '../../keys/_utils/derivation/index.js'
import type { MemFile, MemMeta } from '../../core/vault/types.js'
import type { Vault } from '../../core/vault/index.js'

// Ingest now POSTs each chronicle to the daemon's /api/hooks/ingest_chronicle.
// In tests we don't start a daemon — we mock the api-client + the auto-start
// helper so the POST is shorted into a direct `vault.ingest` call against a
// vault built in-process. The parse + dispatch + ingest pipeline is still
// exercised end-to-end; the network hop is the only thing skipped.
vi.mock('../../daemon/api-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../daemon/api-client.js')>('../../daemon/api-client.js')
  return { ...actual, ingestChronicle: vi.fn() }
})
vi.mock('../../cli/commands/daemon.js', async () => {
  const actual = await vi.importActual<typeof import('../../cli/commands/daemon.js')>('../../cli/commands/daemon.js')
  return { ...actual, ensureDaemonRunning: vi.fn().mockResolvedValue(undefined) }
})

describe('mementos ingest', () => {
  let ctx: IntegrationContext
  let vault: Vault | null = null

  /** Read a `.mem` file and decrypt its `meta` payload — v3 keeps all metadata encrypted. */
  async function readMeta(id: string): Promise<MemMeta> {
    const key = deriveKeyFromEntropy(Buffer.from(process.env['MEMENTOS_RAW_KEY']!, 'base64'))
    const mem = JSON.parse(await readFile(join(ctx.vaultPath, `${id}.mem`), 'utf8')) as MemFile
    return decryptMemMeta(mem, key)
  }

  beforeEach(async () => {
    ctx = await setupTestEnv()
    await runInitWithFlags([
      '--backend=local', '--embedder=minilm', '--index=hnsw',
      '--key=env', '--integrations=none',
    ])
    const { buildVault } = await import('../../cli/_utils/vault.js')
    vault = await buildVault()
    await vault.startup()
    const { ingestChronicle } = await import('../../daemon/api-client.js')
    vi.mocked(ingestChronicle).mockImplementation(async ({ chronicle_id, mementos, tags, createdAt }) => {
      return vault!.ingest(chronicle_id, mementos, { tags, createdAt })
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (vault) { await vault.close(); vault = null }
    await ctx.cleanup()
  })

  /**
   * Capture console.log / console.error for one ingest invocation. Auto-injects
   * `--tag=` if no --tag flag is present so the interactive tag prompt doesn't fire
   * and hang on stdin.
   */
  async function captureIngest(positional: string | undefined, extraArgv: string[] = []): Promise<string[]> {
    const hasTagFlag = extraArgv.some(a => a === '--tag' || a.startsWith('--tag='))
    const argv = hasTagFlag ? extraArgv : [...extraArgv, '--tag=']
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '))
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      logs.push('ERR ' + a.map(String).join(' '))
    })
    try {
      process.argv = ['node', 'mementos', 'ingest', ...(positional ? [positional] : []), ...argv]
      const { runIngest } = await import('../../cli/commands/ingest.js')
      await runIngest(positional, argv)
    } finally {
      logSpy.mockRestore()
      errSpy.mockRestore()
    }
    return logs
  }

  // UUIDs used across tests. Each test's transcript lives under .claude/projects/proj/
  // so the ClaudeCodeIngestor's `detects` claims it.
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

  it('Claude Code JSONL → one memento per turn; chronicle_id and parent_memento_id round-trip', async () => {
    const file = await writeTranscript(SESSION, [
      {
        type: 'user', uuid: T1, timestamp: '2026-05-01T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'turn one' }] },
      },
      {
        type: 'assistant', uuid: T2, parentUuid: T1, timestamp: '2026-05-01T10:01:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'turn two' }] },
      },
      {
        type: 'user', uuid: T3, parentUuid: T2, timestamp: '2026-05-01T10:02:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'turn three' }] },
      },
    ])

    await captureIngest(file, ['--tag=research'])

    const memFiles = (await readdir(ctx.vaultPath)).filter(f => f.endsWith('.mem'))
    expect(memFiles).toHaveLength(3)
    const ids = await Promise.all(memFiles.map(async f =>
      (JSON.parse(await readFile(join(ctx.vaultPath, f), 'utf8')) as MemFile).id))
    // The memento id is the per-message uuid.
    expect(new Set(ids)).toEqual(new Set([T1, T2, T3]))

    const meta = {
      [T1]: await readMeta(T1), [T2]: await readMeta(T2), [T3]: await readMeta(T3),
    }
    // Every memento shares the chronicle_id == the session UUID.
    expect([T1, T2, T3].every(id => meta[id].chronicle_id === SESSION)).toBe(true)
    // parent_memento_id chain preserved.
    expect(meta[T1].parent_memento_id).toBeUndefined()
    expect(meta[T2].parent_memento_id).toBe(T1)
    expect(meta[T3].parent_memento_id).toBe(T2)
    // per-turn createdAt preserved (date-range queries will see the real moments).
    expect(meta[T1].created_at).toBe('2026-05-01T10:00:00Z')
    expect(meta[T2].created_at).toBe('2026-05-01T10:01:00Z')
    expect(meta[T3].created_at).toBe('2026-05-01T10:02:00Z')
  })

  it('re-ingest is idempotent: second run reports "all already present", writes nothing new', async () => {
    const file = await writeTranscript(SESSION, [
      {
        type: 'user', uuid: T1,
        message: { role: 'user', content: [{ type: 'text', text: 'stable content' }] },
      },
    ])

    await captureIngest(file)
    const memsAfterFirst = (await readdir(ctx.vaultPath)).filter(f => f.endsWith('.mem'))
    expect(memsAfterFirst).toHaveLength(1)

    const logs2 = await captureIngest(file)
    const memsAfterSecond = (await readdir(ctx.vaultPath)).filter(f => f.endsWith('.mem'))
    // No new files written.
    expect(memsAfterSecond).toEqual(memsAfterFirst)
    // Summary calls out the no-op.
    expect(logs2.some(l => l.includes('all') && l.includes('already present'))).toBe(true)
  })

  it('--dry-run writes nothing', async () => {
    const file = await writeTranscript(SESSION, [
      {
        type: 'user', uuid: T1,
        message: { role: 'user', content: [{ type: 'text', text: 'this would be ingested' }] },
      },
    ])

    await captureIngest(file, ['--dry-run'])

    const memFiles = (await readdir(ctx.vaultPath)).filter(f => f.endsWith('.mem'))
    expect(memFiles).toHaveLength(0)
  })

  it('directory walk: ingests every detected file under the given root', async () => {
    // Two sessions under the same project dir — ClaudeCodeIngestor detects both.
    const OTHER_SESSION = '22222222-3333-4333-8333-444444444444'
    await writeTranscript(SESSION, [
      { type: 'user', uuid: T1, message: { role: 'user', content: [{ type: 'text', text: 'first session' }] } },
    ])
    const otherDir = join(ctx.homeDir, '.claude', 'projects', 'proj')
    await writeFile(join(otherDir, `${OTHER_SESSION}.jsonl`), JSON.stringify({
      type: 'user', uuid: T2,
      message: { role: 'user', content: [{ type: 'text', text: 'second session' }] },
    }), 'utf8')

    await captureIngest(join(ctx.homeDir, '.claude', 'projects'))

    const memFiles = (await readdir(ctx.vaultPath)).filter(f => f.endsWith('.mem'))
    expect(memFiles).toHaveLength(2)
    const ids = await Promise.all(memFiles.map(async f =>
      (JSON.parse(await readFile(join(ctx.vaultPath, f), 'utf8')) as MemFile).id))
    const chronicleIds = await Promise.all(ids.map(async id => (await readMeta(id)).chronicle_id))
    expect(new Set(chronicleIds)).toEqual(new Set([SESSION, OTHER_SESSION]))
  })
})
