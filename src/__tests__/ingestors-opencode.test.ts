/**
 * Unit tests for the OpenCodeIngestor.
 *
 * Each test builds an `opencode.db` SQLite fixture with the verified schema (`session` /
 * `message` / `part` tables with JSON `data` blobs — confirmed against a real opencode
 * 1.15.1 database) and runs the ingestor against it. The Docker drift test exercises the
 * real `opencode` CLI; this covers the parsing edge cases.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create as createOpenCodeIngestor } from '../ingestors/opencode/index.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface MsgSpec {
  id: string
  sessionId: string
  created: number
  role: string
  parts: Array<{ type: string; text?: string }>
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ingestor-opencode-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Write an `opencode.db` with the session/message/part tables, or skip them entirely. */
function writeDb(name: string, sessionIds: string[], messages: MsgSpec[], withTables = true): string {
  const path = join(dir, name)
  const db = new DatabaseSync(path)
  if (withTables) {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_created INTEGER)')
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
    db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
    const insS = db.prepare('INSERT INTO session VALUES (?, ?, ?)')
    for (const s of sessionIds) insS.run(s, `Session ${s}`, 1715000000000)
    const insM = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
    const insP = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)')
    for (const m of messages) {
      insM.run(m.id, m.sessionId, m.created, JSON.stringify({ role: m.role, time: { created: m.created } }))
      m.parts.forEach((p, i) => {
        insP.run(`${m.id}-p${i}`, m.id, m.sessionId, m.created + i, JSON.stringify(p))
      })
    }
  } else {
    db.exec('CREATE TABLE other (k TEXT)')
  }
  db.close()
  return path
}

describe('OpenCodeIngestor.detects', () => {
  it('claims a file named opencode.db', () => {
    expect(createOpenCodeIngestor().detects('/home/u/.local/share/opencode/opencode.db')).toBe(true)
  })

  it('rejects other / non-db files', () => {
    const ing = createOpenCodeIngestor()
    expect(ing.detects('/home/u/.local/share/opencode/other.db')).toBe(false)
    expect(ing.detects('/home/u/opencode.json')).toBe(false)
  })
})

describe('OpenCodeIngestor.parse', () => {
  function sampleDb(): string {
    return writeDb('opencode.db', ['ses-1'], [
      { id: 'msg-1', sessionId: 'ses-1', created: 1715000001000, role: 'user',
        parts: [{ type: 'text', text: 'I prefer tabs over spaces.' }] },
      { id: 'msg-2', sessionId: 'ses-1', created: 1715000002000, role: 'assistant',
        parts: [{ type: 'step-start' }, { type: 'text', text: 'Noted.' }, { type: 'text', text: 'Tabs it is.' }] },
      { id: 'msg-3', sessionId: 'ses-1', created: 1715000003000, role: 'assistant',
        parts: [{ type: 'tool', text: undefined }] }, // tool-only → no text → dropped
    ])
  }

  it('parses messages into ordered user/assistant turns, joining text parts', async () => {
    const sessions = await createOpenCodeIngestor().parse(sampleDb())
    expect(sessions).toHaveLength(1)
    const session = sessions[0]!
    expect(UUID_RE.test(session.chronicleId)).toBe(true)
    expect(session.tags).toEqual(['source:opencode'])
    // step-start carries no text; the two text parts of msg-2 are joined; msg-3 dropped.
    expect(session.mementos.map(p => p.text)).toEqual([
      'USER: I prefer tabs over spaces.',
      'ASSISTANT: Noted.\nTabs it is.',
    ])
  })

  it('derives createdAt from the message epoch-ms timestamp', async () => {
    const [session] = await createOpenCodeIngestor().parse(sampleDb())
    expect(session!.mementos[0]!.createdAt).toBe(new Date(1715000001000).toISOString())
    expect(session!.createdAt).toBe(new Date(1715000001000).toISOString())
  })

  it('produces one session per session row', async () => {
    const db = writeDb('opencode.db', ['ses-a', 'ses-b'], [
      { id: 'm-a', sessionId: 'ses-a', created: 1715000001000, role: 'user',
        parts: [{ type: 'text', text: 'First chat.' }] },
      { id: 'm-b', sessionId: 'ses-b', created: 1715000005000, role: 'user',
        parts: [{ type: 'text', text: 'Second chat.' }] },
    ])
    const sessions = await createOpenCodeIngestor().parse(db)
    expect(sessions).toHaveLength(2)
  })

  it('returns no sessions for a DB without the opencode tables', async () => {
    expect(await createOpenCodeIngestor().parse(writeDb('opencode.db', [], [], false))).toEqual([])
  })
})
