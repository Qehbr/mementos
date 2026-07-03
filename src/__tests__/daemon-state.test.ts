/**
 * Unit tests for `daemon/state.ts` — the read/write helpers + PID-alive
 * detection that the entire "is the daemon up, and is it ready?" surface
 * is built on. Race-safety of the FILE is delegated to the OS port mutex
 * (tested implicitly by runner.ts's behavior); these tests pin the
 * primitives the rest of the code trusts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rm, writeFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

// `vi.mock` calls are hoisted to the top of the file — including their factory
// — so any module-level constants the factory references must ALSO be hoisted
// via `vi.hoisted`. Without that, the factory runs before the consts assign
// and references-before-initialization throw at module-load time.
const { TEST_DIR, TEST_STATE_FILE } = vi.hoisted(() => {
  // `vi.hoisted` runs before ANY module-level import (including `node:path`,
  // `node:os`, and the `process` global). Keep the body to literal-string
  // construction only. The path is deterministic; uniqueness is not needed
  // because each test cleans up in `afterEach` (and each Vitest worker
  // process gets its own module graph, so no cross-test interference).
  const dir = '/tmp/mementos-state-test'
  return { TEST_DIR: dir, TEST_STATE_FILE: `${dir}/daemon.state` }
})

vi.mock('../daemon/constants.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../daemon/constants.js')>()
  return { ...original, daemonStateFile: () => TEST_STATE_FILE }
})

// Now we can import state.ts statically — it'll use the mocked path.
import {
  readDaemonStateFile, writeDaemonStateFile, deleteDaemonStateFile,
  daemonState, isProcessAlive,
} from '../daemon/state.js'

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true })
  await rm(TEST_STATE_FILE, { force: true })
})

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

describe('state.ts — read / write / coarse state', () => {
  it('roundtrips initializing → ready writes through atomicWriteFile', async () => {
    const startedAt = '2026-06-09T12:00:00.000Z'

    await writeDaemonStateFile('initializing', startedAt)
    const file1 = await readDaemonStateFile()
    expect(file1?.state).toBe('initializing')
    expect(file1?.startedAt).toBe(startedAt)
    expect(file1?.pid).toBe(process.pid)

    await writeDaemonStateFile('ready', startedAt)
    const file2 = await readDaemonStateFile()
    expect(file2?.state).toBe('ready')
    // startedAt is preserved across the init→ready transition — this is the
    // contract `doctor` uses to report "started Xs ago"
    expect(file2?.startedAt).toBe(startedAt)
  })

  it('daemonState reports absent when no state file exists', async () => {
    expect(await daemonState()).toBe('absent')
  })

  it('daemonState reports the written state when PID is alive', async () => {
    await writeDaemonStateFile('initializing', new Date().toISOString())
    expect(await daemonState()).toBe('initializing')

    await writeDaemonStateFile('ready', new Date().toISOString())
    expect(await daemonState()).toBe('ready')
  })

  it('readDaemonStateFile returns null for a stale PID (process is dead)', async () => {
    // Get a definitively-dead PID by spawning a child, waiting for it to
    // exit, and using its PID. (Any hardcoded "surely dead" number can race
    // with whatever else is running on the test machine.)
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
    const deadPid = await new Promise<number>((resolve) => {
      child.on('exit', () => resolve(child.pid as number))
    })

    await writeFile(TEST_STATE_FILE, JSON.stringify({
      pid: deadPid,
      state: 'ready',
      startedAt: new Date().toISOString(),
    }))

    // Stale → readers see "absent" (no client tries to talk to a dead daemon).
    expect(await readDaemonStateFile()).toBeNull()
    expect(await daemonState()).toBe('absent')
  })

  it('readDaemonStateFile returns null for corrupt JSON', async () => {
    await writeFile(TEST_STATE_FILE, '{not valid json at all')
    // Corrupt = absent. Next runDaemon will overwrite cleanly (atomic
    // tmp+rename). No "manual cleanup required" error states.
    expect(await readDaemonStateFile()).toBeNull()
    expect(await daemonState()).toBe('absent')
  })

  it('readDaemonStateFile returns null when required fields are missing or wrong-typed', async () => {
    // Missing pid
    await writeFile(TEST_STATE_FILE, JSON.stringify({ state: 'ready', startedAt: '2026-06-09T12:00:00Z' }))
    expect(await readDaemonStateFile()).toBeNull()
    // Wrong-typed state
    await writeFile(TEST_STATE_FILE, JSON.stringify({ pid: process.pid, state: 'maybe', startedAt: '2026-06-09T12:00:00Z' }))
    expect(await readDaemonStateFile()).toBeNull()
  })

  it('deleteDaemonStateFile is ENOENT-tolerant (idempotent cleanup)', async () => {
    // Call twice — second one must not throw on missing file. (Graceful
    // shutdown can race a manual `rm`; the SIGTERM handler must be safe.)
    await deleteDaemonStateFile()
    await deleteDaemonStateFile()
    expect(await daemonState()).toBe('absent')
  })

  it('isProcessAlive reports the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('isProcessAlive rejects malformed PIDs', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(1.5)).toBe(false)
    expect(isProcessAlive(NaN)).toBe(false)
  })

  it('writes are atomic (tmp file is cleaned up; no half-written content visible)', async () => {
    await writeDaemonStateFile('ready', new Date().toISOString())

    // No `.tmp` orphan left behind by the atomicWriteFile (tmp + rename).
    const entries = await readdir(TEST_DIR)
    const tmpLeftovers = entries.filter(f => f.endsWith('.tmp'))
    expect(tmpLeftovers).toEqual([])

    // And the on-disk JSON is exactly what we wrote (not truncated).
    const raw = await readFile(TEST_STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as { pid: number; state: string; startedAt: string }
    expect(parsed.state).toBe('ready')
    expect(parsed.pid).toBe(process.pid)
  })
})
