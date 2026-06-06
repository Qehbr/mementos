/**
 * MCP server wiring — exposes the Vault's tools over the Model Context Protocol so any
 * compatible AI client can call them: recall, search, write_memento, update_memento,
 * delete_memento, get_memento, get_chronicle, list_chronicles, get_tags, list_mementos,
 * get_memory_index, update_memory_index.
 *
 * `search` is registered only when a lexical searcher is configured (`searcher` is not
 * `none`) — `createMcpServer`'s `searchEnabled` option gates it, so the AI never sees a
 * tool that would always come back empty.
 *
 * Notably absent: a "list every memento" tool. Dumping the whole vault into the context
 * window is wasteful — the AI should search semantically (`recall`) or filter by tag /
 * chronicle. `vault.listMementos()` still exists for the human-facing `mementos list` CLI.
 *
 * Each tool's `description` and per-parameter `.describe()` text is what the AI actually
 * reads to decide when and how to use the tool — these strings are the primary mechanism
 * for steering AI behaviour, alongside the skill file written by ClientIntegration.
 *
 * # Vocabulary
 *   - a **memento** is one logical memory (one `.mem` file, possibly several chunks)
 *   - a **chronicle** is a conversation — a set of mementos sharing a `chronicle_id`,
 *     created only by `mementos ingest` / the snapshot hook
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
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

/** mementos' own version, read from package.json — single source of truth. */
function packageVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')
  return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version
}

/**
 * Build the MCP server, registering one tool per public Vault method.
 *
 * `searchEnabled` gates the `search` tool — pass `true` only when the configured searcher
 * can actually answer (i.e. it is not `none`). Defaults to `false` so callers that don't
 * opt in (older code, tests) simply don't expose it.
 */
export function createMcpServer(
  vault: Vault,
  opts: { searchEnabled?: boolean } = {},
): McpServer {
  const server = new McpServer({ name: 'mementos', version: packageVersion() })

  server.registerTool(
    'write_memento',
    {
      description: 'Store a new memento (memory) in the vault. Use for durable facts: user preferences, architectural decisions, project conventions, mistakes to avoid. One clear fact per memento; avoid transient or conversation-specific notes. Call get_tags first and prefer existing tags over inventing new ones.',
      inputSchema: {
        text: z.string().describe('The memento text. Be specific and self-contained.'),
        tags: z.array(z.string()).optional().describe('Topic tags for filtering, e.g. ["coding", "architecture"]'),
      },
      // Not idempotent: calling twice with the same text raises a "similar memento exists"
      // warning and refuses to write the duplicate. Mutates vault state.
      annotations: { idempotentHint: false },
    },
    async ({ text, tags }) => {
      try {
        return { content: [{ type: 'text', text: renderWrite(await vault.writeMemento({ text, tags })) }] }
      } catch (e) {
        // A duplicate is an expected, recoverable outcome — return its guidance as normal
        // content so the AI reads it and switches to update_memento (same as the stale path).
        // ReservedIndexTagError is the same shape: the AI must update the existing index.
        if (e instanceof DuplicateMementoError || e instanceof ReservedIndexTagError) {
          return { content: [{ type: 'text', text: e.message }] }
        }
        throw e
      }
    },
  )

  server.registerTool(
    'recall',
    {
      description: 'Semantically search the vault for mementos relevant to a query. Call proactively at conversation start to surface relevant context, or when you need context about a specific topic. Optionally filter by tags to scope the search; use exclude_tags to drop categories you do not want (e.g. exclude_tags=["source:claude-code"] for "things I wrote directly, not bulk-imported chat history"). A long memento shows only its best-matching chunk — call get_memento for the full text.',
      inputSchema: {
        query: z.string().describe('Natural language query — what context are you looking for?'),
        k: z.number().int().positive().max(MAX_RECALL_K).default(DEFAULT_RECALL_K).describe(`Max mementos to return (default ${DEFAULT_RECALL_K}, max ${MAX_RECALL_K})`),
        tags: z.array(z.string()).optional().describe('Restrict results to mementos that have at least one of these tags'),
        exclude_tags: z.array(z.string()).optional().describe('Drop any memento that has at least one of these tags (applied after the include filter)'),
        chronicle_id: z.string().optional().describe('Restrict the search to mementos in this conversation (chronicle)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, k, tags, exclude_tags, chronicle_id }) => ({
      content: [{
        type: 'text',
        text: renderRecall(await vault.recall(query, k, chronicle_id, tags, exclude_tags)),
      }],
    }),
  )

  server.registerTool(
    'get_tags',
    {
      description: 'Return all tags currently used in the vault with their usage count. Call before write_memento to see what tags exist and reuse them.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [{ type: 'text', text: renderTags(await vault.getTags()) }],
    }),
  )

  server.registerTool(
    'sync',
    {
      description: 'Pull the latest memories from storage right now. Call when the user says a memory should exist but recall or get_memento came up empty — it may have been written on another device since the last auto-sync.',
      inputSchema: {},
      // Reads from a remote (other devices' .mem files). Doesn't mutate the
      // vault's logical contents itself, but its result depends on external
      // state and varies between calls — that's exactly what openWorldHint
      // signals. Idempotent in the sense that two syncs back-to-back leave
      // the same state (whatever was upstream is now local).
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async () => {
      const counts = formatSyncCounts(await vault.sync())
      const text = counts === null
        ? 'Already up to date — no new memories arrived.'
        : `Synced: ${counts}. Retry your search.`
      return { content: [{ type: 'text', text }] }
    },
  )

  server.registerTool(
    'update_memento',
    {
      description: 'Replace the text of an existing memento by id, and optionally replace its tags. The id is preserved.',
      inputSchema: {
        memento_id: z.string().describe('Memento id to update (from the id= field in recall or list output)'),
        text: z.string().describe('The new full text for the memento'),
        tags: z.array(z.string()).optional().describe('When provided, replaces the memento\'s tags wholesale. Omit to keep the existing tags; pass [] to clear all tags.'),
      },
      // Idempotent: same (id, text, tags) applied twice is a no-op on the second call
      // (etag matches, content matches). Mutates state, so not readOnly.
      annotations: { idempotentHint: true },
    },
    async ({ memento_id, text, tags }) => {
      try {
        return { content: [{ type: 'text', text: renderUpdate(await vault.updateMemento(memento_id, text, tags)) }] }
      } catch (e) {
        // A stale-write conflict is an expected, recoverable outcome — return its
        // instructive message as normal content so the AI reads it and retries.
        if (e instanceof StaleMementoError) {
          return { content: [{ type: 'text', text: e.message }] }
        }
        throw e
      }
    },
  )

  server.registerTool(
    'get_memory_index',
    {
      description: 'Read the curated memory-index memento — the vault\'s top-level summary, hand-curated across sessions. Pass new text to update_memory_index to revise it; the index id is resolved internally.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const entry = await vault.getIndexEntry()
      const text = entry
        ? entry.text
        : 'No memory index yet — call update_memory_index(<text>) to create one. Keep it under ~30 lines; use it to surface high-signal facts (user preferences, project state, decisions) you would otherwise have to recall every session.'
      return { content: [{ type: 'text', text }] }
    },
  )

  server.registerTool(
    'update_memory_index',
    {
      description: 'Replace the body of the curated memory-index memento. Use to revise the vault\'s top-level summary as durable knowledge accumulates (after writing 2–3 related mementos, after deleting a memento the index covered, when an entry has gone stale). Keep the body under ~30 lines — the index is signal, not history. There is only one index memento; the id is resolved internally so you do not need to track it.',
      inputSchema: {
        text: z.string().describe('The full new body for the memory index. Replaces the previous text in its entirety — include everything you want to keep.'),
      },
      // Same posture as update_memento — idempotent for a given body text.
      annotations: { idempotentHint: true },
    },
    async ({ text }) => ({
      content: [{ type: 'text', text: renderUpdate(await vault.updateIndex(text)) }],
    }),
  )

  server.registerTool(
    'get_memento',
    {
      description: 'Return the full text of one memento by id. recall shows only the best-matching chunk of a long memento and notes "(matched chunk N/M)" — pass that memento id here to read the whole thing.',
      inputSchema: {
        memento_id: z.string().describe('The memento id shown in a recall result'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ memento_id }) => ({
      content: [{ type: 'text', text: renderMemento(await vault.getMemento(memento_id), memento_id) }],
    }),
  )

  server.registerTool(
    'get_chronicle',
    {
      description: 'Return every memento of one conversation (chronicle) in order, with forks (edited / re-rolled turns) annotated inline. Get a chronicle_id from list_chronicles or a recall result. Long turns are shown as previews — call get_memento for the full text of any specific turn.',
      inputSchema: {
        chronicle_id: z.string().describe('The chronicle id shown in a recall result'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ chronicle_id }) => ({
      content: [{ type: 'text', text: renderChronicle(await vault.getChronicle(chronicle_id), chronicle_id) }],
    }),
  )

  server.registerTool(
    'list_chronicles',
    {
      description: 'List every conversation (chronicle) in the vault with its memento count and start time. Use to find the right chronicle_id before calling get_chronicle.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [{ type: 'text', text: renderChronicleList(await vault.listChronicles()) }],
    }),
  )

  server.registerTool(
    'delete_memento',
    {
      description: 'Delete a memento from the vault by id. Prefer update_memento to revise an existing memento — it keeps the same id (so references stay valid) and can revise both the text and tags.',
      inputSchema: {
        memento_id: z.string().describe('Memento id to delete'),
      },
      // MCP clients use these hints to flag the call to the user (e.g. an "are you sure?"
      // confirmation) and to skip safety wrappers on read-only ops. delete is idempotent
      // in spec terms — deleting the same id twice ends at the same state — but the second
      // call surfaces an error, so we mark it non-idempotent to keep the client honest.
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ memento_id }) => {
      await vault.deleteMemento(memento_id)
      return { content: [{ type: 'text', text: `Deleted ${memento_id}` }] }
    },
  )

  server.registerTool(
    'list_mementos',
    {
      description: 'List mementos in reverse-chronological order by last-update time, optionally bounded by a date window and/or ranked by a query. Use `start`/`end` for "what did we work on last week?" or "summarise everything from March." With `query`, results are ranked by semantic relevance instead of recency.',
      inputSchema: {
        start: z.string().optional().describe('Lower bound, inclusive. ISO 8601 date or datetime. Omit to allow any.'),
        end: z.string().optional().describe('Upper bound, inclusive. ISO 8601 date or datetime. Omit to allow any.'),
        query: z.string().optional().describe('Optional natural-language query — when present, results are ranked by relevance to it instead of recency.'),
        k: z.number().int().positive().max(MAX_RECENT_LIMIT).default(DEFAULT_RECENT_LIMIT).describe(`Max results to return (default ${DEFAULT_RECENT_LIMIT}, max ${MAX_RECENT_LIMIT})`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ start, end, query, k }) => ({
      content: [{
        type: 'text',
        text: renderMementoList(
          await vault.getMementosInRange(start, end, query, k),
          start || end ? 'No mementos found in that date range.' : 'No memories stored.',
        ),
      }],
    }),
  )

  // `search` — exact lexical lookup. Registered only when a searcher is configured.
  if (opts.searchEnabled) {
    server.registerTool(
      'search',
      {
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
      },
      async ({ query, k, regex, ignore_case, context_chars, tags, exclude_tags, chronicle_id }) => ({
        content: [{
          type: 'text',
          text: renderSearch(
            await vault.search(query, context_chars, regex, ignore_case, chronicle_id, tags, exclude_tags),
            k,
          ),
        }],
      }),
    )
  }

  return server
}
