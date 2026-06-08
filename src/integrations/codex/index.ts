/**
 * CodexIntegration — MCP server via `codex mcp add` (config.toml is owned by Codex's own
 * CLI; we don't poke at it), skill at ~/.agents/skills/mementos/SKILL.md, opt-in
 * SessionStart hook in ~/.codex/hooks.json (a sibling of config.toml — JSON, no TOML
 * dep). Codex has no PreCompact event yet. (UserPromptSubmit is reachable in Codex's
 * own hooks.json schema but mementos no longer installs anything on that event — the
 * per-prompt auto-retrieve hook was retired for token cost; the session-start hook
 * loads the curated memory index once at conversation start instead.)
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { cliRunner } from '../_utils/cli-runner.js'
import { pathExists } from '../../core/_utils/fs.js'
import type { ClientIntegration, BinarySurface } from '../interface.js'
import { MCP_SERVER_COMMAND, SESSION_START_COMMAND } from '../interface.js'
import type { IntegrationImplementationModule } from '../registry.js'
import type { InitContext } from '../../core/init-context/interface.js'
import { promptBinaryToggle, hookToggleMessages, mcpToggleOptions, skillToggleOptions } from '../_utils/prompt.js'
import { StepCounter } from '../../cli/_utils/prompts.js'
import { folderSkillSurface, skillFilePath } from '../_utils/skill.js'
import { HookRegistry, jsonHooksAdapter, type HookSpec } from '../_utils/hook-registry.js'

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
    await this.skill.install()
  }

  /**
   * Remove every mementos-installed artifact: MCP entry (via `codex mcp remove`), skill
   * directory, and any hook we registered in `hooks.json`. Idempotent — tolerates an
   * already-absent server / skill / hook.
   */
  async uninstall(): Promise<void> {
    await this.removeMcpServer()
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
   * Init-time flow. Install if not already installed, then prompt for the
   * session-start hook (default = current state, so `--reinit` keeps things
   * via Enter). Flag `--codex-hook-session-start=on|off` skips the prompt.
   */
  readonly skill: BinarySurface = folderSkillSurface(this.skillDir)

  readonly mcp: BinarySurface = {
    isInstalled: () => this.isInstalled(),
    install: () => this.installMcpServer(),
    uninstall: () => this.removeMcpServer(),
  }

  async setupAtInit(ctx: InitContext): Promise<void> {
    try {
      await promptBinaryToggle({
        ctx, surface: this.mcp,
        ...mcpToggleOptions({ integrationType: type, clientName: 'Codex', agentName: 'Codex', toolWord: 'shell tool' }),
      })
      await promptBinaryToggle({
        ctx, surface: this.skill,
        ...skillToggleOptions({ integrationType: type, clientName: 'Codex', agentName: 'Codex', skillPath: skillFilePath(this.skillDir) }),
      })
      const steps = new StepCounter(1)
      await promptBinaryToggle({
        ctx, surface: this.hooks.hook('session-start'),
        flag: `${type}-hook-session-start`,
        promptText: 'Enable Codex session-start hook? (loads the curated memory index ONCE at conversation start so you do not have to recall it; cheap.)',
        ...hookToggleMessages('Session-start hook', type, 'session-start'),
        defaultYes: true,
        steps,
      })
    } catch (e) {
      ctx.print(`Skipped ${this.name}: ${(e as Error).message}`)
    }
  }

  /** Idempotent: remove-then-add, since `codex mcp add` rejects duplicates. */
  private async installMcpServer(): Promise<void> {
    await this.removeMcpServer()
    await codex(['mcp', 'add', 'mementos', '--', ...MCP_SERVER_COMMAND])
  }

  /** Remove the MCP server registration. Tolerates not-registered. */
  private async removeMcpServer(): Promise<void> {
    await codex(['mcp', 'remove', 'mementos']).catch(() => { /* not present — fine */ })
  }

  // ─── Hook lifecycle ──────────────────────────────────────────────────────────

  /**
   * One entry per hook kind. Codex's documented events are
   * SessionStart/PreToolUse/PermissionRequest/PostToolUse/UserPromptSubmit/Stop —
   * no compaction hook, so no pre-compact kind. Adding a new kind is one entry here.
   */
  private static readonly HOOKS = {
    'session-start': {
      event: 'SessionStart',
      command: SESSION_START_COMMAND,
      baseCommand: SESSION_START_COMMAND,
    },
  } as const satisfies Record<string, HookSpec>

  readonly hooks = new HookRegistry(
    CodexIntegration.HOOKS,
    jsonHooksAdapter(() => this.hooksPath, spec => ({ hooks: [{ type: 'command', command: spec.command }] })),
    this.name,
  )
}

