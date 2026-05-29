/**
 * WhatsAppExportIngestor — parses a WhatsApp "Export chat" `.txt` file.
 *
 * WhatsApp's per-chat export (chat → ⋯ → Export chat → Without media) is a plain-text
 * transcript, one message per line, in one of two locale-dependent layouts:
 *
 *   iOS:      `[3/18/22, 14:56:01] Alice: message text`
 *   Android:  `18/03/2022, 14:56 - Alice: message text`
 *
 * A line that does not start with a timestamp is a continuation of the previous message
 * (multi-line text). System notices (the end-to-end-encryption banner, "X added Y", group
 * renames) and media placeholders ("image omitted", "<Media omitted>") are dropped.
 *
 * The whole file is one chat → one `IngestSession`:
 *   - **`chronicleId`** = a stable UUID hashed from the first message line (chat-unique, and
 *     unchanged when the chat is re-exported with more messages → idempotent re-ingest).
 *   - **`mementoId`** = `<chat>:<index>` hashed; WhatsApp messages have no native id, and a
 *     chat is append-only so the positional index is stable across re-exports.
 *   - **`createdAt`** = best-effort parse of the line's timestamp (locale-ambiguous dates
 *     are resolved by which component exceeds 12; omitted when unparseable).
 *
 * The export is a manual share — no WhatsApp CLI exists to drive. Unit-tested against
 * captured iOS + Android fixtures.
 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Ingestor, IngestSession, IngestorFactory } from '../interface.js'
import type { IngestorImplementationModule } from '../registry.js'
import { toUuid } from '../_utils/uuid.js'
import { turnLine } from '../_utils/turn-line.js'
import { buildSession } from '../_utils/session.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'whatsapp-export'
export const create: IngestorFactory = () => new WhatsAppExportIngestor()
const _shape: IngestorImplementationModule = { type, create }

// A date (`d/m/yy`, `m.d.yyyy`, …) + time (`HH:MM`, `HH:MM:SS`, optional am/pm). Reused by
// both line shapes. U+202F (narrow no-break space) precedes AM/PM on iOS exports.
const DATE = String.raw`(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})`
const TIME = String.raw`(\d{1,2}:\d{2}(?::\d{2})?(?:[\s\u202f]?[APap][Mm])?)`
const IOS_RE = new RegExp(String.raw`^\[${DATE},\s*${TIME}\]\s*(.*)$`)
const ANDROID_RE = new RegExp(String.raw`^${DATE},\s*${TIME}\s-\s(.*)$`)

/**
 * The one system notice that still carries a `Sender:` segment (so it survives the
 * no-sender drop): the end-to-end-encryption banner. Group-management notices ("X added
 * Y", renames) have no `Sender:` segment and are already dropped as senderless lines, so
 * this pattern is deliberately narrow — a broad one would eat real messages like
 * "Bob added sugar".
 */
const SYSTEM_TEXT_RE = /^messages and calls are end-to-end encrypted/i
/** Media placeholders WhatsApp writes in a "Without media" export. */
const MEDIA_RE = /^(<media omitted>|(image|video|audio|gif|sticker|document|contact card) omitted)$/i

class WhatsAppExportIngestor implements Ingestor {
  readonly name = 'WhatsApp export'

  /** `.txt` whose first content line matches a WhatsApp timestamped-message layout. */
  async detects(filePath: string): Promise<boolean> {
    if (extname(filePath).toLowerCase() !== '.txt') return false
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch {
      return false
    }
    // Split on CRLF or LF — iOS exports are CRLF, and a stray \r breaks the `$` anchor.
    for (const line of raw.split(/\r?\n/).slice(0, 10)) {
      const clean = stripMarks(line)
      if (IOS_RE.test(clean) || ANDROID_RE.test(clean)) return true
    }
    return false
  }

  async parse(filePath: string): Promise<IngestSession[]> {
    // Fail loud on a read error (like every sibling ingestor) — the CLI logs the file as an
    // error rather than silently reporting "no content". WhatsApp is plain .txt, no JSON helper.
    const raw = await readFile(filePath, 'utf8')
    const lines = raw.split(/\r?\n/)

    // First pass: fold continuation lines into their owning message.
    const messages: ParsedMessage[] = []
    for (const rawLine of lines) {
      const line = stripMarks(rawLine)
      const parsed = parseLine(line)
      if (parsed) {
        messages.push(parsed)
      } else if (line.length > 0) {
        const last = messages.at(-1)
        if (last) last.text += `\n${line}`
      }
    }
    const [firstMessage] = messages
    if (!firstMessage) return []

    // Chronicle id from the first message line — stable + chat-unique across re-exports.
    const seed = `whatsapp:${firstMessage.raw}`

    const mementos: IngestSession['mementos'] = []
    messages.forEach((msg, index) => {
      if (!msg.sender) return // a system notice (no "Sender:" segment)
      const text = msg.text.trim()
      if (!text || SYSTEM_TEXT_RE.test(text) || MEDIA_RE.test(text)) return

      const ts = msg.timestamp
      mementos.push({
        mementoId: toUuid(`${seed}:${index}`),
        text: turnLine(msg.sender, text),
        createdAt: ts,
      })
    })

    const session = buildSession(toUuid(seed), mementos, 'whatsapp')
    return session ? [session] : []
  }
}

interface ParsedMessage {
  raw: string
  sender?: string
  text: string
  timestamp?: string
}

/**
 * Parse one line as a message-start. Returns `undefined` if the line carries no timestamp
 * (a continuation line). A line with a timestamp but no `Sender: ` segment is a system
 * notice — returned with `sender` unset so the caller drops it.
 */
function parseLine(line: string): ParsedMessage | undefined {
  const m = IOS_RE.exec(line) ?? ANDROID_RE.exec(line)
  if (!m) return undefined
  const [, date = '', time = '', rest = ''] = m
  const colon = rest.indexOf(': ')
  const timestamp = parseTimestamp(date, time)
  if (colon === -1) return { raw: line, text: rest, timestamp } // system notice — no sender
  return { raw: line, sender: rest.slice(0, colon).trim(), text: rest.slice(colon + 2), timestamp }
}

/**
 * Best-effort conversion of a WhatsApp date+time to an ISO 8601 string. The date order is
 * locale-dependent and genuinely ambiguous (`3/4/22` could be Mar 4 or Apr 3); we resolve
 * it when one component exceeds 12 and otherwise assume day-first (the global default).
 * Returns `undefined` if the pieces don't form a real date — the vault then falls back to
 * the session timestamp.
 */
function parseTimestamp(date: string, time: string): string | undefined {
  const dateParts = date.split(/[./-]/).map(Number)
  if (dateParts.length !== 3 || dateParts.some(n => !Number.isFinite(n))) return undefined
  const [a, b, rawYear] = dateParts as [number, number, number]
  let day: number, month: number
  if (a > 12) { day = a; month = b }      // unambiguous: first part is the day
  else if (b > 12) { month = a; day = b } // unambiguous: second part is the day
  else { day = a; month = b }             // ambiguous → day-first
  const year = rawYear < 100 ? rawYear + 2000 : rawYear

  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?[\s\u202f]?([APap][Mm])?$/.exec(time)
  if (!tm) return undefined
  let hour = Number(tm[1])
  const minute = Number(tm[2])
  const second = Number(tm[3] ?? '0')
  const ampm = tm[4]?.toLowerCase()
  if (ampm === 'pm' && hour < 12) hour += 12
  if (ampm === 'am' && hour === 12) hour = 0

  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/** Strip the Unicode directional marks (U+200E/200F, U+202A-202E) WhatsApp sprinkles in. */
function stripMarks(s: string): string {
  return s.replace(/[\u200e\u200f\u202a-\u202e]/g, '')
}
