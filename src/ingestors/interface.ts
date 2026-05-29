/**
 * Ingestor — abstracts a source-specific transcript / document parser for bulk import.
 *
 * The source-specific bits of `mementos ingest` and `mementos snapshot` (transcript parsing,
 * message-uuid extraction, fork detection) live behind this interface so the CLI / hook
 * plumbing is source-agnostic. Adding support for a new source is one file under
 * `src/ingestors/<name>/` — same auto-discovery pattern as the storage / embedder / vector /
 * retriever / key abstractions.
 *
 * An ingestor produces zero or more `IngestSession`s from a file. The CLI then calls
 * `vault.ingest(session.chronicleId, session.mementos, ...)` for each — that primitive
 * handles idempotency (re-runs skip mementos whose `mementoId` already exists), atomicity
 * (one commit per call), and internal chunking of long mementos.
 */

/**
 * One logical conversation worth of content. `chronicleId` becomes the `chronicle_id`
 * shared by every memento; `mementos` map 1:1 to `vault.ingest`'s per-memento input shape.
 */
export interface IngestSession {
  /**
   * Stable UUID v4 identifying this conversation. Must be the same across re-runs (the
   * ingestor derives it from the source — file basename for Claude Code, content hash for
   * sources without a native id, etc.). Used by `vault.ingest` as the `chronicle_id`.
   */
  chronicleId: string

  /** The conversation's mementos. Order matters — it is the conversation order. */
  mementos: Array<{
    /**
     * Stable UUID v4 identifying this memento — the ingestor's hash of the upstream's
     * per-item id (a message uuid, a section anchor). `vault.ingest` skips a memento whose
     * `mementoId` already exists, so re-ingest is idempotent and cross-device convergent.
     */
    mementoId: string
    /** The predecessor memento's id — set when the source tracks a tree (Claude Code). */
    parentMementoId?: string
    /** Plain text. Long text is chunked internally inside the one memento file. */
    text: string
    /** Optional per-memento timestamp (ISO 8601). Falls back to session-level / now. */
    createdAt?: string
  }>

  /** Tags applied to every memento written by this session's ingest. */
  tags?: string[]

  /** Fallback timestamp for mementos missing their own. ISO 8601. */
  createdAt?: string
}

/**
 * Source-specific parser. Each implementation lives at `src/ingestors/<name>/index.ts`
 * and exports `type` (string identifier) + `create()` (factory).
 */
export interface Ingestor {
  /** Human-readable name surfaced to the user during interactive ingest discovery. */
  readonly name: string

  /**
   * Where this source typically stores transcripts on this machine. Used by the
   * interactive `mementos ingest` flow to suggest the source as a discovery candidate.
   * Absent for ingestors that have no canonical default (raw markdown, etc.).
   */
  readonly defaultPath?: string

  /**
   * Does this ingestor handle the file at `filePath`? Fast check — typically extension
   * + optional content sniff (e.g. peek the first line). Used by the CLI to route a
   * single file to the right parser when multiple ingestors are registered.
   */
  detects(filePath: string): boolean | Promise<boolean>

  /**
   * Parse the file into zero or more sessions. One JSONL file = one session for Claude
   * Code; a markdown doc might be one session with one memento. Errors during parse
   * (malformed lines, unreadable file) propagate — the caller logs and continues.
   */
  parse(filePath: string): Promise<IngestSession[]>
}

/** Registry factory shape. */
export type IngestorFactory = () => Ingestor
