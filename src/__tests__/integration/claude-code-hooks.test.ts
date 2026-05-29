/**
 * Hook plumbing for ClaudeCodeIntegration — both kinds today: auto-retrieve and pre-compact.
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

describe('ClaudeCodeIntegration hooks (auto-retrieve + pre-compact)', () => {
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

  it('enableHook(auto-retrieve) writes a UserPromptSubmit entry with `mementos retrieve`', async () => {
    const { ClaudeCodeIntegration } = await import('../../integrations/claude-code/index.js')
    const integ = new ClaudeCodeIntegration()
    await integ.hooks.enableHook('auto-retrieve')

    const settings = await readSettings()
    const hooks = settings.hooks as Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
    expect(hooks.UserPromptSubmit).toBeDefined()
    expect(hooks.UserPromptSubmit[0].hooks?.[0].command).toBe('mementos retrieve')
    expect(hooks.PreCompact).toBeUndefined()
    expect(await integ.hooks.isHookEnabled('auto-retrieve')).toBe(true)
    expect(await integ.hooks.isHookEnabled('pre-compact')).toBe(false)
  })

  it('enableHook(pre-compact) writes a PreCompact entry with `mementos snapshot`', async () => {
    const { ClaudeCodeIntegration } = await import('../../integrations/claude-code/index.js')
    const integ = new ClaudeCodeIntegration()
    await integ.hooks.enableHook('pre-compact')

    const settings = await readSettings()
    const hooks = settings.hooks as Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
    expect(hooks.PreCompact).toBeDefined()
    expect(hooks.PreCompact[0].hooks?.[0].command).toBe('mementos snapshot')
    expect(hooks.UserPromptSubmit).toBeUndefined()
    expect(await integ.hooks.isHookEnabled('pre-compact')).toBe(true)
    expect(await integ.hooks.isHookEnabled('auto-retrieve')).toBe(false)
  })

  it('both hooks coexist; each disable only touches its own event', async () => {
    const { ClaudeCodeIntegration } = await import('../../integrations/claude-code/index.js')
    const integ = new ClaudeCodeIntegration()
    await integ.hooks.enableHook('auto-retrieve')
    await integ.hooks.enableHook('pre-compact')

    let settings = await readSettings()
    let hooks = settings.hooks as Record<string, unknown[]>
    expect(hooks.UserPromptSubmit).toBeDefined()
    expect(hooks.PreCompact).toBeDefined()

    await integ.hooks.disableHook('pre-compact')
    settings = await readSettings()
    hooks = settings.hooks as Record<string, unknown[]>
    expect(hooks.UserPromptSubmit).toBeDefined()
    expect((hooks.PreCompact as unknown[] | undefined)?.length ?? 0).toBe(0)
    expect(await integ.hooks.isHookEnabled('auto-retrieve')).toBe(true)
    expect(await integ.hooks.isHookEnabled('pre-compact')).toBe(false)
  })

  it('enable is idempotent — re-enabling the same kind does not duplicate the entry', async () => {
    const { ClaudeCodeIntegration } = await import('../../integrations/claude-code/index.js')
    const integ = new ClaudeCodeIntegration()
    await integ.hooks.enableHook('pre-compact')
    await integ.hooks.enableHook('pre-compact')

    const settings = await readSettings()
    const hooks = settings.hooks as Record<string, Array<unknown>>
    expect(hooks.PreCompact.length).toBe(1)
  })

  it('disableHook(both kinds in turn) ends up with both events empty', async () => {
    const { ClaudeCodeIntegration } = await import('../../integrations/claude-code/index.js')
    const integ = new ClaudeCodeIntegration()
    await integ.hooks.enableHook('auto-retrieve')
    await integ.hooks.enableHook('pre-compact')

    await integ.hooks.disableHook('auto-retrieve')
    await integ.hooks.disableHook('pre-compact')

    const settings = await readSettings()
    const hooks = settings.hooks as Record<string, Array<unknown> | undefined>
    expect((hooks?.UserPromptSubmit ?? []).length).toBe(0)
    expect((hooks?.PreCompact ?? []).length).toBe(0)
    expect(await integ.hooks.isHookEnabled('auto-retrieve')).toBe(false)
    expect(await integ.hooks.isHookEnabled('pre-compact')).toBe(false)
  })
})
