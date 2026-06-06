/**
 * Hook plumbing for ClaudeCodeIntegration — two kinds today: session-start
 * and pre-compact. (The per-prompt auto-retrieve hook was retired because the
 * skill + session-start prelude cover the same UX without burning tokens on
 * trivial turns.)
 *
 * We exercise the class directly (no `claude mcp` subprocess, no init flow). Each hook
 * lives in `~/.claude/settings.json` under its Claude-Code-side event name; this test
 * verifies the file is written correctly, that enable/disable mutate only the targeted
 * event, and that uninstall sweeps every kind in one atomic write.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setupTestEnv, type IntegrationContext } from './_helpers.js'

describe('ClaudeCodeIntegration hooks (session-start + pre-compact)', () => {
  let ctx: IntegrationContext

  beforeEach(async () => {
    ctx = await setupTestEnv()
    await mkdir(join(ctx.homeDir, '.claude'), { recursive: true })
  })

  afterEach(async () => { await ctx.cleanup() })

  async function readSettings(): Promise<Record<string, unknown>> {
    const raw = await readFile(join(ctx.homeDir, '.claude', 'settings.json'), 'utf8').catch(() => '{}')
    return JSON.parse(raw)
  }

  it('enableHook(session-start) writes a SessionStart entry with `mementos session-start`', async () => {
    const { ClaudeCodeIntegration } = await import('../../integrations/claude-code/index.js')
    const integ = new ClaudeCodeIntegration()
    await integ.hooks.hook('session-start').install()

    const settings = await readSettings()
    const hooks = settings.hooks as Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
    expect(hooks.SessionStart).toBeDefined()
    expect(hooks.SessionStart[0].hooks?.[0].command).toBe('mementos session-start')
    // The retired UserPromptSubmit (auto-retrieve) event must never reappear.
    expect(hooks.UserPromptSubmit).toBeUndefined()
    expect(hooks.PreCompact).toBeUndefined()
    expect(await integ.hooks.hook('session-start').isInstalled()).toBe(true)
  })

  it('enableHook(pre-compact) writes a PreCompact entry with `mementos snapshot`', async () => {
    const { ClaudeCodeIntegration } = await import('../../integrations/claude-code/index.js')
    const integ = new ClaudeCodeIntegration()
    await integ.hooks.hook('pre-compact').install()

    const settings = await readSettings()
    const hooks = settings.hooks as Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
    expect(hooks.PreCompact).toBeDefined()
    expect(hooks.PreCompact[0].hooks?.[0].command).toBe('mementos snapshot')
    expect(hooks.UserPromptSubmit).toBeUndefined()
    expect(hooks.SessionStart).toBeUndefined()
    expect(await integ.hooks.hook('pre-compact').isInstalled()).toBe(true)
  })

  it('both hooks coexist; each disable only touches its own event', async () => {
    const { ClaudeCodeIntegration } = await import('../../integrations/claude-code/index.js')
    const integ = new ClaudeCodeIntegration()
    await integ.hooks.hook('session-start').install()
    await integ.hooks.hook('pre-compact').install()

    let settings = await readSettings()
    let hooks = settings.hooks as Record<string, unknown[]>
    expect(hooks.SessionStart).toBeDefined()
    expect(hooks.PreCompact).toBeDefined()

    await integ.hooks.hook('pre-compact').uninstall()
    settings = await readSettings()
    hooks = settings.hooks as Record<string, unknown[]>
    expect(hooks.SessionStart).toBeDefined()
    expect((hooks.PreCompact as unknown[] | undefined)?.length ?? 0).toBe(0)
    expect(await integ.hooks.hook('session-start').isInstalled()).toBe(true)
    expect(await integ.hooks.hook('pre-compact').isInstalled()).toBe(false)
  })

  it('enable is idempotent — re-enabling the same kind does not duplicate the entry', async () => {
    const { ClaudeCodeIntegration } = await import('../../integrations/claude-code/index.js')
    const integ = new ClaudeCodeIntegration()
    await integ.hooks.hook('pre-compact').install()
    await integ.hooks.hook('pre-compact').install()

    const settings = await readSettings()
    const hooks = settings.hooks as Record<string, Array<unknown>>
    expect(hooks.PreCompact.length).toBe(1)
  })

  it('disableHook(both kinds in turn) ends up with both events empty', async () => {
    const { ClaudeCodeIntegration } = await import('../../integrations/claude-code/index.js')
    const integ = new ClaudeCodeIntegration()
    await integ.hooks.hook('session-start').install()
    await integ.hooks.hook('pre-compact').install()

    await integ.hooks.hook('session-start').uninstall()
    await integ.hooks.hook('pre-compact').uninstall()

    const settings = await readSettings()
    const hooks = settings.hooks as Record<string, Array<unknown> | undefined>
    expect((hooks?.SessionStart ?? []).length).toBe(0)
    expect((hooks?.PreCompact ?? []).length).toBe(0)
    expect(await integ.hooks.hook('session-start').isInstalled()).toBe(false)
    expect(await integ.hooks.hook('pre-compact').isInstalled()).toBe(false)
  })
})
