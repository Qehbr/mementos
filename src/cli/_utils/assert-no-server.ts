/**
 * Refuse to run a state-mutating CLI command (init, migrate, restore, destroy)
 * while the daemon is alive. Three distinct failure modes the guard prevents:
 *
 *   - init (--reinit): rewrites the on-disk MachineConfig while the running
 *     daemon still holds its at-startup StorageBackend / EmbeddingProvider /
 *     KeyProvider / VectorIndex instances. A user switching backend
 *     `local` → `git` keeps a stale `LocalBackend` daemon serving — every
 *     subsequent write goes to disk but never to git, silently producing
 *     17,000 untracked working-tree files. (Real failure that motivated
 *     adding the guard here.)
 *
 *   - migrate / restore: rewrite `.mem` files (or commit a new key/embedder)
 *     under the live daemon's feet. The daemon holds the in-RAM HNSW index +
 *     metaById + searcher state for the pre-rewrite vault, and the rewrite
 *     path bypasses the per-vault write lock entirely (restore writes
 *     through plain `storage.putBatch`, not through `withLock`), so the
 *     two states diverge permanently.
 *
 *   - destroy: removes `~/.config/mementos/` — which holds the daemon's PID
 *     file AND its bearer-token file. The running daemon keeps its in-RAM
 *     token valid, but every NEW client reads the token from disk → ENOENT
 *     → DaemonUnavailableError; `mementos stop` can't find the PID file to
 *     send SIGTERM. The daemon becomes a headless ghost that's unstoppable
 *     through the normal path.
 *
 * `backup` is NOT here — it's read-only (reads `.mem` files, writes them
 * to an external directory), so a live daemon doesn't create the
 * RAM-vs-disk skew the guard prevents.
 *
 * Liveness is read from the state file (`getDaemonState`) — set by the
 * daemon AFTER it binds the port. A daemon mid-`buildVault` (between
 * spawn and port-bind) is NOT yet visible here; for that race, the
 * preflight migration fence is the actual closure (see `withMigrationFence`),
 * and the state-mutating commands install it BEFORE calling this guard.
 */
import { getDaemonState } from '../../daemon/api-client.js'

export async function assertNoServerRunning(action: string): Promise<void> {
  const state = await getDaemonState()
  if (state === 'absent') return
  // Refuse for both `ready` AND `initializing` — an initializing daemon is on
  // its way to owning the same state we're about to mutate. Letting init /
  // migrate / restore / destroy proceed while a daemon is still loading the
  // vault would leave the half-loaded daemon's RAM permanently inconsistent
  // with the rewritten disk.
  console.error(`The mementos daemon is ${state === 'ready' ? 'running' : 'initializing'}.`)
  console.error(`${action} touches state the daemon owns (vault files, or the daemon's own`)
  console.error('config directory). Stop the daemon first:')
  console.error('  mementos stop')
  process.exit(1)
}
