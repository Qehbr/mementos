/**
 * Unit test for probeKeyAgainstVault — the join-time guard that catches a stale leftover
 * key on the joining machine (so the user sees the failure during init instead of via
 * an unrelated "decrypt probe failed" message from `mementos doctor` an hour later).
 *
 * The success path is covered by the cross-device integration tests (machine A writes,
 * machine B joins with the same key, recall returns A's memory). This file covers the
 * failure path that's invisible to the rest of the suite.
 */
import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { probeKeyAgainstVault } from '../cli/commands/init.js'
import { encryptMemPayloads } from '../core/vault/aad.js'
import { deriveKeyFromEntropy } from '../keys/_utils/derivation/index.js'
import type { StorageBackend, FileStat } from '../storage/interface.js'

/** Minimal in-memory storage with just the methods probeKeyAgainstVault touches. */
function memStorage(files: Map<string, Buffer>): StorageBackend {
  return {
    init: async () => {},
    sync: async () => {},
    list: async () => [...files.keys()],
    get: async (path: string) => {
      const data = files.get(path)
      if (!data) throw new Error(`not found: ${path}`)
      return { data, etag: '1' }
    },
    put: async () => ({ mtimeMs: 0 }),
    putBatch: async () => [],
    stat: async (): Promise<FileStat> => ({ mtimeMs: 0 }),
    delete: async () => {},
    describeStoredData: async () => 'in-memory',
    migrate: async () => {},
  }
}

function fakeCtx(printed: string[]): import('../cli/init-context.js').CliInitContext {
  return {
    print: (m: string) => { printed.push(m) },
    warn: () => {},
    showSecret: async () => {},
    getFlag: () => undefined,
    patchMachineConfig: () => {},
    applyPatches: () => {},
  } as unknown as import('../cli/init-context.js').CliInitContext
}

/** Write a `.mem` file payload encrypted under `key`. */
function makeMemFile(id: string, key: Buffer): Buffer {
  const chunks = Buffer.from(JSON.stringify([{ text: 'hello', vector: [0, 0, 0, 1] }]))
  const meta = Buffer.from(JSON.stringify({
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    tags: [],
  }))
  const encrypted = encryptMemPayloads(id, key, { chunks, meta })
  return Buffer.from(JSON.stringify({ id, chunks: encrypted.chunks, meta: encrypted.meta }))
}

describe('probeKeyAgainstVault', () => {
  it('passes silently when the key decrypts a .mem from storage', async () => {
    const key = deriveKeyFromEntropy(randomBytes(32))
    const id = '11111111-1111-1111-1111-111111111111'
    const storage = memStorage(new Map([[`${id}.mem`, makeMemFile(id, key)]]))
    const printed: string[] = []
    await expect(probeKeyAgainstVault(fakeCtx(printed), storage, key, false)).resolves.toBeUndefined()
    expect(printed.some(l => /verified/i.test(l))).toBe(true)
  })

  it('no-ops on an empty vault (nothing to probe — first writes surface mismatches themselves)', async () => {
    const key = deriveKeyFromEntropy(randomBytes(32))
    const storage = memStorage(new Map())  // no .mem files yet
    await expect(probeKeyAgainstVault(fakeCtx([]), storage, key, true)).resolves.toBeUndefined()
  })

  it('throws stale-machine-key error when keptExisting=true and the key does not decrypt', async () => {
    const realKey = deriveKeyFromEntropy(randomBytes(32))
    const wrongKey = deriveKeyFromEntropy(randomBytes(32))  // different leftover key
    const id = '22222222-2222-2222-2222-222222222222'
    const storage = memStorage(new Map([[`${id}.mem`, makeMemFile(id, realKey)]]))
    await expect(
      probeKeyAgainstVault(fakeCtx([]), storage, wrongKey, true),
    ).rejects.toThrow(/leftover from a previous mementos install/)
  })

  it('throws import-mismatch error when keptExisting=false (user typed the wrong mnemonic)', async () => {
    const realKey = deriveKeyFromEntropy(randomBytes(32))
    const wrongKey = deriveKeyFromEntropy(randomBytes(32))
    const id = '33333333-3333-3333-3333-333333333333'
    const storage = memStorage(new Map([[`${id}.mem`, makeMemFile(id, realKey)]]))
    await expect(
      probeKeyAgainstVault(fakeCtx([]), storage, wrongKey, false),
    ).rejects.toThrow(/key you provided does NOT decrypt/)
  })
})
