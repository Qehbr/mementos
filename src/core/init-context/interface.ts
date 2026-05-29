/**
 * InitContext — primitives passed to each implementation's `setupAtInit()`.
 *
 * Implementations call these to interact with the user (prompt, show secrets) and to
 * communicate config back to the CLI (which merges patches into MachineConfig after every
 * chosen impl has run).
 *
 * Centralised here so subtle correctness logic — terminal scrollback clear after showing a
 * secret, TTY checks, atomic config writes — lives in one place. Impls that need none of
 * this just don't import the ctx; their setupAtInit can be `() => Promise<void>`.
 *
 * Design choice: ctx is the minimum necessary surface. Anything an impl wants beyond these
 * primitives (network calls, FS operations, env reads) it can do directly with Node APIs.
 */
import type { MachineConfig } from '../types.js'

export interface InitContext {
  /**
   * Display a secret value to the user, wait for them to acknowledge, then clear the
   * terminal scrollback (TTY only — no-op when piped). Use for any secret the user must
   * write down or copy elsewhere (mnemonics, raw keys, recovery codes).
   */
  showSecret(label: string, value: string): Promise<void>

  /** Print a message to stdout. */
  print(message: string): void

  /** Print a warning to stderr. */
  warn(message: string): void

  /**
   * Read a CLI flag value of the form `--name=value`. Returns undefined if absent.
   * Implementations use this to accept their own configuration up front (e.g. an
   * S3Backend reading `--bucket=foo`) without prompting.
   */
  getFlag(name: string): string | undefined

  /**
   * Stage a partial update to MachineConfig. The CLI merges all staged patches into the
   * final config object before writing it to disk at the end of init. Used by impls that
   * need to record their own configuration (e.g. `git: { remote }` for GitBackend).
   */
  patchMachineConfig(patch: Partial<MachineConfig>): void
}
