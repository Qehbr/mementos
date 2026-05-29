/**
 * OpenClawIngestor — parses OpenClaw's per-session JSONL transcripts.
 *
 * OpenClaw stores conversations at:
 *   `<state>/agents/<agentId>/sessions/<sessionId>.jsonl`
 * where `<state>` is `~/.openclaw` (or `$OPENCLAW_STATE_DIR`).
 *
 * Each line is one transcript record. OpenClaw's own predicates (mirrored here from its
 * bundle) classify them:
 *   - `type === 'session'` — a session-metadata header line. Skipped.
 *   - `type === 'compaction'` — a compaction marker, carries no `message`. Skipped.
 *   - everything else with a `message` object — a conversation turn.
 *
 * We keep `user` / `assistant` turns and drop `toolResult` (and any tool-call-only turn
 * with no text). Identity maps to mementos like this:
 *
 *   - **`chronicleId`** = the file basename. OpenClaw's id is not necessarily a UUID, so it
 *     is hashed into a stable UUID via `toUuid()` (the vault requires UUID-shaped ids).
 *   - **`mementoId`** = each record's `id`, hashed the same way. Stable across re-runs, so
 *     re-ingesting a growing transcript is idempotent.
 *   - **`parentMementoId`** = each record's `parentId`, hashed with the SAME function — so
 *     a child's `parentMementoId` equals its parent's `mementoId` and fork structure is
 *     preserved.
 *   - **`createdAt`** = each record's `timestamp` (ISO string, or epoch ms → ISO).
 *
 * Output: one `IngestSession` per file (or zero, if every record was filtered out).
 */
import { basename, extname, join } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'
import type { Ingestor, IngestSession, IngestorFactory } from '../interface.js'
import type { IngestorImplementationModule } from '../registry.js'
import { toUuid } from '../_utils/uuid.js'
import { fromIso, fromEpochMs } from '../_utils/timestamp.js'
import { joinTextBlocks } from '../_utils/extract-text.js'
import { roleLine } from '../_utils/turn-line.js'
import { buildSession } from '../_utils/session.js'
import { readJsonlRecords } from '../_utils/jsonl.js'
import { pathContains } from '../_utils/detect.js'
import { acceptRole } from '../_utils/role.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'openclaw'
export const create: IngestorFactory = () => new OpenClawIngestor()
const _shape: IngestorImplementationModule = { type, create }

/** OpenClaw's per-user state directory; overridable via `$OPENCLAW_STATE_DIR`. */
function stateDir(): string {
  return process.env['OPENCLAW_STATE_DIR'] ?? join(homedir(), '.openclaw')
}

class OpenClawIngestor implements Ingestor {
  readonly name = 'OpenClaw'
  readonly defaultPath = join(stateDir(), 'agents')

  detects(filePath: string): boolean {
    // Require the OpenClaw transcript path shape (`…/agents/<id>/sessions/<file>.jsonl`)
    // so a stray .jsonl isn't claimed; the sibling `<sid>.trajectory.jsonl` runtime-trace
    // file has a different schema and is skipped.
    if (extname(filePath).toLowerCase() !== '.jsonl') return false
    if (basename(filePath).toLowerCase().endsWith('.trajectory.jsonl')) return false
    return pathContains(filePath, '/agents/') && pathContains(filePath, '/sessions/')
  }

  async parse(filePath: string): Promise<IngestSession[]> {
    const chronicleId = toUuid(basename(filePath).replace(/\.jsonl$/, ''))

    const records = await readJsonlRecords<OpenClawRecord>(filePath)

    const mementos: IngestSession['mementos'] = []
    for (const [i, record] of records.entries()) {
      // Session header / compaction marker — no conversation turn to keep.
      if (record.type === 'session' || record.type === 'compaction') continue
      if (!record.message || typeof record.message !== 'object') continue

      const role = acceptRole(record.message.role)
      if (!role) continue

      const text = extractText(record.message)
      if (!text) continue

      const mementoId = typeof record.id === 'string' && record.id
        ? toUuid(record.id)
        : toUuid(`${chronicleId}:${i}`)
      const parentMementoId = typeof record.parentId === 'string' && record.parentId
        ? toUuid(record.parentId)
        : undefined

      mementos.push({
        mementoId,
        parentMementoId,
        text: roleLine(role, text),
        // OpenClaw writes either an ISO string or epoch ms; try both.
        createdAt: fromIso(record.timestamp) ?? fromEpochMs(record.timestamp),
      })
    }

    const session = buildSession(chronicleId, mementos, 'openclaw')
    return session ? [session] : []
  }
}

/** OpenClaw carries text either directly on `message.text` or in the content union. */
function extractText(message: OpenClawMessage): string {
  if (typeof message.text === 'string') return message.text.trim()
  return joinTextBlocks(message.content)
}

interface OpenClawMessage {
  role?: unknown
  text?: unknown
  content?: unknown
}
interface OpenClawRecord {
  type?: string
  id?: string
  parentId?: string
  timestamp?: unknown
  message?: OpenClawMessage
}
