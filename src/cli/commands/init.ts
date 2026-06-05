/**
 * `mementos init` — interactive first-time setup.
 *
 * Two top-level modes, asked first:
 *   1. Create new vault — generate a fresh vault on this machine. Refuses if the chosen
 *      vault path is non-empty.
 *   2. Join existing vault — attach to a vault that lives somewhere else (git remote or a
 *      shared local path). Clones the storage, adopts the cloned `vault.json`, prompts
 *      for the existing key (type mnemonic / type raw / LAN pair), persists locally.
 *
 * Each prompt offers a default; pressing Enter accepts it. Flags (`--backend=git`,
 * `--mode=join`, etc.) skip the corresponding prompt — useful for CI and scripted setup.
 *
 * Init does NOT auto-start `mementos serve`. The MCP server is launched by the AI client
 * (Claude Code, Claude Desktop) when it connects — we just print instructions.
 *
 * Refuses to switch keyProvider/embedder on an existing vault — the two modes produce
 * different AES keys / incompatible vector spaces, so switching would brick existing data.
 *
 * VaultConfig (`vault.json`) is written *through* the chosen StorageBackend. For
 * GitBackend this commits + pushes, so a second device cloning the same remote sees the
 * config alongside the .mem files. Writing via direct fs would leave vault.json out of
 * git history and break clone-based setups.
 */
import { select, checkbox } from '@inquirer/prompts'
import {
  readMachineConfigOrNull, writeMachineConfig, machineConfigFile,
  readVaultConfig, VAULT_CONFIG_FILENAME, vaultPath,
} from '../../core/config.js'
import type { MachineConfig, VaultConfig } from '../../core/types.js'
import type { StorageBackend } from '../../storage/interface.js'
import type { MemFile } from '../../core/vault/types.js'
import { AuthenticationError } from '../../core/vault/crypto.js'
import { decryptMemChunks } from '../../core/vault/aad.js'
import { MEM_EXTENSION } from '../../core/vault/constants.js'
import { loadStorageBackends } from '../../storage/registry.js'
import { loadEmbedders } from '../../embeddings/registry.js'
import { loadVectorIndexes } from '../../vector/registry.js'
import { loadKeyProviders } from '../../keys/registry.js'
import { loadRetrievers } from '../../retrievers/registry.js'
import { loadSearchers, type SearcherFactory } from '../../searchers/registry.js'
import { loadIntegrations, type IntegrationFactory } from '../../integrations/registry.js'
import { printBanner } from '../_utils/banner.js'
import type { DiscoveredImpl } from '../../core/discovery.js'
import type { StorageImplementationModule } from '../../storage/registry.js'
import type { EmbedderFactory } from '../../embeddings/registry.js'
import type { VectorIndexImplementationModule } from '../../vector/registry.js'
import type { KeyProviderImplementationModule } from '../../keys/registry.js'
import type { RetrieverImplementationModule } from '../../retrievers/registry.js'
import { CliInitContext } from '../init-context.js'
import { requireImpl, refuseIfNonEmpty, runSetupAtInit } from '../_utils/vault.js'
import { promptChoice, promptPath } from '../_utils/prompts.js'
import { parseFlag } from '../_utils/flags.js'
import { promptForExistingKey } from '../_utils/existing-key.js'
import { ensureAllPlugins } from '../../core/plugins.js'

type Mode = 'new' | 'join'

interface InitDeps {
  ctx: CliInitContext
  existing: MachineConfig | null
  storageReg: Map<string, DiscoveredImpl<StorageImplementationModule['create']>>
  embedderReg: Map<string, DiscoveredImpl<EmbedderFactory>>
  indexReg: Map<string, DiscoveredImpl<VectorIndexImplementationModule['create']>>
  keyReg: Map<string, DiscoveredImpl<KeyProviderImplementationModule['create']>>
  retrieverReg: Map<string, DiscoveredImpl<RetrieverImplementationModule['create']>>
  searcherReg: Map<string, DiscoveredImpl<SearcherFactory>>
  integrationReg: Map<string, DiscoveredImpl<IntegrationFactory>>
}

export async function runInit(): Promise<void> {
  const existing = await readMachineConfigOrNull()

  if (existing && parseFlag('reinit') === undefined) {
    console.error('Vault already initialised on this machine.\n')
    console.error('For specific changes use the dedicated commands:')
    console.error('  mementos integration enable <name>   add or refresh an integration')
    console.error('  mementos integration list            show what is installed')
    console.error('  mementos integration hook enable | disable <name>   toggle a client hook\n')
    console.error('To re-prompt all configs without regenerating the vault key:')
    console.error('  mementos init --reinit\n')
    console.error('To completely start over (this can LOSE ACCESS to existing memories):')
    console.error('  mementos destroy   # interactive — choose what to remove, then re-init')
    process.exit(1)
  }

  const [storageReg, embedderReg, indexReg, keyReg, retrieverReg, searcherReg, integrationReg] = await Promise.all([
    loadStorageBackends(),
    loadEmbedders(),
    loadVectorIndexes(),
    loadKeyProviders(),
    loadRetrievers(),
    loadSearchers(),
    loadIntegrations(),
  ])

  const ctx = new CliInitContext()
  printBanner()
  ctx.print('encrypted AI memory vault')
  if (existing) {
    ctx.print('Existing vault detected — re-init will refresh configs and integrations,')
    ctx.print('but will NOT regenerate the vault key (your memories stay readable).')
  }
  ctx.print('Press Enter to accept the [default] for any choice.\n')

  // --reinit always means "new vault flow against existing setup" — switching to join
  // mode mid-vault doesn't have a meaningful preserve-data semantic. Forcing 'new' here
  // (rather than re-prompting) makes the reinit path predictable.
  const mode: Mode = existing
    ? 'new'
    : await promptMode()

  if (mode === 'new') {
    await runInitNew({ ctx, existing, storageReg, embedderReg, indexReg, keyReg, retrieverReg, searcherReg, integrationReg })
  } else {
    await runInitJoin({ ctx, existing, storageReg, embedderReg, indexReg, keyReg, retrieverReg, searcherReg, integrationReg })
  }
}

/** Top-of-init prompt asking new vs. join. `--mode=new|join` skips it. */
async function promptMode(): Promise<Mode> {
  const fromFlag = parseFlag('mode')
  if (fromFlag === 'new' || fromFlag === 'join') return fromFlag
  return await select<Mode>({
    message: 'Are you setting up a new vault, or joining one that already exists?',
    choices: [
      { name: 'Create new vault (default)', value: 'new' },
      { name: 'Join existing vault (clone from a remote or attach to a shared dir)', value: 'join' },
    ],
    default: 'new',
  })
}

// ─── New vault flow ───────────────────────────────────────────────────────────

/** Fresh-vault setup. Refuses if the chosen vaultPath is non-empty. */
async function runInitNew(deps: InitDeps): Promise<void> {
  const { ctx, existing, storageReg, embedderReg, indexReg, keyReg, retrieverReg, searcherReg, integrationReg } = deps

  const existingVault = await readExistingVault(existing)
  await refuseFlagSwitches(existing, existingVault)

  const backendType = await promptChoice(ctx, 'Storage backend', 'backend', storageReg, 'local')
  // Selection-time tips (e.g. local's OS-sync tip, openai's privacy note) are
  // fired by promptChoice itself — each impl module exports `describeSelectionTip`.
  const chosenVaultPath = await promptPath(
    ctx, 'Where should the vault live?', 'vault-path',
    existing?.vaultPath ?? vaultPath(),
  )
  const embedderType = await promptChoice(ctx, 'Embedder', 'embedder', embedderReg, 'minilm')
  const indexType = await promptChoice(ctx, 'Vector index', 'index', indexReg, 'hnsw')
  const retrieverType = await promptChoice(ctx, 'Retriever', 'retriever', retrieverReg, 'semantic')
  const searcherType = await promptChoice(ctx, 'Searcher (lexical search — scan/trigram, or none to disable)', 'searcher', searcherReg, 'scan')
  const keyType = await promptChoice(ctx, 'Key provider', 'key', keyReg, 'keychain')

  const storageImpl = requireImpl(storageReg, backendType, 'storage backend')
  const embedderImpl = requireImpl(embedderReg, embedderType, 'embedder')
  const indexImpl = requireImpl(indexReg, indexType, 'vector index')
  const retrieverImpl = requireImpl(retrieverReg, retrieverType, 'retriever')
  const searcherImpl = requireImpl(searcherReg, searcherType, 'searcher')
  const keyImpl = requireImpl(keyReg, keyType, 'key provider')

  if (existing?.keyProvider && existing.keyProvider !== keyType) {
    ctx.warn(`This machine already has a vault initialised with keyProvider="${existing.keyProvider}".`)
    ctx.warn(`Switching to keyProvider="${keyType}" would lock your existing data.`)
    ctx.warn(`If you really want to start fresh: mementos destroy`)
    process.exit(1)
  }
  if (existingVault && existingVault.vault.embedder !== embedderType) {
    ctx.warn(`This vault was initialised with embedder="${existingVault.vault.embedder}".`)
    ctx.warn(`Switching to embedder="${embedderType}" would make existing memories unretrievable.`)
    ctx.warn(`If you really want to start fresh: mementos destroy`)
    process.exit(1)
  }

  // Skipped on --reinit: the vault dir is expected to have content there.
  if (!existing) await refuseIfNonEmpty(chosenVaultPath, ctx)

  ctx.print('')

  for (const impl of [storageImpl, embedderImpl, indexImpl, retrieverImpl, searcherImpl, keyImpl]) {
    await runSetupAtInit(impl, ctx)
  }

  const machine: MachineConfig = {
    vaultPath: chosenVaultPath,
    backend: backendType,
    vectorIndex: indexType,
    retriever: retrieverType,
    searcher: searcherType,
    keyProvider: keyType,
  }
  ctx.applyPatches(machine)

  const storage = storageImpl.create(machine)
  await storage.init()

  const existingOnStorage = await storage.get(VAULT_CONFIG_FILENAME).catch(() => null)
  if (existingOnStorage) {
    const adopted = JSON.parse(existingOnStorage.data.toString()) as VaultConfig
    if (adopted.embedder !== embedderType) {
      ctx.warn(`The vault at this storage backend was initialised with embedder="${adopted.embedder}".`)
      ctx.warn(`Cannot continue with embedder="${embedderType}" — vectors would be incompatible.`)
      ctx.warn(`Re-run with --embedder=${adopted.embedder} (or use --mode=join to attach as-is).`)
      process.exit(1)
    }
    ctx.print(`Adopted existing ${VAULT_CONFIG_FILENAME} from storage (embedder=${adopted.embedder}).`)
  } else {
    const vault: VaultConfig = { embedder: embedderType }
    await storage.put(VAULT_CONFIG_FILENAME, Buffer.from(JSON.stringify(vault, null, 2), 'utf8'))
    ctx.print(`Wrote ${machine.vaultPath}/${VAULT_CONFIG_FILENAME}`)
  }

  await writeMachineConfig(machine)
  ctx.print(`Wrote ${machineConfigFile()}\n`)

  await runFullInstall(ctx, embedderReg, embedderType)
  await setupIntegrations(ctx, integrationReg)
}

// ─── Join existing vault flow ─────────────────────────────────────────────────

/**
 * Attach this machine to an existing vault hosted somewhere else. We clone before
 * prompting for things downstream because the cloned `vault.json` determines the embedder.
 */
async function runInitJoin(deps: InitDeps): Promise<void> {
  const { ctx, existing, storageReg, embedderReg, indexReg, keyReg, retrieverReg, searcherReg, integrationReg } = deps

  if (existing) {
    // The top-level guard already refused this case if --reinit wasn't passed. But with
    // --reinit + --mode=join, we'd land here on a machine that already has a vault — that
    // would clobber the existing setup with a different one. Refuse with a clear pointer.
    ctx.warn('This machine already has a vault initialised. --mode=join would replace it.')
    ctx.warn('To wipe this machine first:  mementos destroy')
    process.exit(1)
  }

  const backendType = await promptChoice(ctx, 'Storage backend', 'backend', storageReg, 'local')
  const chosenVaultPath = await promptPath(
    ctx, 'Where should the vault live on this machine?', 'vault-path', vaultPath(),
  )

  const storageImpl = requireImpl(storageReg, backendType, 'storage backend')

  // Run only the storage backend's setupAtInit now — git needs the remote URL prompt to
  // happen before storage.init() so the clone has somewhere to clone FROM.
  await runSetupAtInit(storageImpl, ctx)

  // Partial MachineConfig — enough to construct storage + clone. Other fields land below.
  const partial: Partial<MachineConfig> = {
    vaultPath: chosenVaultPath,
    backend: backendType,
  }
  ctx.applyPatches(partial as MachineConfig)

  const storage = storageImpl.create(partial as MachineConfig)
  await storage.init()

  // Refuse if the storage doesn't actually host a vault. This is the "wrong git URL" or
  // "empty shared dir" case — point the user back at --mode=new.
  const existingOnStorage = await storage.get(VAULT_CONFIG_FILENAME).catch(() => null)
  if (!existingOnStorage) {
    ctx.warn(`No ${VAULT_CONFIG_FILENAME} found at this storage location.`)
    ctx.warn('This means there is no vault to join. Either:')
    ctx.warn('  - Double-check the storage URL / vault path you provided, or')
    ctx.warn('  - Use `mementos init --mode=new` if you meant to create a fresh vault here.')
    process.exit(1)
  }
  const adopted = JSON.parse(existingOnStorage.data.toString()) as VaultConfig
  // In join mode the embedder is determined by the existing vault — refuse if the user
  // explicitly passed --embedder= conflicting with that. Letting it through would either
  // silently ignore the flag (confusing) or corrupt vectors (catastrophic).
  const requestedEmbedder = parseFlag('embedder')
  if (requestedEmbedder && requestedEmbedder !== adopted.embedder) {
    ctx.warn(`The vault at this storage location was initialised with embedder="${adopted.embedder}".`)
    ctx.warn(`Cannot continue with --embedder=${requestedEmbedder} — vectors would be incompatible.`)
    ctx.warn(`Drop the --embedder flag, or join a different vault.`)
    process.exit(1)
  }
  ctx.print(`Adopted vault.json from storage (embedder=${adopted.embedder}).`)
  const embedderType = adopted.embedder

  const embedderImpl = requireImpl(embedderReg, embedderType, 'embedder')
  await runSetupAtInit(embedderImpl, ctx)

  const indexType = await promptChoice(ctx, 'Vector index', 'index', indexReg, 'hnsw')
  const retrieverType = await promptChoice(ctx, 'Retriever', 'retriever', retrieverReg, 'semantic')
  const searcherType = await promptChoice(ctx, 'Searcher (lexical search — scan/trigram, or none to disable)', 'searcher', searcherReg, 'scan')
  const keyType = await promptChoice(ctx, 'Key provider', 'key', keyReg, 'keychain')

  const indexImpl = requireImpl(indexReg, indexType, 'vector index')
  const retrieverImpl = requireImpl(retrieverReg, retrieverType, 'retriever')
  const searcherImpl = requireImpl(searcherReg, searcherType, 'searcher')
  const keyImpl = requireImpl(keyReg, keyType, 'key provider')

  await runSetupAtInit(indexImpl, ctx)
  await runSetupAtInit(retrieverImpl, ctx)
  await runSetupAtInit(searcherImpl, ctx)

  const provider = keyImpl.create()
  let keptExisting = false
  if (await provider.isAlreadyConfigured()) {
    ctx.print('Vault key already configured on this machine — keeping the existing key (skipping import).')
    keptExisting = true
  } else {
    const entropy = await promptForExistingKey(ctx)
    await provider.storeEntropy(entropy, ctx)
  }
  // Decrypt-probe one cloned .mem so a key mismatch surfaces RIGHT HERE — not in
  // `mementos doctor` an hour later, where the message wrongly blames file corruption.
  // The "kept existing" path is the dangerous one: a leftover key from a prior install
  // looks fine to isAlreadyConfigured() but doesn't open this vault. The "imported"
  // path can also fail (user typed the wrong mnemonic), so probe both.
  await probeKeyAgainstVault(ctx, storage, await provider.getKey(), keptExisting)

  const machine: MachineConfig = {
    vaultPath: chosenVaultPath,
    backend: backendType,
    vectorIndex: indexType,
    retriever: retrieverType,
    searcher: searcherType,
    keyProvider: keyType,
  }
  ctx.applyPatches(machine)
  await writeMachineConfig(machine)
  ctx.print(`Wrote ${machineConfigFile()}\n`)

  await runFullInstall(ctx, embedderReg, embedderType)
  await setupIntegrations(ctx, integrationReg)
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * `--full` install. Regular `init` installs only the backends the user picked — the
 * thin, on-demand default. `--full` additionally pre-fetches every optional backend and
 * the MiniLM embedding model, trading a longer one-time setup for zero later network
 * dependence: run it online once and the vault works fully offline afterward.
 *
 * No-op unless `--full` is passed. Idempotent — every install underneath skips work
 * already done, so it is safe on a re-run / `--reinit`.
 */
async function runFullInstall(
  ctx: CliInitContext,
  embedderReg: Map<string, DiscoveredImpl<EmbedderFactory>>,
  chosenEmbedder: string,
): Promise<void> {
  if (parseFlag('full') === undefined) return
  ctx.print('')
  ctx.print('--full: pre-installing every optional backend (needs a network now;')
  ctx.print('afterward mementos runs without one).')
  await ensureAllPlugins(s => ctx.print(s))
  // Warm the on-device MiniLM model so the offline-capable default embedder is ready even
  // when the user picked `openai` — they can switch to `minilm` later with no network.
  // Skipped when `minilm` was the choice: its setupAtInit already ran in the main loop.
  if (chosenEmbedder !== 'minilm') {
    const minilmImpl = embedderReg.get('minilm')
    if (minilmImpl) await runSetupAtInit(minilmImpl, ctx)
  }
  ctx.print('Full install complete — mementos can now run fully offline.')
}

/**
 * Uninstall every integration in `integrationReg` whose type is NOT in `wanted`. Both the
 * flag and the checkbox paths through setupIntegrations need this — same shape, different
 * "wanted" source. `reason` annotates the removal log line.
 */
async function uninstallNotIn(
  integrationReg: Map<string, DiscoveredImpl<IntegrationFactory>>,
  wanted: Set<string>,
  ctx: CliInitContext,
  reason: string,
): Promise<void> {
  for (const [name, impl] of integrationReg) {
    if (wanted.has(name)) continue
    const integration = impl.create()
    if (!(await integration.isInstalled().catch(() => false))) continue
    try {
      await integration.uninstall()
      ctx.print(`Removed ${integration.name} ${reason}.`)
    } catch (e) {
      ctx.warn(`Could not remove ${integration.name}: ${(e as Error).message}`)
    }
  }
}

/** Load the cached vault config for the existing machine, ignoring ENOENT. */
async function readExistingVault(
  existing: MachineConfig | null,
): Promise<{ vault: VaultConfig; vaultPath: string } | null> {
  if (!existing) return null
  return readVaultConfig(existing.vaultPath)
    .then(v => ({ vault: v, vaultPath: existing.vaultPath }))
    .catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null
      throw e
    })
}

/**
 * Flag-time data-loss guards. Mirrors the interactive checks done after the prompts in
 * runInitNew — surfaces the same errors before any prompts fire when the user supplies
 * `--key=` / `--embedder=` flags that conflict with their existing setup.
 */
async function refuseFlagSwitches(
  existing: MachineConfig | null,
  existingVault: { vault: VaultConfig; vaultPath: string } | null,
): Promise<void> {
  const requestedKey = parseFlag('key')
  if (existing?.keyProvider && requestedKey && existing.keyProvider !== requestedKey) {
    console.error(`This machine already has a vault initialised with keyProvider="${existing.keyProvider}".`)
    console.error(`Re-running init with keyProvider="${requestedKey}" would lock your existing data.`)
    console.error(`If you really want to start fresh:  mementos destroy`)
    process.exit(1)
  }
  const requestedEmbedder = parseFlag('embedder')
  if (existingVault && requestedEmbedder && existingVault.vault.embedder !== requestedEmbedder) {
    console.error(`This vault was initialised with embedder="${existingVault.vault.embedder}".`)
    console.error(`Re-running init with embedder="${requestedEmbedder}" would make existing memories unretrievable`)
    console.error(`(different embedders produce incompatible vector spaces).`)
    console.error(`If you really want to start fresh:  mementos destroy`)
    process.exit(1)
  }
}

/**
 * Common integration-selection + setup flow shared by both new and join paths.
 * Real toggle (flag and checkbox): unlisted/unchecked installs are uninstalled.
 */
async function setupIntegrations(
  ctx: CliInitContext,
  integrationReg: Map<string, DiscoveredImpl<IntegrationFactory>>,
): Promise<void> {
  const integrationFilter = parseFlag('integrations')
  let integrationImpls: DiscoveredImpl<IntegrationFactory>[] = []
  if (integrationFilter !== undefined) {
    // Flag is the full desired set: install what's listed, uninstall the rest.
    const wanted = (integrationFilter === 'none' || integrationFilter === '')
      ? []
      : integrationFilter.split(',').map(s => s.trim()).filter(Boolean)
    integrationImpls = wanted.map(name => requireImpl(integrationReg, name, 'integration'))
    await uninstallNotIn(integrationReg, new Set(wanted), ctx, '(not in --integrations)')
  } else if (integrationReg.size > 0) {
    const present: Array<{ impl: DiscoveredImpl<IntegrationFactory>; name: string }> = []
    for (const impl of integrationReg.values()) {
      const integration = impl.create()
      if (await integration.isClientPresent()) {
        present.push({ impl, name: integration.name })
      }
    }
    if (present.length === 0) {
      ctx.print('No AI clients detected on this system. Skipping integration setup.')
      ctx.print('To install mementos into a client later:  mementos integration enable <name>')
    } else {
      const chosenTypes = await checkbox<string>({
        message: 'AI clients detected. Which should mementos be wired into?',
        choices: present.map(p => ({ name: p.name, value: p.impl.type, checked: true })),
      })
      integrationImpls = chosenTypes.map(type => {
        const match = present.find(p => p.impl.type === type)
        if (!match) throw new Error(`Internal: chose unknown integration ${type}`)
        return match.impl
      })
      // Unchecking a currently-installed client is a deliberate removal — checkbox is a
      // real toggle, not install-only.
      await uninstallNotIn(integrationReg, new Set(chosenTypes), ctx, '(unchecked)')
    }
  }

  for (const impl of integrationImpls) {
    if (!impl.setupAtInit) continue
    ctx.print(`\n─── ${impl.create().name} ───`)
    await runSetupAtInit(impl, ctx)
  }

  ctx.print('\nVault ready.')
  const installedIntegrations = await Promise.all(integrationImpls.map(async impl => {
    const integration = impl.create()
    const installed = await integration.isInstalled().catch(() => false)
    return installed ? integration.name : null
  }))
  const installedNames = installedIntegrations.filter((n): n is string => n !== null)
  if (installedNames.length > 0) {
    ctx.print(`Open ${installedNames.join(' or ')} — mementos will start automatically when it connects.`)
  } else {
    ctx.print('No AI client integrations are currently installed. To use mementos with an AI client later:')
    ctx.print('  mementos integration enable <name>')
  }

  ctx.print('\nWhen you want to remove mementos: run `mementos uninstall` FIRST (it cleans')
  ctx.print('up config, skills, hooks and MCP entries), THEN `npm uninstall -g mementos`.')
}

/**
 * Verify the active key actually decrypts a memento from the joined storage. Catches
 * the silent-failure scenario where `isAlreadyConfigured()` returned true for a leftover
 * key (from a prior install / restored backup / someone else's setup) that doesn't open
 * THIS vault. Also catches a typed-but-wrong mnemonic in the imported branch.
 *
 * No-op when the vault is empty (nothing to probe yet — first writes will surface the
 * mismatch on their own auth tag if anything is wrong). Non-AuthenticationError failures
 * propagate as-is (corrupt file, etc.) — we only convert clean auth failures.
 */
export async function probeKeyAgainstVault(
  ctx: CliInitContext, storage: StorageBackend, key: Buffer, keptExisting: boolean,
): Promise<void> {
  const files = await storage.list()
  const memFile = files.find(f => f.endsWith(MEM_EXTENSION))
  if (!memFile) return  // empty vault — nothing to probe

  try {
    const { data } = await storage.get(memFile)
    const mem = JSON.parse(data.toString()) as MemFile
    decryptMemChunks(mem, key)
    ctx.print('Vault key verified against joined storage.')
  } catch (e) {
    if (!(e instanceof AuthenticationError)) throw e
    if (keptExisting) {
      throw new Error(
        'The vault key already stored on this machine does NOT decrypt the vault you\'re joining\n' +
        '(likely a leftover from a previous mementos install on this machine).\n\n' +
        'To import the joined vault\'s key instead:\n' +
        '  1. mementos destroy  (uncheck everything except "Vault key" so the rest stays)\n' +
        '  2. mementos init --mode=join  (re-run join to import the correct key)',
      )
    }
    throw new Error(
      'The key you provided does NOT decrypt the vault you\'re joining.\n' +
      'Re-check the mnemonic / raw entropy / paired secret against the source device and re-run init.',
    )
  }
}
