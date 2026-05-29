/**
 * Optimistic-concurrency precondition shared between StorageBackend implementations.
 *
 * `Vault.updateMemento` reads via `storage.get()` (which returns the file's etag) and writes
 * with `{ ifMatch: etag }`. We re-`get()` here at write time and compare the etag — this
 * catches the common lost-update case where a concurrent writer (another device's sync,
 * a manual git pull, a text editor) landed BEFORE our write started.
 *
 * Important caveat: this is a check-then-write, NOT atomic CAS. There's a narrow race
 * window between the `get()` here and the subsequent `writeFile()` in the caller where
 * an external writer could land — that case is NOT closed without storage-native CAS
 * (S3's `If-Match` header would close it). DESIGN.md acknowledges cross-device write
 * races as out of scope; this is the explicit version of "out of scope."
 *
 * Centralised here so the contract is one definition. Two callers today (LocalBackend,
 * GitBackend); a future S3 backend would forward the underlying `If-Match` header instead
 * and not call this. The semantics any caller MUST preserve:
 *
 *   - `ifMatch === undefined` → no precondition; proceed (caller does this — assertIfMatch
 *     is only invoked when ifMatch is set).
 *   - target file missing → throws "etag mismatch on PATH: file no longer exists". A delete
 *     between read and write is a real concurrent change, not a fall-through to "create new".
 *   - etag differs → throws "etag mismatch on PATH: expected EXPECTED".
 */
import { timingSafeEqual } from 'node:crypto'
import type { StorageBackend } from '../interface.js'

/**
 * Thrown when an `ifMatch` precondition fails — the file changed (or vanished) between the
 * caller's read and its write. A typed error so `Vault.updateMemento` can recognise a
 * lost-update conflict and surface it as a recoverable `StaleMementoError` instead of
 * pattern-matching on an error message string (which any reword would silently break).
 */
export class EtagMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EtagMismatchError'
  }
}

export async function assertIfMatch(
  storage: Pick<StorageBackend, 'get'>,
  path: string,
  expected: string,
): Promise<void> {
  // Bare-catch would silently map EACCES / EIO / ENOTDIR / any backend bug into
  // "file no longer exists" → StaleMementoError, sending the AI down the re-read-and-retry
  // playbook for a real OS error. Mirrors listMemFiles in fs-ops.ts: ENOENT is the one
  // fail-soft, every other code propagates as the actionable error it is.
  const existing = await storage.get(path, { etag: true }).catch((e: NodeJS.ErrnoException) => {
    if (e?.code === 'ENOENT') return null
    throw e
  })
  if (existing === null) {
    throw new EtagMismatchError(`etag mismatch on ${path}: file no longer exists`)
  }
  // Constant-time compare. Both etags are local-process strings today, so a timing oracle
  // isn't currently reachable — but a future backend whose etag comes from outside the
  // process (a remote ETag header, an attacker-supplied conditional) would make `===`
  // a real side channel. Free hardening.
  const a = Buffer.from(existing.etag)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new EtagMismatchError(`etag mismatch on ${path}: expected ${expected}`)
  }
}
