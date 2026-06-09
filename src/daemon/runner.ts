/**
 * Daemon main loop.
 *
 * Order of operations (chosen so the on-disk state file CANNOT race two
 * simultaneously-spawning daemons):
 *
 *   1. `buildVault()`            — fast; just constructs deps.
 *   2. `startHttpApi(ready=false)` — **binds the port** via
 *      `assertPortFree` + `server.listen()`. The OS-level port mutex is the
 *      race-safety primitive: a losing daemon-start exits HERE, before
 *      writing anything to disk.
 *   3. Write `daemon.state` with `state: 'initializing'` — we have already
 *      won the port-bind, so there is no other writer.
 *   4. `vault.startup()`         — slow (cold ONNX, decrypt all `.mem`,
 *      build HNSW). Every HTTP request during this window returns 503.
 *   5. `vault.seedIndexIfMissing()` — idempotent placeholder seed.
 *   6. `api.markReady()`         — flip the handler from 503 → real routing.
 *   7. Write `daemon.state` with `state: 'ready'`.
 *   8. Write the bearer token file (`0600`).
 *
 * The order also avoids a SECOND class of race the prior audit closed:
 * if PID / token had been written BEFORE the port bind, a losing daemon
 * could overwrite the winner's token file → every client reads a stale
 * token → 401 against the live daemon. Binding first means the loser
 * exits at step 2 having touched nothing shared.
 *
 * **Why two state-file writes (not one)** — readers care about the
 * distinction. During step 4 the daemon is alive on the port but every
 * request 503s; the state file at that moment reflects that honestly so
 * `mementos doctor` can report "initializing (PID N, started Xs ago)"
 * instead of lying.
 *
 * Used by `mementos start` (and indirectly by `mementos mcp` and the hook
 * subprocesses, both of which spawn `mementos start --foreground` detached
 * when no daemon is up).
 *
 * Returns once a shutdown signal arrives and the vault has flushed cleanly.
 */
import { buildVault } from '../cli/_utils/vault.js'
import { readMachineConfig } from '../core/config.js'
import { startHttpApi } from './http-api.js'
import { generateToken, writeTokenFile, deleteToken } from './token.js'
import { writeDaemonStateFile, deleteDaemonStateFile } from './state.js'

export async function runDaemon(): Promise<void> {
  const vault = await buildVault()

  // Replace cli/index.ts's process-wide exit(1) handler — a stray rejection
  // from a peer dep must not kill the daemon.
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    if (process.env['MEMENTOS_DEBUG']) console.error('[daemon] unhandled rejection:', err.stack ?? err.message)
  })

  // Generate the token in memory only — DON'T touch the disk yet.
  const token = generateToken()

  // ── Step 1+2 (above): bind the port. THIS is the single-instance mutex.
  // Returns the HTTP API with `ready=false`; every request returns 503 until
  // we call `api.markReady()` further down.
  const machine = await readMachineConfig()
  const searchEnabled = machine.searcher !== 'none'
  const api = await startHttpApi(vault, { searchEnabled, token })

  // ── Step 3: write the state file. Safe — port-bind succeeded, no second writer.
  const startedAt = new Date().toISOString()
  await writeDaemonStateFile('initializing', startedAt)

  // ── Step 4: slow vault load. Clients during this window get 503 with
  // {error: "daemon initializing"} — they (e.g. the mcp shim's
  // `ensureDaemonRunning`) poll the state file and wait for `ready`.
  await vault.startup().catch((e: Error) => {
    console.error(e.message)
    process.exit(1)
  })

  // ── Step 5: lazy `_index` seed. Fail-soft (see comment) — vault.startup()
  // already proved the storage + key + embedder paths work, so a failure
  // here is transient. The next write_memento surfaces it loudly anyway.
  await vault.seedIndexIfMissing().catch((e: Error) => {
    if (process.env['MEMENTOS_DEBUG']) console.error('[daemon] index seed skipped:', e.message)
  })

  // ── Step 6+7: flip the HTTP handler to live, update the state file.
  api.markReady()
  await writeDaemonStateFile('ready', startedAt)

  // ── Step 8: publish the token. Done AFTER markReady so a client polling
  // the state file (`ready`) and then trying to authenticate always finds
  // the token in place — no race where state says ready but token is missing.
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
          await deleteDaemonStateFile()
          resolve()
        })
    }
    process.once('SIGTERM', () => shutdown('SIGTERM'))
    process.once('SIGINT', () => shutdown('SIGINT'))
    process.once('SIGHUP', () => shutdown('SIGHUP'))
  })
}
