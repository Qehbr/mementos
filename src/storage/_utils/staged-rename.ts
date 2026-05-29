import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { safeUnlink, pathExists } from '../../core/_utils/fs.js'

/**
 * Two-phase per-file atomic transform shared by every staged-write storage backend:
 *
 *   Phase 1 — write each transformed payload to `<path>.new`.
 *   Phase 2 — atomically rename every `.new` over its final path.
 *
 * Crashes recover cleanly. Phase 1 leaves originals intact (stale `.new` files are filtered
 * from `list()` and overwritten on a re-run). Phase 2 leaves a partial-renamed mix that a
 * re-run finishes — rename(2) is atomic on POSIX and Windows for files on the same
 * filesystem (the working tree always is).
 *
 * `transformFn` returns `null` to declare a file already in target state — its stale
 * `<path>.new` from a previous attempt is cleared and the original is left untouched.
 */
export async function stagedRenameTransform(
  baseDir: string,
  files: readonly string[],
  transformFn: (path: string, oldBytes: Buffer) => Promise<Buffer | null>,
): Promise<void> {
  for (const file of files) {
    const finalPath = join(baseDir, file)
    const newPath = `${finalPath}.new`
    const oldBytes = await readFile(finalPath)
    const newBytes = await transformFn(file, oldBytes)
    if (newBytes === null) {
      // Already in target state — clear any stale `.new` from a previous attempt.
      await safeUnlink(newPath)
      continue
    }
    await writeFile(newPath, newBytes)
  }
  for (const file of files) {
    const finalPath = join(baseDir, file)
    const newPath = `${finalPath}.new`
    if (!await pathExists(newPath)) continue
    await rename(newPath, finalPath)
  }
}
