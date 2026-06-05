/**
 * StorageBackend — abstracts where `.mem` files live.
 *
 * Concrete implementations: LocalBackend (filesystem), GitBackend (filesystem + git remote).
 * Future implementations could include S3, GCS, R2, or a Drive API backend.
 *
 * The Vault depends only on this interface. Adding a new backend means writing one file
 * implementing the methods below — no changes to vault.ts.
 */

/** Lightweight stat result — only the fields the Vault actually needs. */
export interface FileStat {
  mtimeMs: number
}

export interface StorageBackend {
  /**
   * One-time setup. Called once during Vault.startup. Examples: `mkdir -p` for LocalBackend,
   * `git clone` for GitBackend on first use.
   */
  init(): Promise<void>

  /**
   * Periodic refresh. Called from Vault.syncIfStale (every 10 min by default) under the
   * vault lock. No-op for backends where the OS handles sync (Dropbox, iCloud, Google
   * Drive Mirror); GitBackend runs `git pull --rebase --autostash` here.
   */
  sync(): Promise<void>

  /**
   * Read one file's contents.
   *
   * `etag` is a content-derived fingerprint (LocalBackend uses MD5; an S3 backend would
   * forward the S3 ETag header). The Vault uses it together with `put({ ifMatch })` for
   * optimistic-concurrency on `updateMemento`: the per-vault file lock only serialises
   * mementos's own writers, while a sync client / text editor / `git pull` can still touch
   * the file mid-update. The etag captures the read-time state and the put-time `ifMatch`
   * rejects if anything changed in between.
   *
   * `opts.etag` (default false) requests the etag. Skipped by default because the warm-
   * startup, sync, and probe paths discard it — and MD5-over-file-body × N memories adds
   * up to a meaningful fraction of every `mementos serve` launch's startup time.
   * Returns `etag: ''` when not requested; etag consumers MUST pass `{ etag: true }`.
   */
  get(path: string, opts?: { etag?: boolean }): Promise<{ data: Buffer; etag: string }>

  /**
   * Write one file. Returns the file's on-disk `mtimeMs` captured from the same FD that
   * did the write — guarantees the mtime reflects OUR bytes even if an OS sync client
   * (Dropbox/iCloud/Drive) replaces the inode at the path immediately afterwards. The
   * caller uses this for the index-cache freshness check; a second `stat()` round-trip
   * would open a tiny cross-device race window.
   *
   * `opts.ifMatch` (optional): optimistic concurrency. The write fails unless the existing
   * file's etag equals this value. Used by `Vault.updateMemento` against the etag captured
   * at read time — see `get` above for the rationale.
   */
  put(path: string, data: Buffer, opts?: { ifMatch?: string }): Promise<{ mtimeMs: number }>

  /**
   * Write multiple files atomically from the backend's perspective. For GitBackend this is
   * a single commit + single push for the whole batch. Used for chunked-memory writes.
   *
   * Returns `{ path, mtimeMs }` per file in the same order as the input, with mtimes
   * captured from the write FDs — same rationale as `put` above.
   */
  putBatch(files: Array<{ path: string; data: Buffer }>): Promise<Array<{ path: string; mtimeMs: number }>>

  /** List all `.mem` files in the vault. Cache files (e.g. `_index.hnsw.enc`) are excluded. */
  list(): Promise<string[]>

  /** Stat one file. Used for cache freshness checks (mtime) and update detection. */
  stat(path: string): Promise<FileStat>

  /** Delete one file. Tolerates missing files (ENOENT). */
  delete(path: string): Promise<void>

  /**
   * One-line summary of where this backend's data lives. Used by `mementos destroy` to
   * tell the user where their data still is after destroying the key/config — mementos
   * intentionally does NOT remove vault data itself, because the destruction semantics
   * differ across backends (git's remote is a separate decision) and the asymmetry would
   * lead to surprised users.
   */
  describeStoredData(): Promise<string>

  /**
   * Lines of manual-removal instructions printed by `mementos destroy` and migrate
   * abort. Backends with off-machine state (a git remote, a cloud bucket) extend
   * the local `rm -rf` recipe with the corresponding remote-side step so the user
   * isn't misled into thinking a local delete wiped their data. The
   * `localPath` argument is the vault path on this machine — backends use it
   * verbatim in their local-side instructions.
   *
   * Default implementations exist on backends that have nothing extra to say
   * beyond "rm -rf <path>"; the caller renders the lines as-is.
   */
  describeManualRemoval(localPath: string): string[]

  /**
   * Optional: per-backend cleanup performed by `mementos destroy` when the user
   * removes the machine config. Examples: deleting a per-vault SSH key that
   * mementos auto-generated (only when WE generated it — user-supplied keys
   * stay). Default = no-op for backends with nothing extra to clean.
   */
  cleanupOnDestroy?(print: (msg: string) => void): Promise<void>

  /**
   * Optional: backend-specific recovery hint shown by `mementos doctor` when a
   * read against this backend fails. The doctor falls back to a generic
   * filesystem-permissions message when this is absent.
   */
  describeDoctorHint?(): string

  /**
   * Apply `transformFn` to every `.mem` file in the vault, atomically per file.
   *
   * Used by `mementos migrate` to transform vault contents (key rotation, embedder
   * change, etc.). The backend decides HOW to achieve atomicity:
   *
   *   - LocalBackend: writes each transformed file to `<path>.new`, then atomic
   *     rename to `<path>`. Crash-safe per file via the POSIX rename guarantee.
   *   - GitBackend: same temp+rename per file (working-tree only — no commits during
   *     the loop), then a single `git add . && commit -m <commitMessage> && push` at
   *     the end. Network round trips: one regardless of file count.
   *   - Future backends (Drive, S3) implement their own atomicity story (typically
   *     just an atomic API update per object — no staging needed).
   *
   * `transformFn(path, oldBytes)` returns:
   *   - Buffer → write these bytes as the new content for this file
   *   - null   → leave this file unchanged (e.g. already in the target state on a
   *              resumed run; transformFn detects this by inspecting oldBytes)
   *
   * Re-running with the same transformFn is idempotent — files already in the target
   * state are skipped via the null-return path. Storage may leave temp/staging files
   * on crash; they are filtered out of `list()` and harmless until the next migrate.
   *
   * `commitMessage` is used by remote-tracking backends for their commit log; other
   * backends ignore it.
   */
  migrate(
    transformFn: (path: string, oldBytes: Buffer) => Promise<Buffer | null>,
    commitMessage: string,
  ): Promise<void>
}
