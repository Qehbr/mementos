/** MinilmEmbedder constants — all-MiniLM-L6-v2 via the ONNX runtime. */

/** HuggingFace model id loaded by `@xenova/transformers`. */
export const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

/** all-MiniLM-L6-v2 produces 384-dim vectors. */
export const DIMENSIONS = 384

/**
 * Texts per ONNX forward pass. The pipeline pads a batch to its longest sequence and runs
 * it as one tensor; the attention matrix is O(batch × seq²), so the batch size bounds peak
 * memory. 64 keeps that well under ~1 GB while still getting matmul vectorization —
 * `embedBatch` sub-batches anything larger at this size.
 */
export const BATCH_SIZE = 64
