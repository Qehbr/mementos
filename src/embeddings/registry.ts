/**
 * Embedding provider registry — auto-discovers `src/embeddings/<name>/index.ts`.
 */
import { discoverImplementations, type ImplementationModule } from '../core/discovery.js'
import type { EmbeddingProvider } from './interface.js'

export type EmbedderFactory = () => EmbeddingProvider

export type EmbedderImplementationModule = ImplementationModule<EmbedderFactory>

export const loadEmbedders = () =>
  discoverImplementations<EmbedderFactory>(import.meta.url)
