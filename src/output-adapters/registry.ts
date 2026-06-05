/**
 * Output adapter registry — auto-discovers `src/output-adapters/<name>/index.ts`.
 */
import { discoverImplementations, type ImplementationModule } from '../core/discovery.js'
import type { OutputAdapter } from './interface.js'

export type OutputAdapterFactory = () => OutputAdapter

export type OutputAdapterImplementationModule = ImplementationModule<OutputAdapterFactory>

export const loadOutputAdapters = () =>
  discoverImplementations<OutputAdapterFactory>(import.meta.url)
