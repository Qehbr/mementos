/** Ingestor registry — auto-discovers `src/ingestors/<name>/index.ts`. */
import { discoverImplementations, type ImplementationModule } from '../core/discovery.js'
import type { Ingestor, IngestorFactory } from './interface.js'

export type { IngestorFactory } from './interface.js'

export type IngestorImplementationModule = ImplementationModule<IngestorFactory>

export const loadIngestors = () =>
  discoverImplementations<IngestorFactory>(import.meta.url)

export type { Ingestor }
