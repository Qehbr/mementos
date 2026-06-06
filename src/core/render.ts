/**
 * Presentation layer — renders the Vault's structured query results into the text an AI
 * client or the CLI displays.
 *
 * The Vault is the domain layer: its read methods return data (`RecallResult[]`, …), never
 * formatted strings. Everything that turns that data into human/AI-facing text lives here,
 * so retrieval logic and output formatting never entangle and a format change lands in one
 * place. Shared by `core/tools.ts` (the daemon's tool handlers) and the snapshot/session-start hooks.
 */
import type {
  RecallResult, MementoSummary, MementoDetail, ChronicleEntry,
  TagCount, ChronicleSummary, MementoIndexEntry, WriteOutcome, SearchResult,
} from './vault/types.js'
import type { SyncSummary } from './vault/index.js'
import { MIN_LITERAL_QUERY_CHARS } from './vault/constants.js'

/** Characters of a memento's text shown in a chronicle listing before it is truncated. */
const CHRONICLE_PREVIEW_CHARS = 200

/**
 * Header fragment for a memento's chronicle id (or empty when the memento isn't in one).
 * Shared by every renderer that emits a memento header so the format can't drift across
 * MCP recall / get_memento / get_recent_mementos / get_mementos_in_range / CLI list.
 */
const chronicleFragment = (id: string | undefined): string => id ? ` chronicle=${id}` : ''

/**
 * Render `recall` results as the `[MEMENTO …]` text block the AI reads. Each result shows
 * its best-matching chunk; a multi-chunk memento gets a `get_memento` hint for the rest.
 * An empty result list renders as the not-found message.
 */
export function renderRecall(results: RecallResult[]): string {
  if (results.length === 0) return 'No memories found.'
  return results
    .map(r => {
      const tagsStr = r.tags.length ? ` tags=${r.tags.join(',')}` : ''
      let line = `[MEMENTO id=${r.id}${chronicleFragment(r.chronicleId)}${tagsStr}]: "${r.text}"`
      if (r.chunkCount > 1) {
        line += `\n  (matched chunk ${r.chunkIndex + 1}/${r.chunkCount} — call get_memento("${r.id}") for the full text)`
      }
      return line
    })
    .join('\n')
}

/**
 * Render a memento list (`getRecentMementos`, `getMementosInRange`) as `[MEMENTO …]` lines,
 * each showing the memento's full text. An empty list renders as `emptyMessage` — the
 * caller supplies the wording, since "nothing recent" and "nothing in range" differ.
 */
export function renderMementoList(items: MementoSummary[], emptyMessage: string): string {
  if (items.length === 0) return emptyMessage
  return items
    .map(m => {
      const tagsStr = m.tags.length ? ` tags=${m.tags.join(',')}` : ''
      // `updated=` is the sort key for both producers — keep it visible on every row.
      return `[MEMENTO id=${m.id}${chronicleFragment(m.chronicleId)}${tagsStr} created=${m.createdAt} updated=${m.updatedAt}]: "${m.text}"`
    })
    .join('\n')
}

/**
 * Render one memento's full detail (`getMemento`) as the `[id=… ]` header line followed
 * by the complete joined text. `detail` is `null` when the id was not found — the `id`
 * argument carries it through so the not-found message can name the missing memento.
 */
export function renderMemento(detail: MementoDetail | null, id: string): string {
  if (!detail) return `Memory not found: ${id}`
  const parentStr = detail.parentMementoId ? ` parent=${detail.parentMementoId}` : ''
  const tagsStr = detail.tags.length ? ` [${detail.tags.join(', ')}]` : ''
  return `[id=${detail.id}${chronicleFragment(detail.chronicleId)}${parentStr}${tagsStr} ${detail.createdAt}]\n${detail.text}`
}

/**
 * Render a chronicle (`getChronicle`) as one `[MEMENTO …]` line per memento, each showing
 * a length-capped text preview; truncated rows carry a `get_memento` follow-up hint so the
 * AI knows to fetch the full text (same disclosure pattern as `renderRecall`'s long-memento
 * line). A fork point is annotated `(fork from …)` inline. An empty list renders as the
 * not-found message naming the chronicle.
 */
export function renderChronicle(entries: ChronicleEntry[], chronicleId: string): string {
  if (entries.length === 0) {
    return `No mementos found for chronicle ${chronicleId}.\n` +
      `  (id may be stale or wrong — call list_chronicles() to see available chronicles)`
  }
  return entries
    .map(e => {
      const truncated = e.text.length > CHRONICLE_PREVIEW_CHARS
      const preview = truncated ? e.text.slice(0, CHRONICLE_PREVIEW_CHARS) + '…' : e.text
      const forkStr = e.forkFrom ? ` (fork from ${e.forkFrom})` : ''
      let line = `[MEMENTO id=${e.id} created=${e.createdAt}${forkStr}]: "${preview}"`
      if (truncated) {
        line += `\n  (preview truncated — call get_memento("${e.id}") for the full text)`
      }
      return line
    })
    .join('\n')
}

/**
 * Render the tag list (`getTags`) as a comma-separated `tag (count)` string. An empty
 * list — no tags used anywhere — renders as the not-used message.
 */
export function renderTags(tags: TagCount[]): string {
  if (tags.length === 0) return 'No tags used yet.'
  return tags.map(t => `${t.tag} (${t.count})`).join(', ')
}

/**
 * Render the chronicle overview (`listChronicles`) as one line per chronicle. An empty
 * list — no chronicles in the vault — renders as the not-stored message.
 */
export function renderChronicleList(chronicles: ChronicleSummary[]): string {
  if (chronicles.length === 0) return 'No chronicles stored.'
  return chronicles
    .map(c => `chronicle=${c.chronicleId}  ${c.mementoCount} memento(s)  ${c.earliest}`)
    .join('\n')
}

/**
 * Render the `mementos list` CLI index — one metadata line per memento. An empty list
 * renders as `emptyMessage`: the caller distinguishes "vault empty" from "nothing matched
 * the tag filter", since the wording differs.
 */
export function renderMementoIndex(items: MementoIndexEntry[], emptyMessage: string): string {
  if (items.length === 0) return emptyMessage
  return items
    .map(m => {
      const tagsStr = m.tags.length ? ` [${m.tags.join(', ')}]` : ''
      const chunkStr = m.chunkCount > 1 ? ` (${m.chunkCount} chunks)` : ''
      return `id=${m.id}${tagsStr}${chunkStr}${chronicleFragment(m.chronicleId)}  ${m.createdAt}`
    })
    .join('\n')
}

/** The `<Verb> memento (id=…[, N chunks])` confirmation shared by write and update. */
function writeConfirmation(verb: string, o: WriteOutcome): string {
  const chunkPart = o.chunkCount > 1 ? `, ${o.chunkCount} chunks` : ''
  return `${verb} memento (id=${o.id}${chunkPart})`
}

/** Render a `writeMemento` outcome as its `Stored memento (…)` confirmation. */
export function renderWrite(outcome: WriteOutcome): string {
  return writeConfirmation('Stored', outcome)
}

/** Render an `updateMemento` outcome as its `Updated memento (…)` confirmation. */
export function renderUpdate(outcome: WriteOutcome): string {
  return writeConfirmation('Updated', outcome)
}

/**
 * The shared body of a sync outcome: `"N new, M updated, R removed"`, or `null` when nothing
 * changed. Both the emptiness check and the counts phrasing enumerate `SyncSummary`'s fields,
 * so both live here — each surface (CLI `sync`, MCP `sync` tool) wraps the result in its own
 * framing. A new `SyncSummary` field lands in one place, not two.
 */
export function formatSyncCounts(s: SyncSummary): string | null {
  if (s.added === 0 && s.updated === 0 && s.removed === 0) return null
  return `${s.added} new, ${s.updated} updated, ${s.removed} removed`
}

/** Collapse every run of whitespace in a snippet fragment to a single space. */
const collapseWhitespace = (s: string): string => s.replace(/\s+/g, ' ')

/**
 * Render a `search` result. Each non-`ok` status is its own fixed message; an `ok` result
 * is a count header plus up to `k` snippet lines (the counts stay exhaustive — `k` only
 * caps how many snippets are shown) and a follow-up hint.
 *
 * `opts.followUp` lets the CLI override the AI-facing default (`get_memento(...)` is the
 * MCP tool name) with the equivalent CLI command (`mementos get <id>`). The MCP path
 * accepts the default; the CLI path passes its own so the hint names a command that
 * actually exists on the terminal.
 */
export function renderSearch(result: SearchResult, k: number, opts?: { followUp?: string }): string {
  switch (result.status) {
    case 'empty-query':
      return 'Empty query.'
    case 'short-query':
      return `Query too short — a literal search needs at least ${MIN_LITERAL_QUERY_CHARS} characters. Use regex mode for a shorter pattern.`
    case 'bad-regex':
      return result.message
    case 'no-candidates':
      return 'No matches found (no mementos passed the tag/chronicle filter).'
    case 'no-matches':
      return 'No matches found.'
    case 'ok': {
      const { totalMatches, totalMementos, snippets } = result.outcome
      // Snippets already arrive most-recently-updated first — just take the first k.
      const shown = snippets.slice(0, k)
      const matchWord = totalMatches === 1 ? 'match' : 'matches'
      const memWord = totalMementos === 1 ? 'memento' : 'mementos'
      const truncated = totalMatches > shown.length
      const header = `Found ${totalMatches} ${matchWord} in ${totalMementos} ${memWord}` +
        (truncated ? `. Showing first ${shown.length}:` : ':')
      const body = shown
        .map((s, i) => `${i + 1}. [MEMENTO id=${s.mementoId}]: …` +
          `${collapseWhitespace(s.before)}«${collapseWhitespace(s.match)}»${collapseWhitespace(s.after)}…`)
        .join('\n')
      const followUp = opts?.followUp ?? 'Call get_memento("<id>") for a memento\'s full text.'
      return `${header}\n${body}\n\n${followUp}`
    }
  }
}
