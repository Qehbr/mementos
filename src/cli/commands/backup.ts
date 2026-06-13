/**
 * `mementos backup` / `mementos restore` — export the vault to a plain directory and
 * import it back.
 *
 * A backup is a folder of encrypted `.mem` files plus `vault.json`. It holds NO key
 * material — it is only readable with the vault's key — so it is safe to keep wherever
 * you keep other backups. `restore` writes the folder's files back into the vault.
 *
 * Both refuse while a migration is in progress: backing up or restoring a vault that is
 * mid-migration would capture / clobber an inconsistent state.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { VAULT_CONFIG_FILENAME } from '../../core/config.js'
import { buildKeyProvider, buildStorageBackend, readMachineConfigOrExit } from '../_utils/vault.js'
import { readManifest, withMigrationFence } from '../_utils/migration-manifest.js'
import { applyVaultFiles } from '../_utils/migration-backup.js'
import { pathExists } from '../../core/_utils/fs.js'
import { assertNoServerRunning } from '../_utils/assert-no-server.js'
import { canDecryptMem } from '../../core/vault/re-encrypt.js'
import type { StorageBackend } from '../../storage/interface.js'
import type { MachineConfig } from '../../core/types.js'

/** Build + init the storage backend named in the machine config. */
async function storageFor(machine: MachineConfig): Promise<StorageBackend> {
  const storage = await buildStorageBackend(machine)
  await storage.init()
  return storage
}


async function refuseIfMigrating(): Promise<void> {
  if (await readManifest()) {
    console.error('A migration is in progress — finish or cancel it (`mementos migrate`) first.')
    process.exit(1)
  }
}

/** `mementos backup [dir]` — copy every `.mem` + `vault.json` into a plain directory. */
export async function runBackup(dir: string | undefined): Promise<void> {
  await refuseIfMigrating()
  const machine = await readMachineConfigOrExit()

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = dir ?? join(homedir(), `mementos-backup-${stamp}`)
  if (await pathExists(target) && (await readdir(target)).length > 0) {
    console.error(`Target directory is not empty: ${target}`)
    console.error('Pick an empty or non-existent path.')
    process.exit(1)
  }

  const storage = await storageFor(machine)
  await mkdir(target, { recursive: true })
  const files = [...await storage.list(), VAULT_CONFIG_FILENAME]
  for (const f of files) {
    const { data } = await storage.get(f)
    await writeFile(join(target, f), data)
  }
  console.log(`Backed up ${files.length} file(s) to ${target}`)
  console.log('This is an encrypted copy — it needs the vault key to read. Keep it safe.')
}

/** `mementos restore <dir>` — write a backup directory's files back into the vault. */
export async function runRestore(dir: string | undefined): Promise<void> {
  if (!dir) {
    console.error('Usage: mementos restore <backup-dir>')
    process.exit(1)
  }
  const machine = await readMachineConfigOrExit()
  if (!await pathExists(dir)) {
    console.error(`Backup directory not found: ${dir}`)
    process.exit(1)
  }
  // Refuse if a real migration is in progress — read BEFORE the fence so
  // we don't mistake our own preflight for a pending migration.
  await refuseIfMigrating()

  // Wrap from BEFORE assertNoServerRunning + storage.init (git clone/pull
  // for git backends), not just around applyVaultFiles. The earlier order
  // left a seconds-wide window where a hook-spawned daemon would pass
  // assertNoServerRunning AND its own buildVault manifest check, then
  // race our overwrite. The key probe stays inside too so any daemon
  // auto-started while we read files for the warning still bounces.
  await withMigrationFence(async () => {
    await assertNoServerRunning('Restore')
    const storage = await storageFor(machine)
    await applyVaultFiles(storage, dir)
    console.log(`Restored the vault from ${dir}.`)

    // Warn (don't fail) if the restored files don't open under the active key — that means
    // the backup was taken under a different key; the user needs that key to read them.
    if (!machine.keyProvider) return
    const key = await (await buildKeyProvider(machine)).getKey().catch(() => null)
    if (!key) return
    for (const f of await storage.list()) {
      const { data } = await storage.get(f)
      if (!canDecryptMem(data, key)) {
        console.warn('Warning: the restored files do not decrypt under the current vault key.')
        console.warn('They were encrypted under a different key — switch to that key (or run')
        console.warn('`mementos migrate --type=key`) to make the vault readable.')
        return
      }
    }
  })
}
