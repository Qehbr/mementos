/**
 * Unit tests for OpenCodeIntegration.
 *
 * The integration is pure filesystem I/O (opencode has no `mcp add` subcommand), so these
 * tests run against a throwaway `HOME` — the `homedir()`-derived config + skill paths land
 * in a tmp directory. The Docker smoke test exercises the real `opencode` CLI.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, stat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('OpenCodeIntegration', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mementos-opencode-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = home
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  const configDir = () => join(home, '.config', 'opencode')
  const configPath = () => join(configDir(), 'opencode.json')
  const skillPath = () => join(configDir(), 'skills', 'mementos', 'SKILL.md')

  it('install registers the MCP server and writes the skill', async () => {
    const { OpenCodeIntegration } = await import('../integrations/opencode/index.js')
    await new OpenCodeIntegration().install()

    const config = JSON.parse(await readFile(configPath(), 'utf8')) as {
      mcp: Record<string, { type: string; command: string[]; enabled: boolean }>
    }
    expect(config.mcp['mementos']).toEqual({
      type: 'local',
      command: ['mementos', 'mcp'],
      enabled: true,
    })

    const skill = await readFile(skillPath(), 'utf8')
    expect(skill.startsWith('---\nname: mementos\n')).toBe(true)
    expect(skill).toContain('recall')
  })

  it('isInstalled reflects the mcp entry', async () => {
    const { OpenCodeIntegration } = await import('../integrations/opencode/index.js')
    const integ = new OpenCodeIntegration()
    expect(await integ.isInstalled()).toBe(false)
    await integ.install()
    expect(await integ.isInstalled()).toBe(true)
  })

  it('uninstall removes the mcp entry and the skill directory', async () => {
    const { OpenCodeIntegration } = await import('../integrations/opencode/index.js')
    const integ = new OpenCodeIntegration()
    await integ.install()
    await integ.uninstall()
    expect(await integ.isInstalled()).toBe(false)
    await expect(stat(join(configDir(), 'skills', 'mementos'))).rejects.toThrow()
  })

  it('uninstall on a never-installed system tolerates absence AND leaves no opencode.json behind', async () => {
    const { OpenCodeIntegration } = await import('../integrations/opencode/index.js')
    await expect(new OpenCodeIntegration().uninstall()).resolves.toBeUndefined()
    // Regression guard: a previous version of uninstall would call atomicWrite even on
    // a missing config (writeJsonConfig mkdir+writes), creating ~/.config/opencode/opencode.json
    // on a system that never had opencode. The stat-guard at the top of uninstall prevents that.
    await expect(stat(configPath())).rejects.toThrow()
  })

  it('install is idempotent', async () => {
    const { OpenCodeIntegration } = await import('../integrations/opencode/index.js')
    const integ = new OpenCodeIntegration()
    await integ.install()
    await integ.install()
    expect(await integ.isInstalled()).toBe(true)
  })

  it('isClientPresent tracks the ~/.config/opencode directory', async () => {
    const { OpenCodeIntegration } = await import('../integrations/opencode/index.js')
    const integ = new OpenCodeIntegration()
    expect(await integ.isClientPresent()).toBe(false)
    await mkdir(configDir(), { recursive: true })
    expect(await integ.isClientPresent()).toBe(true)
  })

  it('install preserves the user\'s other config and MCP servers', async () => {
    const { OpenCodeIntegration } = await import('../integrations/opencode/index.js')
    await mkdir(configDir(), { recursive: true })
    await writeFile(configPath(), JSON.stringify({
      theme: 'opencode',
      mcp: { other: { type: 'local', command: ['other'], enabled: true } },
    }), 'utf8')

    await new OpenCodeIntegration().install()

    const config = JSON.parse(await readFile(configPath(), 'utf8')) as {
      theme: string; mcp: Record<string, unknown>
    }
    expect(config.theme).toBe('opencode')
    expect(config.mcp['other']).toBeDefined()
    expect(config.mcp['mementos']).toBeDefined()
  })

  it('uninstall leaves the user\'s other MCP servers intact', async () => {
    const { OpenCodeIntegration } = await import('../integrations/opencode/index.js')
    await mkdir(configDir(), { recursive: true })
    await writeFile(configPath(), JSON.stringify({
      mcp: { other: { type: 'local', command: ['other'], enabled: true } },
    }), 'utf8')

    const integ = new OpenCodeIntegration()
    await integ.install()
    await integ.uninstall()

    const config = JSON.parse(await readFile(configPath(), 'utf8')) as {
      mcp: Record<string, unknown>
    }
    expect(config.mcp['other']).toBeDefined()
    expect(config.mcp['mementos']).toBeUndefined()
  })

  it('refuses to overwrite a malformed opencode.json', async () => {
    const { OpenCodeIntegration } = await import('../integrations/opencode/index.js')
    await mkdir(configDir(), { recursive: true })
    await writeFile(configPath(), '{ not valid json', 'utf8')
    await expect(new OpenCodeIntegration().install()).rejects.toThrow(/not valid JSON/)
  })
})
