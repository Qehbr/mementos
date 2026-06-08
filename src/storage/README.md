# `StorageBackend` — where `.mem` files live

The Vault talks to disk through one interface: read a file by path, write a file with an etag-checked `ifMatch` precondition, list `.mem` files, stat, delete, and a `migrate(transformFn)` primitive that rewrites every file atomically.

```typescript
interface StorageBackend {
  init(): Promise<void>     // one-time setup (clone, mkdir)
  sync(): Promise<void>     // periodic sync (git pull); no-op for local FS
  get(path: string, opts?: { etag?: boolean }): Promise<{ data: Buffer; etag: string }>
  put(path: string, data: Buffer, opts?: { ifMatch?: string }): Promise<{ mtimeMs: number }>
  putBatch(files: Array<{ path: string; data: Buffer }>): Promise<Array<{ mtimeMs: number }>>  // index-aligned to input order — callers match by position, NOT by path
  list(): Promise<string[]>
  stat(path: string): Promise<{ mtimeMs: number }>
  delete(path: string): Promise<void>
  describeStoredData(): Promise<string>
  migrate(fn: (path, oldBytes) => Promise<Buffer | null>, commitMessage: string): Promise<void>
}
```

Adding a new backend is one folder under `src/storage/<name>/` — see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Implementations

| | Description |
|---|---|
| **`LocalBackend`** | Plain filesystem. Point it at a Dropbox/iCloud/Google Drive folder for transparent sync — the OS sync daemon handles transfer; `LocalBackend.sync()` is a deliberate no-op. `putBatch` writes in parallel with rollback on partial failure (unlinks only files that didn't exist before the batch, so an overwrite isn't lost). |
| **`GitBackend`** | Commits every `.mem` write, pushes to a remote; `git pull --rebase --autostash` on startup and on each periodic sync. A rebase-conflicted working tree is mapped to `EtagMismatchError` so the standard stale-write retry applies. Push uses bounded exponential backoff with re-sync between attempts. Optional **per-vault SSH key** (deploy-key model — write access to one repo only): `mementos init --backend=git --git-ssh-key=generate` creates a fresh ed25519 keypair at `~/.ssh/mementos_vault_<hash>`, prints the public key + GitHub deploy-keys URL, and verifies with `ls-remote` before persisting. |

## Why flat files instead of SQLite?

Sync. When two devices each write a memory at the same time:
- **SQLite** — both modify the same binary file → merge conflict.
- **Flat files** — each device creates a new UUID-named file → git auto-merges trivially, and cloud sync clients mirror folders without database lock / partial-sync hazards.

A memento is **one file**, regardless of length. Long text is split into chunks, but the chunks are an array *inside* that file — there is no cross-file numbering to renumber on edit, and git's per-file merge unit equals one memento.

## Optimistic concurrency: `ifMatch`

`updateMemento` reads the file's etag and writes with `{ ifMatch: etag }`. The Vault's per-machine lock only serialises writers on *this* machine; a sync client, text editor, or `git pull` can still touch the file mid-update. `assertIfMatch` re-`get`s the file at write time and rejects if anything changed — `Vault` translates the rejection into `StaleMementoError`, surfacing the conflict instead of a silent overwrite.

The MD5 etag is **opt-in via `{ etag: true }`** — callers that discard it (the warm-startup load path, doctor probe, init key probe, migrate scan) save one MD5-over-file-body per call. At 100k mementos that drops a meaningful fraction of every `mementos start` daemon-startup time.

## Cloud sync without git

Point the vault at a folder inside a sync client:

```bash
mementos init --backend=local --vault-path="$HOME/Google Drive/mementos-vault"
```

Works with Google Drive Desktop / Dropbox / iCloud. For any cloud on any OS, `rclone mount` exposes 50+ providers as a local folder — combine it with `LocalBackend` and there is no cloud-specific code in mementos. `GitBackend` is the other option: git handles the merge story and needs no external tool.

## The `migrate` primitive

`mementos migrate --type=key|embedder` rewrites every `.mem` file in the vault. The backend decides HOW to keep it atomic:

- **LocalBackend** — per-file two-phase rename (`<path>.new` + atomic `rename(2)`). Crash-safe per file via the POSIX rename guarantee.
- **GitBackend** — same per-file write to working tree, then a single `git add . && commit && push` for the whole batch. One network round trip regardless of file count.

`transformFn` returns `null` for files already in target state, so re-running a migration is idempotent — the staged-migration model in [src/cli/commands/migrate.ts](../cli/commands/migrate.ts) builds on this.
