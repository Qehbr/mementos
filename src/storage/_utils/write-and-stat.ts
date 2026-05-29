/**
 * Crash-atomic write + mtime capture on the same FD.
 *
 * Writes to `<path>.tmp` and atomically renames to `<path>` — POSIX `rename(2)` is atomic
 * within a single filesystem, so a concurrent reader sees either the OLD inode at `path`
 * or the NEW inode, never a half-written file. `open('w')` on the final path would
 * truncate the prior version BEFORE the new data lands — a crash (SIGKILL, OOM, power
 * loss) between truncate and write-completion would destroy the prior memento with no
 * way to recover from this device.
 *
 * The mtime is captured from the tmp FD via `fh.stat()` — rename(2) doesn't update the
 * inode's mtime, so `storage.stat(path)` after the rename returns the SAME mtime. Closes
 * the cross-device race where a separate `stat()` on the path could see a sync client's
 * (Dropbox/iCloud/Drive) substituted inode.
 *
 * Used by every StorageBackend `put` / `putBatch` so both contracts ("put is atomic" and
 * "put returns the new mtime") are closed by construction, not by follow-up syscalls.
 */
import { open, rename, unlink } from 'node:fs/promises'

export async function writeAndStat(fullPath: string, data: Buffer): Promise<{ mtimeMs: number }> {
  const tmp = fullPath + '.tmp'
  let mtimeMs: number
  const fh = await open(tmp, 'w')
  try {
    await fh.writeFile(data)
    const s = await fh.stat()
    mtimeMs = s.mtimeMs
  } finally {
    await fh.close()
  }
  try {
    await rename(tmp, fullPath)
  } catch (e) {
    // Rename failed — leave the destination untouched and clean up the orphan tmp file.
    await unlink(tmp).catch(() => { /* best-effort cleanup */ })
    throw e
  }
  return { mtimeMs }
}
