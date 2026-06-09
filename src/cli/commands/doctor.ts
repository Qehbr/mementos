/**
 * `mementos doctor` — dependency-ordered health check.
 *
 * Walks the vault's runtime requirements top-down and prints a scannable status table.
 * Checks short-circuit on prerequisite failure: e.g. if Key fails, Decrypt probe is
 * reported as "skipped (key unavailable)" rather than crashing with a raw crypto error.
 *
 * Order:
 *   1.  Machine config         ~/.config/mementos/config.json exists and parses
 *   2.  Vault path             directory exists and is readable
 *   3.  Key                    provider.getKey() succeeds (env var set / keychain reachable)
 *   4.  Storage                storage.list() succeeds (git remote reachable, etc)
 *   5.  Vault config           vault.json exists in storage; embedder matches what's registered
 *   6.  Decrypt probe          one .mem decrypts end-to-end — proves crypto + AAD + key work
 *   7.  Embedder               embedder loads + can embed a sample string
 *   8.  Index cache            ~/.config/mementos/cache/index.hnsw.enc presence / freshness (informational)
 *   9.  Daemon                 is `mementos start` running? token file present + `0600`?
 *   10. Integrations           per-integration isInstalled() (+ hook status if applicable)
 *
 * Exit codes:
 *   0  if every check is OK or informationally skipped (empty vault is fine)
 *   1  if any check failed
 */
import { readdir, stat } from 'node:fs/promises'
import { readMachineConfig, machineConfigFile, readVaultConfig, VAULT_CONFIG_FILENAME, indexCacheFile } from '../../core/config.js'
import { loadEmbedders } from '../../embeddings/registry.js'
import { loadIntegrations } from '../../integrations/registry.js'
import { decrypt } from '../../core/vault/crypto.js'
import { memAad } from '../../core/vault/aad.js'
import { MEM_EXTENSION } from '../../core/vault/constants.js'
import { requireImpl, buildKeyProvider, buildStorageBackend, buildStorageAndKey } from '../_utils/vault.js'
import { readManifest } from '../_utils/migration-manifest.js'
import { getDaemonState } from '../../daemon/api-client.js'
import { readDaemonStateFile } from '../../daemon/state.js'
import { DAEMON_URL, DAEMON_TOKEN_FILE } from '../../daemon/constants.js'
import type { MachineConfig, VaultConfig } from '../../core/types.js'
import type { MemFile } from '../../core/vault/types.js'

type CheckStatus = 'ok' | 'fail' | 'skip'
interface CheckResult {
  name: string
  status: CheckStatus
  detail: string
  /** Indented hint shown under a failed check to help the user fix it. */
  hint?: string
}

const LABEL_WIDTH = 14

export async function runDoctor(): Promise<void> {
  console.log('mementos doctor\n')

  const results: CheckResult[] = []
  let machine: MachineConfig | null = null
  let vaultConfig: VaultConfig | null = null

  const configRes = await checkMachineConfig()
  results.push(configRes)
  if (configRes.status === 'ok') {
    machine = await readMachineConfig().catch(() => null)
  }

  results.push(await checkVaultPath(machine))
  // Surface an unfinished migrate before vault checks — otherwise a half-transformed
  // vault looks like a generic decrypt failure.
  results.push(await checkMigration())

  const keyRes = machine ? await checkKey(machine) : skip('Key', 'machine config unavailable')
  results.push(keyRes)
  const storageRes = machine ? await checkStorage(machine) : skip('Storage', 'machine config unavailable')
  results.push(storageRes)

  let vaultConfigRes: CheckResult
  if (machine && storageRes.status === 'ok') {
    vaultConfigRes = await checkVaultConfig(machine)
    if (vaultConfigRes.status === 'ok') {
      vaultConfig = await readVaultConfig(machine.vaultPath).catch(() => null)
    }
  } else {
    vaultConfigRes = skip('Vault config', 'storage unreachable')
  }
  results.push(vaultConfigRes)

  if (!machine) results.push(skip('Decrypt probe', 'machine config unavailable'))
  else if (keyRes.status !== 'ok') results.push(skip('Decrypt probe', 'key unavailable'))
  else if (storageRes.status !== 'ok') results.push(skip('Decrypt probe', 'storage unreachable'))
  else if (!vaultConfig) results.push(skip('Decrypt probe', 'vault config unavailable'))
  else results.push(await checkDecryptProbe(machine))

  results.push(vaultConfig ? await checkEmbedder(vaultConfig) : skip('Embedder', 'vault config unavailable'))
  results.push(machine ? await checkIndexCache(machine) : skip('Index cache', 'machine config unavailable'))
  results.push(await checkDaemon())
  results.push(...await checkIntegrations())

  for (const r of results) renderResult(r)

  const fails = results.filter(r => r.status === 'fail').length
  console.log('')
  if (fails === 0) {
    console.log('All checks passed.')
    // For remote-syncing backends, the most common "my memories seem gone"
    // symptom is "the local clone is behind the remote" — which doctor's
    // local probes cannot detect (a cheap `list` succeeds even on a stale
    // clone). Point the user at the one action that resolves it. Skipped
    // for the local backend (nothing to pull from).
    if (machine && machine.backend !== 'local') {
      console.log(`If memories you saved on another device aren't here, run \`mementos sync\` to pull the latest from ${machine.backend}.`)
    }
  } else {
    console.log(`${fails} check${fails === 1 ? '' : 's'} failed. Address the fix hints above and re-run \`mementos doctor\`.`)
    process.exit(1)
  }
}

// ─── Individual checks ────────────────────────────────────────────────────────

async function checkMachineConfig(): Promise<CheckResult> {
  const path = machineConfigFile()
  try {
    await readMachineConfig()
    return { name: 'Config', status: 'ok', detail: path }
  } catch (e) {
    const enoent = (e as NodeJS.ErrnoException).code === 'ENOENT'
    return {
      name: 'Config', status: 'fail',
      detail: enoent ? `not found at ${path}` : (e as Error).message,
      hint: enoent ? 'Run: mementos init' : `Fix or remove ${path} and re-run.`,
    }
  }
}

async function checkVaultPath(machine: MachineConfig | null): Promise<CheckResult> {
  if (!machine) return skip('Vault path', 'machine config unavailable')
  try {
    const entries = await readdir(machine.vaultPath)
    const memCount = entries.filter(f => f.endsWith(MEM_EXTENSION)).length
    return {
      name: 'Vault path', status: 'ok',
      detail: `${machine.vaultPath}  (${memCount} memor${memCount === 1 ? 'y' : 'ies'})`,
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return {
        name: 'Vault path', status: 'fail', detail: `${machine.vaultPath} does not exist`,
        hint: 'Either re-init mementos here, or update vaultPath in your machine config to point at the right directory.',
      }
    }
    return {
      name: 'Vault path', status: 'fail', detail: (e as Error).message,
      hint: 'Check directory permissions.',
    }
  }
}

async function checkMigration(): Promise<CheckResult> {
  const manifest = await readManifest().catch((e: Error) => e)
  if (manifest instanceof Error) {
    return {
      name: 'Migration', status: 'fail', detail: manifest.message,
      hint: 'Fix or remove the manifest, then re-run.',
    }
  }
  if (!manifest) {
    return { name: 'Migration', status: 'ok', detail: 'none in progress' }
  }
  return {
    name: 'Migration', status: 'fail',
    detail: `unfinished ${manifest.type} migration (started ${manifest.startedAt})`,
    hint: 'Finish it with `mementos migrate`, or cancel with `mementos migrate --abort`.',
  }
}

async function checkKey(machine: MachineConfig): Promise<CheckResult> {
  if (!machine.keyProvider) {
    return { name: 'Key', status: 'fail', detail: "missing 'keyProvider' in machine config", hint: 'Run: mementos init --reinit' }
  }
  let provider
  try {
    provider = await buildKeyProvider(machine)
    const k = await provider.getKey()
    if (k.byteLength !== 32) {
      return { name: 'Key', status: 'fail', detail: `derived key is ${k.byteLength} bytes (expected 32)`, hint: 'Likely corrupt mnemonic or env value — investigate before re-init.' }
    }
    return { name: 'Key', status: 'ok', detail: provider.describeKeyLocation?.() ?? `${machine.keyProvider} provider` }
  } catch (e) {
    return {
      name: 'Key', status: 'fail', detail: (e as Error).message,
      hint: provider?.describeDoctorHint?.()
        ?? `Investigate before running 'mementos init --reinit' — that would generate a new key.`,
    }
  }
}

async function checkStorage(machine: MachineConfig): Promise<CheckResult> {
  if (!machine.backend) {
    return { name: 'Storage', status: 'fail', detail: "missing 'backend' in machine config", hint: 'Run: mementos init --reinit' }
  }
  let storage
  try {
    storage = await buildStorageBackend(machine)
    // For GitBackend, storage.init() runs the clone-or-noop dance — we skip that here
    // and just attempt a list. On a fresh clone this might 404, but on any existing
    // setup list is the cheapest "is this backend reachable" probe.
    await storage.list()
    const summary = await storage.describeStoredData()
    return { name: 'Storage', status: 'ok', detail: `${machine.backend} — ${summary}` }
  } catch (e) {
    return {
      name: 'Storage', status: 'fail', detail: (e as Error).message,
      hint: storage?.describeDoctorHint?.() ?? 'Check filesystem permissions on the vault path.',
    }
  }
}

async function checkVaultConfig(machine: MachineConfig): Promise<CheckResult> {
  if (!machine.backend) return { name: 'Vault config', status: 'fail', detail: "machine config missing 'backend' field" }
  try {
    const storage = await buildStorageBackend(machine)
    const data = await storage.get(VAULT_CONFIG_FILENAME)
    const cfg = JSON.parse(data.data.toString()) as VaultConfig
    if (!cfg.embedder) {
      return { name: 'Vault config', status: 'fail', detail: 'missing embedder field', hint: 'vault.json is malformed.' }
    }
    const embedderReg = await loadEmbedders()
    if (!embedderReg.has(cfg.embedder)) {
      return {
        name: 'Vault config', status: 'fail',
        detail: `embedder=${cfg.embedder} but no such embedder is registered`,
        hint: `Either install / restore the '${cfg.embedder}' embedder, or re-key the vault with \`mementos migrate --type=embedder\`.`,
      }
    }
    return { name: 'Vault config', status: 'ok', detail: `embedder=${cfg.embedder}` }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return {
        name: 'Vault config', status: 'fail', detail: 'vault.json not found at the storage backend',
        hint: 'Either the vault was never initialised, or storage.init() never ran. Run: mementos init',
      }
    }
    return { name: 'Vault config', status: 'fail', detail: (e as Error).message }
  }
}

async function checkDecryptProbe(machine: MachineConfig): Promise<CheckResult> {
  if (!machine.backend || !machine.keyProvider) {
    return { name: 'Decrypt probe', status: 'fail', detail: 'machine config missing required fields' }
  }
  try {
    const { storage, keyProvider: provider } = await buildStorageAndKey(machine)

    const files = await storage.list()
    const [sample] = files
    if (!sample) {
      return { name: 'Decrypt probe', status: 'ok', detail: 'no memories to probe (empty vault)' }
    }
    const { data } = await storage.get(sample)
    const mem = JSON.parse(data.toString()) as MemFile
    const key = await provider.getKey()
    // Decrypt both payloads — each one's AAD failure would surface here.
    decrypt(mem.chunks, key, memAad(mem.id, 'chunks'))
    decrypt(mem.meta, key, memAad(mem.id, 'meta'))
    return { name: 'Decrypt probe', status: 'ok', detail: `decrypted ${shorten(sample)} (both payloads)` }
  } catch (e) {
    return {
      name: 'Decrypt probe', status: 'fail',
      detail: (e as Error).message,
      hint: 'A successful Key check + failing probe usually means the .mem files were encrypted under a different key, or the file is corrupt. Restore from backup or another device.',
    }
  }
}

async function checkEmbedder(vaultConfig: VaultConfig): Promise<CheckResult> {
  try {
    const reg = await loadEmbedders()
    const embedder = requireImpl(reg, vaultConfig.embedder, 'embedder').create()
    // Read-only: don't run setupAtInit; just verify constructibility + read .dimensions.
    return { name: 'Embedder', status: 'ok', detail: `${vaultConfig.embedder} (${embedder.dimensions}-dim)` }
  } catch (e) {
    return {
      name: 'Embedder', status: 'fail', detail: (e as Error).message,
      hint: `Reinstall the '${vaultConfig.embedder}' embedder dependencies.`,
    }
  }
}

async function checkIndexCache(_machine: MachineConfig): Promise<CheckResult> {
  const cachePath = indexCacheFile()
  try {
    const s = await stat(cachePath)
    const ageMin = Math.round((Date.now() - s.mtimeMs) / 60_000)
    return {
      name: 'Index cache', status: 'ok',
      detail: `${(s.size / 1024).toFixed(1)} KiB, last built ${formatAge(ageMin)}`,
    }
  } catch {
    return {
      name: 'Index cache', status: 'ok',
      detail: 'not present — will be built on next vault startup (informational, not an error)',
    }
  }
}

async function checkDaemon(): Promise<CheckResult> {
  const state = await getDaemonState()
  if (state === 'absent') {
    return {
      name: 'Daemon', status: 'ok',
      detail: 'not running (informational) — start with `mementos start` to use CLI commands or AI clients',
    }
  }
  if (state === 'initializing') {
    const file = await readDaemonStateFile()
    const ago = file ? secondsSince(file.startedAt) : '?'
    return {
      name: 'Daemon', status: 'ok',
      detail: `initializing (PID ${file?.pid ?? '?'}, started ${ago}s ago — loading the vault)`,
      hint: 'large vaults take a minute or two on first start; re-run `mementos doctor` shortly',
    }
  }
  // state === 'ready' — verify the token file is present + 0600.
  try {
    const s = await stat(DAEMON_TOKEN_FILE)
    const mode = s.mode & 0o777
    if (process.platform !== 'win32' && mode !== 0o600) {
      return {
        name: 'Daemon', status: 'fail',
        detail: `running at ${DAEMON_URL} but token file has unsafe perms (${mode.toString(8)})`,
        hint: `fix:  chmod 600 ${DAEMON_TOKEN_FILE}   (or restart the daemon: \`mementos stop && mementos start\`)`,
      }
    }
  } catch {
    return {
      name: 'Daemon', status: 'fail',
      detail: `running at ${DAEMON_URL} but token file missing at ${DAEMON_TOKEN_FILE}`,
      hint: 'restart: `mementos stop && mementos start`',
    }
  }
  return { name: 'Daemon', status: 'ok', detail: `running at ${DAEMON_URL} (token OK)` }
}

function secondsSince(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return '?'
  return String(Math.max(0, Math.round((Date.now() - then) / 1000)))
}

async function checkIntegrations(): Promise<CheckResult[]> {
  const reg = await loadIntegrations()
  if (reg.size === 0) {
    return [{ name: 'Integrations', status: 'ok', detail: 'no integrations registered' }]
  }
  const out: CheckResult[] = []
  for (const impl of reg.values()) {
    const integration = impl.create()
    try {
      const installed = await integration.isInstalled()
      if (!installed) {
        out.push({ name: 'Integration', status: 'ok', detail: `${integration.name}: not installed (informational)` })
        continue
      }
      let hookStatus = ''
      if (integration.hooks) {
        const states: string[] = []
        for (const kind of integration.hooks.supportedHooks()) {
          const enabled = await integration.hooks.hook(kind).isInstalled().catch(() => null)
          if (enabled !== null) states.push(`${kind}=${enabled ? 'on' : 'off'}`)
        }
        if (states.length > 0) hookStatus = `, hooks: ${states.join(' ')}`
      }
      out.push({ name: 'Integration', status: 'ok', detail: `${integration.name}: installed${hookStatus}` })
    } catch (e) {
      out.push({
        name: 'Integration', status: 'fail',
        detail: `${integration.name}: ${(e as Error).message}`,
        hint: `Re-run \`mementos integration enable ${impl.type}\` to repair.`,
      })
    }
  }
  return out
}

// ─── Output formatting ────────────────────────────────────────────────────────

function renderResult(r: CheckResult): void {
  const sym = r.status === 'ok' ? '✓' : r.status === 'fail' ? '✗' : '⊘'
  console.log(`  ${r.name.padEnd(LABEL_WIDTH)}${sym}  ${r.detail}`)
  if (r.hint) console.log(`  ${' '.repeat(LABEL_WIDTH)}   ${r.hint}`)
}

function skip(name: string, reason: string): CheckResult {
  return { name, status: 'skip', detail: `skipped (${reason})` }
}

function shorten(s: string): string {
  return s.length > 16 ? s.slice(0, 12) + '…' : s
}

function formatAge(minutes: number): string {
  if (minutes < 1) return 'moments ago'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
