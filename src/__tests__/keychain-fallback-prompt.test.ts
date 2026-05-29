/**
 * Unit tests for `confirmFallbackOrThrow` — the policy gate the keychain provider
 * consults before silently downgrading to the chmod-600 fallback file.
 *
 * Tests the three policy values: ask (default, prompts), allow (silent), refuse (throws).
 */
import { describe, it, expect, vi } from 'vitest'
import { confirmFallbackOrThrow } from '../keys/keychain/index.js'

function makeCtx(flags: Record<string, string | undefined> = {}) {
  const prints: string[] = []
  const warns: string[] = []
  return {
    flags,
    prints,
    warns,
    showSecret: async () => {},
    print: (m: string) => { prints.push(m) },
    warn: (m: string) => { warns.push(m) },
    getFlag: (name: string) => flags[name],
    patchMachineConfig: () => {},
  }
}

describe('confirmFallbackOrThrow — keychain-fallback policy', () => {
  it('allow: returns silently, prints nothing', async () => {
    const ctx = makeCtx({ 'keychain-fallback': 'allow' })
    await expect(confirmFallbackOrThrow(ctx as never)).resolves.toBeUndefined()
    expect(ctx.warns).toEqual([])
    expect(ctx.prints).toEqual([])
  })

  it('refuse: throws with actionable message naming the flag and a remediation', async () => {
    const ctx = makeCtx({ 'keychain-fallback': 'refuse' })
    await expect(confirmFallbackOrThrow(ctx as never)).rejects.toThrow(/keychain.*unavailable.*refuse/i)
    await expect(confirmFallbackOrThrow(ctx as never)).rejects.toThrow(/libsecret/i)
    await expect(confirmFallbackOrThrow(ctx as never)).rejects.toThrow(/--keychain-fallback=allow/)
  })

  it('ask (default = no flag): prompts the user and proceeds on yes', async () => {
    vi.doMock('@inquirer/prompts', () => ({
      confirm: vi.fn().mockResolvedValue(true),
    }))
    const { confirmFallbackOrThrow: fn } = await import('../keys/keychain/index.js')
    const ctx = makeCtx()
    await expect(fn(ctx as never)).resolves.toBeUndefined()
    expect(ctx.warns.some(w => w.includes('OS keychain is not available'))).toBe(true)
    expect(ctx.warns.some(w => w.includes('libsecret'))).toBe(true)
    vi.doUnmock('@inquirer/prompts')
  })

  it('ask: throws on no with an actionable message', async () => {
    vi.resetModules()
    vi.doMock('@inquirer/prompts', () => ({
      confirm: vi.fn().mockResolvedValue(false),
    }))
    const { confirmFallbackOrThrow: fn } = await import('../keys/keychain/index.js')
    const ctx = makeCtx()
    await expect(fn(ctx as never)).rejects.toThrow(/aborted at user request/i)
    vi.doUnmock('@inquirer/prompts')
  })

  it('unknown policy value falls through to ask (prompts the user)', async () => {
    vi.resetModules()
    const confirmMock = vi.fn().mockResolvedValue(true)
    vi.doMock('@inquirer/prompts', () => ({ confirm: confirmMock }))
    const { confirmFallbackOrThrow: fn } = await import('../keys/keychain/index.js')
    const ctx = makeCtx({ 'keychain-fallback': 'totally-bogus' })
    await expect(fn(ctx as never)).resolves.toBeUndefined()
    expect(confirmMock).toHaveBeenCalled()
    vi.doUnmock('@inquirer/prompts')
  })
})
