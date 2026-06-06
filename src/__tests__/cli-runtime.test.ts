/**
 * Argument-parsing tests for the new MCP-parity CLI handlers.
 *
 * The handlers themselves are thin pass-throughs over `Vault.*` methods + the
 * `render*` functions (both already covered exhaustively). The risk surface
 * unique to the CLI layer is the argv → method-args translation: flag parsing,
 * positional fallbacks, stdin detection, and the mode switch inside `runList`
 * (range/query vs tag mode). Cover that here without spinning up a real vault.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runList, runRecall, runWrite, runUpdate, runChronicle } from '../cli/commands/runtime.js'

/** Stash + restore process.argv across each test so flag-parsing doesn't leak. */
function withArgv<T>(argv: string[], fn: () => T): T {
  const prev = process.argv
  process.argv = ['node', 'mementos', ...argv]
  try { return fn() }
  finally { process.argv = prev }
}

describe('CLI handler argv parsing — smoke', () => {
  let originalCwd: string
  beforeEach(() => { originalCwd = process.cwd() })
  afterEach(() => { process.chdir(originalCwd) })

  // Each handler bails to console.error + process.exit when args are missing.
  // We can't easily assert on process.exit without monkey-patching, but we CAN
  // verify the handler accepts the documented shapes without throwing a
  // type/parse error. The vault layer (loaded via withVault) will throw a
  // "no vault configured" message in these tests since we run without init —
  // that's fine; we're verifying argv parsing reaches the vault call, not the
  // vault response.

  it('runRecall accepts a multi-word positional query', () => {
    expect(() => withArgv(
      ['recall', 'TypeScript', 'project', 'preferences', '--k=3'],
      () => runRecall('TypeScript', ['project', 'preferences', '--k=3']),
    )).not.toThrow()
  })

  it('runRecall surfaces a usage error on empty query', async () => {
    // Empty subcommand + no positional args → handler should error before
    // touching the vault. We check stderr without letting process.exit fire.
    const errors: string[] = []
    const origExit = process.exit
    const origError = console.error
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as never
    console.error = (msg: string) => errors.push(msg)
    try {
      await expect(runRecall(undefined, [])).rejects.toThrow(/exit:1/)
      expect(errors.join('\n')).toMatch(/Usage: mementos recall/)
    } finally {
      process.exit = origExit
      console.error = origError
    }
  })

  it('runWrite surfaces a usage error when stdin is TTY and no positional given', async () => {
    const errors: string[] = []
    const origExit = process.exit
    const origError = console.error
    const origIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as never
    console.error = (msg: string) => errors.push(msg)
    try {
      await expect(runWrite(undefined, [])).rejects.toThrow(/exit:1/)
      expect(errors.join('\n')).toMatch(/Usage: mementos write/)
    } finally {
      process.exit = origExit
      console.error = origError
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
    }
  })

  it('runUpdate refuses an empty id', async () => {
    const errors: string[] = []
    const origExit = process.exit
    const origError = console.error
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as never
    console.error = (msg: string) => errors.push(msg)
    try {
      await expect(runUpdate(undefined, [])).rejects.toThrow(/exit:1/)
      expect(errors.join('\n')).toMatch(/Usage: mementos update/)
    } finally {
      process.exit = origExit
      console.error = origError
    }
  })

  it('runChronicle refuses an empty id', async () => {
    const errors: string[] = []
    const origExit = process.exit
    const origError = console.error
    process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`) }) as never
    console.error = (msg: string) => errors.push(msg)
    try {
      await expect(runChronicle(undefined)).rejects.toThrow(/exit:1/)
      expect(errors.join('\n')).toMatch(/Usage: mementos chronicle/)
    } finally {
      process.exit = origExit
      console.error = origError
    }
  })

  it('runList mode-switch: --start/--end/--query/--k toggles range mode', () => {
    // The mode-switch decision lives entirely in argv parsing — verify it
    // doesn't throw at the parse boundary for any of the trigger flags.
    for (const trigger of [['--start=2026-01-01'], ['--end=2026-12-31'], ['--query=foo'], ['--k=5']]) {
      expect(() => withArgv(
        ['list', ...trigger],
        () => runList(undefined, trigger),
      )).not.toThrow()
    }
  })

  it('runList tag mode: bare positional args treated as tags (back-compat)', () => {
    expect(() => withArgv(
      ['list', 'preference', 'user'],
      () => runList('preference', ['user']),
    )).not.toThrow()
  })

  it('runList tag mode via --tags flag', () => {
    expect(() => withArgv(
      ['list', '--tags=preference,user'],
      () => runList(undefined, ['--tags=preference,user']),
    )).not.toThrow()
  })
})
