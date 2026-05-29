/**
 * SlackExportIngestor — parses a Slack workspace data export.
 *
 * A Slack export (Workspace settings → Import/Export Data) is a ZIP that unzips to a
 * directory per channel / DM, each holding one `YYYY-MM-DD.json` file per active day, plus
 * top-level `channels.json` / `users.json` / `integration_logs.json`. Each day file is a
 * JSON array of message objects.
 *
 * The user unzips the export and points `mementos ingest` at the directory; the CLI walks
 * it and hands each day file here. We keep plain human messages — `type:"message"` with a
 * `user` and `text` and NO `subtype` — and drop the rest (bot posts, file-share / join /
 * topic system events). Identity maps to mementos like this:
 *
 *   - **`chronicleId`** = the channel — the day file's parent directory name — hashed to a
 *     stable UUID. Every day file of one channel ingests into the same chronicle.
 *   - **`mementoId`** = `channel:ts` hashed; `ts` is Slack's per-message id.
 *   - **`parentMementoId`** = `channel:thread_ts` hashed when the message is a threaded
 *     reply — so a reply links to its thread's root message.
 *   - **`createdAt`** = `ts` (epoch seconds → ISO).
 *
 * The export is a manual download (no Slack CLI). Unit-tested against captured day-file
 * fixtures.
 */
import { basename, dirname, extname } from 'node:path'
import type { Ingestor, IngestSession, IngestorFactory } from '../interface.js'
import type { IngestorImplementationModule } from '../registry.js'
import { toUuid } from '../_utils/uuid.js'
import { turnLine } from '../_utils/turn-line.js'
import { fromEpochSeconds } from '../_utils/timestamp.js'
import { readJsonFile } from '../_utils/json-file.js'
import { buildSession } from '../_utils/session.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'slack-export'
export const create: IngestorFactory = () => new SlackExportIngestor()
const _shape: IngestorImplementationModule = { type, create }

/** Slack names every day file `YYYY-MM-DD.json` — the discriminator vs channels/users.json. */
const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.json$/

class SlackExportIngestor implements Ingestor {
  readonly name = 'Slack export'

  detects(filePath: string): boolean {
    return extname(filePath).toLowerCase() === '.json' && DAY_FILE_RE.test(basename(filePath))
  }

  async parse(filePath: string): Promise<IngestSession[]> {
    // The channel is the day file's parent directory: `<export>/<channel>/<date>.json`.
    const channel = basename(dirname(filePath))

    const parsed = await readJsonFile<unknown>(filePath)
    if (!Array.isArray(parsed)) return []
    const messages = parsed as SlackMessage[]

    const mementos: IngestSession['mementos'] = []

    for (const msg of messages) {
      // Plain human turns only: a real `user`, real `text`, and no system/bot `subtype`.
      if (msg.type !== 'message' || msg.subtype) continue
      if (typeof msg.user !== 'string' || !msg.user) continue
      if (typeof msg.text !== 'string' || !msg.text.trim()) continue
      if (typeof msg.ts !== 'string' || !msg.ts) continue

      // Slack `ts` is `"<epoch-seconds>.<counter>"`; parseFloat keeps the fractional part.
      const ts = fromEpochSeconds(Number.parseFloat(msg.ts))

      // A threaded reply carries `thread_ts` = the root message's ts (≠ its own ts).
      const threadTs = typeof msg.thread_ts === 'string' && msg.thread_ts !== msg.ts
        ? msg.thread_ts
        : undefined

      mementos.push({
        mementoId: toUuid(`${channel}:${msg.ts}`),
        parentMementoId: threadTs ? toUuid(`${channel}:${threadTs}`) : undefined,
        text: turnLine(speakerName(msg), cleanText(msg.text)),
        createdAt: ts,
      })
    }

    const session = buildSession(toUuid(`slack:${channel}`), mementos, 'slack')
    return session ? [session] : []
  }
}

/**
 * A display name for the message's author. Modern exports embed a `user_profile`; fall
 * back to the bare user id when it's absent (older exports) so the line is still attributed.
 */
function speakerName(msg: SlackMessage): string {
  const p = msg.user_profile
  return p?.display_name?.trim() || p?.real_name?.trim() || p?.name?.trim() || msg.user || 'unknown'
}

/**
 * Lightly de-markup Slack text. Slack wraps links as `<url|label>` or `<url>`; we keep the
 * label (or the url). User/channel mentions (`<@U…>`, `<#C…>`) are left as-is — without
 * `users.json` in scope here there's no name to resolve them to, and the raw token is
 * still meaningful.
 */
function cleanText(text: string): string {
  return text
    .replace(/<([^>|]+)\|([^>]+)>/g, '$2') // <url|label> → label
    .replace(/<(https?:[^>|]+)>/g, '$1')   // <url> → url
    .trim()
}

interface SlackMessage {
  type?: string
  subtype?: string
  user?: string
  text?: string
  ts?: string
  thread_ts?: string
  user_profile?: { display_name?: string; real_name?: string; name?: string }
}
