/**
 * ClaudeCodeIngestor — parses Claude Code's per-session JSONL transcripts.
 *
 * Claude Code stores conversations at:
 *   `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`
 *
 * Each line is one record produced during the session. We keep the user/assistant text
 * turns and drop everything else (tool calls/results, file snapshots, sidechain subagent
 * conversations). Identity maps cleanly to mementos:
 *
 *   - **`chronicleId`** = the file's basename (without `.jsonl`). Claude Code uses a UUID
 *     v4 for each session, so this is chronicle-id-shaped without massaging.
 *   - **`mementoId`** = each record's `uuid` field. Stable across re-runs.
 *   - **`parentMementoId`** = each record's `parentUuid`. Encodes branching (re-rolls,
 *     edits) — exposed so the vault can later annotate forks via `parent_memento_id`.
 *   - **`createdAt`** = each record's `timestamp`. Per-turn timestamps survive into
 *     date-range retrieval.
 *
 * Skips:
 *   - `isSidechain === true` (subagent conversations — background noise)
 *   - `type !== 'user' && type !== 'assistant'` (snapshots, attachments, etc.)
 *   - text-less content (a turn that's pure `tool_use` / `tool_result` carries nothing
 *     we'd want to remember verbatim)
 *
 * Output: one `IngestSession` per file (or zero, if every record was filtered out).
 */
import { basename, extname } from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Ingestor, IngestSession, IngestorFactory } from '../interface.js'
import type { IngestorImplementationModule } from '../registry.js'
import { joinTextBlocks } from '../_utils/extract-text.js'
import { roleLine } from '../_utils/turn-line.js'
import { buildSession } from '../_utils/session.js'
import { readJsonlRecords } from '../_utils/jsonl.js'
import { pathContains } from '../_utils/detect.js'
import { isValidId } from '../../core/vault/constants.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'claude-code'
export const create: IngestorFactory = () => new ClaudeCodeIngestor()
const _shape: IngestorImplementationModule = { type, create }

class ClaudeCodeIngestor implements Ingestor {
  readonly name = 'Claude Code'
  readonly defaultPath = join(homedir(), '.claude', 'projects')

  detects(filePath: string): boolean {
    // Extension match is the cheap filter. We also require the file to live under a
    // `.claude/projects/` segment so a stray .jsonl elsewhere isn't claimed by this
    // ingestor — Cursor / Aider / others can add their own ingestor without collision.
    if (extname(filePath).toLowerCase() !== '.jsonl') return false
    return pathContains(filePath, '/.claude/projects/')
  }

  async parse(filePath: string): Promise<IngestSession[]> {
    const chronicleId = basename(filePath).replace(/\.jsonl$/, '')
    if (!isValidId(chronicleId)) {
      // Skip files that don't follow Claude Code's "<session-uuid>.jsonl" naming.
      // Could be a hand-renamed copy, partial download, etc. The vault's ingest would
      // reject the chronicleId downstream anyway; bail early with empty output so the
      // CLI logs "skip" instead of "error".
      return []
    }

    const entries = await readJsonlRecords<ClaudeCodeEntry>(filePath)

    const mementos: IngestSession['mementos'] = []
    for (const entry of entries) {
      if (entry.isSidechain) continue
      if (entry.type !== 'user' && entry.type !== 'assistant') continue
      if (!isValidId(entry.uuid)) continue

      const text = joinTextBlocks(entry.message?.content)
      if (!text) continue

      mementos.push({
        mementoId: entry.uuid,
        parentMementoId: isValidId(entry.parentUuid) ? entry.parentUuid : undefined,
        text: roleLine(entry.type, text),
        createdAt: entry.timestamp,
      })
    }

    const session = buildSession(chronicleId, mementos, 'claude-code')
    return session ? [session] : []
  }
}

interface ClaudeCodeEntry {
  type?: string
  uuid?: string
  parentUuid?: string
  isSidechain?: boolean
  timestamp?: string
  message?: {
    role?: string
    content?: unknown
  }
}
