/**
 * EmbeddingProvider — abstracts the model that turns text into a vector.
 *
 * Each provider produces vectors of a fixed dimensionality (`dimensions`). This is stored in
 * `config.json` at vault creation time and cannot change later — the on-disk vectors are
 * incomparable across different models, and the HNSW index is built for one specific
 * dimension.
 *
 * Concrete implementations: LocalEmbedder (ONNX, on-device), OpenAIEmbedder (API).
 */

export interface EmbeddingProvider {
  /** Output vector dimensionality. Must match `Config.dimensions`. */
  readonly dimensions: number

  /** Embed one piece of text into a Float32Array of length `dimensions`. */
  embed(text: string): Promise<Float32Array>

  /**
   * Embed several texts at once, returning one vector per input in order. Used by the Vault
   * for chunked writes and bulk ingest. API-backed providers (OpenAI) save API calls;
   * on-device providers (LocalEmbedder) get matmul vectorization across the batch.
   *
   * Must accept an input of ANY size — a large ingest can hand it 10k+ texts. The
   * underlying engines have hard limits (ONNX memory, the OpenAI per-request cap), so an
   * implementation sub-batches internally (see `embedInBatches`). A provider with no native
   * batch path can implement this as `Promise.all(texts.map(this.embed))`.
   */
  embedBatch(texts: string[]): Promise<Float32Array[]>
}
