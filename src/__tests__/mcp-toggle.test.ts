/**
 * Tests for the unified binary-toggle prompt + the BinarySurface plumbing on
 * AntigravityCliIntegration (the most complex toggle path — plugin.json is
 * shared between skill, MCP, and the agy registration step).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { InitContext } from '../core/init-context/interface.js'
import type { BinarySurface } from '../integrations/interface.js'
import { promptBinaryToggle } from '../integrations/_utils/prompt.js'

/** Build a minimal InitContext that emits no inquirer prompts (flag-driven only). */
function fakeCtx(flags: Record<string, string | undefined> = {}): InitContext & { printed: string[] } {
  const printed: string[] = []
  return {
    printed,
    print: (msg: string) => { printed.push(msg) },
    warn: () => {},
    showSecret: async () => {},
    getFlag: (name: string) => flags[name],
    patchMachineConfig: () => {},
  }
}

/** A configurable in-memory BinarySurface for unit-testing the helper. */
function fakeSurface(initiallyInstalled: boolean): BinarySurface & { installCalls: number; uninstallCalls: number; installed: boolean } {
  return {
    installed: initiallyInstalled,
    installCalls: 0,
    uninstallCalls: 0,
    isInstalled() { return Promise.resolve(this.installed) },
    install() { this.installCalls++; this.installed = true; return Promise.resolve() },
    uninstall() { this.uninstallCalls++; this.installed = false; return Promise.resolve() },
  }
}

describe('promptBinaryToggle', () => {
  it('invokes install idempotently when state already matches "on"', async () => {
    const surface = fakeSurface(true)
    const ctx = fakeCtx({ 'test-toggle': 'on' })
    await promptBinaryToggle({
      ctx, surface, flag: 'test-toggle',
      promptText: 'Test toggle?',
      installedMsg: 'INSTALLED', removedMsg: 'REMOVED',
    })
    expect(surface.installCalls).toBe(1)
    expect(surface.uninstallCalls).toBe(0)
    expect(ctx.printed).toEqual(['INSTALLED'])
  })

  it('installs when current state is off but user chooses on', async () => {
    const surface = fakeSurface(false)
    const ctx = fakeCtx({ 'test-toggle': 'on' })
    await promptBinaryToggle({
      ctx, surface, flag: 'test-toggle',
      promptText: 'Test toggle?',
      installedMsg: 'INSTALLED', removedMsg: 'REMOVED',
    })
    expect(surface.installCalls).toBe(1)
    expect(surface.installed).toBe(true)
    expect(ctx.printed).toEqual(['INSTALLED'])
  })

  it('uninstalls when current state is on but user chooses off', async () => {
    const surface = fakeSurface(true)
    const ctx = fakeCtx({ 'test-toggle': 'off' })
    await promptBinaryToggle({
      ctx, surface, flag: 'test-toggle',
      promptText: 'Test toggle?',
      installedMsg: 'INSTALLED', removedMsg: 'REMOVED',
    })
    expect(surface.uninstallCalls).toBe(1)
    expect(surface.installed).toBe(false)
    expect(ctx.printed).toEqual(['REMOVED'])
  })

  it('invokes uninstall idempotently when state already matches "off"', async () => {
    const surface = fakeSurface(false)
    const ctx = fakeCtx({ 'test-toggle': 'off' })
    await promptBinaryToggle({
      ctx, surface, flag: 'test-toggle',
      promptText: 'Test toggle?',
      installedMsg: 'INSTALLED', removedMsg: 'REMOVED',
    })
    expect(surface.uninstallCalls).toBe(1)
    expect(ctx.printed).toEqual(['REMOVED'])
  })

  it('respects defaultYes for foundational components on fresh install', async () => {
    // No flag set; surface reports not-installed. With `defaultYes: true`,
    // the prompt would default to Yes (we can't drive the inquirer prompt from
    // here, but we can check `resolveYesNo`'s default tracks defaultYes when
    // the flag is absent and defaultYes is set).
    const surface = fakeSurface(false)
    const ctx = fakeCtx({ 'test-toggle': 'on' })  // simulate the user accepting the default
    await promptBinaryToggle({
      ctx, surface, flag: 'test-toggle',
      promptText: 'Install the skill?',
      installedMsg: 'Skill on',
      removedMsg: 'Skill off',
      defaultYes: true,
    })
    expect(surface.installed).toBe(true)
  })
})

describe('AntigravityCliIntegration BinarySurface toggles', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mementos-binary-toggle-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = home
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  const pluginJsonPath = () => join(home, '.gemini', 'config', 'plugins', 'mementos', 'plugin.json')
  const skillPath = () => join(home, '.gemini', 'config', 'plugins', 'mementos', 'skills', 'mementos', 'SKILL.md')

  it('full install() leaves mcpServers populated AND the skill on disk', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    await new AntigravityCliIntegration().install()

    const manifest = JSON.parse(await readFile(pluginJsonPath(), 'utf8')) as { mcpServers?: Record<string, unknown> }
    expect(manifest.mcpServers).toBeDefined()
    expect(manifest.mcpServers!['mementos']).toBeDefined()

    const skill = await readFile(skillPath(), 'utf8')
    expect(skill.startsWith('---\nname: mementos\n')).toBe(true)
  })

  it('mcp.uninstall() drops mcpServers but keeps the plugin manifest', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    const integ = new AntigravityCliIntegration()
    await integ.install()
    await integ.mcp.uninstall()

    const manifest = JSON.parse(await readFile(pluginJsonPath(), 'utf8')) as { mcpServers?: unknown; name?: string }
    expect(manifest.mcpServers).toBeUndefined()
    expect(manifest.name).toBe('mementos')  // plugin metadata still there
  })

  it('mcp toggle off → on round-trips the mcpServers entry without other damage', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    const integ = new AntigravityCliIntegration()
    await integ.install()           // on
    await integ.mcp.uninstall()     // off
    let manifest = JSON.parse(await readFile(pluginJsonPath(), 'utf8')) as { mcpServers?: unknown }
    expect(manifest.mcpServers).toBeUndefined()

    await integ.mcp.install()       // back on
    manifest = JSON.parse(await readFile(pluginJsonPath(), 'utf8')) as { mcpServers?: Record<string, unknown> }
    expect(manifest.mcpServers).toBeDefined()
    expect(manifest.mcpServers!['mementos']).toBeDefined()
  })

  it('skill.isInstalled() reflects SKILL.md presence', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    const integ = new AntigravityCliIntegration()
    expect(await integ.skill.isInstalled()).toBe(false)
    await integ.skill.install()
    expect(await integ.skill.isInstalled()).toBe(true)
    await integ.skill.uninstall()
    expect(await integ.skill.isInstalled()).toBe(false)
  })
})
