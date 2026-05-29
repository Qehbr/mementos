/**
 * OpenCodeIngestor — parses opencode's chat history out of its `opencode.db` SQLite DB.
 *
 * opencode keeps session data in a SQLite database (it migrated off the older
 * JSON-files layout):
 *   `~/.local/share/opencode/opencode.db`
 *
 * Three tables matter, each with a JSON `data` blob:
 *   - `session` — `{ id, title, time_created, … }`
 *   - `message` — `{ id, session_id, time_created, data }` where `data` is
 *     `{ role: "user"|"assistant", time, model, … }`
 *   - `part`    — `{ id, message_id, session_id, time_created, data }` where `data` is
 *     `{ type: "text"|"tool"|…, text? }` — a message's visible content is its `text` parts
 *
 * Each session becomes one `IngestSession`:
 *   - **`chronicleId`** = `opencode:<session id>` hashed to a stable UUID.
 *   - **`mementoId`** = `opencode:<message id>` hashed; the message id is unique.
 *   - **`createdAt`** = the message's `time_created` (epoch ms → ISO).
 *
 * The DB is opened read-only via Node's built-in `node:sqlite`, lazily imported inside
 * `parse()` so an older Node without it fails only this ingestor, not the whole CLI.
 */
import type { Ingestor, IngestSession, IngestorFactory } from '../interface.js'
import type { IngestorImplementationModule } from '../registry.js'
import { toUuid } from '../_utils/uuid.js'
import { fromEpochMs } from '../_utils/timestamp.js'
import { roleLine } from '../_utils/turn-line.js'
import { buildSession } from '../_utils/session.js'
import { acceptRole } from '../_utils/role.js'
import { isNamedFile } from '../_utils/detect.js'
import { withReadonlyDb } from '../_utils/sqlite.js'
import { tryParseJson } from '../_utils/json-file.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'opencode'
export const create: IngestorFactory = () => new OpenCodeIngestor()
const _shape: IngestorImplementationModule = { type, create }

class OpenCodeIngestor implements Ingestor {
  readonly name = 'opencode'

  detects(filePath: string): boolean {
    return isNamedFile(filePath, '.db', 'opencode.db')
  }

  async parse(filePath: string): Promise<IngestSession[]> {
    return withReadonlyDb(filePath, db => {
      const hasTables = ['session', 'message', 'part'].every(name =>
        db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name),
      )
      if (!hasTables) return [] // not an opencode DB (or schema changed) — nothing to ingest

      const sessionRows = db.prepare(`SELECT id FROM session`).all() as Array<{ id: string }>
      // Messages of a session, oldest first; parts of a message, in stored order.
      const messageStmt = db.prepare(
        `SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created, id`,
      )
      const partStmt = db.prepare(
        `SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id`,
      )

      const sessions: IngestSession[] = []
      for (const { id: sessionId } of sessionRows) {
        const session = parseSession(sessionId,
          messageStmt.all(sessionId) as unknown as MessageRow[],
          messageId => (partStmt.all(messageId) as Array<{ data: string }>).map(r => r.data))
        if (session) sessions.push(session)
      }
      return sessions
    })
  }
}

/** Assemble one session from its message rows + a per-message part-blob lookup. */
function parseSession(
  sessionId: string,
  messages: MessageRow[],
  partsOf: (messageId: string) => string[],
): IngestSession | undefined {
  const mementos: IngestSession['mementos'] = []

  for (const row of messages) {
    const info = tryParseJson<{ role?: unknown }>(row.data)
    if (!info) continue
    const role = acceptRole(info.role)
    if (!role) continue

    const text = extractText(partsOf(row.id))
    if (!text) continue

    mementos.push({
      mementoId: toUuid(`opencode:${row.id}`),
      text: roleLine(role, text),
      createdAt: fromEpochMs(row.time_created),
    })
  }

  return buildSession(toUuid(`opencode:${sessionId}`), mementos, 'opencode')
}

/** Join the `text`-type parts of a message; tool calls / step markers carry no prose. */
function extractText(partBlobs: string[]): string {
  const texts: string[] = []
  for (const blob of partBlobs) {
    const part = tryParseJson<{ type?: unknown; text?: unknown }>(blob)
    if (!part) continue
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      texts.push(part.text.trim())
    }
  }
  return texts.join('\n').trim()
}

interface MessageRow {
  id: string
  data: string
  time_created: number
}
