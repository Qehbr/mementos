/**
 * `mementos mcp` — the stdio MCP server AI clients launch via
 * `claude mcp add ... mementos mcp`. Pure translator: receives MCP tool
 * calls over stdio from the AI client, forwards each one as a POST to the
 * daemon's HTTP API, returns the daemon's response.
 *
 * The shim itself holds NO vault state. The daemon is the single source of
 * truth — exactly one vault in memory across the machine, no matter how many
 * AI clients are connected.
 *
 * **Tool discovery**: the shim asks the daemon for `/api/_meta/info` at
 * startup to learn which tools are active (CORE_TOOLS always + `search` only
 * if the daemon has a searcher configured). The shim then registers exactly
 * those tools with the MCP SDK, sourcing each tool's description + input
 * schema + annotations from the local `core/tools.ts` registry. The daemon
 * tells the shim WHAT to expose; the shim already knows the SHAPES.
 *
 * Auto-starts the daemon when missing — AI clients don't have a way to ask
 * the LLM to run `mementos start` first; this is the entry point's job.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ensureDaemonRunning } from './daemon.js'
import { activeTools } from '../../core/tools.js'
import { callTool, getDaemonInfo } from '../../daemon/api-client.js'

export async function runMcp(): Promise<void> {
  await ensureDaemonRunning()

  const info = await getDaemonInfo()
  const tools = activeTools({ searchEnabled: info.searchEnabled })

  const server = new McpServer({ name: 'mementos', version: info.version })

  // Register one MCP tool per active daemon tool. The handler is a thin
  // forwarder: receive MCP call → POST to /api/tools/<name> → return text.
  for (const [name, def] of Object.entries(tools)) {
    server.registerTool(
      name,
      {
        description: def.description,
        inputSchema: def.inputSchema,
        ...(def.annotations ? { annotations: def.annotations } : {}),
      },
      async (args: Record<string, unknown>) => {
        const text = await callTool(name, args)
        return { content: [{ type: 'text', text }] }
      },
    )
  }

  await server.connect(new StdioServerTransport())
}
