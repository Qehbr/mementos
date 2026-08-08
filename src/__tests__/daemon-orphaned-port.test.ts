/**
 * Regression: a process holding the daemon port while no readable `daemon.state`
 * exists must be reported as an orphan.
 *
 * The state file and the port can disagree — a daemon whose state file was lost
 * still owns the port. When that happened, every command drew the wrong conclusion
 * from the state file alone: `doctor` said "not running", `stop` said "no daemon
 * running" and exited, and `start` spawned a child that died on the port bind and
 * reported only "exited within 1500ms". The three answers contradicted each other
 * and none named the real problem, leaving no route back to a working daemon.
 *
 * These tests pin the port as the authority for "is something there".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:net'
import { mkdir, rm } from 'node:fs/promises'

// `vi.mock` factories are hoisted above every import, so anything they close over
// must be hoisted too — and the body may not import (see daemon-state.test.ts).
// `portHolder` is mutable so each test can point the constant at a real ephemeral
// port the OS just handed us, instead of gambling on a hardcoded one being free.
const { TEST_DIR, TEST_STATE_FILE, portHolder } = vi.hoisted(() => {
  const dir = '/tmp/mementos-orphan-port-test'
  return { TEST_DIR: dir, TEST_STATE_FILE: `${dir}/daemon.state`, portHolder: { port: 0 } }
})

vi.mock('../daemon/constants.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../daemon/constants.js')>()
  return {
    ...original,
    daemonStateFile: () => TEST_STATE_FILE,
    get DAEMON_PORT() { return portHolder.port },
  }
})

import { isDaemonPortBound } from '../daemon/api-client.js'
import { runStop } from '../cli/commands/daemon.js'

/** Bind an OS-assigned port and point the mocked `DAEMON_PORT` at it. */
async function occupyDaemonPort(): Promise<Server> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('expected a TCP address')
  portHolder.port = addr.port
  return server
}

let server: Server | null = null

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true })
  await rm(TEST_STATE_FILE, { force: true })
})

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = null
  }
  await rm(TEST_DIR, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('isDaemonPortBound', () => {
  it('is true while the port is held and false once it is released', async () => {
    server = await occupyDaemonPort()
    expect(await isDaemonPortBound()).toBe(true)

    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = null
    expect(await isDaemonPortBound()).toBe(false)
  })
})

describe('runStop with no state file', () => {
  /** Capture stderr and turn `process.exit` into a throw so the command unwinds. */
  function trapExit(): { errors: () => string; code: () => number | undefined } {
    let out = ''
    let code: number | undefined
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out += a.join(' ') + '\n' })
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      code = c
      throw new Error('process.exit')
    }) as never)
    return { errors: () => out, code: () => code }
  }

  it('names the bound port instead of claiming no daemon is running', async () => {
    server = await occupyDaemonPort()
    const trap = trapExit()

    await expect(runStop()).rejects.toThrow('process.exit')

    expect(trap.code()).toBe(1)
    expect(trap.errors()).toContain(`port ${portHolder.port} is bound`)
    // The old behaviour — and the reason the user had nowhere to go.
    expect(trap.errors()).not.toContain('no daemon running')
    // It must point at a way to find the process it cannot signal itself.
    expect(trap.errors()).toMatch(/ss -ltnp|lsof/)
  })

  it('still reports no daemon running when the port is free', async () => {
    // Bind and immediately release, so DAEMON_PORT names a port nothing holds.
    const probe = await occupyDaemonPort()
    await new Promise<void>(resolve => probe.close(() => resolve()))
    const trap = trapExit()

    await expect(runStop()).rejects.toThrow('process.exit')

    expect(trap.code()).toBe(1)
    expect(trap.errors()).toContain('no daemon running')
  })
})
