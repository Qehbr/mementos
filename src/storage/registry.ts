/**
 * Storage backend registry — auto-discovers any subdirectory of `src/storage/` whose
 * `index.ts` exports `type` (string) and `create` (factory). Adding a new backend means
 * dropping a new folder; no edits to this file or to the CLI.
 */
import { discoverImplementations, type ImplementationModule } from '../core/discovery.js'
import type { StorageBackend } from './interface.js'
import type { MachineConfig } from '../core/types.js'

export type StorageFactory = (machine: MachineConfig) => StorageBackend

export type StorageImplementationModule = ImplementationModule<StorageFactory>

export const loadStorageBackends = () =>
  discoverImplementations<StorageFactory>(import.meta.url)
