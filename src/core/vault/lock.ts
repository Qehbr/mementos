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
    await release()
  }
}
