/**
 * LocalBackend — plain filesystem `.mem` files in a single directory.
 *
 * For multi-device sync, point `vaultPath` at a folder synced by the OS (Dropbox, iCloud,
 * Google Drive Mirror). The OS daemon handles transfer; this backend just reads and writes.
 * `sync()` is intentionally a no-op — by the time the Vault's 10-min sync timer fires, any
 * remote files have already been delivered to disk.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { StorageBackend, FileStat } from '../interface.js'
import type { MachineConfig } from '../../core/types.js'
import type { StorageImplementationModule } from '../registry.js'
import type { InitContext } from '../../core/init-context/interface.js'
import { assertIfMatch } from '../_utils/check-if-match.js'
import { summarizeMemDir } from '../_utils/data-summary.js'
import { safeUnlink, pathExists } from '../../core/_utils/fs.js'
import { stagedRenameTransform } from '../_utils/staged-rename.js'
import { writeAndStat } from '../_utils/write-and-stat.js'
import { readWithEtag, listMemFiles, statMtime } from '../_utils/fs-ops.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
// Picked up by the storage registry's auto-scan. See src/core/discovery.ts.
export const type = 'local'
export function create(machine: MachineConfig): StorageBackend {
  return new LocalBackend(machine.vaultPath)
}

/** Selection-time tip — fires in `mementos init` right after the user picks this
 *  backend. Surfaces the OS-sync-folder pattern as the lightweight alternative
 *  to setting up git when cross-device sync is wanted. */
export function describeSelectionTip(ctx: InitContext): void {
  ctx.print('')
  ctx.print('Tip: for cloud sync without setting up git, point the vault path at a folder')
  ctx.print('inside an OS sync client (Google Drive, Dropbox, iCloud). The sync daemon')
  ctx.print('handles transfer transparently — mementos just reads and writes files.')
  ctx.print('')
}

const _shape: StorageImplementationModule = { type, create, describeSelectionTip }

export class LocalBackend implements StorageBackend {
  constructor(private readonly vaultPath: string) {}

  async init(): Promise<void> {
    await mkdir(this.vaultPath, { recursive: true })
  }

  async sync(): Promise<void> {}

  async get(path: string, opts?: { etag?: boolean }): Promise<{ data: Buffer; etag: string }> {
    return readWithEtag(this.vaultPath, path, opts)
  }

  async put(path: string, data: Buffer, opts?: { ifMatch?: string }): Promise<{ mtimeMs: number }> {
    if (opts?.ifMatch !== undefined) await assertIfMatch(this, path, opts.ifMatch)
    // No mkdir here — init() already created the directory. If something deleted it
    // out from under a running process, the open below ENOENTs, which is the correct
    // failure mode (vault is gone; we can't transparently recreate it).
    return writeAndStat(join(this.vaultPath, path), data)
  }

  async putBatch(files: Array<{ path: string; data: Buffer }>): Promise<Array<{ mtimeMs: number }>> {
    // Rollback on partial failure unlinks ONLY files that did not exist before this batch:
    // unlinking an overwritten file would lose live data (its previous content is already
    // gone). Migration commits — the overwrite path — are recoverable from the backup.
    const preExisting = new Set<string>()
    await Promise.all(files.map(async ({ path }) => {
      if (await pathExists(join(this.vaultPath, path))) preExisting.add(path)
    }))
    const results = await Promise.allSettled(files.map(async ({ path, data }) => {
      const { mtimeMs } = await writeAndStat(join(this.vaultPath, path), data)
      return { path, mtimeMs }
    }))
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) {
      const created = results
        .filter((r): r is PromiseFulfilledResult<{ path: string; mtimeMs: number }> => r.status === 'fulfilled')
        .map(r => r.value.path)
        .filter(p => !preExisting.has(p))
      await Promise.all(created.map(p =>
        safeUnlink(join(this.vaultPath, p)).catch(() => { /* best-effort */ }),
      ))
      throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason))
    }
    // Rebuild the result array preserving input order: `path` was carried on the
    // intermediate fulfilled-value purely for the rollback set (above); the public
    // contract is index-aligned `{ mtimeMs }`, so drop `path` from the return.
    return results
      .filter((r): r is PromiseFulfilledResult<{ path: string; mtimeMs: number }> => r.status === 'fulfilled')
      .map(r => ({ mtimeMs: r.value.mtimeMs }))
  }

  async list(): Promise<string[]> {
    return listMemFiles(this.vaultPath)
  }

  async stat(path: string): Promise<FileStat> {
    return statMtime(this.vaultPath, path)
  }

  async delete(path: string): Promise<void> {
    await safeUnlink(join(this.vaultPath, path))
  }

  async describeStoredData(): Promise<string> {
    return summarizeMemDir(this.vaultPath)
  }

  describeManualRemoval(localPath: string): string[] {
    return [
      'To delete it permanently:',
      `  rm -rf ${localPath}`,
    ]
  }

  /** `commitMessage` is unused — LocalBackend has no commit log. */
  async migrate(
    transformFn: (path: string, oldBytes: Buffer) => Promise<Buffer | null>,
    _commitMessage: string,
  ): Promise<void> {
    await stagedRenameTransform(this.vaultPath, await this.list(), transformFn)
  }
}
