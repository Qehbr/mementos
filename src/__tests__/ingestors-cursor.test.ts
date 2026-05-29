/**
 * Unit tests for the CursorIngestor.
 *
 * Cursor is a GUI editor with no headless transcript-generation path, so there is no
 * Docker drift test. Instead each test builds a `state.vscdb` SQLite fixture with the
 * verified `cursorDiskKV` schema (composerData / bubbleId rows — confirmed against the
 * S2thend/cursor-history data-structure analysis) and runs the ingestor against it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create as createCursorIngestor } from '../ingestors/cursor/index.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ingestor-cursor-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Write a `state.vscdb` with a `cursorDiskKV` table holding the given key/value rows. */
function writeVscdb(name: string, rows: Array<[string, string]>, withCursorTable = true): string {
  const path = join(dir, name)
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('telemetry.machineId', '"abc"')
  if (withCursorTable) {
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)')
    const insert = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)')
    for (const [k, v] of rows) insert.run(k, v)
  }
  db.close()
  return path
}

/** A populated Cursor DB: two composer sessions, plus an empty bubble + a missing ref. */
function sampleDb(): string {
  return writeVscdb('state.vscdb', [
    ['composerData:comp-1', JSON.stringify({
      composerId: 'comp-1',
      name: 'TypeScript chat',
      createdAt: 1715000000000,
      lastUpdatedAt: 1715000300000,
      fullConversationHeadersOnly: [
        { bubbleId: 'b1', type: 1 },
        { bubbleId: 'b2', type: 2 },
        { bubbleId: 'b3', type: 1 },        // empty-text bubble → dropped
        { bubbleId: 'b-missing', type: 2 }, // no bubble row → skipped
      ],
    })],
    ['bubbleId:comp-1:b1', JSON.stringify({ bubbleId: 'b1', type: 1, text: 'I prefer tabs over spaces.' })],
    ['bubbleId:comp-1:b2', JSON.stringify({ bubbleId: 'b2', type: 2, text: 'Got it — tabs.' })],
    ['bubbleId:comp-1:b3', JSON.stringify({ bubbleId: 'b3', type: 1, text: '' })],
    ['bubbleId:comp-1:orphan', JSON.stringify({ bubbleId: 'orphan', type: 1, text: 'Unreferenced rewound message.' })],
    ['composerData:comp-2', JSON.stringify({
      composerId: 'comp-2',
      name: 'Second chat',
      createdAt: 1715100000000,
      fullConversationHeadersOnly: [{ bubbleId: 'x1', type: 1 }],
    })],
    ['bubbleId:comp-2:x1', JSON.stringify({ bubbleId: 'x1', type: 1, text: 'Second session works.' })],
  ])
}

describe('CursorIngestor.detects', () => {
  it('claims a file named state.vscdb', () => {
    expect(createCursorIngestor().detects('/home/u/.config/Cursor/User/globalStorage/state.vscdb')).toBe(true)
  })

  it('rejects other / non-vscdb files', () => {
    const ing = createCursorIngestor()
    expect(ing.detects('/home/u/.config/Cursor/User/globalStorage/other.vscdb')).toBe(false)
    expect(ing.detects('/home/u/state.json')).toBe(false)
  })
})

describe('CursorIngestor.parse', () => {
  it('parses each composer into a session of ordered user/assistant turns', async () => {
    const sessions = await createCursorIngestor().parse(sampleDb())
    expect(sessions).toHaveLength(2)

    const comp1 = sessions.find(s => s.mementos[0]?.text.includes('tabs over spaces'))!
    expect(UUID_RE.test(comp1.chronicleId)).toBe(true)
    expect(comp1.tags).toEqual(['source:cursor'])
    // b3 empty-text and b-missing are dropped; the two real turns stay in header order.
    expect(comp1.mementos.map(p => p.text)).toEqual([
      'USER: I prefer tabs over spaces.',
      'ASSISTANT: Got it — tabs.',
    ])
  })

  it('ignores orphan bubbles not listed in fullConversationHeadersOnly', async () => {
    const sessions = await createCursorIngestor().parse(sampleDb())
    const allText = sessions.flatMap(s => s.mementos).map(p => p.text).join('\n')
    expect(allText).not.toContain('Unreferenced rewound message')
  })

  it('derives the session createdAt from the composer epoch-ms timestamp', async () => {
    const sessions = await createCursorIngestor().parse(sampleDb())
    const comp1 = sessions.find(s => s.mementos[0]?.text.includes('tabs over spaces'))!
    expect(comp1.createdAt).toBe(new Date(1715000000000).toISOString())
  })

  it('returns no sessions for a VS Code DB without a cursorDiskKV table', async () => {
    const vscodeDb = writeVscdb('state.vscdb', [], /* withCursorTable */ false)
    expect(await createCursorIngestor().parse(vscodeDb)).toEqual([])
  })

  it('returns no sessions when cursorDiskKV has no composers', async () => {
    const empty = writeVscdb('state.vscdb', [['someOtherKey:1', '{}']])
    expect(await createCursorIngestor().parse(empty)).toEqual([])
  })
})
