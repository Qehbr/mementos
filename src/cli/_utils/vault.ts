/**
 * Vault construction from the auto-discovery registries, plus the config-shape assertions
 * and path guard the one-shot CLI commands share.
 */
import { readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { Vault } from '../../core/vault/index.js'
import { readMachineConfig, readMachineConfigOrNull, readVaultConfig, machineConfigFile } from '../../core/config.js'
import { loadStorageBackends } from '../../storage/registry.js'
import { loadEmbedders } from '../../embeddings/registry.js'
import { loadVectorIndexes } from '../../vector/registry.js'
import { loadKeyProviders } from '../../keys/registry.js'
import { loadRetrievers } from '../../retrievers/registry.js'
import { loadSearchers } from '../../searchers/registry.js'
import type { DiscoveredImpl } from '../../core/discovery.js'
import type { InitContext } from '../../core/init-context/interface.js'
import type { MachineConfig, VaultConfig } from '../../core/types.js'
import type { StorageBackend } from '../../storage/interface.js'
import type { KeyProvider } from '../../keys/interface.js'
import { readManifest } from './migration-manifest.js'

/**
 * Look up an implementation by type-name. Throws a clear, actionable error listing what
 * IS registered if the requested type isn't found.
 */
export function requireImpl<F>(
  registry: Map<string, DiscoveredImpl<F>>,
  type: string,
  abstraction: string,
): DiscoveredImpl<F> {
  const impl = registry.get(type)
  if (!impl) {
    const available = [...registry.keys()]
    throw new Error(
      `Unknown ${abstraction}: '${type}'. Available: ${available.join(', ') || '(none registered)'}`
    )
  }
  return impl
}

/**
 * Build a Vault wired through the auto-discovery registries: storage / embedder / vector
 * index / key provider are each chosen by the type-string in MachineConfig or VaultConfig.
 * Caller must `await vault.startup()`.
 *
 * Strict: throws if either config file is missing rather than falling back to defaults.
 * The post-init paths (the daemon, hook subprocesses, migrate/backup) all need an
 * initialised vault; a silent default-fallback would mask "user forgot to init" as
 * an empty-vault edge case.
 */
export async function buildVault(): Promise<Vault> {
  // Refuse to operate on a vault with an unfinished migration. Key/embedder migrations
  // transform `.mem` files in place, so a half-done one leaves the vault in a state no
  // single key/embedder can read coherently — `startup()` would fail with a cryptic
  // crypto error. `mementos migrate` resolves it; `--abort` cancels it. `migrate` and
  // `doctor` build their own backends (not via buildVault), so neither is blocked here.
  const pendingMigration = await readManifest()
  if (pendingMigration) {
    throw new Error(
      `A ${pendingMigration.type} migration started ${pendingMigration.startedAt} is unfinished.\n` +
      `mementos can't use the vault until it is resolved:\n` +
      `  finish it:  mementos migrate\n` +
      `  cancel it:  mementos migrate --abort`
    )
  }

  // ENOENT-only catch: readMachineConfig/readVaultConfig distinguish "missing" from
  // "malformed JSON". A SyntaxError on a hand-edited config should surface as itself, not
  // be collapsed into "run mementos init" (which would refuse anyway).
  const machine = await readMachineConfig().catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e
    throw new Error(
      `No vault configured on this machine — run 'mementos init' first.\n` +
      `(Looked for ${machineConfigFile()}.)`
    )
  })
  const vault = await readVaultConfig(machine.vaultPath).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e
    throw new Error(
      `No vault found at ${machine.vaultPath} (path from ${machineConfigFile()}).\n` +
      `Likely causes: vault not set up, deleted, moved/renamed, or not yet synced from another device.\n` +
      `Fix: 'mementos init', or edit "vaultPath" in ${machineConfigFile()} to point at the new location.\n` +
      `WARNING: re-running init generates a NEW key; pre-existing .mem files will NOT decrypt with it.`
    )
  })

  requireFullMachineConfig(machine)
  // The write lock is machine-local — it lives under ~/.config/mementos/, NOT in the vault
  // directory. proper-lockfile writes `<lockPath>.lock`; if that sat inside a synced vault
  // folder it would propagate to other devices and one machine's lock could spuriously
  // block another. The lock only ever serialises writers on this machine.
  return buildVaultFromConfig(machine, vault, join(dirname(machineConfigFile()), 'vault-lock'))
}

/**
 * Wire a Vault from a validated config trio: storage / vector index / key / retriever /
 * searcher are each chosen by the type-string in the configs; the embedder's `.dimensions`
 * is the single source of truth for the index. Caller must `await vault.startup()`.
 *
 * The disk reads + pending-migration guard live in `buildVault` (production) and the probe
 * path in `migrate`; this is the shared assembly both delegate to, so a new constructor
 * dependency or a change to the embedder→index rule lands in exactly one place.
 */
export async function buildVaultFromConfig(
  machine: RequiredMachineConfig, vaultCfg: VaultConfig, lockPath: string,
): Promise<Vault> {
  if (!vaultCfg.embedder) throw new Error(`VaultConfig is missing 'embedder' field.`)

  const [storageReg, embedderReg, indexReg, keyReg, retrieverReg, searcherReg] = await Promise.all([
    loadStorageBackends(),
    loadEmbedders(),
    loadVectorIndexes(),
    loadKeyProviders(),
    loadRetrievers(),
    loadSearchers(),
  ])

  const embedder = requireImpl(embedderReg, vaultCfg.embedder, 'embedder').create()
  const index = requireImpl(indexReg, machine.vectorIndex, 'vector index').create(embedder.dimensions)

  return new Vault({
    storage: requireImpl(storageReg, machine.backend, 'storage backend').create(machine),
    embedder,
    index,
    keys: requireImpl(keyReg, machine.keyProvider, 'key provider').create(),
    retriever: requireImpl(retrieverReg, machine.retriever, 'retriever').create(index),
    searcher: requireImpl(searcherReg, machine.searcher, 'searcher').create(),
    lockPath,
  })
}

/** Read the machine config, or print the standard "run init" message and exit(1) if absent. */
export async function readMachineConfigOrExit(): Promise<MachineConfig> {
  const m = await readMachineConfigOrNull()
  if (!m) {
    console.error(`No vault configured on this machine — run 'mementos init' first.`)
    process.exit(1)
  }
  return m
}

/** Build the configured KeyProvider. */
export async function buildKeyProvider(cfg: { keyProvider?: string }): Promise<KeyProvider> {
  if (!cfg.keyProvider) throw new Error(`MachineConfig is missing 'keyProvider'`)
  return requireImpl(await loadKeyProviders(), cfg.keyProvider, 'key provider').create()
}

/** Build the configured StorageBackend (its `create` reads the rest of the machine config). */
export async function buildStorageBackend(cfg: MachineConfig): Promise<StorageBackend> {
  if (!cfg.backend) throw new Error(`MachineConfig is missing 'backend'`)
  return requireImpl(await loadStorageBackends(), cfg.backend, 'storage backend').create(cfg)
}

/** Build storage + key together — the pair `doctor`, `destroy`, and `migrate` need at once. */
export async function buildStorageAndKey(
  cfg: MachineConfig,
): Promise<{ storage: StorageBackend; keyProvider: KeyProvider }> {
  if (!cfg.backend) throw new Error(`MachineConfig is missing 'backend'`)
  if (!cfg.keyProvider) throw new Error(`MachineConfig is missing 'keyProvider'`)
  const [storageReg, keyReg] = await Promise.all([loadStorageBackends(), loadKeyProviders()])
  return {
    storage: requireImpl(storageReg, cfg.backend, 'storage backend').create(cfg),
    keyProvider: requireImpl(keyReg, cfg.keyProvider, 'key provider').create(),
  }
}

/**
 * Run an implementation's `setupAtInit` if it defines one. The cast is centralised here so
 * the call sites read as one line instead of a 2-line `as ...` incantation per registry.
 */
export async function runSetupAtInit(
  impl: { setupAtInit?: unknown },
  ctx: InitContext,
): Promise<void> {
  const setup = impl.setupAtInit as ((ctx: InitContext) => Promise<void>) | undefined
  if (setup) await setup(ctx)
}

/**
 * MachineConfig fields are optional on disk (an old or hand-edited file can be missing any
 * of them). Most CLI paths need every one; this asserts the full shape in one place so the
 * downstream code can use plain field access without per-field guards.
 */
export type RequiredMachineConfig = MachineConfig & Required<Pick<MachineConfig,
  'backend' | 'vectorIndex' | 'retriever' | 'searcher' | 'keyProvider'
>>
export function requireFullMachineConfig(m: MachineConfig, label = 'MachineConfig'): asserts m is RequiredMachineConfig {
  for (const field of ['backend', 'vectorIndex', 'retriever', 'searcher', 'keyProvider'] as const) {
    if (!m[field]) throw new Error(`${label} is missing '${field}'`)
  }
}

/**
 * Refuse to proceed if `path` exists and is non-empty — the `mementos init` and
 * `mementos migrate` target-path guard. ENOENT is treated as "empty enough to use".
 */
export async function refuseIfNonEmpty(
  path: string, ctx: { warn(s: string): void }, label = 'directory',
): Promise<void> {
  const entries = await readdir(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return [] as string[]
    throw e
  })
  if (entries.length === 0) return
  ctx.warn(`The ${label} ${path} is not empty:`)
  for (const e of entries.slice(0, 10)) ctx.warn(`  ${e}`)
  if (entries.length > 10) ctx.warn(`  ... and ${entries.length - 10} more`)
  ctx.warn('Pick a different path or clean this one first.')
  process.exit(1)
}
