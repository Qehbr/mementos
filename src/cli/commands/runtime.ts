/**
 * Runtime subcommands — everything that operates on an already-initialised vault.
 *
 * Two surfaces use these:
 *   1. AI clients via MCP (`serve` runs the stdio server).
 *   2. AI clients OR users via CLI (`recall`/`write`/`update`/...).
 *
 * The CLI commands deliberately mirror the MCP tool names so a user with a
 * shell-capable AI client (Claude Code, Codex, etc.) can opt out of MCP and
 * still get the full operation set.
 *
 * Special hook entry points:
 *   - `serve`         long-running MCP server (called by AI clients, not by hand)
 *   - `session-start` short-lived hook handler — emits the curated index memento
 *                     as a prelude at conversation start
 */
import type { Vault } from '../../core/vault/index.js'
import { createMcpServer } from '../../core/mcp.js'
import {
  renderMemento, renderMementoIndex, renderMementoList, renderSearch,
  renderRecall, renderTags, renderChronicle, renderChronicleList,
  renderWrite, renderUpdate, formatSyncCounts,
} from '../../core/render.js'
import { buildVault, withVault } from '../_utils/vault.js'
import { parseFlag } from '../_utils/flags.js'
import { registerServe } from '../_utils/serve-registry.js'
import { logRetrieveFailure } from '../_utils/retrieve-log.js'
import { readMachineConfig } from '../../core/config.js'
import {
  DEFAULT_RECALL_K, DEFAULT_RECENT_LIMIT, DEFAULT_SEARCH_CONTEXT_CHARS,
  MAX_RECALL_K, MAX_RECENT_LIMIT,
} from '../../core/vault/constants.js'
import { StaleMementoError, DuplicateMementoError, ReservedIndexTagError } from '../../core/vault/index.js'

export async function runServe(): Promise<void> {
  const vault = await buildVault()
  // Rejection handler before startup so model load / native binding init / MCP SDK import
  // failures are caught; shutdown handlers after, so a failed startup exits via its own path.
  installCrashTolerantRejectionHandler()

  await vault.startup().catch((e: Error) => {
    console.error(e.message)
    process.exit(1)
  })

  // Marks this process so `mementos migrate` refuses while it's alive.
  await registerServe()
  installShutdownHandlers(vault)

  const machine = await readMachineConfig()
  const searchEnabled = machine.searcher !== 'none'

  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
  const server = createMcpServer(vault, { searchEnabled })
  await server.connect(new StdioServerTransport())
}

function installCrashTolerantRejectionHandler(): void {
  // Replace cli/index.ts's process-wide exit(1) handler — a stray rejection from a peer
  // dep must not kill an open MCP session.
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    console.error(`mementos serve: unhandled rejection (continuing): ${err.message}`)
    if (process.env['MEMENTOS_DEBUG']) console.error(err.stack)
  })
}

function installShutdownHandlers(vault: Vault): void {
  // Flag (not `once`) so a repeat signal during vault.close() is absorbed — `once`
  // self-unregisters and lets Node's default handler terminate mid-flush.
  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    void vault.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  // SIGHUP: Node's default is termination, so we need an explicit handler to flush.
  process.on('SIGHUP', shutdown)
}

/**
 * Hook entry point for SessionStart. Seeds the `_index` memento if missing,
 * then emits its body as a `[MEMORY-INDEX]` prelude — once per conversation,
 * not per user message. Auto-retrieve handles the per-message recall path.
 *
 * Quiet on error (same fail-silent policy as `runRetrieve`): a broken hook
 * must not block the user's chat. Debug log is gated on MEMENTOS_DEBUG.
 */
export async function runSessionStart(): Promise<void> {
  let vault: Awaited<ReturnType<typeof buildVault>> | null = null
  try {
    vault = await buildVault()
    await vault.startup()
    await vault.seedIndexIfMissing()
    const text = await vault.getIndexText()
    if (text) process.stdout.write(`[MEMORY-INDEX]\n${text}\n`)
  } catch (e) {
    if (process.env['MEMENTOS_DEBUG']) await logRetrieveFailure(e)
  } finally {
    if (vault) await vault.close().catch(() => { /* fail-silent hook */ })
  }
}



/**
 * `mementos list [tag1 tag2 ...] [--tags=a,b] [--start=...] [--end=...] [--query=...] [--k=N]`
 *
 * Two modes, picked automatically:
 *   - **Range/query mode**: any of `--start`/`--end`/`--query`/`--k` present.
 *     Mirrors the MCP `list_mementos` tool — date-bounded recency or semantic ranking.
 *   - **Tag mode** (back-compat): positional args OR `--tags=...` filter by tag.
 *     Same shape as `mementos list` before this CLI got parity with MCP.
 */
export async function runList(subcommand: string | undefined, args: string[]): Promise<void> {
  const start = parseFlag('start')
  const end = parseFlag('end')
  const query = parseFlag('query')
  const kFlag = parseFlag('k')
  const rangeMode = start !== undefined || end !== undefined || query !== undefined || kFlag !== undefined

  await withVault(async vault => {
    if (rangeMode) {
      const k = Math.min(MAX_RECENT_LIMIT, Number(kFlag) || DEFAULT_RECENT_LIMIT)
      const items = await vault.getMementosInRange(start, end, query, k)
      const emptyMsg = start || end ? 'No mementos found in that date range.' : 'No memories stored.'
      console.log(renderMementoList(items, emptyMsg))
      return
    }
    const tagsFromFlag = parseTagList('tags')
    const tagsFromPositional = [subcommand, ...args].filter((a): a is string => !!a && !a.startsWith('-'))
    const tags = tagsFromFlag ?? (tagsFromPositional.length > 0 ? tagsFromPositional : undefined)
    const items = await vault.listMementos(tags)
    const emptyMessage = tags ? 'No memories match the given tags.' : 'No memories stored.'
    console.log(renderMementoIndex(items, emptyMessage))
  })
}

/**
 * Catch the two vault errors that name a memento id the user couldn't otherwise discover
 * (`Invalid id:` and `Memory not found:`) and append a pointer to `mementos list`. CLI-only —
 * the MCP path got the id from a prior recall, so this hint would just be noise there.
 */
const LIST_HINT = '— run `mementos list` to see existing memento ids.'
async function withListHint<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn() }
  catch (e) {
    if (e instanceof Error
      && (e.message.startsWith('Invalid id:') || e.message.startsWith('Memory not found:'))
      && !e.message.includes(LIST_HINT)) {
      throw new Error(`${e.message} ${LIST_HINT}`)
    }
    throw e
  }
}

export async function runGet(id: string | undefined): Promise<void> {
  if (!id) { console.error('Usage: mementos get <id>'); process.exit(1) }
  await withVault(async vault => {
    const detail = await withListHint(() => vault.getMemento(id))
    if (!detail) {
      console.error(`Memory not found: ${id} ${LIST_HINT}`)
      process.exitCode = 1
      return
    }
    console.log(renderMemento(detail, id))
  })
}

export async function runDelete(id: string | undefined): Promise<void> {
  if (!id) { console.error('Usage: mementos delete <id>'); process.exit(1) }
  await withVault(async vault => {
    await withListHint(() => vault.deleteMemento(id))
    console.log(`Deleted ${id}`)
  })
}

/**
 * `mementos sync` — pull the latest memories from storage now, instead of waiting for
 * the ~10-minute auto-sync. Useful right after pushing memories from another device.
 */
export async function runSync(): Promise<void> {
  await withVault(async vault => {
    const counts = formatSyncCounts(await vault.sync())
    console.log(counts === null ? 'Already up to date.' : `Synced: ${counts}.`)
  })
}

/**
 * `mementos search <query>` — exhaustive lexical search across all mementos. Literal
 * substring by default; `--regex` for a regular expression. Prints short snippets with
 * surrounding context, not whole mementos. Refuses with a hint if the searcher is `none`.
 *
 * Flags: `--regex`, `--k=N` (max snippets, default 5), `--context=N` (context chars per
 * side, default 48), `--case-sensitive` (matching is case-insensitive by default).
 */
export async function runSearch(subcommand: string | undefined, args: string[]): Promise<void> {
  const query = [subcommand, ...args]
    .filter((a): a is string => !!a && !a.startsWith('-'))
    .join(' ')
  if (!query) {
    console.error('Usage: mementos search <query> [--regex] [--k=N] [--context=N] [--case-sensitive]')
    process.exit(1)
  }

  // Short-circuit on `searcher = none` BEFORE building a vault. ENOENT means "not
  // initialised" — let buildVault throw its actionable message.
  const machine = await readMachineConfig().catch(() => null)
  if (machine && machine.searcher === 'none') {
    console.error('Deep search is disabled on this machine (searcher = none).')
    console.error('Enable it with:  mementos init --reinit --searcher=scan')
    process.exit(1)
  }

  await withVault(async vault => {
    const k = Number(parseFlag('k')) || DEFAULT_RECALL_K
    const contextChars = Number(parseFlag('context')) || DEFAULT_SEARCH_CONTEXT_CHARS
    const regex = parseFlag('regex') !== undefined
    const ignoreCase = parseFlag('case-sensitive') === undefined
    console.log(renderSearch(
      await vault.search(query, contextChars, regex, ignoreCase), k,
      // Override the MCP-default follow-up — get_memento is an MCP tool name, not a CLI cmd.
      { followUp: 'Run `mementos get <id>` for a memento\'s full text.' },
    ))
  })
}

// ─── CLI parity with MCP tools ────────────────────────────────────────────────
// Each handler mirrors one MCP tool from `src/core/mcp.ts` so users with
// shell-capable AI clients can call the same operations via shell instead of
// going through the stdio MCP server. The vault methods + render functions are
// shared; only the input-parsing and output-printing varies.

/** Parse `--<flag>=a,b,c` into ['a','b','c'], or undefined if absent. */
function parseTagList(flag: string): string[] | undefined {
  const raw = parseFlag(flag)
  if (raw === undefined || raw === '') return undefined
  return raw.split(',').map(t => t.trim()).filter(Boolean)
}

/** Read all of stdin (non-TTY only) and return the trimmed result, or null
 *  when stdin is a TTY (interactive shell). The 1 MB cap matches what the
 *  retired retrieve hook used — long enough for real memos, bounded enough to
 *  protect against accidental pastes. */
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

/** `mementos recall <query> [--k=N] [--tags=a,b] [--exclude-tags=a,b] [--chronicle=id]` */
export async function runRecall(subcommand: string | undefined, args: string[]): Promise<void> {
  const query = [subcommand, ...args].filter((a): a is string => !!a && !a.startsWith('-')).join(' ')
  if (!query) {
    console.error('Usage: mementos recall <query> [--k=N] [--tags=a,b] [--exclude-tags=a,b] [--chronicle=id]')
    process.exit(1)
  }
  await withVault(async vault => {
    const k = Math.min(MAX_RECALL_K, Number(parseFlag('k')) || DEFAULT_RECALL_K)
    const tags = parseTagList('tags')
    const excludeTags = parseTagList('exclude-tags')
    const chronicleId = parseFlag('chronicle')
    console.log(renderRecall(await vault.recall(query, k, chronicleId, tags, excludeTags)))
  })
}

/** `mementos write [<text>] [--tags=a,b]` — text via positional OR piped stdin. */
export async function runWrite(subcommand: string | undefined, args: string[]): Promise<void> {
  const fromStdin = await readStdinText()
  const positional = [subcommand, ...args].filter((a): a is string => !!a && !a.startsWith('-')).join(' ').trim()
  const text = fromStdin && fromStdin.length > 0 ? fromStdin : positional
  if (!text) {
    console.error('Usage: mementos write <text> [--tags=a,b]')
    console.error('       echo "text" | mementos write [--tags=a,b]')
    process.exit(1)
  }
  const tags = parseTagList('tags')
  await withVault(async vault => {
    try {
      console.log(renderWrite(await vault.writeMemento({ text, tags })))
    } catch (e) {
      // Surface the duplicate-warning text directly — same payload the MCP path returns.
      if (e instanceof DuplicateMementoError || e instanceof ReservedIndexTagError) {
        console.error(e.message)
        process.exitCode = 1
        return
      }
      throw e
    }
  })
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
  const text = fromStdin && fromStdin.length > 0 ? fromStdin : positional
  if (!text) {
    console.error('Usage: mementos update <id> <text> [--tags=a,b]')
    process.exit(1)
  }
  const tags = parseTagList('tags')
  await withVault(async vault => {
    try {
      console.log(renderUpdate(await vault.updateMemento(id, text, tags)))
    } catch (e) {
      if (e instanceof StaleMementoError) {
        console.error(e.message)
        process.exitCode = 1
        return
      }
      throw e
    }
  })
}

/** `mementos tags` — list every tag with its usage count. */
export async function runTags(): Promise<void> {
  await withVault(async vault => {
    console.log(renderTags(await vault.getTags()))
  })
}

/** `mementos chronicle <id>` — read a whole chronicle (conversation) in order. */
export async function runChronicle(id: string | undefined): Promise<void> {
  if (!id) { console.error('Usage: mementos chronicle <chronicle-id>'); process.exit(1) }
  await withVault(async vault => {
    console.log(renderChronicle(await vault.getChronicle(id), id))
  })
}

/** `mementos chronicles` — list every chronicle with its memento count + start time. */
export async function runChronicles(): Promise<void> {
  await withVault(async vault => {
    console.log(renderChronicleList(await vault.listChronicles()))
  })
}

/** `mementos index [<text>]` — read the curated memory-index memento, or
 *  replace its body when a positional arg or piped stdin is provided. */
export async function runIndex(subcommand: string | undefined, args: string[]): Promise<void> {
  const fromStdin = await readStdinText()
  const positional = [subcommand, ...args].filter((a): a is string => !!a && !a.startsWith('-')).join(' ').trim()
  const text = fromStdin && fromStdin.length > 0 ? fromStdin : positional
  await withVault(async vault => {
    if (text) {
      console.log(renderUpdate(await vault.updateIndex(text)))
      return
    }
    const entry = await vault.getIndexEntry()
    if (entry) console.log(entry.text)
    else console.log('No memory index yet — run `mementos index "<text>"` (or pipe text in) to create one.')
  })
}

