/**
 * Refuse to run a vault-rewriting CLI command (migrate, restore) while a `mementos serve`
 * process is alive. A live server holds the in-RAM HNSW index + metaById + searcher state
 * for the pre-rewrite vault; rewriting `.mem` files under it would leave RAM and disk
 * permanently inconsistent (and bypass the per-vault write lock entirely — restore writes
 * through plain `storage.putBatch`, not through `withLock`).
 *
 * Dead PIDs are pruned by `listLiveServes` as a side effect, so a crashed server doesn't
 * block this forever.
 */
import { listLiveServes } from './serve-registry.js'

export async function assertNoServerRunning(action: string): Promise<void> {
  const live = await listLiveServes()
  if (live.length === 0) return
  console.error(`A mementos server is running (PID ${live.join(', ')}).`)
  console.error(`${action} rewrites the vault, and a live server would keep stale state in`)
  console.error('memory + bypass the per-vault write lock. Stop the server first: close the AI')
  console.error('client(s) using mementos (or kill the process), then re-run the command.')
  process.exit(1)
}
