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
 *
 * Teardown wipes the scratch root. Individual tests clean up their own
 * directories, but any test that fails or is interrupted before its cleanup
 * leaks one — unswept, those accumulate into thousands of stale fake HOMEs
 * and bare git repos that slow every subsequent tool run over the tree.
 */
import { rm } from 'node:fs/promises'

import { ensureAllPlugins } from '../core/plugins.js'
import { TMP_ROOT } from './_utils/tmp-root.js'

/** Returns the teardown hook — vitest only honours a named `teardown` export when the
 *  setup is also a named export, so a default-exporting setup must return it. */
export default async function setup(): Promise<() => Promise<void>> {
  await ensureAllPlugins(msg => console.log(`[plugins] ${msg}`))
  return async () => {
    await rm(TMP_ROOT, { recursive: true, force: true })
  }
}
