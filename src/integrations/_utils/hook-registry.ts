import type { BinarySurface, HookSurface } from '../interface.js'
import { matchesCommand } from './match-command.js'
import { readJsonConfig, writeJsonConfig } from './json-config.js'

/** One hook kind's binding: which AI-client event fires it, and the command it runs. */
export interface HookSpec {
  /** The client's event name (UserPromptSubmit, PreCompact, BeforeAgent, …). */
  event: string
  /** The shell command the client runs. */
  command: string
  /**
   * Prefix used to recognise OUR existing entry on re-install / uninstall. Any-args
   * tolerant: matches `baseCommand` exactly OR `baseCommand <any args>`. The match rule
   * is centralised in `matchesCommand` — siblings can't drift on the regex shape.
   */
  baseCommand: string
  /**
   * Per-event matcher (Claude Code's `hooks[event][i].matcher`). Semantics depend on the
   * event: for `SessionStart` it's the source (`startup|resume|clear|compact`), for
   * `PreCompact` it's `auto|manual`, for tool events it's a tool-name pattern. Empty
   * string or unset = match all sources. Adapters that don't have a matcher concept
   * (Codex's `hooks.json`) ignore this field.
   */
  matcher?: string
}

/** A per-event group entry — the shape stored under `<config>.hooks[event][i]`. */
export interface GroupWithCommands {
  hooks?: Array<{ command?: string }>
}

/**
 * Per-integration adapter mediating between the registry and the client's on-disk config.
 * Each adapter casts its real shape (e.g. codex's HooksFile) at the boundary so the
 * registry can stay non-generic and satisfy `HookSurface` directly.
 */
export interface HookConfigAdapter {
  read(): Promise<Record<string, unknown>>
  write(config: Record<string, unknown>): Promise<void>
  readGroups(config: Record<string, unknown>, event: string): GroupWithCommands[] | undefined
  writeGroups(config: Record<string, unknown>, event: string, groups: GroupWithCommands[]): void
  newGroup(spec: HookSpec): GroupWithCommands
}

/**
 * A HookConfigAdapter for clients that store hooks in a JSON config file under
 * `<config>.hooks[event]` — the shape every integration with shell-command hooks shares.
 * Only `newGroup` (the per-client group entry) varies; pass it plus the file-path getter.
 */
export function jsonHooksAdapter(
  settingsPath: () => string,
  newGroup: (spec: HookSpec) => GroupWithCommands,
): HookConfigAdapter {
  return {
    read: () => readJsonConfig<Record<string, unknown>>(settingsPath(), {}),
    write: settings => writeJsonConfig(settingsPath(), settings),
    readGroups: (settings, event) =>
      (settings.hooks as Record<string, GroupWithCommands[]> | undefined)?.[event],
    writeGroups: (settings, event, groups) => {
      settings.hooks = (settings.hooks as Record<string, unknown>) ?? {}
      ;(settings.hooks as Record<string, GroupWithCommands[]>)[event] = groups
    },
    newGroup,
  }
}

/**
 * Shared hook-lifecycle plumbing for integrations whose config stores hooks as
 * `event → groups → hooks → command`. Implements `HookSurface`, so integrations expose
 * `readonly hooks = new HookRegistry(...)` directly — no per-class delegation methods.
 */
export class HookRegistry implements HookSurface {
  constructor(
    private readonly specs: Record<string, HookSpec>,
    private readonly adapter: HookConfigAdapter,
    private readonly integrationName: string,
  ) {}

  supportedHooks(): readonly string[] {
    return Object.keys(this.specs)
  }

  spec(kind: string): HookSpec {
    const s = this.specs[kind]
    if (!s) {
      throw new Error(`Unknown hook kind '${kind}' for ${this.integrationName}. Supported: ${this.supportedHooks().join(', ')}`)
    }
    return s
  }

  /**
   * Return a `BinarySurface` for one hook kind — same shape skill + MCP expose,
   * so `promptBinaryToggle` drives all three uniformly. Throws if the kind isn't
   * declared in `supportedHooks()`.
   */
  hook(kind: string): BinarySurface {
    const s = this.spec(kind)
    return {
      isInstalled: () => this.isHookEnabled(s),
      install: () => this.enableHook(s),
      uninstall: () => this.disableHook(s),
    }
  }

  /** Strip every supported hook kind in one batched read/write — the uninstall clean-slate. */
  async disableAllHooks(): Promise<void> {
    const config = await this.adapter.read()
    for (const kind of this.supportedHooks()) {
      await this.disableHookInline(this.spec(kind), config)
    }
    await this.adapter.write(config)
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async isHookEnabled(s: HookSpec): Promise<boolean> {
    const config = await this.adapter.read()
    return this.adapter.readGroups(config, s.event)?.some(g => this.hasCommand(g, s.baseCommand)) ?? false
  }

  private async enableHook(s: HookSpec): Promise<void> {
    const config = await this.adapter.read()
    const groups = (this.adapter.readGroups(config, s.event) ?? []).filter(g => !this.hasCommand(g, s.baseCommand))
    groups.push(this.adapter.newGroup(s))
    this.adapter.writeGroups(config, s.event, groups)
    await this.adapter.write(config)
  }

  private async disableHook(s: HookSpec): Promise<void> {
    const config = await this.adapter.read()
    await this.disableHookInline(s, config)
    await this.adapter.write(config)
  }

  /** Strip a single hook without writing — used by `disableAllHooks` to batch. */
  private async disableHookInline(s: HookSpec, config: Record<string, unknown>): Promise<void> {
    const groups = this.adapter.readGroups(config, s.event)
    if (groups) this.adapter.writeGroups(config, s.event, groups.filter(g => !this.hasCommand(g, s.baseCommand)))
  }

  private hasCommand(group: GroupWithCommands, baseCommand: string): boolean {
    return group.hooks?.some(h => matchesCommand(h.command, baseCommand)) ?? false
  }
}
