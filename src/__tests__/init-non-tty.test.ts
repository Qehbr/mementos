/**
 * The init wizard must not open a prompt it cannot get an answer to.
 *
 * `@inquirer/prompts` rejects with `ExitPromptError` on a non-TTY stdin, which the CLI
 * entry treats as a user-pressed-Ctrl-C: a bare exit 130 plus Node's "unsettled top-level
 * await" warning, naming nothing. Any scripted install — Docker, CI — hits that the moment
 * one flag is missing, and the exit code says SIGINT rather than "you skipped a flag".
 */
import { describe, it, expect, afterEach } from 'vitest'
import { promptPath } from '../cli/_utils/prompts.js'
import { setFakeTTY } from './_utils/fake-tty.js'
import type { InitContext } from '../core/init-context/interface.js'

let restoreTTY: (() => void) | null = null
afterEach(() => { restoreTTY?.(); restoreTTY = null })

/** Minimal InitContext — only `getFlag` is consulted before the guard fires. */
const ctx = (flag?: string): InitContext =>
  ({ getFlag: () => flag, print: () => {}, warn: () => {} }) as unknown as InitContext

describe('prompting without a terminal', () => {
  it('names the flag that would have answered the prompt', async () => {
    restoreTTY = setFakeTTY(false)
    await expect(promptPath(ctx(undefined), 'Where should the vault live?', 'vault-path', '/tmp/v'))
      .rejects.toThrow(/--vault-path/)
  })

  it('says stdin is not a terminal rather than failing opaquely', async () => {
    restoreTTY = setFakeTTY(false)
    await expect(promptPath(ctx(undefined), 'Where should the vault live?', 'vault-path', '/tmp/v'))
      .rejects.toThrow(/not a terminal/)
  })

  it('stays out of the way when the flag supplies the answer', async () => {
    restoreTTY = setFakeTTY(false)
    await expect(promptPath(ctx('/tmp/from-flag'), 'Where should the vault live?', 'vault-path', '/tmp/v'))
      .resolves.toBe('/tmp/from-flag')
  })
})
