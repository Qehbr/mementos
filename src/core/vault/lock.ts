/**
 * Coarse-grained inter-process file lock around state-mutating vault operations.
 *
 * Used by the Vault to serialize `writeMemento`, `updateMemento`, `deleteMemento`, AND
 * `doSync` — sync mutates the in-memory index and metadata map, so it must serialize
 * against concurrent writers from CLI commands and the MCP server.
 *
 * Reads (recall, search, listMementos, getTags, getMemento) are NOT locked at this layer;
 * they're idempotent against concurrent reads and the underlying index supports concurrent
 * search.
 */
import { mkdir } from 'node:fs/promises'
import lockfile from 'proper-lockfile'

/**
 * Thrown when the vault lock is held for longer than `withLock`'s retry budget — almost
 * always a legitimate long write (first-ONNX-load + slow git push can exceed 10s, per
 * DESIGN.md). Replaces `proper-lockfile`'s opaque "Error: Lock file is already being
 * held" so the MCP tool surface tells the AI something actionable instead of an
 * implementation detail. AI clients treat this as a transient retry, the same way they
 * treat StaleMementoError.
 */
export class VaultBusyError extends Error {
  constructor() {
    super('vault is busy with a long-running write (first-time embedder load or slow git push); retry in a few seconds')
    this.name = 'VaultBusyError'
  }
}

/**
 * Re-entrant per-vault write lock. Wraps the filesystem lock (`withLock`) with an
 * in-process holder flag — proper-lockfile cannot detect that the same process is
 * the current holder, so a nested acquire on the same instance would deadlock on
 * its own lockfile. `WriteLock.run` lets nested calls re-enter without re-acquiring.
 *
 * Used for batch writes (CLI ingest of hundreds of sessions) where one outer
 * `run(fn)` holds the lock across many inner Vault writes — instead of acquiring
 * and releasing thousands of times, which opens a race window where a concurrent
 * process can steal the lock between cycles.
 */
export class WriteLock {
  private holding = false
  constructor(private readonly lockPath: string | undefined) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.holding) return fn()
    return withLock(this.lockPath, async () => {
      this.holding = true
      try { return await fn() } finally { this.holding = false }
    })
  }
}

/**
 * Run `fn` while holding the per-vault file lock.
 *
 * If `lockPath` is undefined, runs `fn` directly without locking — only safe for
 * single-writer setups (e.g. unit tests). The CLI always provides a lockPath.
 *
 * Retry budget is ~10s (8 retries, 150ms→2s backoff): a contending writer waits through a
 * normal write (milliseconds) and a first-embed model load (~1-2s) rather than failing
 * with ELOCKED, but does not hang an interactive MCP tool call for a minute. A write that
 * legitimately runs longer (a slow git push) makes the contender fail fast with a clear
 * error it can retry — preferable to a 60s stall.
 *
 * Stale timeout is 120s — well above any legitimate hold — so a genuinely dead holder's
 * lock is still eventually stolen.
 */
export async function withLock<T>(lockPath: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!lockPath) return fn()
  await mkdir(lockPath, { recursive: true }).catch(() => {})
  let release: () => Promise<void>
  try {
    release = await lockfile.lock(lockPath, {
      retries: { retries: 8, minTimeout: 150, maxTimeout: 2000 },
      stale: 120_000,
      // proper-lockfile's default onCompromised throws synchronously from a
      // setInterval callback, which becomes uncaughtException and crashes the
      // process. The lock is a best-effort serialiser; the real safety against
      // concurrent writers is storage-layer CAS (ifMatch). The most common
      // trigger here is the watchdog falsely reporting compromise after an
      // event-loop-blocked write (e.g. a long ONNX batch), which is harmless.
      // Emit a warning so the situation is visible, but don't kill the process.
      onCompromised: (err) => {
        process.emitWarning(`vault lock compromised: ${err.message}`, 'LockCompromised')
      },
    })
  } catch (e) {
    // proper-lockfile throws ELOCKED with an unhelpful "Lock file is already being held"
    // message that surfaces straight to the AI through MCP. Translate to a typed error
    // so the AI sees an actionable hint and so callers can pattern-match on the class.
    if ((e as NodeJS.ErrnoException)?.code === 'ELOCKED') throw new VaultBusyError()
    throw e
  }
  try {
    return await fn()
  } finally {
    // Release errors must never crash the caller — finally is the wrong place to
    // throw (it would mask any error from fn()). ERELEASED means onCompromised
    // already fired and proper-lockfile invalidated this release internally;
    // nothing to clean up. Any other release error just gets surfaced as a
    // warning — the lockfile state on disk is what it is by this point.
    try {
      await release()
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ERELEASED') {
        process.emitWarning(`vault lock release failed: ${(e as Error).message}`, 'LockReleaseFailed')
      }
    }
  }
}
