/**
 * Helpers for integration tests.
 *
 * Each test scenario gets its own scratch HOME under `<repo>/tmp/`. Lazy `vaultPath()` /
 * `machineConfigFile()` in core/config.ts means changing `process.env.HOME` between tests
 * is enough — no module cache to bust, no forks pool needed.
 *
 * All tests use `--key=env` with a per-test `MEMENTOS_RAW_KEY` so we never touch the OS
 * keychain. That also means `EnvKeyProvider.setupAtInit` sees the env var already set and
 * returns early — no `showSecret` blocking on stdin.
 *
 * `runInit` calls `process.exit(1)` on refuse-paths; we spy on that and convert it to a
 * thrown ProcessExitError so tests can assert on those branches.
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { execSync } from 'node:child_process'
import { vi, type MockInstance } from 'vitest'

/** Tests root (this file is at src/__tests__/integration/_helpers.ts). */
const TESTS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Scratch root for integration test artefacts. Always `src/__tests__/tmp/`, never `/tmp`. */
export const TMP_ROOT = join(TESTS_ROOT, 'tmp')

/** Thrown by the `process.exit` mock so tests can assert on the refuse paths. */
export class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`)
    this.name = 'ProcessExitError'
  }
}

export interface IntegrationContext {
  /** Fresh HOME directory for this test (under <repo>/tmp/). */
  homeDir: string
  /** Absolute path to the vault (always <homeDir>/.mementos). */
  vaultPath: string
  /** Base64-encoded raw 32-byte AES key used by EnvKeyProvider. */
  rawKey: string
  /** process.exit spy — call .mockRestore() in cleanup. */
  exitSpy: MockInstance
  /** Restores HOME, MEMENTOS_RAW_KEY, process.argv, process.exit; rm -rf the homeDir. */
  cleanup: () => Promise<void>
}

/**
 * Set up a fresh test environment:
 *   - mkdtemp under `<repo>/tmp/`
 *   - point HOME at it
 *   - generate + export MEMENTOS_RAW_KEY
 *   - mock process.exit so refuse-paths throw instead of killing the worker
 *
 * Caller must `await ctx.cleanup()` (in `afterEach`) — without it, env vars leak into
 * the next test and the tmp dir lingers.
 */
export async function setupTestEnv(): Promise<IntegrationContext> {
  await mkdir(TMP_ROOT, { recursive: true })
  const homeDir = await mkdtemp(join(TMP_ROOT, 'home-'))
  const vaultPath = join(homeDir, '.mementos')

  const origHome = process.env['HOME']
  const origKey = process.env['MEMENTOS_RAW_KEY']
  const origArgv = process.argv

  process.env['HOME'] = homeDir
  const rawKey = randomBytes(32).toString('base64')
  process.env['MEMENTOS_RAW_KEY'] = rawKey

  // Convert process.exit to a thrown error so tests can assert on refuse paths instead
  // of dying. The cast is necessary because Node types `process.exit` as `never`.
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExitError(code ?? 0)
  }) as (code?: number) => never)

  return {
    homeDir,
    vaultPath,
    rawKey,
    exitSpy,
    cleanup: async () => {
      exitSpy.mockRestore()
      process.argv = origArgv
      if (origHome === undefined) delete process.env['HOME']
      else process.env['HOME'] = origHome
      if (origKey === undefined) delete process.env['MEMENTOS_RAW_KEY']
      else process.env['MEMENTOS_RAW_KEY'] = origKey
      await rm(homeDir, { recursive: true, force: true })
    },
  }
}

/**
 * Run `mementos init` with the given flags. Sets `process.argv`, imports + invokes
 * `runInit`, and restores argv on completion.
 *
 * The flags should always include `--integrations=none` for tests (otherwise the yes/no
 * prompt fires). Use `--key=env`; the test env already has MEMENTOS_RAW_KEY set so
 * EnvKeyProvider's setupAtInit returns early without prompting.
 *
 * Auto-injects two flags so the new interactive prompts (top-level mode + vault path)
 * don't hang on stdin:
 *   - `--mode=new` if neither --mode nor --join is supplied; tests that exercise the
 *     join branch (cross-device clone, pre-populated vault adoption) pass --mode=join.
 *   - `--vault-path=<HOME>/.mementos` if not supplied; tests can override.
 */
export async function runInitWithFlags(flags: string[]): Promise<void> {
  const hasFlag = (name: string): boolean =>
    flags.some(f => f === `--${name}` || f.startsWith(`--${name}=`))
  const fullFlags = [...flags]
  if (!hasFlag('mode')) fullFlags.push('--mode=new')
  if (!hasFlag('vault-path')) fullFlags.push(`--vault-path=${join(process.env['HOME']!, '.mementos')}`)
  // Newly-added init prompts need a default injected here so tests don't hang on stdin.
  // Production users see the prompt and accept the default by pressing Enter.
  if (!hasFlag('retriever')) fullFlags.push('--retriever=semantic')
  // `--searcher=none` (not `scan`) so `setupAtInit` runs no `ensurePackage('re2')` —
  // integration tests don't exercise search and must not trigger a network install.
  if (!hasFlag('searcher')) fullFlags.push('--searcher=none')
  process.argv = ['node', 'mementos', 'init', ...fullFlags]
  const { runInit } = await import('../../cli/commands/init.js')
  await runInit()
}

/** Initialise a bare git repository at the given path. Used as the "remote" for git-backend tests. */
export function initBareRepo(path: string): void {
  // --bare so it has no working tree (a remote repo). --initial-branch=main keeps
  // GitBackend's hardcoded branch happy.
  execSync(`git init --bare --initial-branch=main ${JSON.stringify(path)}`, { stdio: 'pipe' })
}

/** Resolve a fresh tmp subdirectory for this test (e.g., a bare repo). */
export async function mkTmpSubdir(prefix: string): Promise<string> {
  await mkdir(TMP_ROOT, { recursive: true })
  return mkdtemp(join(TMP_ROOT, `${prefix}-`))
}

/**
 * Force `syncIfStale` to fire on every read by setting `syncIntervalMs=0`. Tests need
 * this because the production 10-min throttle hides cross-device propagation in
 * sub-second tests. Cast through `unknown` because the field is private; this is the
 * one explicit acknowledgement that we're poking internals for test purposes.
 */
export function forceSyncEveryRead(vault: object): void {
  ;(vault as { syncIntervalMs: number }).syncIntervalMs = 0
}
