/** OpenAIEmbedder defaults + request caps. */

/** Default embedding model. */
export const DEFAULT_MODEL = 'text-embedding-3-small'

/** Default output vector size. text-embedding-3-* supports tunable dimensions. */
export const DEFAULT_DIMENSIONS = 512

/**
 * OpenAI's embeddings endpoint caps a request at 2048 inputs and ~300k total tokens.
 * `embedBatch` sub-batches to stay well under both: ≤MAX_TEXTS inputs and ~MAX_CHARS
 * characters (~200k tokens at the rough 4-chars-per-token ratio).
 */
export const MAX_TEXTS = 1024
export const MAX_CHARS = 800_000
