/**
 * Unit tests for CursorIntegration.
 *
 * Pure filesystem I/O (Cursor is a GUI editor with no CLI), so these run against a
 * throwaway `HOME` — the `homedir()`-derived `~/.cursor/mcp.json` lands in a tmp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setFakeHome } from './_utils/fake-home.js'

describe('CursorIntegration', () => {
  let home: string
  let restoreHome: () => void

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mementos-cursor-'))
    restoreHome = setFakeHome(home)
  })
  afterEach(async () => {
    restoreHome()
    await rm(home, { recursive: true, force: true })
  })

  const configPath = () => join(home, '.cursor', 'mcp.json')

  it('install registers the mementos MCP server in ~/.cursor/mcp.json', async () => {
    const { create } = await import('../integrations/cursor/index.js')
    await create().install()
    const config = JSON.parse(await readFile(configPath(), 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>
    }
    expect(config.mcpServers['mementos']).toEqual({ command: 'mementos', args: ['mcp'] })
  })

  it('isInstalled reflects the mcp entry', async () => {
    const { create } = await import('../integrations/cursor/index.js')
    const integ = create()
    expect(await integ.isInstalled()).toBe(false)
    await integ.install()
    expect(await integ.isInstalled()).toBe(true)
  })

  it('uninstall removes the mementos entry', async () => {
    const { create } = await import('../integrations/cursor/index.js')
    const integ = create()
    await integ.install()
    await integ.uninstall()
    expect(await integ.isInstalled()).toBe(false)
  })

  it('uninstall tolerates a not-installed state', async () => {
    const { create } = await import('../integrations/cursor/index.js')
    await expect(create().uninstall()).resolves.toBeUndefined()
  })

  it('install is idempotent', async () => {
    const { create } = await import('../integrations/cursor/index.js')
    const integ = create()
    await integ.install()
    await integ.install()
    expect(await integ.isInstalled()).toBe(true)
  })

  it('isClientPresent tracks the ~/.cursor directory', async () => {
    const { create } = await import('../integrations/cursor/index.js')
    const integ = create()
    expect(await integ.isClientPresent()).toBe(false)
    await mkdir(join(home, '.cursor'), { recursive: true })
    expect(await integ.isClientPresent()).toBe(true)
  })

  it('install preserves the user\'s other MCP servers, uninstall leaves them', async () => {
    const { create } = await import('../integrations/cursor/index.js')
    await mkdir(join(home, '.cursor'), { recursive: true })
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

  it('refuses to overwrite a malformed mcp.json', async () => {
    const { create } = await import('../integrations/cursor/index.js')
    await mkdir(join(home, '.cursor'), { recursive: true })
    await writeFile(configPath(), '{ not valid json', 'utf8')
    await expect(create().install()).rejects.toThrow(/not valid JSON/)
  })
})
