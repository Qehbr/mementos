/**
 * Atomicity primitives for the staged-migration model (see `migrate.ts` for the lifecycle):
 *
 *   - `stageVaultFiles` writes each file via `<f>.tmp` + rename, so a file present in the
 *     staging directory is always complete — a resumed stage skips it safely.
 *   - `backupVaultFiles` builds in `<dir>.partial` then renames the whole directory, so
 *     `<dir>` existing always means a COMPLETE backup.
 *
 * Both directories live as siblings of the vault (same filesystem; renames stay atomic).
 */
import { mkdir, readFile, writeFile, readdir, rename, rm } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import type { StorageBackend } from '../../storage/interface.js'
import { VAULT_CONFIG_FILENAME } from '../../core/config.js'
import { MEM_EXTENSION } from '../../core/vault/constants.js'
import { pathExists } from '../../core/_utils/fs.js'

/** Sibling directory for the in-progress staged copy of a migration. */
export function stagingDirFor(vaultPath: string, startedAt: string): string {
  return join(dirname(vaultPath), `${basename(vaultPath)}.migrating-${sanitise(startedAt)}`)
}

/** Sibling directory for the pre-migration backup of the vault. */
export function backupDirFor(vaultPath: string, startedAt: string): string {
  return join(dirname(vaultPath), `${basename(vaultPath)}.backup-${sanitise(startedAt)}`)
}

/** ISO timestamps contain `:`/`.` which some filesystems reject in names. */
function sanitise(startedAt: string): string {
  return startedAt.replace(/[:.]/g, '-')
}


/**
 * Transform every `.mem` file of the vault into `stagingDir`. `transform` returns the new
 * bytes for a file. Idempotent: a file already present in `stagingDir` is left alone, so a
 * resumed stage only does the work that's left. Each file is written atomically
 * (`<f>.tmp` + rename), so a staged file is never half-written.
 */
export async function stageVaultFiles(
  storage: StorageBackend,
  stagingDir: string,
  transform: (path: string, bytes: Buffer) => Promise<Buffer>,
): Promise<void> {
  await mkdir(stagingDir, { recursive: true })
  // Parallel per-file fan-out — each file is independent (separate path, separate I/O,
  // resume-skip is decided per-file). For key migration that's a real I/O parallel win
  // on a 100k vault; for embedder migration the LocalEmbedder's single ONNX session is
  // still the serial bottleneck inside `transform`, so the outer fan-out doesn't hurt.
  const files = await storage.list()
  await Promise.all(files.map(async f => {
    const dest = join(stagingDir, f)
    if (await pathExists(dest)) return
    const { data } = await storage.get(f)
    const out = await transform(f, data)
    await writeFile(dest + '.tmp', out)
    await rename(dest + '.tmp', dest)
  }))
}

/**
 * Copy every `.mem` file plus `vault.json` out of the vault into `backupPath`. Atomic at
 * the directory level: built in `<backupPath>.partial`, then renamed — so `backupPath`
 * existing always means the backup is complete. A no-op if it already exists.
 */
export async function backupVaultFiles(storage: StorageBackend, backupPath: string): Promise<void> {
  if (await pathExists(backupPath)) return
  const partial = backupPath + '.partial'
  await rm(partial, { recursive: true, force: true })
  await mkdir(partial, { recursive: true })
  // Parallel per-file copy — each storage.get + writeFile is independent. The atomic
  // dir-level rename at the end keeps the all-or-nothing invariant.
  const files = [...await storage.list(), VAULT_CONFIG_FILENAME]
  await Promise.all(files.map(async f => {
    const { data } = await storage.get(f)
    await writeFile(join(partial, f), data)
  }))
  await rename(partial, backupPath)
}

/**
 * Write every `.mem` / `vault.json` file in `sourceDir` into the vault through the storage
 * backend, in one batch (one commit for a Git backend). Used both for the commit (swap the
 * staged files in) and for abort (restore the backup).
 */
export async function applyVaultFiles(storage: StorageBackend, sourceDir: string): Promise<void> {
  const names = await readdir(sourceDir)
  const wanted = names.filter(n => n === VAULT_CONFIG_FILENAME || n.endsWith(MEM_EXTENSION))
  // Parallel reads — independent files, no ordering need. The migration commit phase is
  // the one place the user is unambiguously waiting, so the speedup is felt directly.
  const batch = await Promise.all(wanted.map(async name => ({
    path: name,
    data: await readFile(join(sourceDir, name)),
  })))
  await storage.putBatch(batch)
}
