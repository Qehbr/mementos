/**
 * Verify that each implementation's setupAtInit installs exactly the package it owns
 * and nothing else — picking one impl never drags in another's plugin. The cross-impl
 * checks below (e.g. hnsw doesn't install openai's package) cover this generically.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

const mockEnsurePackage = vi.fn().mockResolvedValue(undefined)

vi.mock('../core/plugins.js', () => ({
  ensurePackage: mockEnsurePackage,
  ensurePluginSetup: (pkg: string) => (c: { print: (s: string) => void }) =>
    mockEnsurePackage(pkg, (s: string) => c.print(s)),
  requireFromPlugins: vi.fn(),
  pluginsDir: () => '/tmp/mock-mementos-plugins',
}))

// Flag-aware: each setupAtInit reads its OWN flag. A blanket return for every flag name
// would make 'git-ssh-key' look like a path and send git/setupAtInit into resolveExistingKey.
const flagValues: Record<string, string | undefined> = { 'git-remote': 'git@github.com:user/vault.git' }
const ctx = {
  print: vi.fn(),
  warn: vi.fn(),
  ask: vi.fn(),
  showSecret: vi.fn(),
  getFlag: vi.fn().mockImplementation((name: string) => flagValues[name]),
  patchMachineConfig: vi.fn(),
}

beforeEach(() => {
  mockEnsurePackage.mockClear()
  vi.clearAllMocks()
  mockEnsurePackage.mockResolvedValue(undefined)
  ctx.getFlag.mockImplementation((name: string) => flagValues[name])
})

describe('selective package installation', () => {
  it('hnsw setupAtInit installs only hnswlib-node', async () => {
    const { setupAtInit } = await import('../vector/hnsw/index.js')
    await setupAtInit(ctx)
    expect(mockEnsurePackage).toHaveBeenCalledOnce()
    expect(mockEnsurePackage).toHaveBeenCalledWith('hnswlib-node', expect.any(Function))
    expect(mockEnsurePackage).not.toHaveBeenCalledWith('openai', expect.any(Function))
  })

  it('git backend setupAtInit installs only simple-git', async () => {
    const { setupAtInit } = await import('../storage/git/index.js')
    await setupAtInit(ctx)
    expect(mockEnsurePackage).toHaveBeenCalledOnce()
    expect(mockEnsurePackage).toHaveBeenCalledWith('simple-git', expect.any(Function))
    expect(mockEnsurePackage).not.toHaveBeenCalledWith('openai', expect.any(Function))
  })

  it('openai embedder setupAtInit installs only openai', async () => {
    const { setupAtInit } = await import('../embeddings/openai/index.js')
    await setupAtInit(ctx)
    expect(mockEnsurePackage).toHaveBeenCalledOnce()
    expect(mockEnsurePackage).toHaveBeenCalledWith('openai', expect.any(Function))
    expect(mockEnsurePackage).not.toHaveBeenCalledWith('simple-git', expect.any(Function))
  })
})
