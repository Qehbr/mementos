/**
 * Unit tests for OpenClawIntegration.
 *
 * The integration shells out to the `openclaw` CLI for MCP registration, so we mock
 * `node:child_process`. `promisify(execFile)` calls `execFile(file, args, cb)`; the mock
 * records the call and invokes `cb(null, …)` on success or `cb(err)` to simulate a CLI
 * failure (server not registered / `openclaw` not installed). The skill-file side is real
 * filesystem I/O against a tmp `OPENCLAW_STATE_DIR`.
 *
 * Names are `mock`-prefixed so vitest's `vi.mock` hoisting allows the factory to close
 * over them.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const mockExecCalls: Array<{ file: string; args: string[] }> = []
let mockExecBehavior: 'ok' | 'fail' = 'ok'

vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], cb: (e: Error | null, r?: unknown) => void) => {
    mockExecCalls.push({ file, args })
    if (mockExecBehavior === 'fail') cb(new Error('openclaw: command failed'))
    else cb(null, { stdout: '', stderr: '' })
  },
}))

describe('OpenClawIntegration', () => {
  let stateDir: string

  beforeEach(async () => {
    mockExecCalls.length = 0
    mockExecBehavior = 'ok'
    stateDir = await mkdtemp(join(tmpdir(), 'mementos-openclaw-'))
    process.env['OPENCLAW_STATE_DIR'] = stateDir
  })

  afterEach(async () => {
    delete process.env['OPENCLAW_STATE_DIR']
    await rm(stateDir, { recursive: true, force: true })
  })

  it('install registers the MCP server via the openclaw CLI and writes the skill', async () => {
    const { OpenClawIntegration } = await import('../integrations/openclaw/index.js')
    await new OpenClawIntegration().install()

    const set = mockExecCalls.find(c => c.args[0] === 'mcp' && c.args[1] === 'set')
    expect(set).toBeDefined()
    expect(set?.file).toBe('openclaw')
    expect(set?.args).toEqual(['mcp', 'set', 'mementos', '{"command":"mementos","args":["serve"]}'])

    const skill = await readFile(join(stateDir, 'workspace', 'skills', 'mementos', 'SKILL.md'), 'utf8')
    expect(skill.startsWith('---\nname: mementos\n')).toBe(true)
    expect(skill).toContain('recall')
  })

  it('uninstall unsets the MCP server and removes the skill directory', async () => {
    const { OpenClawIntegration } = await import('../integrations/openclaw/index.js')
    const integ = new OpenClawIntegration()
    await integ.install()
    await integ.uninstall()

    expect(mockExecCalls.some(c => c.args[0] === 'mcp' && c.args[1] === 'unset')).toBe(true)
    await expect(stat(join(stateDir, 'workspace', 'skills', 'mementos'))).rejects.toThrow()
  })

  it('uninstall tolerates an un-registered server (unset errors)', async () => {
    const { OpenClawIntegration } = await import('../integrations/openclaw/index.js')
    mockExecBehavior = 'fail'
    await expect(new OpenClawIntegration().uninstall()).resolves.toBeUndefined()
  })

  it('isInstalled reflects whether `openclaw mcp show` succeeds', async () => {
    const { OpenClawIntegration } = await import('../integrations/openclaw/index.js')
    const integ = new OpenClawIntegration()
    mockExecBehavior = 'ok'
    expect(await integ.isInstalled()).toBe(true)
    mockExecBehavior = 'fail'
    expect(await integ.isInstalled()).toBe(false)
  })

  it('isClientPresent tracks the OpenClaw state directory', async () => {
    const { OpenClawIntegration } = await import('../integrations/openclaw/index.js')
    const integ = new OpenClawIntegration()
    expect(await integ.isClientPresent()).toBe(true)
    process.env['OPENCLAW_STATE_DIR'] = join(stateDir, 'does-not-exist')
    expect(await integ.isClientPresent()).toBe(false)
  })
})
