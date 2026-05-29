/**
 * `updateMemento` — replace a memento's text end-to-end through a real vault.
 *
 * The memento is re-chunked and re-embedded under the same id (preserving chronicle
 * membership). After the update, `recall` returns the new content under the same id, and
 * the old text no longer matches.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestEnv, runInitWithFlags, type IntegrationContext } from './_helpers.js'
import { renderRecall } from '../../core/render.js'

describe('updateMemento roundtrip', () => {
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

  it('replaces the entire text; old content no longer retrievable', async () => {
    const v = await freshVault()
    const { id } = await v.writeMemento({ text: 'the user uses Redux for state', tags: ['stack'] })

    await v.updateMemento(id, 'the user uses MobX for state')

    // New content retrievable under the same id
    const after = renderRecall(await v.recall('the user uses MobX for state'))
    expect(after).toContain('MobX')
    expect(after).toContain(`id=${id}`)
    expect(after).not.toContain('Redux')

    // Old content no longer matches — the same memento may still surface (it's the only
    // one in the vault), but its text MUST be the new version.
    const oldQuery = renderRecall(await v.recall('the user uses Redux for state'))
    if (oldQuery !== 'No memories found.') {
      expect(oldQuery).toContain('MobX')
      expect(oldQuery).not.toContain('Redux')
    }
  }, 90_000)

  it('getMemento reflects the updated text', async () => {
    const v = await freshVault()
    const { id } = await v.writeMemento({ text: 'the original note' })

    await v.updateMemento(id, 'the revised note')
    const detail = await v.getMemento(id)
    expect(detail?.text).toContain('the revised note')
    expect(detail?.text).not.toContain('the original note')
  }, 90_000)

  it('rejects an update to an unknown memento id', async () => {
    const v = await freshVault()
    await expect(
      v.updateMemento('00000000-0000-4000-8000-000000000000', 'whatever'),
    ).rejects.toThrow()
  }, 60_000)
})
