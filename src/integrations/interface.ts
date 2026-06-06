/**
 * ClientIntegration — abstracts how a particular AI client is wired up to mementos.
 *
 * Each integration knows where its client's config files live (e.g. `~/.claude/settings.json`,
 * `~/Library/Application Support/Claude/`) and how to register an MCP server entry there.
 *
 * Lifecycle:
 *   - `setupAtInit(ctx)` (module-level export) — invoked by `mementos init`. Typical body:
 *     check `isInstalled()`, call `install()` if not, print status via ctx.
 *   - `install()` / `uninstall()` / `isInstalled()` — public API used both by the
 *     `setupAtInit` flow above AND by the standalone `mementos integration enable|disable|list`
 *     and `mementos integration hook enable|disable|status` commands after init.
 *
 * Implementations are auto-discovered from `src/integrations/<name>/index.ts`; the
 * MCP-only clients share `standardJsonIntegration`.
 */

/**
 * The argv used to launch the MCP server from any client's config. Hardcoded constant —
 * every integration writes the same entry. Lives here so a single change updates every
 * client. Note: secrets are NEVER passed via argv; the `mementos serve` subprocess reads
 * the vault key from the OS keychain at startup.
 */
export const MCP_SERVER_COMMAND = ['mementos', 'mcp'] as const

/**
 * Shell command for the SessionStart hook — emits the curated `_index` memento
 * as a one-time-per-conversation prelude (NOT per user message). Separate from
 * `auto-retrieve` to keep the per-message recall path lean.
 */
export const SESSION_START_COMMAND = 'mementos session-start'

/** The standard `{ command, args }` MCP-server entry every integration writes into its client config. */
export function mcpServerEntry(): { command: string; args: string[] } {
  return { command: MCP_SERVER_COMMAND[0], args: MCP_SERVER_COMMAND.slice(1) }
}

/**
 * Hook lifecycle surface for integrations whose client fires shell commands around AI
 * events. Hook kind identifiers are plain strings, validated at runtime against
 * `supportedHooks()`. `HookRegistry` implements this; integrations expose it as
 * `readonly hooks`.
 */
/**
 * Registry of per-kind hook toggles. Each kind is itself a `BinarySurface`, so
 * `promptBinaryToggle` drives skill / MCP / hook toggles through one helper:
 *   promptBinaryToggle({ surface: integration.hooks.hook('session-start'), … })
 */
export interface HookSurface {
  /** Hook kinds this integration supports. Used by `mementos integration hook` for --type validation. */
  supportedHooks(): readonly string[]
  /** Return the BinarySurface for one hook kind. Throws on unknown kinds. */
  hook(kind: string): BinarySurface
  /** Strip every hook kind in one batched read/write — the uninstall clean-slate. */
  disableAllHooks(): Promise<void>
}

/**
 * One install/uninstall pair for any binary-toggle component (MCP server, skill
 * file, …). Same shape `HookSurface` has but for a single resource rather than
 * a kind-keyed registry. `promptBinaryToggle` (in `_utils/prompt.ts`) drives
 * any field of this shape with a consistent yes/no prompt.
 */
export interface BinarySurface {
  /** Whether this component is currently installed. */
  isInstalled(): Promise<boolean>
  /** Install the component. Idempotent — safe to call when already installed. */
  install(): Promise<void>
  /** Remove the component. Idempotent — safe to call when already absent. */
  uninstall(): Promise<void>
}

export interface ClientIntegration {
  /** Human-readable name shown in the init log. */
  readonly name: string

  /** Wire up the MCP server (and any per-client extras like a skill file). Idempotent. */
  install(): Promise<void>

  /** Remove the mementos entry from this client's config. Idempotent. */
  uninstall(): Promise<void>

  /** Whether mementos is currently registered with this client. */
  isInstalled(): Promise<boolean>

  /**
   * Whether the target AI client appears to be present on this machine. Heuristic — return
   * `true` if uncertain (a false positive is annoying; a false negative is broken).
   */
  isClientPresent(): Promise<boolean>

  /** MCP server registration surface — optional toggle in `setupAtInit`. */
  readonly mcp?: BinarySurface
  /** Skill file surface — optional toggle in `setupAtInit`. */
  readonly skill?: BinarySurface
  /** Hook lifecycle, if this client fires shell commands around AI events. */
  readonly hooks?: HookSurface
}
