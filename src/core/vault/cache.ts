/**
 * The encrypted HNSW cache — a snapshot of the in-memory vector index, loaded at startup
 * to avoid re-decrypting and re-inserting every `.mem` file.
 *
 * Lives at `~/.config/mementos/cache/index.hnsw.enc` (resolved via `indexCacheFile()`),
 * NOT inside the vault directory. The cache is per-machine regenerable state, so it has
 * no business being synced to other devices. Keeping it out of the vault directory means:
 *   - Cloud-synced vault folders (Google Drive Desktop, Dropbox, iCloud) don't ship
 *     machine-local state across devices and don't generate conflict copies.
 *   - GitBackend never has to special-case "is this file versioned?" for the cache.
 *
 * Validation on load: the cache records, per memento, the id AND the mtime it had when the
 * cache was built. The cache is valid iff the on-disk set of `{id, mtime}` pairs is
 * IDENTICAL — a new id, a removed id, or a changed mtime (an in-place update) all
 * invalidate it. Each file is compared to its OWN recorded mtime, never to a
 * clock-dependent reference like the cache file's own mtime — so a cross-device update
 * that lands with an older mtime (the writing device's clock runs behind) is still caught.
 *
 * AAD-bound to the sorted `(id, mtimeMs)` set: replaying an older valid cache (different
 * id-set OR a swap-back after an in-place update) fails GCM authentication because the AAD
 * differs. Binding mtimes — not just ids — is what catches the swap-after-update attack:
 * forging `entries[i].mtimeMs` to match the on-disk file now also invalidates the AAD.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { pathExists } from '../_utils/fs.js'
import { dirname } from 'node:path'
import type { StorageBackend } from '../../storage/interface.js'
import type { VectorIndex } from '../../vector/interface.js'
import { encrypt, decrypt, AuthenticationError, type Encrypted } from './crypto.js'
import { cacheAad } from './aad.js'
import { idFromMemFilename } from './constants.js'
import { indexCacheFile } from '../config.js'

/** One memento's identity in the cache: its id and the mtime seen when the cache was built. */
export interface CacheEntry {
  id: string
  mtimeMs: number
}

/**
 * Wire format of the cache file. `entries` is plaintext — the `.mem` filenames are already
 * plaintext, and the mtimes leak nothing the file system doesn't already expose. Tampering
 * with `entries` is bounded: the encrypted `data` is AAD-bound to the sorted `(id, mtimeMs)`
 * set, so forging either an id OR an mtime invalidates authentication and the cache rebuilds.
 */
export interface IndexCache {
  entries: CacheEntry[]
  data: Encrypted
}

/**
 * Try to fast-path startup by loading the encrypted HNSW cache.
 *
 * @returns On hit, a `Map<id, mtimeMs>` of the validated on-disk mtimes — the caller can
 *   thread these into `loadAndRegister` instead of re-statting every file (a 10k-memento
 *   warm startup would otherwise pay 2N stat syscalls instead of N). `null` on miss —
 *   cache absent, stale, or unauthenticated; caller rebuilds from .mem files.
 *
 * On AAD failure surfaces a tampering warning to stderr before returning null — a GCM
 * auth-tag failure is a cryptographic signal, not a routine "cache miss".
 */
export async function tryLoadIndexCache(
  storage: StorageBackend,
  index: VectorIndex,
  key: Buffer,
  memFiles: string[],
): Promise<Map<string, number> | null> {
  const cachePath = indexCacheFile()
  try {
    if (!await pathExists(cachePath)) return null

    // Parallel stat — sequential here is N round-trips on a vault with thousands of files.
    const stats = await Promise.all(memFiles.map(f => storage.stat(f).catch(() => null)))
    const onDisk = new Map<string, number>()
    for (let i = 0; i < memFiles.length; i++) {
      const s = stats[i]
      if (!s) return null  // a file we can't stat — treat the cache as untrustworthy
      onDisk.set(idFromMemFilename(memFiles[i]), s.mtimeMs)
    }

    const data = await readFile(cachePath)
    const cache = JSON.parse(data.toString()) as IndexCache
    const entries = cache.entries ?? []

    // Valid iff the on-disk {id, mtime} set EXACTLY equals the cached one. Catches adds,
    // removes, AND in-place updates (changed mtime) — clock-independently, since each file
    // is checked against its own recorded mtime.
    if (entries.length !== onDisk.size) return null
    for (const e of entries) {
      if (onDisk.get(e.id) !== e.mtimeMs) return null
    }

    // cacheAad canonicalises (sorts by id) internally — no pre-sort needed.
    const indexData = decrypt(cache.data, key, cacheAad(entries))
    // No init() before load() — VectorIndex.load is required to fully construct internal
    // state from the serialized blob. HNSWIndex.load builds a fresh HierarchicalNSW; an
    // earlier init() would just allocate a 100k-element index and discard it.
    await index.load(indexData)
    return onDisk
  } catch (e) {
    if (e instanceof AuthenticationError) {
      console.error('Warning: index cache failed authentication — possible tampering. Rebuilding from .mem files.')
    }
    return null
  }
}

/**
 * Persist the current HNSW index as an encrypted, AAD-bound cache file. Failures are
 * non-fatal (next startup just rebuilds from .mem files) but logged so users with a
 * mysteriously-not-persisting cache have something to triage.
 */
export async function saveIndexCache(
  index: VectorIndex,
  key: Buffer,
  entries: CacheEntry[],
): Promise<void> {
  const cachePath = indexCacheFile()
  try {
    const indexData = await index.serialize()
    const cache: IndexCache = {
      entries,
      data: encrypt(indexData, key, cacheAad(entries)),
    }
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(cachePath, Buffer.from(JSON.stringify(cache)))
  } catch (e) {
    console.error(`Warning: failed to save index cache: ${(e as Error).message}`)
  }
}
