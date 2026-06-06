/**
 * `write_memento` tool-registry regression: the duplicate-write path must
 * deliver its "duplicate → use update_memento" guidance as the handler's
 * RETURN VALUE (normal text content), not by throwing.
 *
 * The Vault throws `DuplicateMementoError`; the registry's `write_memento`
 * handler catches it and returns the message. That's what every consumer
 * (daemon HTTP route, MCP shim forwarding to it, CLI `mementos write`)
 * relies on to render the guidance as ordinary text the AI can read and
 * act on — same channel `update_memento` uses for its stale-write conflict.
 *
 * Tested at the registry level because that's the single source of truth
 * for both the daemon HTTP routes and the MCP shim's tool registrations.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestEnv, runInitWithFlags, type IntegrationContext } from './_helpers.js'

describe('write_memento tool handler — duplicate is guidance, not a throw', () => {
  let ctx: IntegrationContext

  beforeEach(async () => { ctx = await setupTestEnv() })
  afterEach(async () => { await ctx.cleanup() })

  it('returns the duplicate guidance as normal text (not throwing)', async () => {
    await runInitWithFlags(['--backend=local', '--embedder=minilm', '--index=hnsw', '--key=env', '--integrations=none'])
    const { buildVault } = await import('../../cli/_utils/vault.js')
    const { CORE_TOOLS } = await import('../../core/tools.js')
    const vault = await buildVault()
    await vault.startup()

    const writeMemento = CORE_TOOLS['write_memento']!
    const text = 'the user prefers tabs over spaces'

    const first = await writeMemento.handler(vault, { text })
    expect(first).toMatch(/Stored memento/)

    // Identical text → duplicate. Must come back as guidance text, not a throw.
    const dup = await writeMemento.handler(vault, { text })
    expect(dup).toMatch(/update_memento/)

    await vault.close()
  }, 90_000)
})
