/**
 * MinilmEmbedder — on-device embeddings via `all-MiniLM-L6-v2` (ONNX runtime).
 *
 * Default embedder: 384-dim, runs on CPU, no API key. Output is mean-pooled and L2-normalized
 * so cosine distance is the natural similarity metric (matches HNSWIndex's `'cosine'` space).
 *
 * The transformers library is loaded lazily on first call — deferring the ~150 MB model
 * download until it's actually needed keeps `mementos` import-time cheap. The model is
 * cached on disk by the library after the first run.
 */
import type { EmbeddingProvider } from '../interface.js'
import type { EmbedderImplementationModule } from '../registry.js'
import type { InitContext } from '../../core/init-context/interface.js'
import { embedInBatches } from '../_utils/batch.js'
import { MODEL_ID, DIMENSIONS, BATCH_SIZE } from './constants.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'minilm'
export function create(): EmbeddingProvider {
  return new MinilmEmbedder()
}
/**
 * Warm the model cache at init: one throwaway embed front-loads the ~150 MB download so
 * the daemon never blocks a first recall (and an online `init` leaves it usable offline).
 */
export async function setupAtInit(ctx: InitContext): Promise<void> {
  ctx.print('Preparing the MiniLM embedding model (all-MiniLM-L6-v2 — first run downloads ~150 MB)...')
  await new MinilmEmbedder().embed('warmup')
  ctx.print('MiniLM embedding model ready.')
}
const _shape: EmbedderImplementationModule = { type, create, setupAtInit }

type Pipeline = (input: string | string[], opts: object) => Promise<{ data: Float32Array }>

export class MinilmEmbedder implements EmbeddingProvider {
  readonly dimensions = DIMENSIONS

  private pipeline: Pipeline | null = null

  private async getPipeline(): Promise<Pipeline> {
    if (this.pipeline) return this.pipeline
    // @xenova/transformers is ESM-only; dynamic import keeps the dependency optional and
    // delays the model download until first embed.
    const { pipeline } = await import('@xenova/transformers')
    this.pipeline = await pipeline('feature-extraction', MODEL_ID) as Pipeline
    return this.pipeline
  }

  async embed(text: string): Promise<Float32Array> {
    const pipe = await this.getPipeline()
    const output = await pipe(text, { pooling: 'mean', normalize: true })
    return output.data
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return embedInBatches(texts, { maxTexts: BATCH_SIZE }, b => this.runBatch(b))
  }

  /** One ONNX forward pass; the returned tensor `.data` is a flat `length × dimensions` array, sliced per-text. */
  private async runBatch(texts: string[]): Promise<Float32Array[]> {
    const pipe = await this.getPipeline()
    const output = await pipe(texts, { pooling: 'mean', normalize: true })
    const result: Float32Array[] = []
    for (let i = 0; i < texts.length; i++) {
      result.push(output.data.slice(i * this.dimensions, (i + 1) * this.dimensions))
    }
    return result
  }
}
