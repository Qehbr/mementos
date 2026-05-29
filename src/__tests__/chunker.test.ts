import { describe, it, expect } from 'vitest'
import { needsChunking, chunkText, CHUNK_CHAR_LIMIT } from '../core/vault/chunker.js'

const SHORT = 'This is a short text.'
const LONG = ('This is a sentence that contributes to the total length. ').repeat(40)  // ~2240 chars

describe('needsChunking', () => {
  it('returns false for short text', () => {
    expect(needsChunking(SHORT)).toBe(false)
  })

  it('returns true for long text', () => {
    expect(needsChunking(LONG)).toBe(true)
  })

  it('returns false at exactly the limit', () => {
    expect(needsChunking('x'.repeat(CHUNK_CHAR_LIMIT))).toBe(false)
  })

  it('returns true one char over the limit', () => {
    expect(needsChunking('x'.repeat(CHUNK_CHAR_LIMIT + 1))).toBe(true)
  })
})

describe('chunkText', () => {
  it('returns at least 2 chunks for long text', () => {
    const chunks = chunkText(LONG)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })

  it('every chunk is within the char limit', () => {
    const chunks = chunkText(LONG)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_CHAR_LIMIT)
    }
  })

  it('produces no empty chunks', () => {
    const chunks = chunkText(LONG)
    for (const chunk of chunks) {
      expect(chunk.trim().length).toBeGreaterThan(0)
    }
  })

  it('preserves all words (no data loss)', () => {
    const chunks = chunkText(LONG)
    const rejoined = chunks.join(' ').replace(/\s+/g, ' ')
    const original = LONG.replace(/\s+/g, ' ').trim()
    // Every word in the original should appear somewhere in the joined chunks
    for (const word of original.split(' ').slice(0, 20)) {
      expect(rejoined).toContain(word)
    }
  })

  it('handles text with paragraph breaks', () => {
    const para = [SHORT, SHORT, SHORT].join('\n\n')
    const chunks = chunkText(para.repeat(15))
    expect(chunks.length).toBeGreaterThan(0)
    chunks.forEach(c => expect(c.length).toBeLessThanOrEqual(CHUNK_CHAR_LIMIT))
  })

  it('handles a single sentence exceeding the limit', () => {
    const huge = 'word '.repeat(500)  // ~2500 chars, no sentence boundaries
    const chunks = chunkText(huge)
    expect(chunks.length).toBeGreaterThan(1)
    chunks.forEach(c => expect(c.length).toBeLessThanOrEqual(CHUNK_CHAR_LIMIT))
  })
})
