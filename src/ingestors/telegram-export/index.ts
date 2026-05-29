/**
 * TelegramExportIngestor — parses a Telegram Desktop JSON export's `result.json`.
 *
 * Telegram Desktop (Settings → Advanced → Export Telegram data, or "Export chat history"
 * on one chat) writes a `result.json`. Two shapes are handled:
 *   - a full-account export — `{ chats: { list: [ <chat>, … ] } }`
 *   - a single-chat export  — the `<chat>` object itself at the top level
 * where a `<chat>` is `{ id, name, type, messages: [ <message>, … ] }`.
 *
 * We keep `type:"message"` entries and drop `type:"service"` (joins, calls, pins). Each
 * chat becomes one `IngestSession`:
 *   - **`chronicleId`** = `telegram:<chat id>` hashed to a stable UUID.
 *   - **`mementoId`** = `telegram:<chat id>:<message id>` hashed; the message id is unique
 *     within its chat.
 *   - **`parentMementoId`** = the same for `reply_to_message_id` — so a reply links to the
 *     message it answers.
 *   - **`createdAt`** = `date_unixtime` (epoch seconds) → ISO.
 *
 * The export is a manual download (no Telegram CLI). Unit-tested against a captured
 * `result.json` fixture.
 */
import type { Ingestor, IngestSession, IngestorFactory } from '../interface.js'
import type { IngestorImplementationModule } from '../registry.js'
import { toUuid } from '../_utils/uuid.js'
import { turnLine } from '../_utils/turn-line.js'
import { fromEpochSeconds } from '../_utils/timestamp.js'
import { buildSession } from '../_utils/session.js'
import { isNamedFile } from '../_utils/detect.js'
import { readJsonFile } from '../_utils/json-file.js'
import { joinTextRuns } from '../_utils/extract-text.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'telegram-export'
export const create: IngestorFactory = () => new TelegramExportIngestor()
const _shape: IngestorImplementationModule = { type, create }

class TelegramExportIngestor implements Ingestor {
  readonly name = 'Telegram export'

  detects(filePath: string): boolean {
    // `result.json` is the fixed filename Telegram Desktop writes the export to.
    return isNamedFile(filePath, '.json', 'result.json')
  }

  async parse(filePath: string): Promise<IngestSession[]> {
    const root = await readJsonFile<TelegramExport>(filePath)
    if (!root) return []

    // Full-account export nests chats under `chats.list`; a single-chat export IS the chat.
    const chats: TelegramChat[] = Array.isArray(root.chats?.list)
      ? root.chats.list
      : Array.isArray(root.messages) ? [root] : []

    const sessions: IngestSession[] = []
    for (const chat of chats) {
      const session = parseChat(chat)
      if (session) sessions.push(session)
    }
    return sessions
  }
}

function parseChat(chat: TelegramChat): IngestSession | undefined {
  if (!Array.isArray(chat.messages)) return undefined
  // A chat usually has a numeric `id`; fall back to the name so a session id still exists.
  const chatKey = `telegram:${chat.id ?? chat.name ?? 'chat'}`

  const mementos: IngestSession['mementos'] = []

  for (const msg of chat.messages) {
    if (msg.type !== 'message') continue // skip service entries (joins, calls, pins)
    const text = joinTextRuns(msg.text)
    if (!text) continue

    // `date_unixtime` is epoch seconds as a string; `date` is local with no zone, so unixtime wins.
    const ts = fromEpochSeconds(Number(msg.date_unixtime))

    const replyId = msg.reply_to_message_id
    mementos.push({
      mementoId: toUuid(`${chatKey}:${msg.id}`),
      parentMementoId: replyId !== undefined && replyId !== null
        ? toUuid(`${chatKey}:${replyId}`)
        : undefined,
      text: turnLine(typeof msg.from === 'string' && msg.from ? msg.from : 'unknown', text),
      createdAt: ts,
    })
  }

  return buildSession(toUuid(chatKey), mementos, 'telegram')
}

interface TelegramMessage {
  id?: number | string
  type?: string
  date_unixtime?: string
  from?: unknown
  text?: unknown
  reply_to_message_id?: number | string | null
}
interface TelegramChat {
  id?: number | string
  name?: string
  type?: string
  messages?: TelegramMessage[]
}
interface TelegramExport extends TelegramChat {
  chats?: { list?: TelegramChat[] }
}
