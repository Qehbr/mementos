/**
 * Unit tests for the ChatGptExportIngestor.
 *
 * Parses a `conversations.json` fixture (`fixtures/chatgpt-conversations.json`) whose shape
 * is matched field-for-field to the published ChatGPT-export schema (sanand0/openai-
 * conversations, derived from 2,000 real conversations): two conversations exercising the
 * mapping tree, the system/hidden + tool-role filters, the multimodal `parts` array, branch
 * parent links, and epoch-second timestamps. There is no ChatGPT CLI to run, so the export
 * is the only artifact — hence a fixture, not a drift test.
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create as createChatGptIngestor } from '../ingestors/chatgpt-export/index.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const fixturesDir = join(fileURLToPath(import.meta.url), '..', 'fixtures')
const fixture = join(fixturesDir, 'chatgpt-conversations.json')

describe('ChatGptExportIngestor.detects', () => {
  it('claims a file named conversations.json', () => {
    expect(createChatGptIngestor().detects('/exports/chatgpt/conversations.json')).toBe(true)
  })

  it('rejects other .json files', () => {
    expect(createChatGptIngestor().detects('/exports/chatgpt/chat.json')).toBe(false)
  })

  it('rejects non-json extensions', () => {
    expect(createChatGptIngestor().detects('/exports/conversations.txt')).toBe(false)
  })
})

describe('ChatGptExportIngestor.parse', () => {
  it('parses the fixture export into one session of user/assistant turns', async () => {
    const sessions = await createChatGptIngestor().parse(fixture)
    // The second conversation is tool-only → filtered out entirely.
    expect(sessions).toHaveLength(1)
    const session = sessions[0]!
    expect(UUID_RE.test(session.chronicleId)).toBe(true)
    expect(session.tags).toEqual(['source:chatgpt'])
    // System/hidden primer dropped; user + assistant + user kept, in create_time order.
    expect(session.mementos.map(p => p.text)).toEqual([
      'USER: I prefer tabs over spaces in TypeScript.',
      'ASSISTANT: Noted — tabs it is.',
      'USER: And use Zustand for state.',
    ])
  })

  it('preserves the branch parent link between consecutive turns', async () => {
    const [session] = await createChatGptIngestor().parse(fixture)
    const [p1, p2, p3] = session!.mementos
    expect(p1!.parentMementoId).toBeDefined()       // node-a1's parent is the hidden system node
    expect(p2!.parentMementoId).toBe(p1!.mementoId)  // assistant's parent is the user turn
    expect(p3!.parentMementoId).toBe(p2!.mementoId)  // follow-up's parent is the assistant turn
  })

  it('keeps only the string parts of a multimodal message', async () => {
    const [session] = await createChatGptIngestor().parse(fixture)
    // node-a3 mixes an image_asset_pointer object with a string — only the string survives.
    expect(session!.mementos[2]!.text).toBe('USER: And use Zustand for state.')
  })

  it('converts epoch-second create_time to an ISO timestamp', async () => {
    const [session] = await createChatGptIngestor().parse(fixture)
    expect(session!.mementos[0]!.createdAt).toBe(new Date(1715000001 * 1000).toISOString())
    expect(session!.createdAt).toBe(new Date(1715000001 * 1000).toISOString())
  })

  it('returns no sessions for non-JSON input', async () => {
    expect(await createChatGptIngestor().parse(import.meta.url.replace('file://', ''))).toEqual([])
  })
})
