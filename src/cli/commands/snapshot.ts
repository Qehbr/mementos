/**
 * `mementos snapshot` — PreCompact hook entrypoint. Reads the hook payload
 * from stdin, parses the named transcript via the matching Ingestor, then
 * forwards every session to the running daemon as one
 * `POST /api/hooks/ingest_chronicle` call. The daemon does the actual
 * `vault.ingest(...)` — no own vault built here.
 *
 * Auto-starts the daemon if it isn't running (hooks fire automatically; can't
 * ask the LLM to do it). Quiet by default: the AI client logs hook stdout
 * into the transcript itself, so noise here pollutes the user's conversation.
 */
import { loadIngestors } from '../../ingestors/registry.js'
import { findIngestor } from '../../ingestors/_utils/dispatch.js'
import { ensureDaemonRunning } from './daemon.js'
import { ingestChronicle, DaemonUnavailableError } from '../../daemon/api-client.js'

interface PreCompactPayload {
  /** Path to the current session's JSONL transcript. AI client provides this. */
  transcript_path?: string
  /** Free-form fields we don't use today. */
  [k: string]: unknown
}

export async function runSnapshot(payload?: PreCompactPayload): Promise<void> {
  // Fail-soft posture throughout — see the longer comment below the
  // ingestor-discovery block. Every failure path here logs only under
  // MEMENTOS_DEBUG and returns 0, same as runSessionStart.
  if (!payload) {
    try { payload = await readStdinJson() }
    catch (e) {
      if (process.env['MEMENTOS_DEBUG']) {
        console.error(`mementos snapshot: ${(e as Error).message}`)
      }
      return
    }
  }
  const transcriptPath = payload.transcript_path
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    if (process.env['MEMENTOS_DEBUG']) {
      console.error('mementos snapshot: stdin payload is missing or has a non-string `transcript_path`.')
    }
    return
  }

  // Parse the transcript locally — the ingestor knows the file format. The
  // result is a list of structured sessions (each = one chronicle), each
  // ready to ship to the daemon as-is.
  const ingestorReg = await loadIngestors()
  const ingestors = [...ingestorReg.values()].map(impl => impl.create())
  const ingestor = await findIngestor(transcriptPath, ingestors)
  if (!ingestor) {
    if (process.env['MEMENTOS_DEBUG']) {
      console.error(`mementos snapshot: no ingestor claims ${transcriptPath}. Skipping.`)
    }
    return
  }

  // Fail-soft from here on, same posture as runSessionStart in runtime.ts.
  // Snapshot is a hook the AI client invokes around PreCompact; an error
  // bubbling out as a non-zero exit code (or stderr the client surfaces)
  // would interrupt the user's conversation for an op that's strictly a
  // background convenience — the next snapshot fires anyway and the user
  // can always re-run `mementos ingest <path>` interactively to see the
  // real error. Debug logging gated on MEMENTOS_DEBUG.
  let sessions
  try {
    sessions = await ingestor.parse(transcriptPath)
  } catch (e) {
    if (process.env['MEMENTOS_DEBUG']) {
      console.error(`mementos snapshot: failed to parse ${transcriptPath}: ${(e as Error).message}`)
    }
    return
  }
  if (sessions.length === 0) return // tool-use-only sessions ingest nothing; stay quiet

  try {
    await ensureDaemonRunning()
  } catch (e) {
    if (process.env['MEMENTOS_DEBUG']) {
      console.error(`mementos snapshot: daemon not available: ${(e as Error).message}`)
    }
    return
  }

  let added = 0
  let skipped = 0
  for (const s of sessions) {
    try {
      const r = await ingestChronicle({
        chronicle_id: s.chronicleId,
        mementos: s.mementos,
        tags: s.tags,
        createdAt: s.createdAt,
      })
      added += r.added
      skipped += r.skipped
    } catch (e) {
      if (process.env['MEMENTOS_DEBUG']) {
        console.error(`mementos snapshot: ingest failed for chronicle ${s.chronicleId}: ${(e as Error).message}`)
      }
      // Daemon went away mid-batch — stop trying; remaining chronicles will
      // get picked up on the next snapshot. Any other error: skip this one,
      // continue with the rest.
      if (e instanceof DaemonUnavailableError) break
    }
  }
  if (added > 0) console.log(`mementos snapshot: +${added} new memento(s), ${skipped} already present`)
}

/** Read all of stdin into a string, then JSON.parse. Bare object expected. */
async function readStdinJson(): Promise<PreCompactPayload> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(typeof c === 'string' ? Buffer.from(c) : c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as PreCompactPayload
    throw new Error('stdin payload must be a JSON object')
  } catch (e) {
    throw new Error(`failed to parse stdin as JSON: ${(e as Error).message}`)
  }
}
