/**
 * Unit tests for CodexIntegration.
 *
 * `node:child_process` is mocked with a stateful in-memory `codex mcp` registry — `add` /
 * `remove` / `list` behave consistently, and `remove` of an absent server errors like the
 * real CLI. The skill-file side is real filesystem I/O against a tmp `HOME`, so the
 * `homedir()`-derived skill path lands in a throwaway directory.
 *
 * Names are `mock`-prefixed so vitest's `vi.mock` hoisting allows the factory to close
 * over them.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, stat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const mockExecCalls: string[][] = []
const mockServers = new Set<string>()

vi.mock('node:child_process', () => ({
  execFile: (_file: string, args: string[], cb: (e: Error | null, r?: unknown) => void) => {
    mockExecCalls.push(args)
    const [sub, verb, name] = args
    if (sub === 'mcp' && verb === 'add') {
      mockServers.add(name)
      cb(null, { stdout: '', stderr: '' })
      return
    }
    if (sub === 'mcp' && verb === 'remove') {
      if (!mockServers.has(name)) { cb(new Error(`codex: no such MCP server '${name}'`)); return }
      mockServers.delete(name)
      cb(null, { stdout: '', stderr: '' })
      return
    }
    if (sub === 'mcp' && verb === 'list') {
      cb(null, { stdout: [...mockServers].join('\n'), stderr: '' })
      return
    }
    cb(null, { stdout: '', stderr: '' })
  },
}))

describe('CodexIntegration', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    mockExecCalls.length = 0
    mockServers.clear()
    home = await mkdtemp(join(tmpdir(), 'mementos-codex-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = home
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  const skillDir = () => join(home, '.agents', 'skills', 'mementos')

  it('install registers the MCP server via the codex CLI and writes the skill', async () => {
    const { CodexIntegration } = await import('../integrations/codex/index.js')
    await new CodexIntegration().install()

    const add = mockExecCalls.find(a => a[0] === 'mcp' && a[1] === 'add')
    expect(add).toEqual(['mcp', 'add', 'mementos', '--', 'mementos', 'serve'])

    const skill = await readFile(join(skillDir(), 'SKILL.md'), 'utf8')
    expect(skill.startsWith('---\nname: mementos\n')).toBe(true)
    expect(skill).toContain('recall')
  })

  it('isInstalled reflects the codex mcp registry', async () => {
    const { CodexIntegration } = await import('../integrations/codex/index.js')
    const integ = new CodexIntegration()
    expect(await integ.isInstalled()).toBe(false)
    await integ.install()
    expect(await integ.isInstalled()).toBe(true)
  })

  it('uninstall removes the server and the skill directory', async () => {
    const { CodexIntegration } = await import('../integrations/codex/index.js')
    const integ = new CodexIntegration()
    await integ.install()
    await integ.uninstall()
    expect(await integ.isInstalled()).toBe(false)
    await expect(stat(skillDir())).rejects.toThrow()
  })

  it('uninstall tolerates an un-registered server', async () => {
    const { CodexIntegration } = await import('../integrations/codex/index.js')
    await expect(new CodexIntegration().uninstall()).resolves.toBeUndefined()
  })

  it('install is idempotent (remove-then-add)', async () => {
    const { CodexIntegration } = await import('../integrations/codex/index.js')
    const integ = new CodexIntegration()
    await integ.install()
    await integ.install()
    expect(await integ.isInstalled()).toBe(true)
  })

  it('isClientPresent tracks the ~/.codex directory', async () => {
    const { CodexIntegration } = await import('../integrations/codex/index.js')
    const integ = new CodexIntegration()
    expect(await integ.isClientPresent()).toBe(false)
    await mkdir(join(home, '.codex'), { recursive: true })
    expect(await integ.isClientPresent()).toBe(true)
  })

  // ─── Hooks ────────────────────────────────────────────────────────────────
  const hooksPath = () => join(home, '.codex', 'hooks.json')

  it('supportedHooks reports session-start only (auto-retrieve hook was retired)', async () => {
    const { CodexIntegration } = await import('../integrations/codex/index.js')
    expect(new CodexIntegration().hooks.supportedHooks()).toEqual(['session-start'])
  })

  it('enableHook writes a SessionStart command hook to hooks.json', async () => {
    const { CodexIntegration } = await import('../integrations/codex/index.js')
    const integ = new CodexIntegration()
    expect(await integ.hooks.hook('session-start').isInstalled()).toBe(false)

    await integ.hooks.hook('session-start').install()
    expect(await integ.hooks.hook('session-start').isInstalled()).toBe(true)

    const file = JSON.parse(await readFile(hooksPath(), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>
    }
    expect(file.hooks['SessionStart']).toEqual([
      { hooks: [{ type: 'command', command: 'mementos session-start' }] },
    ])
    // The retired UserPromptSubmit event must never reappear in our entries.
    expect(file.hooks['UserPromptSubmit']).toBeUndefined()
  })

  it('enableHook is idempotent — no duplicate entry on second call', async () => {
    const { CodexIntegration } = await import('../integrations/codex/index.js')
    const integ = new CodexIntegration()
    await integ.hooks.hook('session-start').install()
    await integ.hooks.hook('session-start').install()
    const file = JSON.parse(await readFile(hooksPath(), 'utf8')) as {
      hooks: Record<string, unknown[]>
    }
    expect(file.hooks['SessionStart']).toHaveLength(1)
  })

  it('disableHook removes our entry but preserves the user\'s own hooks', async () => {
    const { CodexIntegration } = await import('../integrations/codex/index.js')
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(hooksPath(), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'my-own-hook' }] }] },
    }), 'utf8')

    const integ = new CodexIntegration()
    await integ.hooks.hook('session-start').install()
    await integ.hooks.hook('session-start').uninstall()

    expect(await integ.hooks.hook('session-start').isInstalled()).toBe(false)
    const file = JSON.parse(await readFile(hooksPath(), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    expect(file.hooks['SessionStart']).toEqual([
      { hooks: [{ type: 'command', command: 'my-own-hook' }] },
    ])
  })

  it('uninstall strips the hook along with the server and skill', async () => {
    const { CodexIntegration } = await import('../integrations/codex/index.js')
    const integ = new CodexIntegration()
    await integ.install()
    await integ.hooks.hook('session-start').install()
    await integ.uninstall()
    expect(await integ.hooks.hook('session-start').isInstalled()).toBe(false)
  })

  it('readHooks refuses to overwrite a malformed hooks.json', async () => {
    const { CodexIntegration } = await import('../integrations/codex/index.js')
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(hooksPath(), '{ not valid json', 'utf8')
    await expect(new CodexIntegration().hooks.hook('session-start').install()).rejects.toThrow(/not valid JSON/)
  })

  it('hook() rejects an unknown hook kind synchronously', async () => {
    const { CodexIntegration } = await import('../integrations/codex/index.js')
    expect(() => new CodexIntegration().hooks.hook('auto-retrieve')).toThrow(/Unknown hook kind/)
  })
})
