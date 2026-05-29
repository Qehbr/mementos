/**
 * Unit tests for the TelegramExportIngestor.
 *
 * Parses captured-shape `result.json` fixtures whose shape is matched to the official
 * Telegram Desktop export schema (core.telegram.org/import-export):
 *   - `fixtures/telegram-full/result.json`   — full-account export (`chats.list`)
 *   - `fixtures/telegram-single/result.json` — single-chat export (chat object at root)
 * They exercise the `service`-type drop, string vs entity-array `text`, reply links, the
 * empty-text (media-only) drop, and epoch `date_unixtime`. Telegram has no CLI to drive,
 * so the export is the only artifact — hence a fixture test.
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create as createTelegramIngestor } from '../ingestors/telegram-export/index.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const fixturesDir = join(fileURLToPath(import.meta.url), '..', 'fixtures')
const fullExport = join(fixturesDir, 'telegram-full', 'result.json')
const singleExport = join(fixturesDir, 'telegram-single', 'result.json')

describe('TelegramExportIngestor.detects', () => {
  it('claims a file named result.json', () => {
    expect(createTelegramIngestor().detects('/DataExport_15_01_2024/result.json')).toBe(true)
  })

  it('rejects other .json files', () => {
    expect(createTelegramIngestor().detects('/exports/conversations.json')).toBe(false)
  })

  it('rejects non-json extensions', () => {
    expect(createTelegramIngestor().detects('/exports/result.txt')).toBe(false)
  })
})

describe('TelegramExportIngestor.parse', () => {
  // Guards the shared readJsonFile helper's fail-loud read (used by telegram/slack/chatgpt):
  // an unreadable file must throw so the ingest loop reports an error + exit 1, not a silent
  // "no content" skip. The plain-readFile (whatsapp) and readJsonlRecords (gemini) helpers
  // have their own parity tests; readJsonFile was the last untested one.
  it('parse throws on a read error (fail-loud, like every sibling ingestor)', async () => {
    await expect(createTelegramIngestor().parse('/nonexistent/result.json')).rejects.toThrow()
  })

  it('parses a full-account export, dropping service and empty-text messages', async () => {
    const sessions = await createTelegramIngestor().parse(fullExport)
    expect(sessions).toHaveLength(1)
    const session = sessions[0]!
    expect(UUID_RE.test(session.chronicleId)).toBe(true)
    expect(session.tags).toEqual(['source:telegram'])
    // service create_group dropped; photo-only message dropped; two real turns kept.
    expect(session.mementos.map(p => p.text)).toEqual([
      'Alice: I prefer tabs over spaces.',
      'Bob: Agreed — see the style guide.',
    ])
  })

  it('concatenates the runs of an entity-array text field', async () => {
    const [session] = await createTelegramIngestor().parse(fullExport)
    // text was ["Agreed — see ", {type:"link",text:"the style guide"}, "."]
    expect(session!.mementos[1]!.text).toBe('Bob: Agreed — see the style guide.')
  })

  it('links a reply to the message it answers', async () => {
    const [session] = await createTelegramIngestor().parse(fullExport)
    const [first, reply] = session!.mementos
    expect(first!.parentMementoId).toBeUndefined()
    expect(reply!.parentMementoId).toBe(first!.mementoId)
  })

  it('converts date_unixtime to an ISO timestamp', async () => {
    const [session] = await createTelegramIngestor().parse(fullExport)
    expect(session!.mementos[0]!.createdAt).toBe(new Date(1705314600 * 1000).toISOString())
    expect(session!.createdAt).toBe(new Date(1705314600 * 1000).toISOString())
  })

  it('parses a single-chat export (chat object at the top level)', async () => {
    const sessions = await createTelegramIngestor().parse(singleExport)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.mementos.map(p => p.text)).toEqual(['Carol: Single-chat export works.'])
  })
})
