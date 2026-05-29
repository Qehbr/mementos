/**
 * MCP-layer regression: write_memento must deliver its "duplicate → use update_memento"
 * guidance as NORMAL content, not an MCP error (isError). The Vault throws
 * DuplicateMementoError; the write_memento handler catches it and returns the message as
 * content — the same channel update_memento uses for its stale-write conflict, because an
 * isError result is not reliably read/retried by AI clients.
 *
 * The Vault-level duplicate-detection test asserts the throw; it can't see this MCP-layer
 * conversion, which is exactly where the contract ("the tool will warn you") lives.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { setupTestEnv, runInitWithFlags, type IntegrationContext } from './_helpers.js'

interface ToolResult { content: Array<{ type: string; text?: string }>; isError?: boolean }

describe('write_memento MCP handler — duplicate is guidance, not an error', () => {
  let ctx: IntegrationContext

  beforeEach(async () => { ctx = await setupTestEnv() })
  afterEach(async () => { await ctx.cleanup() })

  it('returns the duplicate guidance as non-error content (not isError)', async () => {
    await runInitWithFlags(['--backend=local', '--embedder=local', '--index=hnsw', '--key=env', '--integrations=none'])
    const { buildVault } = await import('../../cli/_utils/vault.js')
    const { createMcpServer } = await import('../../core/mcp.js')
    const vault = await buildVault()
    await vault.startup()

    const server = createMcpServer(vault)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const text = 'the user prefers tabs over spaces'
    const first = await client.callTool({ name: 'write_memento', arguments: { text } }) as ToolResult
    expect(first.isError).toBeFalsy()

    // Identical text → duplicate. Must come back as guidance content, NOT isError.
    const dup = await client.callTool({ name: 'write_memento', arguments: { text } }) as ToolResult
    expect(dup.isError).toBeFalsy()
    expect(dup.content[0]?.text).toMatch(/update_memento/)

    await client.close()
    await vault.close()
  }, 90_000)
})
