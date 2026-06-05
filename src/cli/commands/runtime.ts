/**
 * Runtime subcommands — everything that operates on an already-initialised vault.
 *
 *   - `serve`         long-running MCP server (called by AI clients, not by hand)
 *   - `retrieve`      short-lived hook handler (called by Claude Code's UserPromptSubmit
 *                     hook when enabled — not a user-facing command)
 *   - `list/get/delete`  user-facing terminal commands for vault inspection
 */
import type { Vault } from '../../core/vault/index.js'
import { createMcpServer } from '../../core/mcp.js'
import { renderRecall, renderMemento, renderMementoIndex, renderSearch, formatSyncCounts } from '../../core/render.js'
import { buildVault, withVault } from '../_utils/vault.js'
import { parseFlag } from '../_utils/flags.js'
import { registerServe } from '../_utils/serve-registry.js'
import { logRetrieveFailure } from '../_utils/retrieve-log.js'
import { loadOutputAdapters } from '../../output-adapters/registry.js'
import { readMachineConfig } from '../../core/config.js'
import { DEFAULT_RECALL_K, DEFAULT_SEARCH_CONTEXT_CHARS } from '../../core/vault/constants.js'

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
    if (text) process.stdout.write(await formatRetrieval(`[MEMORY-INDEX]\n${text}`))
  } catch (e) {
    if (process.env['MEMENTOS_DEBUG']) await logRetrieveFailure(e)
  } finally {
    if (vault) await vault.close().catch(() => { /* fail-silent hook */ })
  }
}

/**
 * Hook entry point. Reads the user's message from stdin, runs one recall, writes results
 * to stdout. Exits silently on any error (debug log only with MEMENTOS_DEBUG) so a broken
 * hook can never interrupt the user's conversation.
 */
export async function runRetrieve(): Promise<void> {
  const query = extractQuery(await readStdin())
  if (!query) return

  let vault: Awaited<ReturnType<typeof buildVault>> | null = null
  try {
    vault = await buildVault()
    await vault.startup()
    const results = await vault.recall(query, DEFAULT_RECALL_K)
    if (results.length > 0) process.stdout.write(await formatRetrieval(renderRecall(results)))
  } catch (e) {
    if (process.env['MEMENTOS_DEBUG']) await logRetrieveFailure(e)
  } finally {
    // syncIfStale can dirty the cache via doSync's register/unregister even on a thrown
    // recall — without this flush every failed retrieve subprocess silently drifts.
    if (vault) await vault.close().catch(() => { /* fail-silent hook */ })
  }
}


export async function runList(subcommand: string | undefined, args: string[]): Promise<void> {
  await withVault(async vault => {
    const tags = [subcommand, ...args].filter(Boolean) as string[]
    const items = await vault.listMementos(tags.length > 0 ? tags : undefined)
    const emptyMessage = tags.length > 0 ? 'No memories match the given tags.' : 'No memories stored.'
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

// ─── retrieve helpers (private — only used by runRetrieve) ───────────────────

/**
 * Wrap hook output in whatever envelope the firing client expects. Adapter is
 * selected via `--output-adapter=<name>` and resolved through the auto-discovered
 * `src/output-adapters/` registry — client-specific envelope details live in each
 * adapter module, NOT here. `--hook-event=<event>` and any other `--hook-*` flag
 * flows through as `params` for adapters that need them. No adapter selected (or
 * an unknown one) = plain text + newline, the default Claude Code / Codex use.
 */
async function formatRetrieval(memories: string): Promise<string> {
  const adapterName = parseFlag('output-adapter')
  if (!adapterName) return memories + '\n'
  const registry = await loadOutputAdapters()
  const impl = registry.get(adapterName)
  if (!impl) return memories + '\n'  // unknown adapter → fail-soft to plain text
  return impl.create().wrap(memories, { event: parseFlag('hook-event') ?? '' })
}

function extractQuery(raw: string): string {
  try {
    const input = JSON.parse(raw) as Record<string, unknown>
    if (typeof input['message'] === 'string') return input['message']
    if (typeof input['prompt'] === 'string') return input['prompt']
    if (Array.isArray(input['messages'])) {
      const msgs = input['messages'] as Array<{ role?: string; content?: unknown }>
      const last = [...msgs].reverse().find(m => m.role === 'user')
      const c = last?.content
      return typeof c === 'string' ? c : ''
    }
  } catch { /* not JSON — use the raw text */ }
  return raw.trim()
}

const MAX_STDIN_CHARS = 1024 * 1024

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  return new Promise(resolve => {
    let data = ''
    let exceeded = false
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      if (exceeded) return
      if (data.length + chunk.length > MAX_STDIN_CHARS) {
        exceeded = true
        data = ''
        return
      }
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(''))
  })
}
