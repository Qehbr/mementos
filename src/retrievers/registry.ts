/** Retriever registry — auto-discovers `src/retrievers/<name>/index.ts`. */
import { discoverImplementations, type ImplementationModule } from '../core/discovery.js'
import type { Retriever, RetrieverFactory } from './interface.js'

export type { RetrieverFactory } from './interface.js'

export type RetrieverImplementationModule = ImplementationModule<RetrieverFactory>

export const loadRetrievers = () =>
  discoverImplementations<RetrieverFactory>(import.meta.url)

export type { Retriever }
