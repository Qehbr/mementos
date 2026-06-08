/**
 * Migration manifest — a small marker file at `~/.config/mementos/migration-pending.json`
 * that records "a migration is in progress, here is what kind."
 *
 * Critically, the manifest holds NO secret material. Even for key migration, the new
 * mnemonic stays in memory — never on disk — because writing it would defeat the OS
 * keychain's at-rest protection. Resume of key migration re-prompts the user for the
 * mnemonic and verifies it by attempting to decrypt one of the already-created
 * `.mem.new` files; mismatches refuse cleanly rather than silently corrupting.
 *
 * Manifest lifecycle:
 *   - Written at the start of migration (before any `.mem.new` / target-backend files)
 *   - Read on every `mementos migrate` invocation to detect in-progress state
 *   - Deleted on successful completion or on explicit `mementos migrate --abort`
 *
 * Schema is discriminated by `type` so each variant has its own shape and TS narrowing
 * works naturally on the union.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { safeUnlink } from '../../core/_utils/fs.js'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { stagingDirFor, backupDirFor } from './migration-backup.js'

/**
 * Which half of a staged migration is in progress.
 *   - `staging`    — building the migrated copy in the staging directory; the live vault
 *                    is still 100% untouched, so abort is a plain `rm` of the staging dir.
 *   - `committing` — staging is complete; the live vault is being swapped over. The
 *                    originals are backed up first, so abort here restores from the backup.
 */
export type MigrationPhase = 'staging' | 'committing'

export type MigrationManifest =
  | {
      /**
       * Pre-flight fence written BEFORE the type/key/embedder prompts fire.
       * Its only job is to block daemon auto-starts during the interactive
       * window. `buildVault` refuses on any manifest — including this one —
       * so a hook-launched daemon spawned mid-prompt fails its startup
       * instead of caching the old key and racing the commit.
       *
       * Gets overwritten by the real (`storage`/`key`/`embedder`) manifest
       * once the user finishes the prompts. If the user aborts during the
       * prompts (Ctrl-C, error throw), `withMigrationFence` deletes it.
       * If a forced kill leaves it on disk, `mementos migrate --abort`
       * cleans it up — `doAbort` treats it as "nothing to roll back."
       */
      type: 'preflight'
      startedAt: string
    }
  | {
      type: 'storage'
      startedAt: string
      targetBackend: string
      targetVaultPath: string
      /** Per-backend config blob — same shape rules as MachineConfig.backendConfig. */
      targetBackendConfig?: Record<string, unknown>
    }
  | {
      type: 'embedder'
      startedAt: string
      targetEmbedder: string
      /** Directory the re-embedded vault is built in before it is swapped into place. */
      stagingPath: string
      /** Directory the pre-migration vault is copied to during the commit (for abort). */
      backupPath: string
      phase: MigrationPhase
    }
  | {
      type: 'key'
      startedAt: string
      /** Directory the re-encrypted vault is built in before it is swapped into place. */
      stagingPath: string
      /**
       * Directory the pre-migration vault is copied to during the commit — still readable
       * with the PREVIOUS key. `--abort` restores from it when the commit was mid-flight;
       * a completed migration leaves it as the user's safety copy. No secret material:
       * just encrypted `.mem` files. See `migration-backup.ts`.
       */
      backupPath: string
      phase: MigrationPhase
    }

/** Absolute path to the manifest. Lazily resolved so integration tests can override HOME. */
export function manifestFile(): string {
  return join(homedir(), '.config', 'mementos', 'migration-pending.json')
}

/** Read the manifest. Returns null if absent (no migration in progress). */
export async function readManifest(): Promise<MigrationManifest | null> {
  let raw: string
  try {
    raw = await readFile(manifestFile(), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  try {
    return JSON.parse(raw) as MigrationManifest
  } catch (e) {
    // Malformed manifest — refuse to act on it rather than silently dropping a
    // potentially in-progress migration. User can `mementos migrate --abort` to clean up.
    throw new Error(
      `${manifestFile()} is not valid JSON: ${(e as Error).message}. ` +
      `Either fix it or remove it manually before re-running.`
    )
  }
}

/** Persist the manifest. Creates the XDG config directory if missing. */
export async function writeManifest(m: MigrationManifest): Promise<void> {
  const file = manifestFile()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(m, null, 2), 'utf8')
}

/** Remove the manifest. ENOENT-tolerant (idempotent cleanup). */
export async function deleteManifest(): Promise<void> {
  await safeUnlink(manifestFile())
}

/**
 * Write a `preflight` manifest, run `fn`, then clean up.
 *
 * **Why**: `assertNoServerRunning` runs once before the interactive prompts in
 * `mementos migrate` (mnemonic entry, embedder pick, …) and the real manifest
 * is only written after them. In the meantime — possibly minutes — a Claude
 * SessionStart hook or an MCP shim could call `ensureDaemonRunning`,
 * `buildVault` would see no manifest, and the new daemon would cache the
 * current (old) key. When the migration's commit then rewrites every `.mem`
 * under the new key, the running daemon's writes encrypt under the OLD key
 * and land in the new vault → drop-on-next-startup data loss.
 *
 * The fence closes the window: the preflight manifest fails `buildVault`
 * in the daemon, so any daemon auto-started during the prompts exits
 * cleanly before it can cache a key or serve a write.
 *
 * On successful completion of `fn`, the cleanup checks the manifest type —
 * if it's still `preflight` (i.e. the migration aborted before writing the
 * real manifest), the file is removed; if `fn` overwrote it with a real
 * manifest, the cleanup leaves the real one in place.
 *
 * On a throw (including inquirer's `ExitPromptError` from Ctrl-C), the same
 * check runs in `finally`.
 *
 * (A `kill -9` during the preflight window leaves the file on disk;
 * `mementos migrate --abort` cleans it via the `preflight` branch in
 * `doAbort`.)
 */
export async function withMigrationFence<T>(fn: () => Promise<T>): Promise<T> {
  await writeManifest({ type: 'preflight', startedAt: new Date().toISOString() })
  try {
    return await fn()
  } finally {
    const current = await readManifest().catch(() => null)
    if (current?.type === 'preflight') await deleteManifest()
  }
}

/**
 * Refuse to act on a `key` / `embedder` manifest whose `stagingPath` / `backupPath` aren't
 * what *this* code would compute for the recorded `startedAt` + the user's actual
 * `vaultPath` (i.e. siblings of the vault dir with the standard name shape — see
 * `stagingDirFor` / `backupDirFor`). Without this check, an attacker with write access
 * to `~/.config/mementos/` could repoint those paths into attacker-controlled directories
 * and the next `mementos migrate` resume / abort would copy whatever `.mem` files sit
 * there into the live vault (DoS / corruption — they can't exfiltrate without the key).
 *
 * `storage` migrations are skipped: their `targetVaultPath` is user-chosen by design
 * (`promptPath` at migration start), so a sibling-path check would be wrong.
 */
export function validateManifestPaths(m: MigrationManifest, vaultPath: string): void {
  // `storage` migrations: user-chosen `targetVaultPath`, no sibling-path rule.
  // `preflight` fence: no paths at all, nothing to validate.
  if (m.type === 'storage' || m.type === 'preflight') return
  const expectedStaging = stagingDirFor(vaultPath, m.startedAt)
  const expectedBackup = backupDirFor(vaultPath, m.startedAt)
  if (m.stagingPath !== expectedStaging || m.backupPath !== expectedBackup) {
    throw new Error(
      `${manifestFile()}: stagingPath/backupPath don't match this vault's expected sibling ` +
      `directories — possible manifest tampering. Inspect the file, then either restore ` +
      `the correct paths or remove the manifest manually.`
    )
  }
}
