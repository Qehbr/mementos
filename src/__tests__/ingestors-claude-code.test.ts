/**
 * Unit tests for the ClaudeCodeIngestor.
 *
 * Synthetic JSONL fixtures: we hand-craft the records to exercise each filter rule
 * (kept user/assistant text, dropped sidechain, dropped tool-use, dropped file-history
 * snapshots) and the identity mapping (uuid → mementoId, parentUuid → parentMementoId,
 * timestamp → createdAt). No real Claude Code installation needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create as createClaudeCodeIngestor } from '../ingestors/claude-code/index.js'

const SESSION = '11111111-2222-4333-8444-555555555555'
const T1 = 'aaaaaaaa-1111-4111-8111-111111111111'
const T2 = 'aaaaaaaa-2222-4222-8222-222222222222'
const T3 = 'aaaaaaaa-3333-4333-8333-333333333333'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ingestor-cc-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('ClaudeCodeIngestor.detects', () => {
  it('claims .jsonl files inside a .claude/projects path', () => {
    const ing = createClaudeCodeIngestor()
    expect(ing.detects(`${tmp}/.claude/projects/proj/${SESSION}.jsonl`)).toBe(true)
  })

  it('rejects .jsonl outside .claude/projects (avoids stomping other ingestors)', () => {
    const ing = createClaudeCodeIngestor()
    expect(ing.detects(`${tmp}/random/path/${SESSION}.jsonl`)).toBe(false)
  })

  it('rejects non-jsonl extensions', () => {
    const ing = createClaudeCodeIngestor()
    expect(ing.detects(`${tmp}/.claude/projects/proj/notes.md`)).toBe(false)
  })
})

describe('ClaudeCodeIngestor.parse', () => {
  async function writeTranscript(uuid: string, lines: object[]): Promise<string> {
    const dir = join(tmp, '.claude', 'projects', 'proj')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${uuid}.jsonl`)
    await writeFile(path, lines.map(o => JSON.stringify(o)).join('\n'), 'utf8')
    return path
  }

  it('extracts user + assistant text turns; carries uuid/parentUuid/timestamp through', async () => {
    const path = await writeTranscript(SESSION, [
      {
        type: 'user', uuid: T1, parentUuid: null, timestamp: '2026-05-01T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'first user turn' }] },
      },
      {
        type: 'assistant', uuid: T2, parentUuid: T1, timestamp: '2026-05-01T10:01:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'assistant reply' }] },
      },
      {
        type: 'user', uuid: T3, parentUuid: T2, timestamp: '2026-05-01T10:05:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'follow-up question' }] },
      },
    ])

    const ing = createClaudeCodeIngestor()
    const sessions = await ing.parse(path)
    expect(sessions).toHaveLength(1)
    const s = sessions[0]

    expect(s.chronicleId).toBe(SESSION)
    expect(s.mementos).toHaveLength(3)
    expect(s.mementos[0]).toMatchObject({ mementoId: T1, parentMementoId: undefined, createdAt: '2026-05-01T10:00:00Z' })
    expect(s.mementos[1]).toMatchObject({ mementoId: T2, parentMementoId: T1, createdAt: '2026-05-01T10:01:00Z' })
    expect(s.mementos[2]).toMatchObject({ mementoId: T3, parentMementoId: T2, createdAt: '2026-05-01T10:05:00Z' })
    expect(s.mementos[0].text).toContain('first user turn')
    expect(s.mementos[1].text).toContain('assistant reply')
    expect(s.tags).toEqual(['source:claude-code'])
    expect(s.createdAt).toBe('2026-05-01T10:00:00Z')
  })

  it('drops sidechain, tool-use, and non-conversation entries', async () => {
    const path = await writeTranscript(SESSION, [
      // Keep — normal user text.
      {
        type: 'user', uuid: T1, timestamp: '2026-05-01T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'kept' }] },
      },
      // Drop — sidechain.
      {
        type: 'user', uuid: T2, isSidechain: true,
        message: { role: 'user', content: [{ type: 'text', text: 'background noise' }] },
      },
      // Drop — tool-use only (no text block).
      {
        type: 'assistant', uuid: T3,
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
      },
      // Drop — non-conversation entry (file-history-snapshot).
      { type: 'file-history-snapshot', messageId: 'irrelevant' },
    ])

    const ing = createClaudeCodeIngestor()
    const sessions = await ing.parse(path)
    expect(sessions[0].mementos).toHaveLength(1)
    expect(sessions[0].mementos[0].mementoId).toBe(T1)
    expect(sessions[0].mementos[0].text).toContain('kept')
    // Confirm filtered content didn't sneak in via any code path.
    expect(JSON.stringify(sessions[0].mementos)).not.toContain('background noise')
    expect(JSON.stringify(sessions[0].mementos)).not.toContain('ls')
  })

  it('returns [] for a file whose basename is not a UUID (skip rather than throw)', async () => {
    const dir = join(tmp, '.claude', 'projects', 'proj')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'not-a-uuid.jsonl')
    await writeFile(path, JSON.stringify({
      type: 'user', uuid: T1,
      message: { role: 'user', content: [{ type: 'text', text: 'will not be ingested' }] },
    }), 'utf8')

    const ing = createClaudeCodeIngestor()
    const sessions = await ing.parse(path)
    expect(sessions).toEqual([])
  })

  it('returns [] when every record is filtered out (e.g. tool-only session)', async () => {
    const path = await writeTranscript(SESSION, [
      {
        type: 'assistant', uuid: T1,
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
      },
    ])
    const ing = createClaudeCodeIngestor()
    const sessions = await ing.parse(path)
    expect(sessions).toEqual([])
  })

  it('tolerates malformed JSON lines (skip the bad line, keep the rest)', async () => {
    const dir = join(tmp, '.claude', 'projects', 'proj')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${SESSION}.jsonl`)
    const goodLine = JSON.stringify({
      type: 'user', uuid: T1,
      message: { role: 'user', content: [{ type: 'text', text: 'kept' }] },
    })
    await writeFile(path, `{not json\n${goodLine}\n`, 'utf8')

    const ing = createClaudeCodeIngestor()
    const sessions = await ing.parse(path)
    expect(sessions[0].mementos).toHaveLength(1)
    expect(sessions[0].mementos[0].text).toContain('kept')
  })
})
