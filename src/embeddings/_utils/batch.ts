/**
 * Sub-batching for `embedBatch`.
 *
 * `EmbeddingProvider.embedBatch` accepts any number of texts — but the engines underneath
 * have hard limits. `LocalEmbedder` runs the whole batch as one padded ONNX tensor (peak
 * memory and the O(batch × seq²) attention matrix grow with the batch); the OpenAI
 * embeddings endpoint caps a request at 2048 inputs / ~300k tokens. A single large ingest
 * (10k+ sub-chunks) would OOM the former and 400 the latter.
 *
 * `embedInBatches` walks the input, accumulates texts into a sub-batch until the next text
 * would exceed `maxTexts` or `maxChars`, runs `runBatch` per sub-batch, and concatenates
 * the vectors in input order. A single text longer than `maxChars` still goes through
 * alone — splitting one text is the chunker's job, not the embedder's.
 */
export async function embedInBatches(
  texts: string[],
  limits: { maxTexts: number; maxChars?: number },
  runBatch: (batch: string[]) => Promise<Float32Array[]>,
): Promise<Float32Array[]> {
  if (texts.length === 0) return []
  const maxChars = limits.maxChars ?? Infinity
  const out: Float32Array[] = []
  let batch: string[] = []
  let chars = 0

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const vectors = await runBatch(batch)
    if (vectors.length !== batch.length) {
      throw new Error(
        `embedInBatches: runBatch returned ${vectors.length} vectors for ${batch.length} texts`,
      )
    }
    for (const v of vectors) out.push(v)
    batch = []
    chars = 0
  }

  for (const text of texts) {
    // Flush before adding `text` if the current (non-empty) batch is already at the text
    // cap, or adding `text` would push it over the character budget.
    if (batch.length > 0 && (batch.length >= limits.maxTexts || chars + text.length > maxChars)) {
      await flush()
    }
    batch.push(text)
    chars += text.length
  }
  await flush()
  return out
}
