/**
 * `mementos snapshot` — Claude Code's PreCompact hook entrypoint. Reads the hook payload
 * from stdin, routes the named transcript through the matching Ingestor, and ingests it.
 * Quiet by default: Claude Code logs hook stdout into the transcript itself, so noise
 * here pollutes the user's conversation.
 */
import { buildVault } from '../_utils/vault.js'
import { loadIngestors } from '../../ingestors/registry.js'
import { findIngestor } from '../../ingestors/_utils/dispatch.js'

interface PreCompactPayload {
  /** Path to the current session's JSONL transcript. Claude Code provides this. */
  transcript_path?: string
  /** Free-form fields we don't use today. */
  [k: string]: unknown
}

export async function runSnapshot(payload?: PreCompactPayload): Promise<void> {
  payload = payload ?? await readStdinJson()
  const transcriptPath = payload.transcript_path
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    console.error('mementos snapshot: stdin payload is missing or has a non-string `transcript_path`.')
    process.exit(1)
  }

  const ingestorReg = await loadIngestors()
  const ingestors = [...ingestorReg.values()].map(impl => impl.create())
  const ingestor = await findIngestor(transcriptPath, ingestors)
  if (!ingestor) {
    console.error(`mementos snapshot: no ingestor claims ${transcriptPath}. Skipping.`)
    process.exit(0) // not an error worth failing the hook — just nothing to do
  }

  let sessions
  try {
    sessions = await ingestor.parse(transcriptPath)
  } catch (e) {
    console.error(`mementos snapshot: failed to parse ${transcriptPath}: ${(e as Error).message}`)
    process.exit(1)
  }
  if (sessions.length === 0) return // tool-use-only sessions ingest nothing; stay quiet

  const vault = await buildVault()
  await vault.startup()

  let added = 0
  let skipped = 0
  try {
    // Hold the write lock once across all sessions — see the comment on the
    // identical wrapper in `runIngest`; same in-process timer/long-write race
    // applies here when a session embeds a large batch.
    await vault.writeLock.run(async () => {
      for (const s of sessions) {
        try {
          const r = await vault.ingest(s.chronicleId, s.mementos, {
            tags: s.tags,
            createdAt: s.createdAt,
          })
          added += r.added
          skipped += r.skipped
        } catch (e) {
          // Don't exit-immediately on a per-chronicle failure: the finally below needs to
          // flush the cache for the 0..N-1 that succeeded, or every failed snapshot drifts
          // the cache one ingest behind.
          console.error(`mementos snapshot: ingest failed for chronicle ${s.chronicleId}: ${(e as Error).message}`)
          process.exitCode = 1
          break
        }
      }
    })
  } finally {
    await vault.close()
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
