/**
 * CodexIntegration — MCP server via `codex mcp add` (config.toml is owned by Codex's own
 * CLI; we don't poke at it), skill at ~/.agents/skills/mementos/SKILL.md, opt-in
 * UserPromptSubmit hook in ~/.codex/hooks.json (a sibling of config.toml — JSON, no TOML
 * dep). Codex has no PreCompact event yet.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { cliRunner } from '../_utils/cli-runner.js'
import { pathExists } from '../../core/_utils/fs.js'
import type { ClientIntegration } from '../interface.js'
import { MCP_SERVER_COMMAND, AUTO_RETRIEVE_COMMAND } from '../interface.js'
import type { IntegrationImplementationModule } from '../registry.js'
import type { InitContext } from '../../core/init-context/interface.js'
import { promptAutoRetrieveHook } from '../_utils/prompt.js'
import { SKILL_MD, writeSkillFile } from '../_utils/skill.js'
import { HookRegistry, jsonHooksAdapter, type HookSpec } from '../_utils/hook-registry.js'
import { withInstallShell } from '../_utils/install-shell.js'

/** Run `codex <args>` as a subprocess — Codex's own CLI owns the MCP-config schema. */
const codex = cliRunner('codex')

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'codex'
export function create(): ClientIntegration {
  return new CodexIntegration()
}
/** Module-level setupAtInit delegates into the class so install helpers can stay private. */
export const setupAtInit = (ctx: InitContext) => new CodexIntegration().setupAtInit(ctx)
const _shape: IntegrationImplementationModule = { type, create, setupAtInit }

export class CodexIntegration implements ClientIntegration {
  readonly name = 'Codex'

  /** Codex loads user-scoped SKILL.md skills from `~/.agents/skills/<name>/`. */
  private get skillDir(): string {
    return join(homedir(), '.agents', 'skills', 'mementos')
  }

  /** Codex discovers lifecycle hooks from `~/.codex/hooks.json`. */
  private get hooksPath(): string {
    return join(homedir(), '.codex', 'hooks.json')
  }

  /** Install bundle: MCP server registration + skill file. Idempotent. */
  async install(): Promise<void> {
    await this.installMcpServer()
    await this.installSkill()
  }

  /**
   * Remove every mementos-installed artifact: MCP entry (via `codex mcp remove`), skill
   * directory, and any hook we registered in `hooks.json`. Idempotent — tolerates an
   * already-absent server / skill / hook.
   */
  async uninstall(): Promise<void> {
    await codex(['mcp', 'remove', 'mementos']).catch(() => { /* not registered — fine */ })
    await rm(this.skillDir, { recursive: true, force: true })
    await this.hooks.disableAllHooks()
  }

  /** Whether Codex currently has a mementos MCP server registered. */
  async isInstalled(): Promise<boolean> {
    try {
      const { stdout, stderr } = await codex(['mcp', 'list'])
      return (stdout + stderr).includes('mementos')
    } catch {
      return false
    }
  }

  async isClientPresent(): Promise<boolean> {
    return pathExists(join(homedir(), '.codex'))
  }

  /**
   * Init-time flow. Install if not already installed, then prompt for the auto-retrieval
   * hook (default = current state, so `--reinit` keeps things via Enter). Flag
   * `--codex-hook-auto-retrieve=on|off` skips the prompt.
   */
  async setupAtInit(ctx: InitContext): Promise<void> {
    await withInstallShell(
      { name: this.name, install: () => this.install(), isInstalled: () => this.isInstalled() },
      ctx,
      () => promptAutoRetrieveHook(ctx, this, type,
        'Enable Codex auto-retrieval hook? (pre-injects memories before every message; costs tokens on trivial turns)'),
    )
  }

  /** Idempotent: remove-then-add, since `codex mcp add` rejects duplicates. */
  private async installMcpServer(): Promise<void> {
    await codex(['mcp', 'remove', 'mementos']).catch(() => { /* not present — fine */ })
    await codex(['mcp', 'add', 'mementos', '--', ...MCP_SERVER_COMMAND])
  }

  private async installSkill(): Promise<void> {
    await writeSkillFile(this.skillDir, 'SKILL.md', SKILL_MD)
  }

  // ─── Hook lifecycle ──────────────────────────────────────────────────────────

  /**
   * One entry per hook kind. Codex has no compaction hook event (its documented events are
   * SessionStart/PreToolUse/PermissionRequest/PostToolUse/UserPromptSubmit/Stop), so only
   * `auto-retrieve` is wired. Adding a new kind is one entry here.
   */
  private static readonly HOOKS = {
    'auto-retrieve': {
      event: 'UserPromptSubmit',
      command: AUTO_RETRIEVE_COMMAND,
      baseCommand: AUTO_RETRIEVE_COMMAND,
    },
  } as const satisfies Record<string, HookSpec>

  readonly hooks = new HookRegistry(
    CodexIntegration.HOOKS,
    jsonHooksAdapter(() => this.hooksPath, spec => ({ hooks: [{ type: 'command', command: spec.command }] })),
    this.name,
  )
}

