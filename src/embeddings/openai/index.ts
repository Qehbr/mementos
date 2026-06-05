/**
 * OpenAIEmbedder — embeddings via OpenAI's API.
 *
 * Privacy note: memory text is sent in plaintext to OpenAI's servers for embedding.
 * mementos' encryption protects data at rest, NOT the network call. Use the MinilmEmbedder
 * (default) if you don't want memory content to leave the machine.
 *
 * Default model is `text-embedding-3-small` at 512 dimensions, but any OpenAI embedding
 * model works as long as the dimensionality is fixed at vault creation time.
 */
import type { OpenAI as OpenAIClient } from 'openai'
import type { EmbeddingProvider } from '../interface.js'
import type { InitContext } from '../../core/init-context/interface.js'
import type { EmbedderImplementationModule } from '../registry.js'
import { ensurePackage, requireFromPlugins } from '../../core/plugins.js'
import { embedInBatches } from '../_utils/batch.js'
import { DEFAULT_MODEL, DEFAULT_DIMENSIONS, MAX_TEXTS, MAX_CHARS } from './constants.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'openai'
export function create(): EmbeddingProvider {
  // API key check is deferred to first network call: buildVault constructs the embedder
  // just to read `.dimensions`, so requiring OPENAI_API_KEY at construction would block
  // every command unless the key was set.
  return new OpenAIEmbedder(process.env['OPENAI_API_KEY'] ?? '')
}
export async function setupAtInit(ctx: InitContext): Promise<void> {
  await ensurePackage('openai', s => ctx.print(s))
  if (!process.env['OPENAI_API_KEY']) {
    ctx.warn('Note: OpenAIEmbedder requires OPENAI_API_KEY in the environment at runtime.')
    ctx.warn('You will see errors at startup if it is unset when mementos serve runs.')
  }
}

/** Selection-time warning — mementos's headline is end-to-end encryption, but
 *  this embedder sends raw memento text to OpenAI's API. Users picking openai
 *  to "get better recall" without reading the README would silently forfeit the
 *  property they came for. Surface the trade-off at the moment of decision. */
export function describeSelectionTip(ctx: InitContext): void {
  ctx.print('')
  ctx.print('Note: the openai embedder sends every memento\'s text to OpenAI\'s API for embedding.')
  ctx.print('Encryption protects data AT REST in the vault, but NOT this network call.')
  ctx.print('For full end-to-end privacy, re-run init with --embedder=minilm.')
  ctx.print('')
}

const _shape: EmbedderImplementationModule = { type, create, setupAtInit, describeSelectionTip }

export class OpenAIEmbedder implements EmbeddingProvider {
  readonly dimensions: number
  private client: OpenAIClient | null = null

  constructor(
    private readonly apiKey: string,
    private readonly model = DEFAULT_MODEL,
    dimensions = DEFAULT_DIMENSIONS,
  ) {
    this.dimensions = dimensions
  }

  /** Lazy: avoids loading the openai SDK until first call. Client is reused across requests. */
  private async getClient(): Promise<OpenAIClient> {
    if (this.client) return this.client
    if (!this.apiKey) throw new Error('OpenAIEmbedder requires OPENAI_API_KEY env var')
    const { OpenAI } = requireFromPlugins('openai') as typeof import('openai')
    this.client = new OpenAI({ apiKey: this.apiKey })
    return this.client
  }

  async embed(text: string): Promise<Float32Array> {
    const client = await this.getClient()
    const response = await client.embeddings.create({
      model: this.model,
      input: text,
      dimensions: this.dimensions,
    })
    return new Float32Array(response.data[0].embedding)
  }

  /**
   * Batched embedding. Accepts any number of texts: the input is sub-batched under the
   * API's per-request limits, one request per sub-batch — still far cheaper than per-text
   * round trips, and a very-large ingest can't 400 on an oversized request.
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return embedInBatches(
      texts,
      { maxTexts: MAX_TEXTS, maxChars: MAX_CHARS },
      b => this.runBatch(b),
    )
  }

  /** One embeddings request for a bounded sub-batch. */
  private async runBatch(texts: string[]): Promise<Float32Array[]> {
    const client = await this.getClient()
    const response = await client.embeddings.create({
      model: this.model,
      input: texts,
      dimensions: this.dimensions,
    })
    // API may return out of order — sort by `.index` to align with input `texts`.
    return response.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map(d => new Float32Array(d.embedding))
  }
}
