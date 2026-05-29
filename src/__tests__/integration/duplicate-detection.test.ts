/**
 * `writeMemento` duplicate detection.
 *
 * `findDuplicate` checks the new memory's vector against the index for any neighbour
 * within `DUPLICATE_DISTANCE_THRESHOLD = 0.08` cosine distance (≈ 92% similarity).
 * Identical text → identical vector → distance 0 → rejected. The error message
 * suggests `update_memento` instead.
 *
 * Catches: "embedder swap broke the threshold tuning", "dedup logic regression",
 * "the duplicate gate doesn't actually fire on real-world identical inputs."
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestEnv, runInitWithFlags, type IntegrationContext } from './_helpers.js'

describe('writeMemento duplicate detection', () => {
  let ctx: IntegrationContext

  beforeEach(async () => { ctx = await setupTestEnv() })
  afterEach(async () => { await ctx.cleanup() })

  async function freshVault() {
    await runInitWithFlags([
      '--backend=local',
      '--embedder=local',
      '--index=hnsw',
      '--key=env',
      '--integrations=none',
    ])
    const { buildVault } = await import('../../cli/_utils/vault.js')
    const v = await buildVault()
    await v.startup()
    return v
  }

  it('rejects an identical write with a clear suggestion to use update_memento', async () => {
    const v = await freshVault()

    await v.writeMemento({ text: 'the user prefers tabs over spaces', tags: ['preferences'] })

    // Identical text → identical vector → distance 0 < 0.08 → rejected
    await expect(
      v.writeMemento({ text: 'the user prefers tabs over spaces', tags: ['preferences'] }),
    ).rejects.toThrow(/[Ss]imilar.*update_memento/)
  }, 90_000)

  it('allows topically related but distinct memories', async () => {
    const v = await freshVault()

    await v.writeMemento({ text: 'the user prefers tabs over spaces', tags: ['preferences'] })

    // Topically related but distinct text. all-MiniLM-L6-v2 will produce vectors
    // close enough to be retrievable but NOT within the 0.08 dedup threshold.
    const second = await v.writeMemento({
      text: 'the user wants strict TypeScript with noImplicitAny',
      tags: ['preferences'],
    })
    expect(second.id).toMatch(/^[0-9a-f-]{36}$/)
  }, 90_000)
})
