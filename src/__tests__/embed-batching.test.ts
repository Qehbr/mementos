/**
 * Unit tests for `embedInBatches` — the sub-batching helper that lets `embedBatch` accept
 * an arbitrarily large input without OOMing the local ONNX pass or exceeding the OpenAI
 * per-request cap.
 *
 * The fake `runBatch` encodes `Number(text)` into a 1-element vector, so the output order
 * can be verified against the input order, and records every sub-batch it received.
 */
import { describe, it, expect, vi } from 'vitest'
import { embedInBatches } from '../embeddings/_utils/batch.js'

function makeRunBatch() {
  const calls: string[][] = []
  const runBatch = vi.fn((batch: string[]) => {
    calls.push([...batch])
    return Promise.resolve(batch.map(t => Float32Array.of(Number(t))))
  })
  return { runBatch, calls }
}

describe('embedInBatches', () => {
  it('returns empty for empty input and never calls runBatch', async () => {
    const { runBatch } = makeRunBatch()
    expect(await embedInBatches([], { maxTexts: 4 }, runBatch)).toEqual([])
    expect(runBatch).not.toHaveBeenCalled()
  })

  it('runs a single sub-batch when the input fits maxTexts', async () => {
    const { runBatch, calls } = makeRunBatch()
    const out = await embedInBatches(['0', '1', '2'], { maxTexts: 8 }, runBatch)
    expect(calls).toEqual([['0', '1', '2']])
    expect(out.map(v => v[0])).toEqual([0, 1, 2])
  })

  it('splits into ceil(N / maxTexts) sub-batches, preserving order', async () => {
    const { runBatch, calls } = makeRunBatch()
    const texts = Array.from({ length: 10 }, (_, i) => String(i))
    const out = await embedInBatches(texts, { maxTexts: 4 }, runBatch)
    expect(calls.map(c => c.length)).toEqual([4, 4, 2])
    expect(out.map(v => v[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('flushes early when maxChars would be exceeded', async () => {
    const { runBatch, calls } = makeRunBatch()
    // texts are 3 chars each; maxChars 7 holds 2 (6 chars) — a 3rd (9) overflows.
    const out = await embedInBatches(['000', '001', '002', '003', '004'], { maxTexts: 999, maxChars: 7 }, runBatch)
    expect(calls.map(c => c.length)).toEqual([2, 2, 1])
    expect(out.map(v => v[0])).toEqual([0, 1, 2, 3, 4])
  })

  it('sends a single over-budget text through on its own', async () => {
    const { runBatch, calls } = makeRunBatch()
    const big = '0'.repeat(49) + '5' // length 50, Number() === 5
    const out = await embedInBatches(['1', big, '2'], { maxTexts: 999, maxChars: 10 }, runBatch)
    expect(calls).toEqual([['1'], [big], ['2']])
    expect(out.map(v => v[0])).toEqual([1, 5, 2])
  })

  it('throws if runBatch returns the wrong number of vectors', async () => {
    const bad = (batch: string[]) => Promise.resolve(batch.slice(1).map(() => Float32Array.of(0)))
    await expect(embedInBatches(['a', 'b'], { maxTexts: 8 }, bad)).rejects.toThrow(/returned 1 vectors for 2/)
  })
})
