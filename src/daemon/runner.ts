/**
 * Daemon main loop — builds the vault, generates the auth token, starts the
 * plain HTTP API server on `127.0.0.1:<port>`, registers in the serve registry
 * (so `mementos migrate` refuses while it's alive), writes the PID file, and
 * parks waiting for SIGTERM.
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
import { registerServe } from '../cli/_utils/serve-registry.js'
import { readMachineConfig } from '../core/config.js'
import { startHttpApi } from './http-api.js'
import { pidFilePath } from './endpoint.js'
import { generateAndWriteToken, deleteToken } from './token.js'

export async function runDaemon(): Promise<void> {
  const vault = await buildVault()

  // Replace cli/index.ts's process-wide exit(1) handler — a stray rejection
  // from a peer dep must not kill the daemon (same posture the old runServe took).
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    if (process.env['MEMENTOS_DEBUG']) console.error('[daemon] unhandled rejection:', err.stack ?? err.message)
  })

  await vault.startup().catch((e: Error) => {
    console.error(e.message)
    process.exit(1)
  })

  // Marks this process so `mementos migrate` refuses while it's alive.
  await registerServe()

  const pidPath = pidFilePath()
  await mkdir(dirname(pidPath), { recursive: true }).catch(() => { /* fine */ })
  await writeFile(pidPath, String(process.pid), 'utf8')

  // Auth token: generated once per daemon lifetime, written `0600` to the
  // shared file every client reads from.
  const token = await generateAndWriteToken()

  const machine = await readMachineConfig()
  const searchEnabled = machine.searcher !== 'none'
  const api = await startHttpApi(vault, { searchEnabled, token })

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
          await unlink(pidPath).catch(() => { /* already gone */ })
          resolve()
        })
    }
    process.once('SIGTERM', () => shutdown('SIGTERM'))
    process.once('SIGINT', () => shutdown('SIGINT'))
    process.once('SIGHUP', () => shutdown('SIGHUP'))
  })
}
