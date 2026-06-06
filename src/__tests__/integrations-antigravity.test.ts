/**
 * Unit tests for AntigravityIntegration.
 *
 * Pure filesystem I/O (Antigravity is a GUI editor with no CLI), so these run against a
 * throwaway `HOME` — `~/.gemini/config/mcp_config.json` lands in a tmp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('AntigravityIntegration', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mementos-antigravity-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = home
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  const configPath = () => join(home, '.gemini', 'config', 'mcp_config.json')

  it('install registers the mementos MCP server in mcp_config.json', async () => {
    const { create } = await import('../integrations/antigravity/index.js')
    await create().install()
    const config = JSON.parse(await readFile(configPath(), 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>
    }
    expect(config.mcpServers['mementos']).toEqual({ command: 'mementos', args: ['serve'] })
  })

  it('isInstalled reflects the mcp entry', async () => {
    const { create } = await import('../integrations/antigravity/index.js')
    const integ = create()
    expect(await integ.isInstalled()).toBe(false)
    await integ.install()
    expect(await integ.isInstalled()).toBe(true)
  })

  it('uninstall removes the mementos entry', async () => {
    const { create } = await import('../integrations/antigravity/index.js')
    const integ = create()
    await integ.install()
    await integ.uninstall()
    expect(await integ.isInstalled()).toBe(false)
  })

  it('uninstall tolerates a not-installed state', async () => {
    const { create } = await import('../integrations/antigravity/index.js')
    await expect(create().uninstall()).resolves.toBeUndefined()
  })

  it('install is idempotent', async () => {
    const { create } = await import('../integrations/antigravity/index.js')
    const integ = create()
    await integ.install()
    await integ.install()
    expect(await integ.isInstalled()).toBe(true)
  })

  it('isClientPresent tracks the ~/.gemini/config directory (shared with Antigravity CLI + IDE)', async () => {
    const { create } = await import('../integrations/antigravity/index.js')
    const integ = create()
    expect(await integ.isClientPresent()).toBe(false)
    await mkdir(join(home, '.gemini', 'config'), { recursive: true })
    expect(await integ.isClientPresent()).toBe(true)
  })

  it('install preserves the user\'s other MCP servers, uninstall leaves them', async () => {
    const { create } = await import('../integrations/antigravity/index.js')
    await mkdir(join(home, '.gemini', 'config'), { recursive: true })
    await writeFile(configPath(), JSON.stringify({
      mcpServers: { other: { command: 'other-cmd' } },
    }), 'utf8')

    const integ = create()
    await integ.install()
    let config = JSON.parse(await readFile(configPath(), 'utf8')) as { mcpServers: Record<string, unknown> }
    expect(config.mcpServers['other']).toBeDefined()
    expect(config.mcpServers['mementos']).toBeDefined()

    await integ.uninstall()
    config = JSON.parse(await readFile(configPath(), 'utf8')) as { mcpServers: Record<string, unknown> }
    expect(config.mcpServers['other']).toBeDefined()
    expect(config.mcpServers['mementos']).toBeUndefined()
  })

  it('refuses to overwrite a malformed mcp_config.json', async () => {
    const { create } = await import('../integrations/antigravity/index.js')
    await mkdir(join(home, '.gemini', 'config'), { recursive: true })
    await writeFile(configPath(), '{ not valid json', 'utf8')
    await expect(create().install()).rejects.toThrow(/not valid JSON/)
  })
})
