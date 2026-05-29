import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { MEM_EXTENSION } from '../../core/vault/constants.js'
import type { FileStat } from '../interface.js'

/**
 * The shared filesystem-rooted `get`/`list`/`stat` bodies. Both LocalBackend and GitBackend
 * read `.mem` files straight off disk under their own base directory; only that directory
 * differs. Keeping the etag digest here makes it a single definition — `assertIfMatch`
 * compares against it, so a backend computing it differently would silently break ifMatch.
 */

/**
 * Read `dir/path`. The md5 etag is computed only when `opts.etag === true` — callers that
 * discard the etag (the warm-startup load path, doctor probe, init key probe, migrate
 * scan) save one MD5-over-file-body per call. At 100k mementos that drops ~20–30% of the
 * documented ~5 s warm-startup. Etag-requiring callers (Vault.readMemento for
 * updateMemento's optimistic-concurrency, assertIfMatch for put's ifMatch) opt in
 * explicitly; everywhere else gets the default off.
 */
export async function readWithEtag(
  dir: string, path: string, opts?: { etag?: boolean },
): Promise<{ data: Buffer; etag: string }> {
  const data = await readFile(join(dir, path))
  const etag = opts?.etag ? createHash('md5').update(data).digest('hex') : ''
  return { data, etag }
}

/**
 * List the `.mem` files directly under `dir`. ENOENT is the one fail-soft: the directory
 * not existing genuinely means "no files yet" (pre-init, fresh state). Every other readdir
 * error (EACCES, EIO, ENOTDIR, mount drop, …) is "I don't know what's there" and must
 * throw — a silent `[]` would make `Vault.doSync` treat a transient permission/mount glitch
 * as "every memento was deleted" and unregister the whole vault.
 */
export async function listMemFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return [] as string[]
    throw e
  })
  return entries.filter(f => f.endsWith(MEM_EXTENSION))
}

/** Stat `dir/path` for its mtime. */
export async function statMtime(dir: string, path: string): Promise<FileStat> {
  const s = await stat(join(dir, path))
  return { mtimeMs: s.mtimeMs }
}
