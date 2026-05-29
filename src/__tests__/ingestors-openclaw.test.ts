/**
 * Unit tests for the OpenClawIngestor.
 *
 * Synthetic JSONL fixtures hand-crafted to exercise each filter rule (kept user/assistant
 * turns; dropped session header, compaction marker, toolResult, text-less turns), the
 * content shapes (string content, text-block array, direct `message.text`), the id → UUID
 * hashing (parentId → parentMementoId equals the parent's mementoId), and timestamp
 * coercion (ISO string + epoch ms). No real OpenClaw installation needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create as createOpenClawIngestor } from '../ingestors/openclaw/index.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ingestor-oc-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

/** Write a transcript at `<tmp>/agents/<agent>/sessions/<session>.jsonl`. */
async function writeTranscript(session: string, lines: object[]): Promise<string> {
  const dir = join(tmp, 'agents', 'agent-1', 'sessions')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${session}.jsonl`)
  await writeFile(path, lines.map(o => JSON.stringify(o)).join('\n'), 'utf8')
  return path
}

describe('OpenClawIngestor.detects', () => {
  it('claims .jsonl files inside an agents/<id>/sessions path', () => {
    const ing = createOpenClawIngestor()
    expect(ing.detects(`${tmp}/agents/a1/sessions/sess-1.jsonl`)).toBe(true)
  })

  it('rejects .jsonl outside the agents/sessions shape', () => {
    const ing = createOpenClawIngestor()
    expect(ing.detects(`${tmp}/.claude/projects/proj/sess.jsonl`)).toBe(false)
  })

  it('rejects non-jsonl extensions', () => {
    const ing = createOpenClawIngestor()
    expect(ing.detects(`${tmp}/agents/a1/sessions/notes.md`)).toBe(false)
  })

  it('rejects the sibling <sid>.trajectory.jsonl runtime-trace file', () => {
    const ing = createOpenClawIngestor()
    // The real transcript is `<sid>.jsonl`; OpenClaw writes a trace file next to it.
    expect(ing.detects(`${tmp}/agents/a1/sessions/sess-1.jsonl`)).toBe(true)
    expect(ing.detects(`${tmp}/agents/a1/sessions/sess-1.trajectory.jsonl`)).toBe(false)
  })
})

describe('OpenClawIngestor.parse', () => {
  it('keeps user/assistant turns and drops session header, compaction, toolResult', async () => {
    const path = await writeTranscript('sess-abc', [
      { type: 'session', sessionId: 'sess-abc', timestamp: '2026-05-01T10:00:00.000Z' },
      { id: 'msg_1', parentId: null, timestamp: '2026-05-01T10:00:01.000Z',
        message: { role: 'user', content: 'I prefer tabs over spaces.' } },
      { id: 'msg_2', parentId: 'msg_1', timestamp: '2026-05-01T10:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] } },
      { id: 'msg_3', parentId: 'msg_2', timestamp: '2026-05-01T10:00:03.000Z',
        message: { role: 'toolResult', content: 'tool output' } },
      { type: 'compaction', id: 'c1', parentId: 'msg_3' },
    ])

    const sessions = await createOpenClawIngestor().parse(path)
    expect(sessions).toHaveLength(1)
    const session = sessions[0]!
    expect(UUID_RE.test(session.chronicleId)).toBe(true)
    expect(session.tags).toEqual(['source:openclaw'])
    expect(session.mementos.map(p => p.text)).toEqual([
      'USER: I prefer tabs over spaces.',
      'ASSISTANT: Noted.',
    ])
  })

  it('hashes ids to UUIDs and preserves the parent link', async () => {
    const path = await writeTranscript('sess-1', [
      { id: 'msg_1', parentId: null, timestamp: '2026-05-01T10:00:01.000Z',
        message: { role: 'user', content: 'first' } },
      { id: 'msg_2', parentId: 'msg_1', timestamp: '2026-05-01T10:00:02.000Z',
        message: { role: 'assistant', content: 'second' } },
    ])

    const [session] = await createOpenClawIngestor().parse(path)
    const [p1, p2] = session!.mementos
    expect(UUID_RE.test(p1!.mementoId)).toBe(true)
    expect(p1!.parentMementoId).toBeUndefined()
    // msg_2's parentId is msg_1 — its parentMementoId must equal msg_1's mementoId.
    expect(p2!.parentMementoId).toBe(p1!.mementoId)
  })

  it('reads text from a direct message.text field', async () => {
    const path = await writeTranscript('sess-2', [
      { id: 'm1', parentId: null, timestamp: '2026-05-01T10:00:00.000Z',
        message: { role: 'assistant', text: 'direct text field' } },
    ])
    const [session] = await createOpenClawIngestor().parse(path)
    expect(session!.mementos[0]!.text).toBe('ASSISTANT: direct text field')
  })

  it('coerces an epoch-ms timestamp to ISO and sets the session createdAt', async () => {
    const epoch = Date.UTC(2026, 4, 1, 12, 0, 0)
    const path = await writeTranscript('sess-3', [
      { id: 'm1', parentId: null, timestamp: epoch,
        message: { role: 'user', content: 'hello' } },
    ])
    const [session] = await createOpenClawIngestor().parse(path)
    expect(session!.mementos[0]!.createdAt).toBe(new Date(epoch).toISOString())
    expect(session!.createdAt).toBe(new Date(epoch).toISOString())
  })

  it('skips malformed lines without aborting the transcript', async () => {
    const dir = join(tmp, 'agents', 'a1', 'sessions')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'sess-4.jsonl')
    await writeFile(path, [
      '{ not json',
      JSON.stringify({ id: 'm1', parentId: null, timestamp: '2026-05-01T10:00:00.000Z',
        message: { role: 'user', content: 'survived' } }),
    ].join('\n'), 'utf8')

    const [session] = await createOpenClawIngestor().parse(path)
    expect(session!.mementos).toHaveLength(1)
    expect(session!.mementos[0]!.text).toBe('USER: survived')
  })

  it('returns no sessions when every record is filtered out', async () => {
    const path = await writeTranscript('sess-5', [
      { type: 'session', sessionId: 'sess-5' },
      { id: 'm1', parentId: null, message: { role: 'toolResult', content: 'x' } },
      { id: 'm2', parentId: 'm1', message: { role: 'assistant', content: '' } },
    ])
    expect(await createOpenClawIngestor().parse(path)).toEqual([])
  })
})
