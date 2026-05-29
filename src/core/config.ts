/**
 * Read / write the two configuration files used by mementos.
 *
 * MachineConfig — `~/.config/mementos/config.json` — per-machine. Tells THIS device where
 * the vault lives, which backend, which key provider, the git remote. **Not in the vault
 * directory** — keeping it outside means `git status` in the vault doesn't show an
 * "untracked machine config" footgun and machine-specific state doesn't risk landing in
 * the shared repo. XDG-standard location.
 *
 * VaultConfig — `<vaultPath>/vault.json` — per-vault. Tells any device opening the vault
 * which embedder it was built with. Synced across devices via the storage backend so it
 * arrives on machine B alongside the .mem files. **Written through `storage.put` at init**
 * (so GitBackend commits + pushes it). Read after `storage.init()` has populated the local
 * working tree — `readVaultConfig` is the post-clone read used by buildVault.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { MachineConfig, VaultConfig } from './types.js'

/**
 * Vault directory used by `mementos init` (currently fixed; not user-overrideable yet).
 *
 * Resolved lazily per-call so integration tests can override `HOME` per scenario without
 * a forks-pool per test file. Production cost is one extra `homedir()` lookup per call;
 * none of these paths sit in tight loops.
 */
export function vaultPath(): string {
  return join(homedir(), '.mementos')
}

/**
 * Absolute path to the per-machine config file. Lives in `~/.config/mementos/` (XDG),
 * NOT in the vault directory — the vault is shared across devices, machine config is
 * not. Lazily resolved so tests can override HOME per scenario.
 */
export function machineConfigFile(): string {
  return join(homedir(), '.config', 'mementos', 'config.json')
}

/** Filename of the vault-local config (lives inside the vault directory, synced via storage). */
export const VAULT_CONFIG_FILENAME = 'vault.json'

/**
 * Absolute path to the per-machine HNSW index cache.
 *
 * Lives in `~/.config/mementos/cache/` (NOT inside the vault directory) for two reasons:
 *   1. The cache is regenerable per-machine — it has no value to other devices.
 *   2. When the vault directory is inside an OS sync client (Google Drive Desktop,
 *      Dropbox, iCloud), putting machine-local state into the synced folder creates
 *      conflict copies on every save. Pulling cache OUT of vaultPath keeps the synced
 *      folder restricted to the files that should actually sync (`.mem`, `vault.json`).
 *
 * Lazy for the same reason as the other path helpers (HOME-override in tests).
 */
export function indexCacheFile(): string {
  return join(homedir(), '.config', 'mementos', 'cache', 'index.hnsw.enc')
}

// ─── MachineConfig ────────────────────────────────────────────────────────────

/**
 * Read the per-machine config.
 *
 * Distinguishes "missing" (ENOENT — caller decides whether to bootstrap) from "malformed"
 * (parse error or wrong shape — refuse to overwrite a recoverable file). Callers that do
 * `.catch(() => null)` against this only swallow the ENOENT case; the malformed-config
 * SyntaxError propagates with a clear message naming the file.
 */
export async function readMachineConfig(): Promise<MachineConfig> {
  const file = machineConfigFile()
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw e  // caller decides
    throw new Error(`Failed to read ${file}: ${(e as Error).message}`)
  }
  try {
    return JSON.parse(raw) as MachineConfig
  } catch (e) {
    throw new Error(
      `${file} is not valid JSON: ${(e as Error).message}. ` +
      `Refusing to proceed — fix or remove the file manually before re-running.`
    )
  }
}

/** `readMachineConfig` with ENOENT mapped to `null` — the "not initialised on this machine" case. */
export async function readMachineConfigOrNull(): Promise<MachineConfig | null> {
  return readMachineConfig().catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null
    throw e
  })
}

/** Persist the per-machine config, creating the XDG config directory if necessary. */
export async function writeMachineConfig(config: MachineConfig): Promise<void> {
  const file = machineConfigFile()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(config, null, 2), 'utf8')
}

// ─── VaultConfig ──────────────────────────────────────────────────────────────

/** Read the vault-local config from inside the vault directory. Same ENOENT/malformed split as MachineConfig. */
export async function readVaultConfig(vaultPath: string): Promise<VaultConfig> {
  const file = join(vaultPath, VAULT_CONFIG_FILENAME)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw e
    throw new Error(`Failed to read ${file}: ${(e as Error).message}`)
  }
  try {
    return JSON.parse(raw) as VaultConfig
  } catch (e) {
    throw new Error(
      `${file} is not valid JSON: ${(e as Error).message}. ` +
      `Refusing to proceed — fix or remove the file manually before re-running.`
    )
  }
}
