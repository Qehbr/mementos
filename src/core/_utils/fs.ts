import { unlink, stat, open, rename } from 'node:fs/promises'

/** Delete `path`, ignoring ENOENT. Any other error propagates. */
export async function safeUnlink(path: string): Promise<void> {
  await unlink(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e
  })
}

/** True if a filesystem path exists. */
export async function pathExists(p: string): Promise<boolean> {
  return stat(p).then(() => true).catch(() => false)
}

/**
 * Crash-atomic file write: write to `<path>.tmp` then `rename(2)` over the final
 * path. `rename` is atomic on POSIX and Windows within a single filesystem, so a
 * concurrent reader / SIGKILL / power loss observes either the previous file
 * unchanged or the new file complete — never a truncated half. The destination's
 * parent directory must already exist (caller's responsibility — same convention
 * as `writeFile`).
 *
 * Used by every config write whose torn-write would wedge the system into a
 * "refusing to start until manually repaired" state — currently `writeMachineConfig`
 * (the migrate cutover's last step), but the helper is general so future config
 * writes can adopt it without inlining the tmp+rename + cleanup dance again.
 *
 * `storage/_utils/write-and-stat.ts` does the same thing PLUS captures the
 * tmp-FD's mtime (the storage contract returns post-write mtimes); kept
 * separate because that file path is hot and shouldn't carry the
 * `core` dependency direction implied by reuse.
 */
export async function atomicWriteFile(path: string, data: string | Buffer): Promise<void> {
  const tmp = path + '.tmp'
  const fh = await open(tmp, 'w')
  try {
    await fh.writeFile(data)
  } finally {
    await fh.close()
  }
  try {
    await rename(tmp, path)
  } catch (e) {
    await safeUnlink(tmp)
    throw e
  }
}
