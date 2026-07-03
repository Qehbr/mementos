/**
 * Vitest global setup — ensure the optional native/heavyweight packages are
 * installed in `~/.config/mementos/plugins/` before any test runs.
 *
 * The suite exercises code that loads them via `requireFromPlugins` (HNSW
 * index, re2 searchers, git backend, LAN pairing) — the same on-demand
 * location `mementos init` installs into. Installing here, instead of a CI
 * shell step, keeps a single cross-platform mechanism and makes `npm test`
 * work on a fresh clone. No-op when everything already resolves; the first
 * run needs a network and, for hnswlib-node, a C++ toolchain.
 */
import { ensureAllPlugins } from '../core/plugins.js'

export default async function setup(): Promise<void> {
  await ensureAllPlugins(msg => console.log(`[plugins] ${msg}`))
}
