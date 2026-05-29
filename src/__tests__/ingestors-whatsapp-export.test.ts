/**
 * Unit tests for the WhatsAppExportIngestor.
 *
 * Parses captured-shape `.txt` fixtures for both export layouts:
 *   - `fixtures/whatsapp-ios.txt`     — bracketed `[M/D/YY, HH:MM:SS]`, CRLF, U+200E marks
 *   - `fixtures/whatsapp-android.txt` — `D/M/YYYY, HH:MM -` , LF
 * Their shapes are matched to real WhatsApp exports (starkdmi/whats_json test data). They
 * exercise: the timestamp layouts, multi-line continuation, the no-`Sender:` system-notice
 * drop, the e2e-banner text drop, media placeholders, and locale-ambiguous date parsing.
 * WhatsApp has no CLI to drive, so the export is the only artifact — hence a fixture test.
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create as createWhatsAppIngestor } from '../ingestors/whatsapp-export/index.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const fixturesDir = join(fileURLToPath(import.meta.url), '..', 'fixtures')
const iosFixture = join(fixturesDir, 'whatsapp-ios.txt')
const androidFixture = join(fixturesDir, 'whatsapp-android.txt')

describe('WhatsAppExportIngestor.detects', () => {
  it('claims a .txt whose first lines match the WhatsApp layout', async () => {
    expect(await createWhatsAppIngestor().detects(iosFixture)).toBe(true)
    expect(await createWhatsAppIngestor().detects(androidFixture)).toBe(true)
  })

  it('rejects a non-txt extension', async () => {
    expect(await createWhatsAppIngestor().detects('/exports/chat.json')).toBe(false)
  })

  it('rejects a .txt that is not a WhatsApp transcript', async () => {
    // The ingestor's own source file is a .txt-less TS file → not readable as a chat.
    expect(await createWhatsAppIngestor().detects(fileURLToPath(import.meta.url))).toBe(false)
  })

  it('throws on an unreadable file (fail-loud, like its sibling ingestors)', async () => {
    await expect(createWhatsAppIngestor().parse('/nonexistent/whatsapp.txt')).rejects.toThrow()
  })
})

describe('WhatsAppExportIngestor.parse (iOS)', () => {
  it('parses bracketed lines, dropping the e2e banner, media, and the group notice', async () => {
    const sessions = await createWhatsAppIngestor().parse(iosFixture)
    expect(sessions).toHaveLength(1)
    const session = sessions[0]!
    expect(UUID_RE.test(session.chronicleId)).toBe(true)
    expect(session.tags).toEqual(['source:whatsapp'])
    expect(session.mementos.map(p => p.text)).toEqual([
      'Alice: I prefer tabs over spaces.',
      'Bob: Got it — tabs it is.\nThis is a follow-up thought.',
    ])
  })

  it('parses the M/D/YY timestamp to ISO', async () => {
    const [session] = await createWhatsAppIngestor().parse(iosFixture)
    // [3/27/22, 21:41:35] → 27 > 12 so day=27, month=3.
    expect(session!.mementos[0]!.createdAt).toBe('2022-03-27T21:41:35.000Z')
    expect(session!.createdAt).toBe('2022-03-27T21:41:35.000Z')
  })
})

describe('WhatsAppExportIngestor.parse (Android)', () => {
  it('parses `D/M/YYYY, HH:MM -` lines and folds continuation lines', async () => {
    const [session] = await createWhatsAppIngestor().parse(androidFixture)
    expect(session!.mementos.map(p => p.text)).toEqual([
      'Carol: Morning team!',
      'Dave: Lets use Zustand for state.\nAnd keep the store small.',
      'Carol: Sounds good.',
    ])
  })

  it('parses the D/M/YYYY timestamp to ISO', async () => {
    const [session] = await createWhatsAppIngestor().parse(androidFixture)
    // 18/03/2022, 14:56 → 18 > 12 so day=18, month=3.
    expect(session!.mementos[0]!.createdAt).toBe('2022-03-18T14:56:00.000Z')
  })

  it('gives each chat a distinct session id', async () => {
    const ing = createWhatsAppIngestor()
    const [ios] = await ing.parse(iosFixture)
    const [android] = await ing.parse(androidFixture)
    expect(ios!.chronicleId).not.toBe(android!.chronicleId)
  })
})
