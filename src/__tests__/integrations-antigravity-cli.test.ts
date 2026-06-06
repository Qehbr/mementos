/**
 * Unit tests for AntigravityCliIntegration.
 *
 * Pure filesystem I/O — runs against a throwaway `HOME` so the plugin dir and
 * import_manifest.json land in a tmp directory. The Docker smoke test exercises the real
 * `agy` CLI; this covers the file-shape contract.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, stat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('AntigravityCliIntegration', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mementos-antigravity-cli-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = home
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  const pluginDir = () => join(home, '.gemini', 'config', 'plugins', 'mementos')
  const pluginManifestPath = () => join(pluginDir(), 'plugin.json')
  const skillPath = () => join(pluginDir(), 'skills', 'mementos', 'SKILL.md')
  const importManifestPath = () => join(home, '.gemini', 'config', 'import_manifest.json')

  it('install writes plugin.json with the mementos MCP server and a SKILL.md', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    await new AntigravityCliIntegration().install()

    const manifest = JSON.parse(await readFile(pluginManifestPath(), 'utf8')) as {
      name: string; version: string; mcpServers: Record<string, { command: string; args: string[] }>
    }
    expect(manifest.name).toBe('mementos')
    expect(manifest.version).toBeTruthy()
    expect(manifest.mcpServers['mementos']).toEqual({ command: 'mementos', args: ['serve'] })

    const skill = await readFile(skillPath(), 'utf8')
    expect(skill.startsWith('---')).toBe(true)  // YAML frontmatter required by Antigravity's skill loader
    expect(skill).toContain('recall')
  })

  it('install adds an entry to import_manifest.json so `agy plugin list` shows us', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    await new AntigravityCliIntegration().install()

    const importManifest = JSON.parse(await readFile(importManifestPath(), 'utf8')) as {
      imports: Array<{ name: string; source?: string; importedAt?: string; components?: string[] }>
    }
    const entry = importManifest.imports.find(e => e.name === 'mementos')
    expect(entry).toBeDefined()
    expect(entry?.source).toBe('mementos-init')
    expect(entry?.components).toContain('installed')
  })

  it('isInstalled reflects the plugin.json presence', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    const integ = new AntigravityCliIntegration()
    expect(await integ.isInstalled()).toBe(false)
    await integ.install()
    expect(await integ.isInstalled()).toBe(true)
  })

  it('uninstall removes the plugin directory AND the import_manifest entry', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    const integ = new AntigravityCliIntegration()
    await integ.install()
    await integ.uninstall()

    expect(await integ.isInstalled()).toBe(false)
    await expect(stat(pluginDir())).rejects.toThrow()
    const importManifest = JSON.parse(await readFile(importManifestPath(), 'utf8')) as { imports: Array<{ name: string }> }
    expect(importManifest.imports.find(e => e.name === 'mementos')).toBeUndefined()
  })

  it('uninstall tolerates a not-installed state', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    await expect(new AntigravityCliIntegration().uninstall()).resolves.toBeUndefined()
  })

  it('install is idempotent', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    const integ = new AntigravityCliIntegration()
    await integ.install()
    await integ.install()
    expect(await integ.isInstalled()).toBe(true)
    // import_manifest entry isn't duplicated on a second install.
    const im = JSON.parse(await readFile(importManifestPath(), 'utf8')) as { imports: Array<{ name: string }> }
    expect(im.imports.filter(e => e.name === 'mementos')).toHaveLength(1)
  })

  it('install preserves the user\'s other plugins in import_manifest', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    await mkdir(join(home, '.gemini', 'config'), { recursive: true })
    await writeFile(importManifestPath(), JSON.stringify({
      imports: [{ name: 'other-plugin', source: 'local-install', components: ['installed'] }],
    }), 'utf8')

    const integ = new AntigravityCliIntegration()
    await integ.install()
    let im = JSON.parse(await readFile(importManifestPath(), 'utf8')) as { imports: Array<{ name: string }> }
    expect(im.imports.find(e => e.name === 'other-plugin')).toBeDefined()
    expect(im.imports.find(e => e.name === 'mementos')).toBeDefined()

    await integ.uninstall()
    im = JSON.parse(await readFile(importManifestPath(), 'utf8')) as { imports: Array<{ name: string }> }
    expect(im.imports.find(e => e.name === 'other-plugin')).toBeDefined()
    expect(im.imports.find(e => e.name === 'mementos')).toBeUndefined()
  })

  it('isClientPresent tracks the ~/.gemini directory', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    const integ = new AntigravityCliIntegration()
    expect(await integ.isClientPresent()).toBe(false)
    await mkdir(join(home, '.gemini'), { recursive: true })
    expect(await integ.isClientPresent()).toBe(true)
  })

  // No hook lifecycle: Antigravity ships MCP + skill only. Antigravity has no
  // session-lifecycle event, and the per-prompt auto-retrieve hook was dropped
  // across all integrations.
  it('exposes no hook surface', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    expect(new AntigravityCliIntegration().hooks).toBeUndefined()
  })

  it('refuses to overwrite a malformed plugin.json', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    await mkdir(pluginDir(), { recursive: true })
    await writeFile(pluginManifestPath(), '{ not valid json', 'utf8')
    await expect(new AntigravityCliIntegration().install()).rejects.toThrow(/not valid JSON/)
  })

  it('discovery contract: type/create/setupAtInit module exports', async () => {
    const mod = await import('../integrations/antigravity-cli/index.js')
    expect(mod.type).toBe('antigravity-cli')
    expect(typeof mod.create).toBe('function')
    expect(typeof mod.setupAtInit).toBe('function')
    const created = mod.create()
    expect(created.name).toBe('Antigravity CLI')
  })
})
