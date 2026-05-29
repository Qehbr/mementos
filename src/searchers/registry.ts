/** Searcher registry — auto-discovers `src/searchers/<name>/index.ts`. */
import { discoverImplementations, type ImplementationModule } from '../core/discovery.js'
import type { Searcher, SearcherFactory } from './interface.js'

export type { SearcherFactory } from './interface.js'

export type SearcherImplementationModule = ImplementationModule<SearcherFactory>

export const loadSearchers = () =>
  discoverImplementations<SearcherFactory>(import.meta.url)

export type { Searcher }
