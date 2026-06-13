/**
 * Regression test for the Fable 5 audit finding: `ensureDaemonRunning`
 * with `timeoutMs: null` (the mcp shim's wait-forever mode) used to poll
 * the state file unconditionally, with no way to distinguish "daemon is
 * still loading the vault" (legitimate slow case) from "daemon spawn
 * failed and the state file never appeared" (silent hang).
 *
 * The trigger that makes this finding routine: the audit-fable5 wizard
 * fence (commit 755fd99) is designed to make any daemon spawned during
 * a migrate / init --reinit wizard fail its buildVault. Without this
 * fix, the mcp shim spawned by an AI client mid-wizard would poll
 * forever — the MCP handshake never completes and the user sees
 * mementos "not working" with no error anywhere.
 *
 * The fix in `waitForReady`: even in `null` budget mode, persistent
 * `absent` past the spawn sanity window means the daemon never came up.
 * `initializing` (PID alive, vault loading) keeps waiting — the
 * legitimate long path must not be cut short.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

// `vi.hoisted` so the mock pid is settable per-test from outside the
// vi.mock factory (the factory itself is hoisted above imports).
const mockSpawnState = vi.hoisted(() => ({ pid: 999_999 }))

// Mock node:child_process at module level — spawn calls from daemon.ts
// must not fork a real subprocess in tests. The spawn is fire-and-forget
// in production; here we return a stub object with the same shape the
// caller reads (`pid`, `unref`).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: () => ({ pid: mockSpawnState.pid, unref: () => {} } as unknown as ReturnType<typeof actual.spawn>),
  }
})

describe('ensureDaemonRunning ({ timeoutMs: null })', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    mockSpawnState.pid = 999_999  // dead-pid default for the next test
  })

  it('throws when the spawned daemon never appears (persistent `absent`)', async () => {
    // Simulates a daemon that died in buildVault — getDaemonState always
    // returns 'absent'. Before the Fable 5 fix, waitForReady(null) would
    // poll forever; the contract under test is that it now gives up after
    // the SPAWN_SANITY_CHECK_MS window of persistent absent.
    const apiClient = await import('../daemon/api-client.js')
    vi.spyOn(apiClient, 'getDaemonState').mockResolvedValue('absent')

    const { ensureDaemonRunning } = await import('../cli/commands/daemon.js')

    const start = Date.now()
    await expect(ensureDaemonRunning({ timeoutMs: null }))
      .rejects.toThrow(/daemon failed to start/i)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(10_000)
  }, 30_000)

  it('keeps waiting when the spawned daemon is `initializing` (legitimate slow case)', async () => {
    // The fix must NOT cut short the legitimate slow path — vault-loading
    // on a huge corpus can take minutes. As long as the state is
    // `initializing`, the mcp shim keeps waiting; once `ready`, it returns.
    const apiClient = await import('../daemon/api-client.js')
    let calls = 0
    vi.spyOn(apiClient, 'getDaemonState').mockImplementation(async () => {
      calls++
      // Many polls of 'initializing' (past the 1.5s sanity window) then ready.
      // If the fix incorrectly cut these short, this test would throw.
      return calls < 60 ? 'initializing' : 'ready'
    })

    const { ensureDaemonRunning } = await import('../cli/commands/daemon.js')

    await expect(ensureDaemonRunning({ timeoutMs: null })).resolves.toBeUndefined()
  }, 30_000)

  // The false-positive case the timing-based grace window can't handle:
  // a daemon that IS alive but is slow to write the `initializing` state
  // file (slow first-load dynamic imports, slow disk, constrained system).
  // The PID is alive, buildVault is still running, the state file is
  // legitimately absent for > 1.5s. A timing-based grace would wrongly
  // declare the spawn failed. A PID-liveness signal (`isProcessAlive(pid)`)
  // is correct: the daemon is alive, just slow, so we keep waiting.
  it('does NOT throw on a slow-but-alive startup (state absent > 1.5s, PID alive)', async () => {
    // Spawn mock returns our OWN process PID — guaranteed alive throughout
    // the test. Real production: the spawned daemon's PID, alive until the
    // process exits.
    mockSpawnState.pid = process.pid

    // State stays 'absent' for ~2.5s (well past SPAWN_SANITY_CHECK_MS),
    // then transitions to 'initializing', then 'ready'. Mirrors the real
    // failure mode the test pins: a legitimately-slow buildVault on a
    // first-load device.
    const startedAt = Date.now()
    const apiClient = await import('../daemon/api-client.js')
    vi.spyOn(apiClient, 'getDaemonState').mockImplementation(async () => {
      const elapsed = Date.now() - startedAt
      if (elapsed < 2_500) return 'absent'
      if (elapsed < 3_500) return 'initializing'
      return 'ready'
    })

    const { ensureDaemonRunning } = await import('../cli/commands/daemon.js')

    // With a timing-only grace window (the v1 fix), this throws at 1.5s
    // even though the daemon is alive. With PID-liveness, the check
    // confirms the spawn is alive and we keep waiting → ready.
    await expect(ensureDaemonRunning({ timeoutMs: null })).resolves.toBeUndefined()
  }, 30_000)
})
