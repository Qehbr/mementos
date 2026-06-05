/**
 * Unit tests for pure helpers in src/cli/_utils/ that don't need stdin or filesystem.
 *
 * `validatePath` is the interactive vault-path prompt's sanitiser — same path through both
 * --flag input and prompt input. Tested here as a pure function to avoid spinning up
 * inquirer.
 */
import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promptChoice, validatePath } from '../cli/_utils/prompts.js'
import type { InitContext } from '../core/init-context/interface.js'
import type { DiscoveredImpl } from '../core/discovery.js'

describe('validatePath', () => {
  it('returns absolute paths unchanged', () => {
    expect(validatePath('/tmp/foo')).toBe('/tmp/foo')
    expect(validatePath('/mnt/nfs/mementos')).toBe('/mnt/nfs/mementos')
  })

  it('expands "~" to homedir', () => {
    expect(validatePath('~')).toBe(homedir())
  })

  it('expands "~/" prefix to homedir', () => {
    expect(validatePath('~/myvault')).toBe(join(homedir(), 'myvault'))
    expect(validatePath('~/.mementos')).toBe(join(homedir(), '.mementos'))
  })

  it('rejects relative paths', () => {
    expect(() => validatePath('relative/path')).toThrow(/must be absolute/)
    expect(() => validatePath('./foo')).toThrow(/must be absolute/)
    expect(() => validatePath('../foo')).toThrow(/must be absolute/)
  })

  it('rejects paths containing null bytes', () => {
    expect(() => validatePath('/tmp/foo\0bar')).toThrow(/null byte/)
  })

  it('does NOT expand bare "~name" (only `~` and `~/` are recognised)', () => {
    // `~root` is a shell-only convention; we treat it as a literal relative segment and reject.
    expect(() => validatePath('~root/foo')).toThrow(/must be absolute/)
  })
})

describe('promptChoice — non-interactive branches', () => {
  type Impl = DiscoveredImpl<unknown>
  /** Strip ANSI escape sequences so assertions compare against the visible
   *  text. promptChoice colours the auto-pick "only option" notice with the
   *  brand-violet theme; the visible content (✔ / type / "(only option)") is
   *  what the test cares about. */
  // eslint-disable-next-line no-control-regex
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
  function ctx(flags: Record<string, string | undefined> = {}): InitContext & { printed: string[] } {
    const printed: string[] = []
    return {
      printed,
      print: (msg: string) => { printed.push(stripAnsi(msg)) },
      warn: () => {},
      showSecret: async () => {},
      getFlag: (name: string) => flags[name],
      patchMachineConfig: () => {},
    }
  }
  function regOf(...types: string[]): Map<string, Impl> {
    return new Map(types.map(t => [t, { type: t } as unknown as Impl]))
  }

  it('returns the flag value directly when --flag=<v> is provided (skips the prompt)', async () => {
    // Even with 3 options, an explicit flag wins — this is the CI / scripted path.
    const c = ctx({ backend: 'git' })
    expect(await promptChoice(c, 'Storage', 'backend', regOf('local', 'git', 'other'), 'local')).toBe('git')
    expect(c.printed).toEqual([])  // no prompt-skip message: there was no prompt to skip
  })

  it('flag overrides the single-entry case (still respects the explicit choice)', async () => {
    // A single-entry registry no longer auto-picks (users see and confirm every choice),
    // but a flag still bypasses the prompt entirely for scripted use.
    const c = ctx({ index: 'forced' })
    expect(await promptChoice(c, 'Vector index', 'index', regOf('hnsw'), 'hnsw')).toBe('forced')
    expect(c.printed).toEqual([])
  })
})
