/**
 * Argument-parsing tests for the MCP-parity CLI handlers.
 *
 * Each handler is a thin wrapper that parses argv into MCP tool args, then
 * calls `callTool(name, args)` against the daemon. Two failure modes worth
 * covering at the argv level:
 *   1. Usage errors (missing required positional, empty id) — handler should
 *      print usage to stderr and exit(1) BEFORE touching the daemon.
 *   2. Successful argv parse → daemon call. With no daemon running in tests,
 *      this hits `failNoDaemon` → exit(1) with the "Run `mementos start`"
 *      message. We assert THAT message to verify the parse reached the daemon
 *      step (i.e. argv parsing didn't bail with a usage error along the way).
 *
 * The daemon path itself (callTool over MCP HTTP) is covered by the daemon's
 * own integration smokes.
 */
import { describe, it, expect } from 'vitest'
import { runList, runRecall, runWrite, runUpdate, runChronicle } from '../cli/commands/runtime.js'

/** Run `fn` with `process.exit` and `console.error` stubbed; capture both. */
async function captureExit(fn: () => Promise<void> | void): Promise<{ code: number; errors: string[] }> {
  const errors: string[] = []
  const origExit = process.exit
  const origError = console.error
  let code = 0
  process.exit = ((c?: number) => { code = c ?? 0; throw new Error(`exit:${code}`) }) as never
  console.error = (msg: string) => errors.push(msg)
  try {
    await fn()
    return { code, errors }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('exit:')) return { code, errors }
    throw e
  } finally {
    process.exit = origExit
    console.error = origError
  }
}

describe('CLI handler argv parsing', () => {
  // ─── Usage-error path: argv missing required input → exit BEFORE daemon ──

  it('runRecall errors with usage hint on empty query', async () => {
    const { code, errors } = await captureExit(() => runRecall(undefined, []))
    expect(code).toBe(1)
    expect(errors.join('\n')).toMatch(/Usage: mementos recall/)
  })

  it('runWrite errors with usage hint when stdin is TTY and no positional given', async () => {
    const origIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    try {
      const { code, errors } = await captureExit(() => runWrite(undefined, []))
      expect(code).toBe(1)
      expect(errors.join('\n')).toMatch(/Usage: mementos write/)
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
    }
  })

  it('runUpdate errors with usage hint on empty id', async () => {
    const { code, errors } = await captureExit(() => runUpdate(undefined, []))
    expect(code).toBe(1)
    expect(errors.join('\n')).toMatch(/Usage: mementos update/)
  })

  it('runChronicle errors with usage hint on empty id', async () => {
    const { code, errors } = await captureExit(() => runChronicle(undefined))
    expect(code).toBe(1)
    expect(errors.join('\n')).toMatch(/Usage: mementos chronicle/)
  })

  // ─── Happy-path argv: argv parses cleanly → reaches daemon → no daemon ──
  // The "no mementos daemon running" error message is what argv parsing
  // SUCCESS looks like in unit tests (we don't run a daemon). If a USAGE
  // error fires instead, argv parsing failed earlier — that's the
  // regression we're guarding against.

  it('runRecall: multi-word positional + --k passes argv parsing', async () => {
    const { errors } = await captureExit(() => runRecall('TypeScript', ['project', 'preferences', '--k=3']))
    expect(errors.join('\n')).toMatch(/No mementos daemon running/)
    expect(errors.join('\n')).not.toMatch(/Usage:/)
  })

  it('runList range-mode flags all pass argv parsing', async () => {
    for (const trigger of [['--start=2026-01-01'], ['--end=2026-12-31'], ['--query=foo'], ['--k=5']]) {
      const { errors } = await captureExit(() => runList(undefined, trigger))
      expect(errors.join('\n')).toMatch(/No mementos daemon running/)
    }
  })

  it('runList tag-mode (positional) passes argv parsing', async () => {
    const { errors } = await captureExit(() => runList('preference', ['user']))
    expect(errors.join('\n')).toMatch(/No mementos daemon running/)
  })

  it('runList tag-mode (--tags) passes argv parsing', async () => {
    const { errors } = await captureExit(() => runList(undefined, ['--tags=preference,user']))
    expect(errors.join('\n')).toMatch(/No mementos daemon running/)
  })
})
