/**
 * `mementos migrate` — three migration types (storage / key / embedder), all on one
 * staged model. A manifest at `~/.config/mementos/migration-pending.json` fences the
 * operation: while it exists, `buildVault` refuses every command except `migrate`, so no
 * normal operation observes a mid-migration vault.
 *
 *   STAGE  — build the migrated copy in a staging area; live vault untouched.
 *   COMMIT — back the live vault up, swap staged files in, finalise (keychain / vault.json
 *            / machine config). Recoverable from either side: roll forward from staging or
 *            roll back from the backup.
 *
 * The manifest is deleted last, so "manifest absent" implies "vault consistent".
 */
import { rm, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { confirm as confirmPrompt, select } from '@inquirer/prompts'
import { readMachineConfigOrNull, writeMachineConfig, machineConfigFile, VAULT_CONFIG_FILENAME, readVaultConfig, indexCacheFile } from '../../core/config.js'
import { MEM_EXTENSION } from '../../core/vault/constants.js'
import type { VaultConfig } from '../../core/types.js'
import { loadStorageBackends } from '../../storage/registry.js'
import { loadEmbedders } from '../../embeddings/registry.js'
import { reEncryptMem, canDecryptMem } from '../../core/vault/re-encrypt.js'
import { encrypt } from '../../core/vault/crypto.js'
import { memAad, decryptMemChunks } from '../../core/vault/aad.js'
import { deriveKeyFromEntropy } from '../../keys/_utils/derivation/index.js'
import { safeUnlink } from '../../core/_utils/fs.js'
import { assertNoServerRunning } from '../_utils/assert-no-server.js'
import { CliInitContext } from '../init-context.js'
import type { InitContext } from '../../core/init-context/interface.js'
import { requireImpl, refuseIfNonEmpty, requireFullMachineConfig, runSetupAtInit, buildVaultFromConfig, buildKeyProvider, buildStorageBackend, buildStorageAndKey } from '../_utils/vault.js'
import { promptChoice, promptPath, WizardHeader } from '../_utils/prompts.js'
import { promptTheme, dim } from '../_utils/style.js'
import { parseFlag } from '../_utils/flags.js'
import { promptForNewKey } from '../_utils/new-key.js'
import {
  readManifest, writeManifest, deleteManifest, validateManifestPaths,
  type MigrationManifest, type MigrationPhase,
} from '../_utils/migration-manifest.js'
import {
  stagingDirFor, backupDirFor, stageVaultFiles, backupVaultFiles, applyVaultFiles,
} from '../_utils/migration-backup.js'
import { pathExists } from '../../core/_utils/fs.js'
import type { MachineConfig } from '../../core/types.js'
import type { StorageBackend } from '../../storage/interface.js'
import type { EmbeddingProvider } from '../../embeddings/interface.js'
import type { KeyProvider } from '../../keys/interface.js'
import type { MemFile } from '../../core/vault/types.js'
import { buildChunks } from '../../core/vault/chunker.js'
import type { RequiredMachineConfig } from '../_utils/vault.js'

type MigrationType = 'storage' | 'key' | 'embedder'

export async function runMigrate(): Promise<void> {
  if (parseFlag('abort') !== undefined) {
    await runAbort()
    return
  }

  const machine = await readMachineConfigOrNull()
  if (!machine) {
    console.error('No vault on this machine to migrate. Run `mementos init` first.')
    process.exit(1)
  }

  await assertNoServerRunning('Migration')
  await assertKeyReachable(machine)
  await syncSourceVault(machine)

  const pending = await readManifest()
  if (pending) {
    validateManifestPaths(pending, machine.vaultPath)
    await resumeOrAbort(machine, pending)
    return
  }

  const ctx = new CliInitContext()
  const type = await promptType()
  switch (type) {
    case 'storage':
      await runStorageMigration(ctx, machine)
      return
    case 'key':
      await runKeyMigration(ctx, machine)
      return
    case 'embedder':
      await runEmbedderMigration(ctx, machine)
      return
  }
}

// ─── Type prompt ──────────────────────────────────────────────────────────────

async function promptType(): Promise<MigrationType> {
  const fromFlag = parseFlag('type')
  if (fromFlag === 'storage' || fromFlag === 'key' || fromFlag === 'embedder') return fromFlag
  // Top-level migration-type pick. Each branch paints its own header with
  // branch-specific step count below.
  new WizardHeader('mementos migrate', 1).show(1, console.log)
  return await select<MigrationType>({
    message: `What kind of migration?\n${dim('  Each branch re-encrypts the whole vault under a different config — pick the dimension you want to change.')}`,
    choices: [
      { name: 'Storage backend  (move .mem files to a different backend, e.g. local → git)', value: 'storage' },
      { name: 'Vault key  (rotate to a new mnemonic, re-encrypt all memories)', value: 'key' },
      { name: 'Embedder  (switch embedder, re-embed all memories, rebuild index)', value: 'embedder' },
    ],
    default: 'storage',
    theme: promptTheme,
  })
}

/**
 * Pre-flight check: surface a clear error if the configured key provider can't reach its
 * key material, rather than crashing halfway through a migration with a raw provider error.
 */
async function assertKeyReachable(machine: MachineConfig): Promise<void> {
  const provider = await buildKeyProvider(machine)
  try {
    await provider.getKey()
  } catch (e) {
    console.error(`Cannot read the vault key from the configured provider (${machine.keyProvider}):`)
    console.error(`  ${(e as Error).message}`)
    console.error('')
    console.error('Migration requires the current vault key. Make sure it is reachable in')
    console.error('this shell, then re-run `mementos migrate`.')
    process.exit(1)
  }
}

/** Pull the latest vault from the storage backend before migrating (no-op for LocalBackend). */
async function syncSourceVault(machine: MachineConfig): Promise<void> {
  if (!machine.backend) return
  const storage = await buildStorageBackend(machine)
  await storage.init()
  await storage.sync()
}

/**
 * Storage backend + key provider — the common pair every staged-migration entry point
 * needs. Embedder lookup stays inline at the one caller that loads it.
 */
function loadMigrationBackends(
  machine: RequiredMachineConfig,
): Promise<{ storage: StorageBackend; keyProvider: KeyProvider }> {
  return buildStorageAndKey(machine)
}

// ─── Staged-migration runner ─────────────────────────────────────────────────

const SUCCESS_MSG: Record<'key' | 'embedder', string> = {
  key: '\nKey rotation complete. The new key is active.',
  embedder: '\nEmbedder migration complete. The new embedder is active.',
}

/** The sibling staging+backup directories for a fresh staged migration. */
function migrationPaths(vaultPath: string, startedAt: string): { stagingPath: string; backupPath: string } {
  return {
    stagingPath: stagingDirFor(vaultPath, startedAt),
    backupPath: backupDirFor(vaultPath, startedAt),
  }
}

/**
 * Drive a staged key/embedder migration through its lifecycle. `startFromPhase` skips the
 * stage half on a resume of an already-staged migration.
 */
interface StagedMigration {
  type: 'key' | 'embedder'
  stagingPath: string
  backupPath: string
  buildManifest: (phase: MigrationPhase) => MigrationManifest
  stage: () => Promise<void>
  commit: () => Promise<void>
}

async function runStagedMigration(
  ctx: CliInitContext, m: StagedMigration,
  startFromPhase: MigrationPhase = 'staging',
): Promise<void> {
  if (startFromPhase === 'staging') {
    await writeManifest(m.buildManifest('staging'))
    await m.stage()
    await writeManifest(m.buildManifest('committing'))
  }
  await m.commit()
  await deleteManifest()
  await rm(m.stagingPath, { recursive: true, force: true })
  ctx.print(SUCCESS_MSG[m.type])
  printBackupNote(ctx, m.backupPath, m.type)
}

/** Throw a consistent `Cannot parse <path>` wrapped error around `JSON.parse`. */
function parseMemFile(path: string, bytes: Buffer): MemFile {
  try {
    return JSON.parse(bytes.toString('utf8')) as MemFile
  } catch (e) {
    throw new Error(`Cannot parse ${path} as a MemFile: ${(e as Error).message}`)
  }
}

/** True iff `predicate` is truthy for every `.mem` file in storage. */
async function everyMemMatches(
  storage: StorageBackend,
  predicate: (data: Buffer) => boolean | Promise<boolean>,
): Promise<boolean> {
  const files = await storage.list()
  const results = await Promise.all(files.map(async f => predicate((await storage.get(f)).data)))
  return results.every(Boolean)
}

// ─── Key migration ────────────────────────────────────────────────────────────

/** Rotate the vault key. Backup is kept after success — recovery for a mistyped mnemonic. */
async function runKeyMigration(ctx: CliInitContext, machine: MachineConfig): Promise<void> {
  requireFullMachineConfig(machine)
  const { storage, keyProvider: provider } = await loadMigrationBackends(machine)
  const oldKey = await provider.getKey()

  // The new-key flow has its own 1-3 prompts (generate vs type, optional
  // double-entry); 1-step header here gives the user the command context.
  new WizardHeader('mementos migrate (key)', 1).show(1, ctx.print)
  // New key from the user — generated fresh (recommended) or typed (entered twice).
  const { entropy: newEntropy } = await promptForNewKey(ctx)
  const newKey = deriveKeyFromEntropy(newEntropy)

  const startedAt = new Date().toISOString()
  const { stagingPath, backupPath } = migrationPaths(machine.vaultPath, startedAt)
  await runStagedMigration(ctx, {
    type: 'key',
    stagingPath, backupPath,
    buildManifest: phase => ({ type: 'key', startedAt, stagingPath, backupPath, phase }),
    stage: async () => {
      ctx.print('\nRe-encrypting the vault into a staging area (the live vault is untouched)...')
      await stageVaultFiles(storage, stagingPath, (path, bytes) => keyStageTransform(path, bytes, oldKey, newKey))
    },
    commit: () => commitKeyMigration(ctx, storage, stagingPath, backupPath, provider, newEntropy),
  })
}

async function keyStageTransform(path: string, bytes: Buffer, oldKey: Buffer, newKey: Buffer): Promise<Buffer> {
  const mem = parseMemFile(path, bytes)
  if (!canDecryptMem(bytes, oldKey)) {
    throw new Error(`Cannot decrypt ${path} with the current vault key — file may be corrupt.`)
  }
  return Buffer.from(JSON.stringify(reEncryptMem(mem, oldKey, newKey)))
}

/** Commit half — back up, swap staged files in, switch the keychain. Idempotent. */
async function commitKeyMigration(
  ctx: CliInitContext, storage: StorageBackend, stagingPath: string, backupPath: string,
  provider: { storeEntropy: (e: Buffer, c: InitContext) => Promise<void> }, newEntropy: Buffer,
): Promise<void> {
  ctx.print('Backing up the vault under the previous key...')
  await backupVaultFiles(storage, backupPath)
  ctx.print('Activating the re-encrypted vault...')
  await applyVaultFiles(storage, stagingPath)
  ctx.print('Updating the stored key...')
  await provider.storeEntropy(newEntropy, ctx)
}

/** Re-prompts for the new mnemonic; refuses if it doesn't decrypt a staged file. */
async function resumeKeyMigration(
  ctx: CliInitContext, machine: MachineConfig,
  manifest: { startedAt: string; stagingPath: string; backupPath: string; phase: MigrationPhase },
): Promise<void> {
  requireFullMachineConfig(machine)
  const { storage, keyProvider: provider } = await loadMigrationBackends(machine)

  ctx.print('Re-enter the new mnemonic from the in-progress migration.')
  const { entropy: newEntropy } = await promptForNewKey(ctx)
  const newKey = deriveKeyFromEntropy(newEntropy)
  await verifyKeyAgainstStaging(manifest.stagingPath, newKey, ctx)

  await runStagedMigration(ctx, {
    type: 'key',
    stagingPath: manifest.stagingPath, backupPath: manifest.backupPath,
    buildManifest: phase => ({ type: 'key', ...manifest, phase }),
    stage: async () => {
      const oldKey = await provider.getKey()
      ctx.print('\nContinuing to re-encrypt into the staging area...')
      await stageVaultFiles(storage, manifest.stagingPath,
        (path, bytes) => keyStageTransform(path, bytes, oldKey, newKey))
    },
    commit: () => commitKeyMigration(ctx, storage, manifest.stagingPath, manifest.backupPath, provider, newEntropy),
  }, manifest.phase)
}

async function verifyKeyAgainstStaging(stagingPath: string, newKey: Buffer, ctx: CliInitContext): Promise<void> {
  const names = await readdir(stagingPath).catch(() => [] as string[])
  const sample = names.find(n => n.endsWith(MEM_EXTENSION))
  if (!sample) return
  const bytes = await readFile(join(stagingPath, sample))
  if (!canDecryptMem(bytes, newKey)) {
    ctx.warn('That mnemonic does not match the in-progress migration.')
    ctx.warn('Re-run `mementos migrate` with the correct mnemonic, or')
    ctx.warn('`mementos migrate --abort` to discard the in-progress migration.')
    process.exit(1)
  }
}

// ─── Embedder migration ───────────────────────────────────────────────────────

/** Switch the embedder. Re-embeds every memory, writes vault.json, drops the HNSW cache. */
async function runEmbedderMigration(ctx: CliInitContext, machine: MachineConfig): Promise<void> {
  requireFullMachineConfig(machine)

  const vaultConfig = await readVaultConfig(machine.vaultPath)
  const currentEmbedderType = vaultConfig.embedder

  const [{ storage, keyProvider }, embedderReg] = await Promise.all([
    loadMigrationBackends(machine),
    loadEmbedders(),
  ])

  new WizardHeader('mementos migrate (embedder)', 1).show(1, ctx.print)
  const targetEmbedderType = await promptChoice(
    ctx, `Target embedder (current: ${currentEmbedderType})`,
    'target-embedder',
    new Map([...embedderReg].filter(([name]) => name !== currentEmbedderType)),
    {
      defaultType: [...embedderReg.keys()].find(k => k !== currentEmbedderType) ?? '',
      hint: 'Re-embeds every memento under the new model and rebuilds the vector index.',
    },
  )
  if (targetEmbedderType === currentEmbedderType) {
    ctx.warn(`Target embedder must differ from current (${currentEmbedderType}). Nothing to do.`)
    process.exit(1)
  }

  const targetEmbedder = await resolveTargetEmbedder(ctx, embedderReg, currentEmbedderType, targetEmbedderType)
  const key = await keyProvider.getKey()

  const startedAt = new Date().toISOString()
  const { stagingPath, backupPath } = migrationPaths(machine.vaultPath, startedAt)
  await runStagedMigration(ctx, {
    type: 'embedder',
    stagingPath, backupPath,
    buildManifest: phase => ({
      type: 'embedder', startedAt, targetEmbedder: targetEmbedderType, stagingPath, backupPath, phase,
    }),
    stage: async () => {
      ctx.print('\nRe-embedding the vault into a staging area (the live vault is untouched)...')
      await stageVaultFiles(storage, stagingPath, (path, bytes) => embedderStageTransform(path, bytes, key, targetEmbedder))
    },
    commit: () => commitEmbedderMigration(ctx, storage, stagingPath, backupPath, targetEmbedderType),
  })
}

/** Refuses if source and target dimensions match — the abort probe relies on dim mismatch. */
async function resolveTargetEmbedder(
  ctx: CliInitContext,
  embedderReg: Awaited<ReturnType<typeof loadEmbedders>>,
  currentEmbedderType: string, targetEmbedderType: string,
): Promise<EmbeddingProvider> {
  const targetImpl = requireImpl(embedderReg, targetEmbedderType, 'embedder')
  await runSetupAtInit(targetImpl, ctx)
  const targetEmbedder = targetImpl.create()
  const sourceEmbedder = requireImpl(embedderReg, currentEmbedderType, 'embedder').create()
  if (targetEmbedder.dimensions === sourceEmbedder.dimensions) {
    ctx.warn(`Source and target embedder have the same vector dimension (${targetEmbedder.dimensions}).`)
    ctx.warn(`mementos cannot reliably tell migrated files from untouched ones when dims match. Refusing.`)
    process.exit(1)
  }
  return targetEmbedder
}

async function embedderStageTransform(
  path: string, bytes: Buffer, key: Buffer, embedder: EmbeddingProvider,
): Promise<Buffer> {
  const mem = parseMemFile(path, bytes)
  const chunks = decryptMemChunks(mem, key)
  // `embedBatch` sub-batches internally so a long memento re-embeds in a few padded
  // passes, not one ONNX call per chunk.
  const vectors = await embedder.embedBatch(chunks.map(c => c.text))
  const reEmbedded = buildChunks(chunks.map(c => c.text), vectors)
  return Buffer.from(JSON.stringify({
    ...mem,
    chunks: encrypt(Buffer.from(JSON.stringify(reEmbedded)), key, memAad(mem.id, 'chunks')),
  }))
}

/** Commit half — back up, swap, write vault.json, drop HNSW cache. Idempotent. */
async function commitEmbedderMigration(
  ctx: CliInitContext, storage: StorageBackend, stagingPath: string, backupPath: string,
  targetEmbedderType: string,
): Promise<void> {
  ctx.print('Backing up the vault under the previous embedder...')
  await backupVaultFiles(storage, backupPath)
  ctx.print('Activating the re-embedded vault...')
  await applyVaultFiles(storage, stagingPath)
  ctx.print('Updating vault.json...')
  const newVaultConfig: VaultConfig = { embedder: targetEmbedderType }
  await storage.put(VAULT_CONFIG_FILENAME, Buffer.from(JSON.stringify(newVaultConfig, null, 2), 'utf8'))
  // The HNSW cache has the old vectors / wrong dimension — drop it; it rebuilds on startup.
  await safeUnlink(indexCacheFile())
}

async function resumeEmbedderMigration(
  ctx: CliInitContext, machine: MachineConfig,
  manifest: {
    startedAt: string; targetEmbedder: string
    stagingPath: string; backupPath: string; phase: MigrationPhase
  },
): Promise<void> {
  requireFullMachineConfig(machine)
  const [{ storage, keyProvider }, embedderReg] = await Promise.all([
    loadMigrationBackends(machine),
    loadEmbedders(),
  ])

  await runStagedMigration(ctx, {
    type: 'embedder',
    stagingPath: manifest.stagingPath, backupPath: manifest.backupPath,
    buildManifest: phase => ({ type: 'embedder', ...manifest, phase }),
    stage: async () => {
      const vaultConfig = await readVaultConfig(machine.vaultPath)
      const targetEmbedder = await resolveTargetEmbedder(ctx, embedderReg, vaultConfig.embedder, manifest.targetEmbedder)
      const key = await keyProvider.getKey()
      ctx.print('\nContinuing to re-embed into the staging area...')
      await stageVaultFiles(storage, manifest.stagingPath,
        (path, bytes) => embedderStageTransform(path, bytes, key, targetEmbedder))
    },
    commit: () => commitEmbedderMigration(ctx, storage, manifest.stagingPath, manifest.backupPath, manifest.targetEmbedder),
  }, manifest.phase)
}

// ─── Storage migration ────────────────────────────────────────────────────────

async function runStorageMigration(ctx: CliInitContext, machine: MachineConfig): Promise<void> {
  const storageReg = await loadStorageBackends()
  ctx.print(`Current vault: backend=${machine.backend}, path=${machine.vaultPath}\n`)

  const header = new WizardHeader('mementos migrate (storage)', 2)
  header.show(1, ctx.print)
  const targetBackendType = await promptChoice(ctx, 'Target storage backend', 'backend', storageReg, {
    defaultType: 'git',
    hint: 'Where the encrypted .mem files will live after the migration.',
  })
  header.show(2, ctx.print)
  ctx.print(dim('  Absolute path; refuses to start if anything already exists at this location.'))
  const targetVaultPath = await promptPath(ctx, 'Target vault path (must be empty or non-existent)', 'vault-path', '')
  if (targetVaultPath === machine.vaultPath) {
    ctx.warn('Target vault path is the same as the current one. Pick a different path.')
    process.exit(1)
  }
  await refuseIfNonEmpty(targetVaultPath, ctx)

  // Build a partial target MachineConfig; impl-specific setupAtInit may patch in fields
  // (e.g. GitBackend's `git: { remote }` from its remote-URL prompt).
  const targetImpl = requireImpl(storageReg, targetBackendType, 'storage backend')
  await runSetupAtInit(targetImpl, ctx)

  const target: MachineConfig = {
    ...machine,
    vaultPath: targetVaultPath,
    backend: targetBackendType,
  }
  ctx.applyPatches(target)

  // Write the manifest BEFORE creating any files on the target — any artifacts the
  // migration creates after this point are claimed by this manifest.
  await writeManifest({
    type: 'storage',
    startedAt: new Date().toISOString(),
    targetBackend: targetBackendType,
    targetVaultPath,
    targetBackendConfig: target.backendConfig,
  })

  await doStorageCopy(ctx, machine, target)
}

/**
 * The data-moving body of storage migration. Shared by the fresh-start path and the
 * resume path because both end up here after the manifest exists and the target
 * MachineConfig is known.
 */
async function doStorageCopy(ctx: CliInitContext, source: MachineConfig, target: MachineConfig): Promise<void> {
  const storageReg = await loadStorageBackends()
  const sourceImpl = requireImpl(storageReg, source.backend ?? '', 'storage backend')
  const targetImpl = requireImpl(storageReg, target.backend ?? '', 'storage backend')

  const sourceBackend = sourceImpl.create(source)
  const targetBackend = targetImpl.create(target)
  await targetBackend.init()

  await refuseIfTargetHostsForeignVault(sourceBackend, targetBackend, ctx)

  const sourceMemFiles = await sourceBackend.list()
  const targetMemFiles = new Set(await targetBackend.list())
  const filesNeedingCopy = sourceMemFiles.filter(f => !targetMemFiles.has(f))

  const targetHasVaultJson = await targetBackend.get(VAULT_CONFIG_FILENAME).then(() => true).catch(() => false)

  const totalAlready = sourceMemFiles.length - filesNeedingCopy.length + (targetHasVaultJson ? 1 : 0)
  const totalToCopy = filesNeedingCopy.length + (targetHasVaultJson ? 0 : 1)
  ctx.print(`\n${totalAlready} files already at target, ${totalToCopy} files to copy.`)

  if (totalToCopy > 0) {
    ctx.print(`Reading from source and writing to target...`)
    const reads = await Promise.all(filesNeedingCopy.map(f => sourceBackend.get(f)))
    const batch: Array<{ path: string; data: Buffer }> = filesNeedingCopy.map((f, i) => ({
      path: f, data: reads[i].data,
    }))
    if (!targetHasVaultJson) {
      const { data } = await sourceBackend.get(VAULT_CONFIG_FILENAME)
      batch.push({ path: VAULT_CONFIG_FILENAME, data })
    }
    await targetBackend.putBatch(batch)
    ctx.print(`Wrote ${batch.length} files to target.`)
  }

  ctx.print(`Verifying with decrypt probe...`)
  await probeTarget(target)
  ctx.print(`Probe passed.`)

  // Atomic swap: rewrite the MachineConfig pointing at the target.
  await writeMachineConfig(target)
  ctx.print(`Wrote ${machineConfigFile()} — vault now points at ${target.backend} at ${target.vaultPath}`)

  await deleteManifest()

  ctx.print('\nMigration complete.')
  ctx.print(`Old vault data is at ${source.vaultPath} — delete it manually once the new backend is confirmed working.`)
  // Backend-specific reminder: git's remote is a separate destruction decision.
  // Each backend's describeManualRemoval enumerates the lines; we render them as
  // post-migrate notes so the user knows what still has copies.
  for (const line of sourceBackend.describeManualRemoval(source.vaultPath)) ctx.print(`  ${line}`)
}

/**
 * If the target storage already has a vault.json, it must either be a partial copy of
 * our source (resume case — matching bytes) or somebody else's vault (refuse case).
 */
async function refuseIfTargetHostsForeignVault(
  source: StorageBackend, target: StorageBackend, ctx: CliInitContext,
): Promise<void> {
  const targetVault = await target.get(VAULT_CONFIG_FILENAME).catch(() => null)
  if (!targetVault) return
  const sourceVault = await source.get(VAULT_CONFIG_FILENAME).catch(() => null)
  if (sourceVault && targetVault.data.equals(sourceVault.data)) return  // matches — resume case
  ctx.warn(`The target backend already contains a different vault.json.`)
  ctx.warn('Refusing to merge — pick a different target location or wipe it first.')
  process.exit(1)
}

/**
 * Build a one-shot Vault against the target MachineConfig and run startup() — reads every
 * `.mem` and decrypts it, the strongest end-to-end check for a storage migration.
 */
async function probeTarget(target: MachineConfig): Promise<void> {
  const vaultCfg = await readVaultConfig(target.vaultPath)
  requireFullMachineConfig(target, 'target MachineConfig')
  const probe = await buildVaultFromConfig(target, vaultCfg, target.vaultPath)
  await probe.startup()
}

// ─── Resume / abort ───────────────────────────────────────────────────────────

async function resumeOrAbort(machine: MachineConfig, manifest: MigrationManifest): Promise<void> {
  const ctx = new CliInitContext()
  ctx.print(`Detected migration in progress (type=${manifest.type}, started=${manifest.startedAt}).`)
  new WizardHeader('mementos migrate (resume)', 1).show(1, ctx.print)
  const cont = await confirmPrompt({
    message: `Continue this migration?\n${dim('  Choose No to abort and roll back any staged changes.')}`,
    default: true,
    theme: promptTheme,
  })
  if (!cont) {
    await doAbort(manifest, machine, ctx)
    return
  }

  switch (manifest.type) {
    case 'storage': {
      const target: MachineConfig = {
        ...machine,
        backend: manifest.targetBackend,
        vaultPath: manifest.targetVaultPath,
        backendConfig: manifest.targetBackendConfig,
      }
      await doStorageCopy(ctx, machine, target)
      return
    }
    case 'key':
      await resumeKeyMigration(ctx, machine, manifest)
      return
    case 'embedder':
      await resumeEmbedderMigration(ctx, machine, manifest)
      return
  }
}

async function runAbort(): Promise<void> {
  const manifest = await readManifest()
  if (!manifest) {
    console.log('No migration in progress.')
    return
  }
  // Aborting a key/embedder migration can rewrite `.mem` files (restoring the backup) —
  // the same "no live server" rule as a forward migration.
  await assertNoServerRunning('Migration')
  const machine = await readMachineConfigOrNull()
  // The abort probe reads the vault under the current key. Storage abort just deletes a
  // directory — no key needed.
  if (machine && manifest.type !== 'storage') {
    validateManifestPaths(manifest, machine.vaultPath)
    await assertKeyReachable(machine)
  }
  const ctx = new CliInitContext()
  await doAbort(manifest, machine, ctx)
}

/** Cancel an in-progress migration, leaving the vault as it was before `mementos migrate`. */
async function doAbort(
  manifest: MigrationManifest, machine: MachineConfig | null, ctx: CliInitContext,
): Promise<void> {
  switch (manifest.type) {
    case 'storage': {
      ctx.print(`Aborting storage migration — removing ${manifest.targetVaultPath}.`)
      ctx.print(`(Source vault is untouched.)`)
      await rm(manifest.targetVaultPath, { recursive: true, force: true })
      // Per-backend reminder of state we DIDN'T touch (e.g. a git remote stays).
      // Build a target-shaped MachineConfig just to instantiate the backend so we
      // can ask it for its own removal recipe. Only backend/backendConfig/vaultPath
      // affect storage construction; the other required fields are filled with empty
      // strings (backend.create never reads them, so they cannot mislead anyone).
      const targetCfg: MachineConfig = {
        backend: manifest.targetBackend,
        backendConfig: manifest.targetBackendConfig,
        vaultPath: manifest.targetVaultPath,
        vectorIndex: machine?.vectorIndex ?? '',
        retriever: machine?.retriever ?? '',
        searcher: machine?.searcher ?? '',
        keyProvider: machine?.keyProvider ?? '',
      }
      const targetBackendForRecipe = await buildStorageBackend(targetCfg)
      for (const line of targetBackendForRecipe.describeManualRemoval(manifest.targetVaultPath)) ctx.print(`  ${line}`)
      break
    }
    case 'key': {
      if (!machine) { ctx.warn('No machine config found — removing the manifest only.'); break }
      await abortStagedMigration(machine, manifest.stagingPath, manifest.backupPath, ctx, 'key')
      break
    }
    case 'embedder': {
      if (!machine) { ctx.warn('No machine config found — removing the manifest only.'); break }
      await abortStagedMigration(machine, manifest.stagingPath, manifest.backupPath, ctx, 'embedder')
      break
    }
  }
  await deleteManifest()
  ctx.print('Migration aborted — the vault is back to its pre-migration state.')
}

async function abortStagedMigration(
  machine: MachineConfig, stagingPath: string, backupPath: string,
  ctx: CliInitContext, kind: 'key' | 'embedder',
): Promise<void> {
  requireFullMachineConfig(machine)
  const { storage, keyProvider } = await loadMigrationBackends(machine)
  const key = await keyProvider.getKey()

  const probeOk = kind === 'key'
    ? await vaultMatchesActiveKey(storage, key)
    : await vaultMatchesActiveEmbedder(storage, machine.vaultPath, key)
  // Safety net: the decrypt/dimension probe only inspects files that still EXIST — a
  // commit that lost `.mem` files mid-write would still "probe consistent" on the
  // survivors. Cross-check the live file set against the backup: a live vault missing any
  // memento the backup has is NOT consistent — restore from the backup before it's gone.
  const complete = !await pathExists(backupPath) || await liveCoversBackup(storage, backupPath)
  const consistent = probeOk && complete

  if (consistent) {
    ctx.print('The live vault is consistent — discarding the migration staging area.')
  } else {
    if (!await pathExists(backupPath)) {
      ctx.warn(`The pre-migration backup at ${backupPath} is missing — cannot restore.`)
      ctx.warn('Run `mementos migrate` to finish the migration forward instead.')
      process.exit(1)
    }
    ctx.print(`Restoring the pre-migration vault from ${backupPath}...`)
    await applyVaultFiles(storage, backupPath)
    await safeUnlink(indexCacheFile())
  }
  await rm(stagingPath, { recursive: true, force: true })
  await rm(backupPath, { recursive: true, force: true })
}

/**
 * True if the live vault contains every `.mem` file the backup directory has. A live
 * vault missing files the backup holds means a commit lost data mid-write — the live
 * vault is incomplete and must be restored, regardless of whether the survivors decrypt.
 */
async function liveCoversBackup(storage: StorageBackend, backupPath: string): Promise<boolean> {
  const live = new Set(await storage.list())
  const backedUp = (await readdir(backupPath)).filter(f => f.endsWith(MEM_EXTENSION))
  return backedUp.every(f => live.has(f))
}

/** True iff every `.mem` decrypts under `key`. */
async function vaultMatchesActiveKey(storage: StorageBackend, key: Buffer): Promise<boolean> {
  return everyMemMatches(storage, data => canDecryptMem(data, key))
}

/** True iff every chunk vector matches the dimension of the embedder named in vault.json. */
async function vaultMatchesActiveEmbedder(
  storage: StorageBackend, vaultPath: string, key: Buffer,
): Promise<boolean> {
  const vaultConfig = await readVaultConfig(vaultPath)
  const embedderReg = await loadEmbedders()
  const dims = requireImpl(embedderReg, vaultConfig.embedder, 'embedder').create().dimensions
  return everyMemMatches(storage, data => {
    const mem = JSON.parse(data.toString()) as MemFile
    const chunks = decryptMemChunks(mem, key)
    return !chunks[0] || chunks[0].vector.length === dims
  })
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Tell the user where the kept pre-migration backup is. */
function printBackupNote(ctx: CliInitContext, backupPath: string, kind: 'key' | 'embedder'): void {
  ctx.print(`\nA backup of your vault from before the migration was kept at:\n  ${backupPath}`)
  if (kind === 'key') {
    ctx.print('It is readable with your PREVIOUS mnemonic. Confirm the new key works')
    ctx.print('(e.g. `mementos doctor`), then delete it. If the new mnemonic was mistyped,')
    ctx.print('that backup is your only readable copy.')
  } else {
    ctx.print('Delete it once you are satisfied with the new embedder.')
  }
}
