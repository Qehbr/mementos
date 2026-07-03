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
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { runList, runRecall, runWrite, runUpdate, runChronicle, translateMcpToCli } from '../cli/commands/runtime.js'
import { TMP_ROOT } from './integration/_helpers.js'
import { setFakeHome } from './_utils/fake-home.js'

/**
 * Run `fn` under a fresh empty fake home. The daemon client resolves its
 * state/token files from `homedir()` at call time, so an empty home is a
 * deterministic "no daemon" — without this, a live daemon on the developer's
 * machine (contributors are users) answers the request and the expected
 * failure never fires.
 */
async function withTmpHome(fn: () => Promise<void>): Promise<void> {
  await mkdir(TMP_ROOT, { recursive: true })
  const dir = await mkdtemp(join(TMP_ROOT, 'cli-home-'))
  const restoreHome = setFakeHome(dir)
  try {
    await fn()
  } finally {
    restoreHome()
    await rm(dir, { recursive: true, force: true })
  }
}

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

  it('runRecall: multi-word positional + --k passes argv parsing', () => withTmpHome(async () => {
    const { errors } = await captureExit(() => runRecall('TypeScript', ['project', 'preferences', '--k=3']))
    expect(errors.join('\n')).toMatch(/No mementos daemon running/)
    expect(errors.join('\n')).not.toMatch(/Usage:/)
  }))

  it('runList range-mode flags all pass argv parsing', () => withTmpHome(async () => {
    for (const trigger of [['--start=2026-01-01'], ['--end=2026-12-31'], ['--query=foo'], ['--k=5']]) {
      const { errors } = await captureExit(() => runList(undefined, trigger))
      expect(errors.join('\n')).toMatch(/No mementos daemon running/)
    }
  }))

  it('runList tag-mode (positional) passes argv parsing', () => withTmpHome(async () => {
    const { errors } = await captureExit(() => runList('preference', ['user']))
    expect(errors.join('\n')).toMatch(/No mementos daemon running/)
  }))

  it('runList tag-mode (--tags) passes argv parsing', () => withTmpHome(async () => {
    const { errors } = await captureExit(() => runList(undefined, ['--tags=preference,user']))
    expect(errors.join('\n')).toMatch(/No mementos daemon running/)
  }))
})

describe('translateMcpToCli', () => {
  // The daemon-side error messages are authored for the AI (MCP tool names);
  // the CLI surface needs runnable shell commands. The translator rewrites
  // known patterns; anything else passes through unchanged.

  it('rewrites the duplicate-memento guidance to runnable CLI commands', () => {
    const ai = 'Similar memento exists (id=abc-123). Call get_memento("abc-123") to read its current text, then update_memento("abc-123", merged_text) to refine it.'
    const cli = translateMcpToCli(ai)
    expect(cli).toContain('mementos get abc-123')
    expect(cli).toContain('mementos update abc-123 "<text>"')
    expect(cli).not.toContain('get_memento(')
    expect(cli).not.toContain('update_memento(')
  })

  it('rewrites the stale-update guidance', () => {
    const ai = 'Memento abc-123 changed since you read it — re-read with get_memento("abc-123") and re-apply.'
    expect(translateMcpToCli(ai)).toContain('mementos get abc-123')
  })

  it('accepts single quotes (ReservedIndexTagError uses them)', () => {
    const ai = `The '_index' tag is reserved. Use update_memento('abc-123') to revise the existing index instead.`
    const cli = translateMcpToCli(ai)
    expect(cli).toContain('mementos update abc-123 "<text>"')
  })

  it('rewrites update_memory_index for the CLI', () => {
    const ai = 'No memory index yet. Create one with update_memory_index(<text>).'
    expect(translateMcpToCli(ai)).toContain('mementos index "<text>"')
  })

  it('rewrites the tag-filter empty-result hint (get_tags → mementos tags)', () => {
    // The list_mementos tag-empty branch surfaces this to nudge the consumer at
    // the get_tags listing — the CLI surface needs the runnable command name.
    const ai = 'No mementos match those tags within the given window. Call get_tags to see which tags exist (the spelling may differ).'
    const cli = translateMcpToCli(ai)
    expect(cli).toContain('Call mementos tags to see')
    expect(cli).not.toContain('get_tags')
  })

  it('leaves messages without MCP forms untouched', () => {
    const ai = 'Memory not found: abc-123\n  (id may be wrong, the memento may have been deleted — call recall to find it by content, or sync then retry)'
    // "call recall" reads naturally as either MCP or CLI verb; no rewrite needed.
    expect(translateMcpToCli(ai)).toBe(ai)
  })
})
