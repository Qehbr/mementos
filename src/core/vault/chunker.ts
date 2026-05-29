/**
 * Sentence-aware chunker for long memories.
 *
 * Splitting at the sentence level (not character N) gives the embedder coherent inputs and
 * the AI human-shaped fragments to retrieve. Each chunk gets its own embedding; all chunks
 * of one memento live INSIDE that memento's single `.mem` file (the `chunks` array) — they
 * are not separate files. This chunker only splits text; the Vault embeds each chunk and
 * zips text+vector into the `MemChunk[]` payload.
 *
 * The 1600-char limit targets all-MiniLM-L6-v2's effective context (~400 tokens at ~4
 * chars/token, with headroom under the model's 512-token window). It applies uniformly to
 * every embedder today; an embedder with a much larger context (e.g. OpenAI at 8192 tokens)
 * gets sub-optimal chunking but never exceeds its limit. If/when that becomes a real cost
 * for users, move this onto the EmbeddingProvider interface (`readonly maxChars: number`).
 */

import type { MemChunk } from './types.js'

/** Maximum characters per chunk. Texts longer than this are split. */
export const CHUNK_CHAR_LIMIT = 1600

/**
 * Zip aligned chunk texts with their embedding vectors into the on-disk `MemChunk[]`. The
 * `Array.from` is load-bearing: it coerces the embedder's `Float32Array` into the plain
 * `number[]` that gets `JSON.stringify`'d into the `.mem` blob. One source for that encoding
 * so the write/update/ingest paths and the embedder-migration transform can't disagree on it.
 */
export function buildChunks(texts: string[], vectors: Float32Array[]): MemChunk[] {
  return texts.map((text, i) => ({ text, vector: Array.from(vectors[i]) }))
}

/** Whether `text` exceeds the per-chunk character limit and must be split before storage. */
export function needsChunking(text: string): boolean {
  return text.length > CHUNK_CHAR_LIMIT
}

/**
 * Split a long text into ordered chunks at sentence boundaries where possible. Falls back
 * to word boundaries for sentences longer than the limit, and to character boundaries only
 * for pathological inputs (one giant token).
 *
 * Empty / whitespace-only chunks are dropped.
 */
export function chunkText(text: string): string[] {
  const sentences: string[] = []

  // Treat blank lines as paragraph separators, then split each paragraph on sentence-ending
  // punctuation followed by whitespace and a capital letter or quote.
  for (const para of text.split(/\n{2,}/)) {
    const trimmed = para.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/(?<=[.!?])\s+(?=[A-Z"'])/)
    sentences.push(...parts.filter(s => s.trim()))
  }

  const chunks: string[] = []
  let current = ''

  for (const sentence of sentences) {
    // Sentence is itself longer than the limit — flush the current chunk first, then split.
    if (sentence.length > CHUNK_CHAR_LIMIT) {
      if (current) { chunks.push(current.trim()); current = '' }
      chunks.push(...splitAtWordBoundary(sentence, CHUNK_CHAR_LIMIT))
      continue
    }
    const candidate = current ? `${current} ${sentence}` : sentence
    if (candidate.length > CHUNK_CHAR_LIMIT) {
      chunks.push(current.trim())
      current = sentence
    } else {
      current = candidate
    }
  }

  if (current.trim()) chunks.push(current.trim())
  return chunks.filter(c => c.length > 0)
}

/** Split a sentence longer than `limit` into pieces of ≤ `limit` chars at the last space. */
function splitAtWordBoundary(text: string, limit: number): string[] {
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    const at = remaining.lastIndexOf(' ', limit)
    const cutAt = at > 0 ? at : limit  // no space found — hard cut at the limit
    chunks.push(remaining.slice(0, cutAt).trim())
    remaining = remaining.slice(cutAt).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}
