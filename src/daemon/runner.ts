/**
 * Daemon main loop — builds the vault, **claims the port first** (the real
 * mutex), then writes the PID + token files. Parks waiting for SIGTERM.
 *
 * (`mementos migrate / restore / destroy` use the same port-bind as their
 * own liveness signal via `assertNoServerRunning` → `isDaemonRunning`.
 * There is no separate PID-file registry — the listening port for the
 * daemon's full lifetime IS the registration.)
 *
 * **Why this order matters**: `ensureDaemonRunning` can race two callers
 * (e.g. an MCP shim and a hook subprocess firing nearly simultaneously) into
 * spawning two `mementos start` processes back-to-back. The top-of-start
 * `isDaemonRunning()` probe is TOCTOU — both children pass it. The port-bind
 * inside `startHttpApi` is the actual single-instance guarantee
 * (`assertPortFree`). If we wrote the PID / token files BEFORE binding, the
 * losing daemon would overwrite the winner's files and then exit on port
 * conflict, leaving every client reading a stale token → 401 against the
 * live daemon (i.e. wedged and unreachable). Binding first means the loser
 * exits having touched nothing shared.
 *
 * Used by `mementos start` (and indirectly by `mementos mcp` and the hook
 * subprocesses, both of which spawn `mementos start --foreground` detached
 * when no daemon is up).
 *
 * Returns once a shutdown signal arrives and the vault has flushed cleanly.
 */
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { buildVault } from '../cli/_utils/vault.js'
import { readMachineConfig } from '../core/config.js'
import { startHttpApi } from './http-api.js'
import { DAEMON_PID_FILE } from './constants.js'
import { generateToken, writeTokenFile, deleteToken } from './token.js'

export async function runDaemon(): Promise<void> {
  const vault = await buildVault()

  // Replace cli/index.ts's process-wide exit(1) handler — a stray rejection
  // from a peer dep must not kill the daemon.
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    if (process.env['MEMENTOS_DEBUG']) console.error('[daemon] unhandled rejection:', err.stack ?? err.message)
  })

  await vault.startup().catch((e: Error) => {
    console.error(e.message)
    process.exit(1)
  })

  // Seed the singleton `_index` placeholder if absent. Idempotent — O(1) hashmap
  // check on the common case (already seeded). Lives here, not in `mementos init`,
  // so the slow first call (embedder cold-start) doesn't block the init wizard
  // AND existing vaults that pre-date the invariant heal themselves on next start.
  //
  // Fail-soft is justified here: vault.startup() already succeeded on the same
  // storage + key + embedder path, so a `seedIndexIfMissing` failure means
  // something transient and outside our control (filesystem hiccup, slow embed
  // batch). The `_index` is a UX convenience, not load-bearing for the daemon —
  // the next write_memento on the same code path will surface the same error
  // loudly. Letting the daemon boot anyway is better than refusing to serve.
  await vault.seedIndexIfMissing().catch((e: Error) => {
    if (process.env['MEMENTOS_DEBUG']) console.error('[daemon] index seed skipped:', e.message)
  })

  // Generate the token in memory only — DON'T touch the disk yet.
  const token = generateToken()

  // Bind the port. THIS is the single-instance mutex. If something is already
  // listening, `assertPortFree` inside `startHttpApi` throws and we exit
  // without having touched the shared PID / token files.
  const machine = await readMachineConfig()
  const searchEnabled = machine.searcher !== 'none'
  const api = await startHttpApi(vault, { searchEnabled, token })

  // Port is ours. Safe to publish the token + PID. If either fails we still
  // own the port; the shutdown handler below will clean up on SIGTERM. (None
  // of these writes should fail in practice — same user's HOME, perms
  // already established by `init`.)
  await mkdir(dirname(DAEMON_PID_FILE), { recursive: true }).catch(() => { /* parent may exist */ })
  await writeFile(DAEMON_PID_FILE, String(process.pid), 'utf8')
  await writeTokenFile(token)

  // Park until a shutdown signal arrives. The handler awaits vault.close() so
  // the encrypted HNSW cache flushes — a SIGINT in the middle of a write
  // could otherwise leave the cache out of date and force a slow rebuild next
  // startup.
  await new Promise<void>(resolve => {
    const shutdown = (sig: string) => {
      if (process.env['MEMENTOS_DEBUG']) console.error(`[daemon] received ${sig}, shutting down`)
      void api.close()
        .then(() => vault.close())
        .catch(() => { /* fail-soft on shutdown */ })
        .finally(async () => {
          await deleteToken()
          await unlink(DAEMON_PID_FILE).catch(() => { /* already gone */ })
          resolve()
        })
    }
    process.once('SIGTERM', () => shutdown('SIGTERM'))
    process.once('SIGINT', () => shutdown('SIGINT'))
    process.once('SIGHUP', () => shutdown('SIGHUP'))
  })
}
