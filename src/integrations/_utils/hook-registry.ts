import type { HookSurface } from '../interface.js'
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

  async isHookEnabled(kind: string): Promise<boolean> {
    const s = this.spec(kind)
    const config = await this.adapter.read()
    return this.adapter.readGroups(config, s.event)?.some(g => this.hasCommand(g, s.baseCommand)) ?? false
  }

  async enableHook(kind: string): Promise<void> {
    const s = this.spec(kind)
    const config = await this.adapter.read()
    const groups = (this.adapter.readGroups(config, s.event) ?? []).filter(g => !this.hasCommand(g, s.baseCommand))
    groups.push(this.adapter.newGroup(s))
    this.adapter.writeGroups(config, s.event, groups)
    await this.adapter.write(config)
  }

  /**
   * Caller may pass a pre-loaded `settings` to batch multiple disables into one write
   * (e.g. uninstall strips every kind before writing once).
   */
  async disableHook(kind: string, settings?: Record<string, unknown>): Promise<void> {
    const s = this.spec(kind)
    const c = settings ?? await this.adapter.read()
    const groups = this.adapter.readGroups(c, s.event)
    if (groups) this.adapter.writeGroups(c, s.event, groups.filter(g => !this.hasCommand(g, s.baseCommand)))
    if (!settings) await this.adapter.write(c)
  }

  /** Strip every supported hook kind in one batched read/write — the uninstall clean-slate. */
  async disableAllHooks(): Promise<void> {
    const config = await this.adapter.read()
    for (const kind of this.supportedHooks()) await this.disableHook(kind, config)
    await this.adapter.write(config)
  }

  private hasCommand(group: GroupWithCommands, baseCommand: string): boolean {
    return group.hooks?.some(h => matchesCommand(h.command, baseCommand)) ?? false
  }
}
