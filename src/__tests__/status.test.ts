/**
 * `mementos status` — the cheap readout that complements `doctor`.
 *
 * Two properties matter and neither is obvious from the implementation:
 *   - it never exits non-zero, including with nothing initialised, so it can be run
 *     on a whim or from a prompt without a failing status leaking into a shell
 *   - it reports the orphaned-port condition, which is the state that makes
 *     `mementos start` fail and `mementos stop` powerless
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:net'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setFakeHome } from './_utils/fake-home.js'
import { TMP_ROOT } from './_utils/tmp-root.js'

// Same hoisting constraint as daemon-orphaned-port.test.ts: the factory is lifted above
// every import, so the port it reads must live in a hoisted mutable holder.
const { portHolder } = vi.hoisted(() => ({ portHolder: { port: 0 } }))

vi.mock('../daemon/constants.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../daemon/constants.js')>(),
  get DAEMON_PORT() { return portHolder.port },
}))

import { runStatus } from '../cli/commands/status.js'

let homeDir: string
let restoreHome: () => void
let server: Server | null = null
let out = ''

/** Bind an OS-assigned port and point the mocked `DAEMON_PORT` at it. */
async function occupyDaemonPort(): Promise<Server> {
  const s = createServer()
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve))
  const addr = s.address()
  if (addr === null || typeof addr === 'string') throw new Error('expected a TCP address')
  portHolder.port = addr.port
  return s
}

beforeEach(async () => {
  await mkdir(TMP_ROOT, { recursive: true })
  homeDir = await mkdtemp(join(TMP_ROOT, 'status-'))
  restoreHome = setFakeHome(homeDir)
  out = ''
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out += a.join(' ') + '\n' })
})

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = null
  }
  vi.restoreAllMocks()
  restoreHome()
  await rm(homeDir, { recursive: true, force: true })
})

describe('mementos status', () => {
  it('reports an uninitialised machine without failing', async () => {
    await expect(runStatus()).resolves.toBeUndefined()
    expect(out).toContain('not initialised')
    expect(out).toContain('mementos init')
  })

  it('names the orphaned port when the daemon state file is missing', async () => {
    server = await occupyDaemonPort()
    const configDir = join(homeDir, '.config', 'mementos')
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, 'config.json'),
      JSON.stringify({ vaultPath: join(homeDir, '.mementos'), backend: 'local' }),
    )

    await runStatus()

    expect(out).toContain(`port ${portHolder.port} bound but no readable daemon state`)
    expect(out).toMatch(/ss -ltnp|lsof/)
  })

  it('reports a vault that cannot be read instead of throwing', async () => {
    const configDir = join(homeDir, '.config', 'mementos')
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, 'config.json'),
      JSON.stringify({ vaultPath: join(homeDir, 'does-not-exist'), backend: 'local' }),
    )

    await expect(runStatus()).resolves.toBeUndefined()
    expect(out).toContain('unreadable')
  })
})
