import { vi, describe, it, expect, beforeEach } from 'vitest'

const mockCreate = vi.fn()

// openai is now an on-demand peer dep loaded via requireFromPlugins. Mock the
// plugins module so the test doesn't need the package installed in pluginsDir.
vi.mock('../core/plugins.js', () => ({
  requireFromPlugins: (name: string) => {
    if (name === 'openai') {
      class OpenAI {
        embeddings = { create: mockCreate }
        constructor() {}
      }
      return { OpenAI }
    }
    throw new Error(`Unexpected requireFromPlugins call for: ${name}`)
  },
  ensurePackage: vi.fn().mockResolvedValue(undefined),
  pluginsDir: () => '/tmp/mock-mementos-plugins',
}))

describe('OpenAIEmbedder', () => {
  beforeEach(() => {
    mockCreate.mockReset()
    mockCreate.mockImplementation(({ input, dimensions }: { input: string | string[], dimensions: number }) => {
      const texts = Array.isArray(input) ? input : [input]
      // Each item carries an `index` — the real API does, and runBatch sorts on it.
      return Promise.resolve({
        data: texts.map((_, i) => ({ index: i, embedding: Array(dimensions).fill(0.1) })),
      })
    })
  })

  it('returns a Float32Array of the configured dimensions', async () => {
    const { OpenAIEmbedder } = await import('../embeddings/openai/index.js')
    const embedder = new OpenAIEmbedder('test-key', 'text-embedding-3-small', 512)
    const result = await embedder.embed('hello world')
    expect(result).toBeInstanceOf(Float32Array)
    expect(result.length).toBe(512)
  })

  it('reuses the same client across calls', async () => {
    const { OpenAIEmbedder } = await import('../embeddings/openai/index.js')
    const embedder = new OpenAIEmbedder('test-key')
    await embedder.embed('first')
    await embedder.embed('second')
    expect(mockCreate).toHaveBeenCalledTimes(2)  // two embed calls, one client
  })

  it('embedBatch returns one vector per text', async () => {
    const { OpenAIEmbedder } = await import('../embeddings/openai/index.js')
    const embedder = new OpenAIEmbedder('test-key', 'text-embedding-3-small', 256)
    const results = await embedder.embedBatch(['one', 'two', 'three'])
    expect(results).toHaveLength(3)
    results.forEach(r => {
      expect(r).toBeInstanceOf(Float32Array)
      expect(r.length).toBe(256)
    })
  })

  it('embedBatch sub-batches an input larger than the per-request cap', async () => {
    const { OpenAIEmbedder } = await import('../embeddings/openai/index.js')
    const embedder = new OpenAIEmbedder('test-key', 'text-embedding-3-small', 64)
    // 2500 texts exceed the 1024-input cap → 3 requests (1024 + 1024 + 452).
    const texts = Array.from({ length: 2500 }, (_, i) => `t${i}`)
    const results = await embedder.embedBatch(texts)
    expect(results).toHaveLength(2500)
    expect(mockCreate).toHaveBeenCalledTimes(3)
    for (const call of mockCreate.mock.calls) {
      expect((call[0] as { input: string[] }).input.length).toBeLessThanOrEqual(1024)
    }
  })

  it('embedBatch reorders results by the response index', async () => {
    const { OpenAIEmbedder } = await import('../embeddings/openai/index.js')
    // Mock returns items out of order; runBatch must sort them back by `index`.
    mockCreate.mockImplementationOnce(({ input, dimensions }: { input: string[], dimensions: number }) => ({
      data: input
        .map((_, i) => ({ index: i, embedding: Array(dimensions).fill(i) }))
        .reverse(),
    }))
    const embedder = new OpenAIEmbedder('test-key', 'text-embedding-3-small', 4)
    const results = await embedder.embedBatch(['a', 'b', 'c'])
    expect(results.map(r => r[0])).toEqual([0, 1, 2])
  })
})
