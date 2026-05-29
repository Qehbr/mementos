import { unlink, stat } from 'node:fs/promises'

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
