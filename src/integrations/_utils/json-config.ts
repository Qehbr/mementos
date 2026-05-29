/**
 * Atomic read/write of a foreign-tool JSON config file (Claude Code's `settings.json`,
 * Codex's `hooks.json`, Cursor's `mcp.json`, …). One definition of:
 *
 *   - Missing file → return `defaultValue` (the integration treats it as "not installed
 *     yet"). ENOENT is the only IO error swallowed.
 *   - Malformed JSON → **refuse** with a clear "fix or remove" error. Overwriting an
 *     unparseable file would discard a hand-edited config the user just broke.
 *   - Write goes through `<path>.tmp` + atomic `rename(2)` (via `renameWithRetry` for
 *     Windows EBUSY). Parent dir is `mkdir -p`'d so a freshly-installed tool whose dir
 *     doesn't exist yet still works.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { renameWithRetry } from './atomic-write.js'

export async function readJsonConfig<T>(path: string, defaultValue: T): Promise<T> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return defaultValue
    throw e
  }
  try {
    return JSON.parse(raw) as T
  } catch (e) {
    throw new Error(
      `${path} is not valid JSON: ${(e as Error).message}. ` +
      `Refusing to overwrite. Fix or remove the file and re-run.`,
    )
  }
}

export async function writeJsonConfig(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await renameWithRetry(tmp, path)
}
