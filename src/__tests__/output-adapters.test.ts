/**
 * Output adapter abstraction — auto-discovery contract + shipped adapter behaviour.
 */
import { describe, it, expect } from 'vitest'
import { loadOutputAdapters } from '../output-adapters/registry.js'

describe('output adapters', () => {
  it('auto-discovers every shipped adapter under src/output-adapters/<name>/', async () => {
    const registry = await loadOutputAdapters()
    // gemini-hook is the only shipped adapter today; this assertion guards two things:
    // (1) the discovery scan runs, (2) the implementation registers under the right type.
    expect([...registry.keys()]).toContain('gemini-hook')
  })

  describe('gemini-hook adapter', () => {
    it('wraps text in hookSpecificOutput.additionalContext with the given event name', async () => {
      const registry = await loadOutputAdapters()
      const adapter = registry.get('gemini-hook')!.create()
      const raw = adapter.wrap('hello world', { event: 'SessionStart' })
      expect(JSON.parse(raw)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'hello world',
        },
      })
    })

    it('defaults event name to BeforeAgent when params.event is absent', async () => {
      const registry = await loadOutputAdapters()
      const adapter = registry.get('gemini-hook')!.create()
      const raw = adapter.wrap('x', {})
      expect(JSON.parse(raw)).toMatchObject({
        hookSpecificOutput: { hookEventName: 'BeforeAgent' },
      })
    })
  })
})
