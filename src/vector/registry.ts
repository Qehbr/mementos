/**
 * Vector index registry — auto-discovers `src/vector/<name>/index.ts`.
 */
import { discoverImplementations, type ImplementationModule } from '../core/discovery.js'
import type { VectorIndex } from './interface.js'

export type VectorIndexFactory = (dimensions: number) => VectorIndex

export type VectorIndexImplementationModule = ImplementationModule<VectorIndexFactory>

export const loadVectorIndexes = () =>
  discoverImplementations<VectorIndexFactory>(import.meta.url)
