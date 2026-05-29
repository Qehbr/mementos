/**
 * Key provider registry — auto-discovers `src/keys/<name>/index.ts`. Folders starting with
 * underscore (e.g. `_utils/`) are skipped, so the shared HKDF derivation isn't mistaken
 * for an implementation. `mnemonic/` is test-only and doesn't export `type`/`create`,
 * so it's silently skipped too.
 */
import { discoverImplementations, type ImplementationModule } from '../core/discovery.js'
import type { KeyProvider } from './interface.js'

export type KeyProviderFactory = () => KeyProvider

export type KeyProviderImplementationModule = ImplementationModule<KeyProviderFactory>

export const loadKeyProviders = () =>
  discoverImplementations<KeyProviderFactory>(import.meta.url)
