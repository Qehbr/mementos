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

  // ─── Hooks ────────────────────────────────────────────────────────────────
  // Antigravity 1.0.2 supports only PreInvocation for context injection — verified
  // by grepping the agy binary. `BeforeAgent` (Gemini CLI legacy) and `SessionStart`
  // (Claude-Code-style) are not registered hook event names.
  it('supportedHooks reports auto-retrieve only (no SessionStart equivalent in Antigravity)', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    expect(new AntigravityCliIntegration().hooks.supportedHooks()).toEqual(['auto-retrieve'])
  })

  it('enableHook(auto-retrieve) writes a PreInvocation command hook into plugin.json', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    const integ = new AntigravityCliIntegration()
    await integ.install()  // base plugin.json must exist first

    expect(await integ.hooks.isHookEnabled('auto-retrieve')).toBe(false)
    await integ.hooks.enableHook('auto-retrieve')
    expect(await integ.hooks.isHookEnabled('auto-retrieve')).toBe(true)

    const manifest = JSON.parse(await readFile(pluginManifestPath(), 'utf8')) as {
      name: string
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>
    }
    // Hook lives INSIDE plugin.json, not in a separate settings file.
    expect(manifest.hooks['PreInvocation']).toEqual([
      {
        matcher: '*',
        hooks: [{ name: 'mementos-retrieve', type: 'command', command: 'mementos retrieve' }],
      },
    ])
    // The retired `BeforeAgent` event name must never reappear.
    expect(manifest.hooks['BeforeAgent']).toBeUndefined()
    expect(manifest.name).toBe('mementos')  // plugin metadata preserved
  })

  it('enableHook(session-start) throws — Antigravity has no SessionStart event', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    const integ = new AntigravityCliIntegration()
    await integ.install()

    await expect(integ.hooks.enableHook('session-start')).rejects.toThrow(/Unknown hook kind 'session-start'/)
  })

  it('enableHook on a fresh setup creates a valid plugin.json (name/version present)', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    // Toggle hook WITHOUT calling install() first — common when `mementos integration hook enable`
    // is run before / instead of full install. The adapter must defensively inject baseline fields.
    await new AntigravityCliIntegration().hooks.enableHook('auto-retrieve')

    const manifest = JSON.parse(await readFile(pluginManifestPath(), 'utf8')) as { name?: string; version?: string }
    expect(manifest.name).toBe('mementos')
    expect(manifest.version).toBeTruthy()
  })

  it('enableHook is idempotent — no duplicate entry on second call', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    const integ = new AntigravityCliIntegration()
    await integ.install()
    await integ.hooks.enableHook('auto-retrieve')
    await integ.hooks.enableHook('auto-retrieve')

    const manifest = JSON.parse(await readFile(pluginManifestPath(), 'utf8')) as { hooks: Record<string, unknown[]> }
    expect(manifest.hooks['PreInvocation']).toHaveLength(1)
  })

  it('disableHook removes our entry but preserves other groups under PreInvocation', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    const integ = new AntigravityCliIntegration()
    await integ.install()

    // User has a pre-existing hook of their own under the same event.
    const manifestRaw = JSON.parse(await readFile(pluginManifestPath(), 'utf8')) as Record<string, unknown>
    manifestRaw['hooks'] = {
      PreInvocation: [{ matcher: '*', hooks: [{ type: 'command', command: 'my-own-hook' }] }],
    }
    await writeFile(pluginManifestPath(), JSON.stringify(manifestRaw), 'utf8')

    await integ.hooks.enableHook('auto-retrieve')
    await integ.hooks.disableHook('auto-retrieve')

    expect(await integ.hooks.isHookEnabled('auto-retrieve')).toBe(false)
    const manifest = JSON.parse(await readFile(pluginManifestPath(), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    expect(manifest.hooks['PreInvocation']).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: 'my-own-hook' }] },
    ])
  })

  it('uninstall strips the hook along with the plugin dir', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    const integ = new AntigravityCliIntegration()
    await integ.install()
    await integ.hooks.enableHook('auto-retrieve')
    await integ.uninstall()
    expect(await integ.hooks.isHookEnabled('auto-retrieve')).toBe(false)
  })

  it('refuses to overwrite a malformed plugin.json', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    await mkdir(pluginDir(), { recursive: true })
    await writeFile(pluginManifestPath(), '{ not valid json', 'utf8')
    await expect(new AntigravityCliIntegration().install()).rejects.toThrow(/not valid JSON/)
  })

  it('enableHook rejects an unknown hook kind', async () => {
    const { AntigravityCliIntegration } = await import('../integrations/antigravity-cli/index.js')
    await expect(new AntigravityCliIntegration().hooks.enableHook('pre-compact')).rejects.toThrow(/Unknown hook kind/)
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
