/**
 * Shared helper for StorageBackend.describeStoredData() — formats a vault directory's
 * `.mem` files as "N memories, ~X MiB at <path>". Used by every filesystem-rooted backend
 * (their layouts are identical at the directory level).
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { MEM_EXTENSION } from '../../core/vault/constants.js'

export async function summarizeMemDir(dir: string): Promise<string> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return `${dir} — not present`
  }
  const memFiles = entries.filter(f => f.endsWith(MEM_EXTENSION))
  let totalBytes = 0
  for (const f of memFiles) {
    try {
      const s = await stat(join(dir, f))
      totalBytes += s.size
    } catch { /* ignore */ }
  }
  const mib = (totalBytes / (1024 * 1024)).toFixed(1)
  return `${memFiles.length} memories, ~${mib} MiB at ${dir}`
}
