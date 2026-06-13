/**
 * Tool registry — single source of truth for every operation the vault exposes.
 *
 * Three consumers:
 *   1. **The daemon** (`mementos start`) — registers one HTTP route per tool,
 *      `POST /api/tools/<name>`. Each route's handler is `TOOLS[name].handler`.
 *   2. **The MCP shim** (`mementos mcp`) — registers each tool with the MCP SDK
 *      so AI clients see them as MCP tools. The MCP handler is a thin wrapper
 *      that POSTs to the daemon's matching HTTP route.
 *   3. **CLI commands** (`mementos recall`, etc.) — POST directly to the
 *      daemon, by-name. They don't need the registry; they hardcode the tool
 *      name and let the daemon handle dispatch + validation.
 *
 * Tool definitions and their server-side implementations live together so
 * descriptions/schemas/annotations and the actual `vault.method(...)` call
 * stay in lockstep. The MCP shim sees only the "metadata" half (description
 * + inputSchema + annotations) — the `handler` runs only on the daemon side.
 *
 * **Vocabulary**:
 *   - a **memento** is one logical memory
 *   - a **chronicle** is a conversation (a set of mementos sharing a `chronicle_id`)
 */
import { z } from 'zod'
import { StaleMementoError, DuplicateMementoError, ReservedIndexTagError, type Vault } from './vault/index.js'
import {
  DEFAULT_RECALL_K, DEFAULT_RECENT_LIMIT, DEFAULT_SEARCH_CONTEXT_CHARS,
  MIN_LITERAL_QUERY_CHARS, SEARCH_MAX_SNIPPETS,
  MAX_RECALL_K, MAX_RECENT_LIMIT, MAX_SEARCH_CONTEXT_CHARS,
} from './vault/constants.js'
import {
  renderRecall, renderMementoList, renderMemento, renderChronicle,
  renderTags, renderChronicleList, renderWrite, renderUpdate, renderSearch,
  formatSyncCounts,
} from './render.js'

export interface ToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface ToolDef<A = unknown> {
  description: string
  /** Zod field map (matches MCP SDK `inputSchema` shape). */
  inputSchema: Record<string, z.ZodTypeAny>
  annotations?: ToolAnnotations
  /** Daemon-side implementation. Receives the live vault + already-validated args. */
  handler: (vault: Vault, args: A) => Promise<string>
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const writeMemento: ToolDef<{ text: string; tags?: string[] }> = {
  description: 'Store a new memento (memory) in the vault. Use for durable facts: user preferences, architectural decisions, project conventions, mistakes to avoid. One clear fact per memento; avoid transient or conversation-specific notes. Call get_tags first and prefer existing tags over inventing new ones.',
  inputSchema: {
    text: z.string().describe('The memento text. Be specific and self-contained.'),
    tags: z.array(z.string()).optional().describe('Topic tags for filtering, e.g. ["coding", "architecture"]'),
  },
  annotations: { idempotentHint: false },
  handler: async (vault, { text, tags }) => {
    try {
      return renderWrite(await vault.writeMemento({ text, tags }))
    } catch (e) {
      // Recoverable errors come back as their guidance message — same MCP-side
      // pattern: the AI reads it and switches to update_memento.
      if (e instanceof DuplicateMementoError || e instanceof ReservedIndexTagError) return e.message
      throw e
    }
  },
}

const recall: ToolDef<{ query: string; k?: number; tags?: string[]; exclude_tags?: string[]; chronicle_id?: string }> = {
  description: 'Semantically search the vault for mementos relevant to a query. Call proactively at conversation start to surface relevant context, or when you need context about a specific topic. Optionally filter by tags to scope the search; use exclude_tags to drop categories you do not want (e.g. exclude_tags=["source:claude-code"] for "things I wrote directly, not bulk-imported chat history"). A long memento shows only its best-matching chunk — call get_memento for the full text.',
  inputSchema: {
    query: z.string().describe('Natural language query — what context are you looking for?'),
    k: z.number().int().positive().max(MAX_RECALL_K).default(DEFAULT_RECALL_K).describe(`Max mementos to return (default ${DEFAULT_RECALL_K}, max ${MAX_RECALL_K})`),
    tags: z.array(z.string()).optional().describe('Restrict results to mementos that have at least one of these tags'),
    exclude_tags: z.array(z.string()).optional().describe('Drop any memento that has at least one of these tags (applied after the include filter)'),
    chronicle_id: z.string().optional().describe('Restrict the search to mementos in this conversation (chronicle)'),
  },
  annotations: { readOnlyHint: true },
  handler: async (vault, { query, k, tags, exclude_tags, chronicle_id }) =>
    renderRecall(await vault.recall(query, k ?? DEFAULT_RECALL_K, chronicle_id, tags, exclude_tags)),
}

const getTags: ToolDef<Record<string, never>> = {
  description: 'Return all tags currently used in the vault with their usage count. Call before write_memento to see what tags exist and reuse them.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
  handler: async vault => renderTags(await vault.getTags()),
}

const sync: ToolDef<Record<string, never>> = {
  description: 'Reconcile this device with storage in BOTH directions: pull any new memories written on other devices AND push any local commits or untracked memory files that haven\'t reached the remote. Call when the user says a memory should exist but recall or get_memento came up empty — it may have been written on another device since the last auto-sync.',
  inputSchema: {},
  // No readOnlyHint: GitBackend.sync commits and pushes untracked / unpushed
  // state to the user's remote. MCP clients use these hints for permission
  // gating; auto-approving this as a read tool would bypass write gating
  // for a network mutation.
  annotations: { openWorldHint: true, idempotentHint: true },
  handler: async vault => {
    const counts = formatSyncCounts(await vault.sync())
    return counts === null
      ? 'Already up to date — no new memories arrived.'
      : `Synced: ${counts}. Retry your search.`
  },
}

const updateMemento: ToolDef<{ memento_id: string; text: string; tags?: string[] }> = {
  description: 'Replace the text of an existing memento by id, and optionally replace its tags. The id is preserved.',
  inputSchema: {
    memento_id: z.string().describe('Memento id to update (from the id= field in recall or list output)'),
    text: z.string().describe('The new full text for the memento'),
    tags: z.array(z.string()).optional().describe('When provided, replaces the memento\'s tags wholesale. Omit to keep the existing tags; pass [] to clear all tags.'),
  },
  annotations: { idempotentHint: true },
  handler: async (vault, { memento_id, text, tags }) => {
    try {
      return renderUpdate(await vault.updateMemento(memento_id, text, tags))
    } catch (e) {
      if (e instanceof StaleMementoError) return e.message
      throw e
    }
  },
}

const getMemoryIndex: ToolDef<Record<string, never>> = {
  description: 'Read the curated memory-index memento — the vault\'s top-level summary, hand-curated across sessions. Pass new text to update_memory_index to revise it; the index id is resolved internally.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
  handler: async vault => {
    // The daemon seeds the singleton `_index` on startup (idempotent), so in
    // production a real entry always exists by the time this tool is callable.
    // A null here means either (a) the AI manually deleted the index, or
    // (b) the vault is freshly init'd and no daemon has booted against it yet
    // (unusual — the daemon is what serves the tool). Either way, point at
    // update_memory_index so the AI can heal the state.
    const entry = await vault.getIndexEntry()
    return entry
      ? entry.text
      : 'No memory index yet. Create one with update_memory_index(<text>).'
  },
}

const updateMemoryIndex: ToolDef<{ text: string }> = {
  description: 'Replace the body of the curated memory-index memento. Use to revise the vault\'s top-level summary as durable knowledge accumulates (after writing 2–3 related mementos, after deleting a memento the index covered, when an entry has gone stale). Keep the body under ~30 lines — the index is signal, not history. There is only one index memento; the id is resolved internally so you do not need to track it.',
  inputSchema: {
    text: z.string().describe('The full new body for the memory index. Replaces the previous text in its entirety — include everything you want to keep.'),
  },
  annotations: { idempotentHint: true },
  handler: async (vault, { text }) => renderUpdate(await vault.updateIndex(text)),
}

const getMemento: ToolDef<{ memento_id: string }> = {
  description: 'Return the full text of one memento by id. recall shows only the best-matching chunk of a long memento and notes "(matched chunk N/M)" — pass that memento id here to read the whole thing.',
  inputSchema: {
    memento_id: z.string().describe('The memento id shown in a recall result'),
  },
  annotations: { readOnlyHint: true },
  handler: async (vault, { memento_id }) => renderMemento(await vault.getMemento(memento_id), memento_id),
}

const getChronicle: ToolDef<{ chronicle_id: string }> = {
  description: 'Return every memento of one conversation (chronicle) in order, with forks (edited / re-rolled turns) annotated inline. Get a chronicle_id from list_chronicles or a recall result. Long turns are shown as previews — call get_memento for the full text of any specific turn.',
  inputSchema: {
    chronicle_id: z.string().describe('The chronicle id shown in a recall result'),
  },
  annotations: { readOnlyHint: true },
  handler: async (vault, { chronicle_id }) => renderChronicle(await vault.getChronicle(chronicle_id), chronicle_id),
}

const listChronicles: ToolDef<Record<string, never>> = {
  description: 'List every conversation (chronicle) in the vault with its memento count and start time. Use to find the right chronicle_id before calling get_chronicle.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
  handler: async vault => renderChronicleList(await vault.listChronicles()),
}

const deleteMemento: ToolDef<{ memento_id: string }> = {
  description: 'Delete a memento from the vault by id. Prefer update_memento to revise an existing memento — it keeps the same id (so references stay valid) and can revise both the text and tags.',
  inputSchema: {
    memento_id: z.string().describe('Memento id to delete'),
  },
  annotations: { destructiveHint: true, idempotentHint: false },
  handler: async (vault, { memento_id }) => {
    await vault.deleteMemento(memento_id)
    return `Deleted ${memento_id}`
  },
}

const listMementosTool: ToolDef<{ start?: string; end?: string; query?: string; k?: number; tags?: string[] }> = {
  description: 'List mementos in reverse-chronological order by last-update time, optionally constrained by a date window and/or tag set. `tags`, `start`, and `end` are TRUE filters — only mementos matching all of them appear. `query` is a presentation hint that REORDERS the listing so semantically-relevant mementos come first (then the rest by recency); it never drops mementos that pass the tag/date filter. For relevance-filtered semantic search (cold queries return empty), use `recall` instead.',
  inputSchema: {
    start: z.string().optional().describe('Lower bound, inclusive. ISO 8601 date or datetime. Omit to allow any.'),
    end: z.string().optional().describe('Upper bound, inclusive. ISO 8601 date or datetime. Omit to allow any.'),
    query: z.string().optional().describe('Optional reorder hint — relevant mementos float to the top; non-relevant mementos still appear (after the relevant ones, in recency order). Use `recall` if you need relevance-filtered search instead.'),
    k: z.number().int().positive().max(MAX_RECENT_LIMIT).default(DEFAULT_RECENT_LIMIT).describe(`Max results to return (default ${DEFAULT_RECENT_LIMIT}, max ${MAX_RECENT_LIMIT})`),
    tags: z.array(z.string()).optional().describe('Tag filter — return only mementos carrying at least one of these tags. Stacks with `start`/`end`/`query`.'),
  },
  annotations: { readOnlyHint: true },
  handler: async (vault, { start, end, query, k, tags }) =>
    renderMementoList(
      await vault.getMementos({ start, end, query, k, tags }),
      (tags?.length ?? 0) > 0
        // Mirror the get_chronicle empty-result template: the wrong-tag case is
        // the single most common failure (tags aren't autocompleted), and
        // get_tags is one call away — name it so the consumer doesn't dead-end
        // at "nothing found" when the spelling was simply off.
        ? 'No mementos match those tags within the given window. Call get_tags to see which tags exist (the spelling may differ).'
        : (start || end ? 'No mementos found in that date range.' : 'No memories stored.'),
    ),
}

const search: ToolDef<{ query: string; k?: number; regex?: boolean; ignore_case?: boolean; context_chars?: number; tags?: string[]; exclude_tags?: string[]; chronicle_id?: string }> = {
  description: 'Exact-text search across every memento — literal substring or regular expression. Use this (not recall) when you need a SPECIFIC string that semantic search misses: an error message, a code identifier, a file path, a UUID, an exact phrase. recall answers "what do I know about X"; search answers "where does X literally appear". Returns short snippets showing each match in context plus a total count — call get_memento for a hit\'s full text.',
  inputSchema: {
    query: z.string().describe(`The text to find. A literal substring unless regex=true. A literal query must be at least ${MIN_LITERAL_QUERY_CHARS} characters.`),
    k: z.number().int().positive().max(SEARCH_MAX_SNIPPETS).default(DEFAULT_RECALL_K).describe(`Max match snippets to show (default ${DEFAULT_RECALL_K}, max ${SEARCH_MAX_SNIPPETS}). The total match count is always reported.`),
    regex: z.boolean().default(false).describe('Treat query as a regular expression instead of a literal substring.'),
    ignore_case: z.boolean().default(true).describe('Case-insensitive matching (default true).'),
    context_chars: z.number().int().positive().max(MAX_SEARCH_CONTEXT_CHARS).default(DEFAULT_SEARCH_CONTEXT_CHARS).describe(`Characters of surrounding context to show on each side of a match (default ${DEFAULT_SEARCH_CONTEXT_CHARS}, max ${MAX_SEARCH_CONTEXT_CHARS}).`),
    tags: z.array(z.string()).optional().describe('Restrict the search to mementos that have at least one of these tags'),
    exclude_tags: z.array(z.string()).optional().describe('Drop any memento that has at least one of these tags'),
    chronicle_id: z.string().optional().describe('Restrict the search to mementos in this conversation (chronicle)'),
  },
  annotations: { readOnlyHint: true },
  handler: async (vault, { query, k, regex, ignore_case, context_chars, tags, exclude_tags, chronicle_id }) =>
    renderSearch(
      await vault.search(query, context_chars ?? DEFAULT_SEARCH_CONTEXT_CHARS, regex ?? false, ignore_case ?? true, chronicle_id, tags, exclude_tags),
      k ?? DEFAULT_RECALL_K,
    ),
}

// ─── Registry ───────────────────────────────────────────────────────────────

/**
 * Tools always available — independent of vault configuration. Registered as
 * routes by the daemon, and as MCP tools by the shim.
 */
export const CORE_TOOLS: Record<string, ToolDef> = {
  write_memento: writeMemento as unknown as ToolDef,
  recall: recall as unknown as ToolDef,
  get_tags: getTags as unknown as ToolDef,
  sync: sync as unknown as ToolDef,
  update_memento: updateMemento as unknown as ToolDef,
  get_memory_index: getMemoryIndex as unknown as ToolDef,
  update_memory_index: updateMemoryIndex as unknown as ToolDef,
  get_memento: getMemento as unknown as ToolDef,
  get_chronicle: getChronicle as unknown as ToolDef,
  list_chronicles: listChronicles as unknown as ToolDef,
  delete_memento: deleteMemento as unknown as ToolDef,
  list_mementos: listMementosTool as unknown as ToolDef,
}

/**
 * Conditionally-registered tools — only included when the runtime config
 * supports them. `search` requires a configured searcher (not `none`).
 */
export const CONDITIONAL_TOOLS: Record<string, ToolDef> = {
  search: search as unknown as ToolDef,
}

/**
 * Resolve which tools are active given the daemon's machine config. Used by
 * both the daemon (which routes to register) and the shim (which MCP tools
 * to register).
 */
export function activeTools(opts: { searchEnabled: boolean }): Record<string, ToolDef> {
  return {
    ...CORE_TOOLS,
    ...(opts.searchEnabled ? { search: CONDITIONAL_TOOLS['search']! } : {}),
  }
}
