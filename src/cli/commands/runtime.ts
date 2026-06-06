/**
 * CLI vault commands — every one is a thin MCP HTTP client of the daemon. The
 * CLI never builds its own vault; the daemon owns the single in-memory copy.
 *
 * Each handler:
 *   1. Parses CLI flags (positional + `--foo=bar`) into MCP tool arguments
 *   2. Calls `callTool(name, args)` against the running daemon
 *   3. Prints the rendered text or surfaces a clear error
 *   4. Refuses (exit 1) with "Run `mementos start` first" when no daemon
 *
 * The strict no-auto-start posture is deliberate: CLI commands are user-typed,
 * so a clean error pointing at `mementos start` is more honest than silently
 * spawning a daemon they didn't ask for. (Hooks and the `mementos mcp` shim
 * auto-start — they run automatically and can't ask the user.)
 *
 * Tool-name → CLI-command map mirrors `src/core/mcp.ts`:
 *
 *   recall       → recall, write_memento → write, update_memento → update,
 *   get_tags     → tags, get_memento → get, delete_memento → delete,
 *   get_chronicle → chronicle, list_chronicles → chronicles,
 *   get_memory_index / update_memory_index → index (read vs. update),
 *   list_mementos → list, search → search, sync → sync
 *
 * Hook entry points (`session-start`, `snapshot`) stay vault-aware for now
 * — Phase 4 will refactor them to auto-start the daemon then proxy.
 */
import { parseFlag } from '../_utils/flags.js'
import { readMachineConfig } from '../../core/config.js'
import { logRetrieveFailure } from '../_utils/retrieve-log.js'
import { callTool, DaemonUnavailableError } from '../../daemon/api-client.js'
import { ensureDaemonRunning } from './daemon.js'
import { DEFAULT_RECALL_K, DEFAULT_RECENT_LIMIT, DEFAULT_SEARCH_CONTEXT_CHARS, MAX_RECALL_K, MAX_RECENT_LIMIT } from '../../core/vault/constants.js'

/**
 * SessionStart hook entry point. Auto-starts the daemon if needed (hooks fire
 * before the LLM speaks — no user to nudge), then prints the curated
 * memory-index memento under a `[MEMORY-INDEX]` prelude. The daemon's
 * `get_memory_index` tool returns either the index text or a brief
 * "no index yet — call update_memory_index" placeholder; we surface either
 * one verbatim under the prelude so the AI sees the situation.
 *
 * Fail-silent on errors (broken hook must not block the user's chat). Debug
 * logging gated on `MEMENTOS_DEBUG`.
 */
export async function runSessionStart(): Promise<void> {
  try {
    await ensureDaemonRunning()
    const text = await callTool('get_memory_index', {})
    if (text) process.stdout.write(`[MEMORY-INDEX]\n${text}\n`)
  } catch (e) {
    if (process.env['MEMENTOS_DEBUG']) await logRetrieveFailure(e)
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse `--<flag>=a,b,c` into ['a','b','c'], or undefined if absent. */
function parseTagList(flag: string): string[] | undefined {
  const raw = parseFlag(flag)
  if (raw === undefined || raw === '') return undefined
  return raw.split(',').map(t => t.trim()).filter(Boolean)
}

/** Stdin text (non-TTY only), null otherwise. 1 MB cap. */
const MAX_STDIN_CHARS = 1024 * 1024
async function readStdinText(): Promise<string | null> {
  if (process.stdin.isTTY) return null
  return new Promise(resolve => {
    let data = ''
    let exceeded = false
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      if (exceeded) return
      if (data.length + chunk.length > MAX_STDIN_CHARS) { exceeded = true; data = ''; return }
      data += chunk
    })
    process.stdin.on('end', () => resolve(data.trim()))
    process.stdin.on('error', () => resolve(null))
  })
}

/** Concatenate the positional bits of `subcommand + args` into a string
 *  (whitespace-joined). Skips anything starting with `--`. */
function positionalArgs(subcommand: string | undefined, args: string[]): string {
  return [subcommand, ...args]
    .filter((a): a is string => !!a && !a.startsWith('-'))
    .join(' ')
}

/** Print + exit(1) when no daemon is up — single source of the message. */
function failNoDaemon(): never {
  console.error('No mementos daemon running. Start one with: mementos start')
  process.exit(1)
}

/**
 * Single wrapper around `callTool` that turns the MCP HTTP roundtrip into a
 * "print to stdout, exit 1 on daemon errors" CLI contract. Daemon error
 * messages (duplicate-memento warning, stale-write retry hint, not-found,
 * etc.) get printed verbatim with exit 1 — they're already actionable text
 * authored for AI/user consumption.
 */
async function callAndPrint(name: string, args: Record<string, unknown>): Promise<void> {
  try {
    const text = await callTool(name, args)
    if (text) console.log(text)
  } catch (e) {
    if (e instanceof DaemonUnavailableError) failNoDaemon()
    console.error((e as Error).message)
    process.exit(1)
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

/** `mementos recall <query> [--k=N] [--tags=a,b] [--exclude-tags=a,b] [--chronicle=id]` */
export async function runRecall(subcommand: string | undefined, args: string[]): Promise<void> {
  const query = positionalArgs(subcommand, args)
  if (!query) {
    console.error('Usage: mementos recall <query> [--k=N] [--tags=a,b] [--exclude-tags=a,b] [--chronicle=id]')
    process.exit(1)
  }
  await callAndPrint('recall', {
    query,
    k: Math.min(MAX_RECALL_K, Number(parseFlag('k')) || DEFAULT_RECALL_K),
    tags: parseTagList('tags'),
    exclude_tags: parseTagList('exclude-tags'),
    chronicle_id: parseFlag('chronicle'),
  })
}

/** `mementos write [<text>] [--tags=a,b]` — text via positional OR piped stdin. */
export async function runWrite(subcommand: string | undefined, args: string[]): Promise<void> {
  const fromStdin = await readStdinText()
  const text = (fromStdin && fromStdin.length > 0) ? fromStdin : positionalArgs(subcommand, args).trim()
  if (!text) {
    console.error('Usage: mementos write <text> [--tags=a,b]')
    console.error('       echo "text" | mementos write [--tags=a,b]')
    process.exit(1)
  }
  await callAndPrint('write_memento', { text, tags: parseTagList('tags') })
}

/** `mementos update <id> [<text>] [--tags=a,b]` — text via positional OR piped stdin. */
export async function runUpdate(subcommand: string | undefined, args: string[]): Promise<void> {
  const id = subcommand
  if (!id) {
    console.error('Usage: mementos update <id> <text> [--tags=a,b]')
    console.error('       echo "text" | mementos update <id> [--tags=a,b]')
    process.exit(1)
  }
  const fromStdin = await readStdinText()
  const positional = args.filter(a => !a.startsWith('-')).join(' ').trim()
  const text = (fromStdin && fromStdin.length > 0) ? fromStdin : positional
  if (!text) {
    console.error('Usage: mementos update <id> <text> [--tags=a,b]')
    process.exit(1)
  }
  await callAndPrint('update_memento', { memento_id: id, text, tags: parseTagList('tags') })
}

/** `mementos tags` — list every tag with its usage count. */
export async function runTags(): Promise<void> {
  await callAndPrint('get_tags', {})
}

/** `mementos chronicle <id>` — read a whole chronicle in order. */
export async function runChronicle(id: string | undefined): Promise<void> {
  if (!id) { console.error('Usage: mementos chronicle <chronicle-id>'); process.exit(1) }
  await callAndPrint('get_chronicle', { chronicle_id: id })
}

/** `mementos chronicles` — list every chronicle with memento count + start time. */
export async function runChronicles(): Promise<void> {
  await callAndPrint('list_chronicles', {})
}

/** `mementos index [<text>]` — read the curated index memento, or replace it
 *  when a positional arg or piped stdin is provided. */
export async function runIndex(subcommand: string | undefined, args: string[]): Promise<void> {
  const fromStdin = await readStdinText()
  const text = (fromStdin && fromStdin.length > 0) ? fromStdin : positionalArgs(subcommand, args).trim()
  if (text) {
    await callAndPrint('update_memory_index', { text })
    return
  }
  await callAndPrint('get_memory_index', {})
}

/**
 * `mementos list [tag1 tag2 ...] [--tags=a,b] [--start=...] [--end=...] [--query=...] [--k=N]`
 *
 * Range/query mode (any of `--start`/`--end`/`--query`/`--k`) maps to the MCP
 * `list_mementos` tool, with tag-mode (positional args or `--tags=`) routing
 * to the same tool via the `tags` arg the daemon now honors.
 */
export async function runList(subcommand: string | undefined, args: string[]): Promise<void> {
  // Every filter stacks at the daemon. Collect what's set and forward — the
  // MCP `list_mementos` tool composes date + query + tags into one filter.
  const tagsFromFlag = parseTagList('tags')
  const tagsFromPositional = [subcommand, ...args].filter((a): a is string => !!a && !a.startsWith('-'))
  const tags = tagsFromFlag ?? (tagsFromPositional.length > 0 ? tagsFromPositional : undefined)
  const kFlag = parseFlag('k')
  await callAndPrint('list_mementos', {
    start: parseFlag('start'),
    end: parseFlag('end'),
    query: parseFlag('query'),
    tags,
    k: Math.min(MAX_RECENT_LIMIT, Number(kFlag) || DEFAULT_RECENT_LIMIT),
  })
}

/**
 * `mementos get <id>` — print the full text of one memento.
 */
export async function runGet(id: string | undefined): Promise<void> {
  if (!id) { console.error('Usage: mementos get <id>'); process.exit(1) }
  await callAndPrint('get_memento', { memento_id: id })
}

/** `mementos delete <id>` — delete one memento. */
export async function runDelete(id: string | undefined): Promise<void> {
  if (!id) { console.error('Usage: mementos delete <id>'); process.exit(1) }
  await callAndPrint('delete_memento', { memento_id: id })
}

/** `mementos sync` — pull the latest memories from storage now. */
export async function runSync(): Promise<void> {
  await callAndPrint('sync', {})
}

/**
 * `mementos search <query>` — exact lexical search.
 *
 * Local short-circuit on `searcher = none` for a friendlier error than the
 * "unknown tool" the daemon would otherwise return (we register the `search`
 * tool only when a searcher is configured).
 */
export async function runSearch(subcommand: string | undefined, args: string[]): Promise<void> {
  const query = positionalArgs(subcommand, args)
  if (!query) {
    console.error('Usage: mementos search <query> [--regex] [--k=N] [--context=N] [--case-sensitive]')
    process.exit(1)
  }
  const machine = await readMachineConfig().catch(() => null)
  if (machine && machine.searcher === 'none') {
    console.error('Deep search is disabled on this machine (searcher = none).')
    console.error('Enable it with:  mementos init --reinit --searcher=scan')
    process.exit(1)
  }
  await callAndPrint('search', {
    query,
    k: Number(parseFlag('k')) || DEFAULT_RECALL_K,
    context_chars: Number(parseFlag('context')) || DEFAULT_SEARCH_CONTEXT_CHARS,
    regex: parseFlag('regex') !== undefined,
    ignore_case: parseFlag('case-sensitive') === undefined,
  })
}
