/**
 * Unit tests for the SlackExportIngestor.
 *
 * Parses captured-shape Slack day-file fixtures (`fixtures/slack-export/general/*.json`),
 * whose shape is matched to a real Slack workspace export (hfaran/slack-export-viewer's
 * `testarchive.zip`): plain human messages, the no-`subtype` filter that drops join/bot
 * events, threaded replies, `user_profile` name resolution, and `<url|label>` de-markup.
 * Slack has no CLI to drive, so the export is the only artifact — hence a fixture test.
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create as createSlackIngestor } from '../ingestors/slack-export/index.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const channelDir = join(fileURLToPath(import.meta.url), '..', 'fixtures', 'slack-export', 'general')
const day1 = join(channelDir, '2024-01-15.json')
const day2 = join(channelDir, '2024-01-16.json')

describe('SlackExportIngestor.detects', () => {
  it('claims a YYYY-MM-DD.json day file', () => {
    expect(createSlackIngestor().detects('/export/general/2024-01-15.json')).toBe(true)
  })

  it('rejects the export\'s channels.json / users.json index files', () => {
    const ing = createSlackIngestor()
    expect(ing.detects('/export/channels.json')).toBe(false)
    expect(ing.detects('/export/users.json')).toBe(false)
  })

  it('rejects non-json extensions', () => {
    expect(createSlackIngestor().detects('/export/general/2024-01-15.txt')).toBe(false)
  })
})

describe('SlackExportIngestor.parse', () => {
  it('keeps plain human messages and drops join / bot-subtyped ones', async () => {
    const sessions = await createSlackIngestor().parse(day1)
    expect(sessions).toHaveLength(1)
    const session = sessions[0]!
    expect(UUID_RE.test(session.chronicleId)).toBe(true)
    expect(session.tags).toEqual(['source:slack'])
    // channel_join + bot_message dropped; two human turns kept.
    expect(session.mementos.map(p => p.text)).toEqual([
      'alice: The Q4 report is ready, see the doc.',
      'Bob Brown: Thanks <@U01ALICE>! I\'ll review it.',
    ])
  })

  it('links a threaded reply to its root message', async () => {
    const [session] = await createSlackIngestor().parse(day1)
    const [root, reply] = session!.mementos
    expect(root!.parentMementoId).toBeUndefined()
    expect(reply!.parentMementoId).toBe(root!.mementoId)
  })

  it('resolves the speaker name from user_profile, falling back across fields', async () => {
    const [session] = await createSlackIngestor().parse(day1)
    // First message: display_name "alice". Second: display_name "" → real_name "Bob Brown".
    expect(session!.mementos[0]!.text.startsWith('alice: ')).toBe(true)
    expect(session!.mementos[1]!.text.startsWith('Bob Brown: ')).toBe(true)
  })

  it('groups every day file of one channel under the same session id', async () => {
    const ing = createSlackIngestor()
    const [s1] = await ing.parse(day1)
    const [s2] = await ing.parse(day2)
    expect(s1!.chronicleId).toBe(s2!.chronicleId)
  })

  it('converts the ts to an ISO timestamp', async () => {
    const [session] = await createSlackIngestor().parse(day1)
    expect(session!.mementos[0]!.createdAt).toBe(new Date(1705316400.0002 * 1000).toISOString())
  })
})
