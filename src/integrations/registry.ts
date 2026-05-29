/**
 * Client integration registry — auto-discovers `src/integrations/<name>/index.ts`.
 *
 * Unlike storage/embedder/key registries (where the CLI picks ONE), the init flow
 * iterates over every discovered integration to install them all (or a user-filtered
 * subset via `--integrations=name1,name2`).
 */
import { discoverImplementations, type ImplementationModule } from '../core/discovery.js'
import type { ClientIntegration } from './interface.js'

export type IntegrationFactory = () => ClientIntegration

export type IntegrationImplementationModule = ImplementationModule<IntegrationFactory>

export const loadIntegrations = () =>
  discoverImplementations<IntegrationFactory>(import.meta.url)
