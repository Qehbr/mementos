/**
 * CursorIngestor — parses Cursor's chat history out of its `state.vscdb` SQLite database.
 *
 * Cursor (a VS Code fork) keeps global state in `state.vscdb` under its user directory:
 *   macOS    `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
 *   Linux    `~/.config/Cursor/User/globalStorage/state.vscdb`
 *   Windows  `%APPDATA%\Cursor\User\globalStorage\state.vscdb`
 *
 * Chat data lives in the `cursorDiskKV` key/value table (key TEXT, value TEXT-JSON):
 *   - `composerData:<composerId>` — a session: `{ name, createdAt, lastUpdatedAt,
 *     fullConversationHeadersOnly: [{ bubbleId, type }] }`. That array is the linear,
 *     ordered message list (Cursor has no fork/tree structure).
 *   - `bubbleId:<composerId>:<bubbleId>` — one message: `{ text, type }`, where
 *     `type` is 1 = user, 2 = assistant. Bubbles carry no per-message timestamp.
 *
 * Each composer becomes one `IngestSession`:
 *   - **`chronicleId`** = `cursor:<composerId>` hashed to a stable UUID.
 *   - **`mementoId`** = `cursor:<composerId>:<bubbleId>` hashed.
 *   - **`createdAt`** = the session's `createdAt` (epoch ms → ISO); bubbles have none.
 *
 * The DB is opened read-only via Node's built-in `node:sqlite`, lazily imported inside
 * `parse()` so an older Node without it fails only this ingestor, not the whole CLI.
 *
 * Unit-tested against a `state.vscdb` fixture built with the verified schema (Cursor is
 * a GUI with no headless transcript-generation path).
 */
import type { Ingestor, IngestSession, IngestorFactory } from '../interface.js'
import type { IngestorImplementationModule } from '../registry.js'
import { toUuid } from '../_utils/uuid.js'
import { roleLine } from '../_utils/turn-line.js'
import { fromEpochMs } from '../_utils/timestamp.js'
import { buildSession } from '../_utils/session.js'
import { isNamedFile } from '../_utils/detect.js'
import { withReadonlyDb } from '../_utils/sqlite.js'
import { tryParseJson } from '../_utils/json-file.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'cursor'
export const create: IngestorFactory = () => new CursorIngestor()
const _shape: IngestorImplementationModule = { type, create }

class CursorIngestor implements Ingestor {
  readonly name = 'Cursor'

  detects(filePath: string): boolean {
    // Cursor's global state DB is always `state.vscdb`. A non-Cursor VS Code DB of the
    // same name simply has no `cursorDiskKV` table — `parse()` then yields nothing.
    return isNamedFile(filePath, '.vscdb', 'state.vscdb')
  }

  async parse(filePath: string): Promise<IngestSession[]> {
    return withReadonlyDb(filePath, db => {
      // No `cursorDiskKV` table → not a Cursor DB (or no chats yet). Nothing to ingest.
      const hasTable = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'`,
      ).get()
      if (!hasTable) return []

      const composerRows = db.prepare(
        `SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%'`,
      ).all() as Array<{ value: string }>
      const bubbleStmt = db.prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)

      const sessions: IngestSession[] = []
      for (const row of composerRows) {
        const session = parseComposer(row.value, key => {
          const found = bubbleStmt.get(key) as { value: string } | undefined
          return found?.value
        })
        if (session) sessions.push(session)
      }
      return sessions
    })
  }
}

/**
 * Build one session from a `composerData` JSON value. `lookupBubble` resolves a
 * `bubbleId:<composerId>:<bubbleId>` key to its raw JSON value (or `undefined` if the
 * bubble row is absent — orphaned / partially-synced DBs happen).
 */
function parseComposer(
  rawComposer: string,
  lookupBubble: (key: string) => string | undefined,
): IngestSession | undefined {
  const composer = tryParseJson<CursorComposer>(rawComposer)
  if (!composer) return undefined
  const composerId = composer.composerId
  if (typeof composerId !== 'string' || !composerId) return undefined
  const headers = Array.isArray(composer.fullConversationHeadersOnly)
    ? composer.fullConversationHeadersOnly
    : []

  const mementos: IngestSession['mementos'] = []
  for (const header of headers) {
    if (!header || typeof header.bubbleId !== 'string') continue
    const raw = lookupBubble(`bubbleId:${composerId}:${header.bubbleId}`)
    if (!raw) continue
    const bubble = tryParseJson<CursorBubble>(raw)
    if (!bubble) continue
    const text = typeof bubble.text === 'string' ? bubble.text.trim() : ''
    if (!text) continue
    // `type` 1 = user, 2 = assistant — prefer the bubble's own, fall back to the header's.
    const role = (bubble.type ?? header.type) === 2 ? 'assistant' : 'user'

    mementos.push({
      mementoId: toUuid(`cursor:${composerId}:${header.bubbleId}`),
      text: roleLine(role, text),
    })
  }

  return buildSession(toUuid(`cursor:${composerId}`), mementos, 'cursor', fromEpochMs(composer.createdAt))
}

interface CursorComposer {
  composerId?: string
  name?: string
  createdAt?: number
  fullConversationHeadersOnly?: Array<{ bubbleId?: string; type?: number }>
}
interface CursorBubble {
  text?: string
  type?: number
}
