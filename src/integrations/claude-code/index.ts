/**
 * ClaudeCodeIntegration — MCP server (via `claude mcp add --scope user` → ~/.claude.json),
 * skill file at ~/.claude/skills/mementos.md, opt-in UserPromptSubmit + PreCompact hooks
 * in ~/.claude/settings.json. Hooks default OFF (pre-injection burns tokens on trivial turns).
 */
import { safeUnlink, pathExists } from '../../core/_utils/fs.js'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { cliRunner, probeCli } from '../_utils/cli-runner.js'
import type { ClientIntegration } from '../interface.js'
import { MCP_SERVER_COMMAND, AUTO_RETRIEVE_COMMAND, SESSION_START_COMMAND } from '../interface.js'
import type { IntegrationImplementationModule } from '../registry.js'
import type { InitContext } from '../../core/init-context/interface.js'
import { resolveYesNo, promptHookToggle, promptAutoRetrieveHook } from '../_utils/prompt.js'
import { StepCounter } from '../../cli/_utils/prompts.js'
import { SKILL_BODY, writeSkillFile } from '../_utils/skill.js'
import { HookRegistry, jsonHooksAdapter, type HookSpec } from '../_utils/hook-registry.js'
import { withInstallShell } from '../_utils/install-shell.js'

const claude = cliRunner('claude')
const claudeMcp = (args: string[]) => claude(['mcp', ...args])

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'claude-code'
export function create(): ClientIntegration {
  return new ClaudeCodeIntegration()
}
/** Module-level setupAtInit delegates into the class so install helpers can stay private. */
export const setupAtInit = (ctx: InitContext) => new ClaudeCodeIntegration().setupAtInit(ctx)
const _shape: IntegrationImplementationModule = { type, create, setupAtInit }

export class ClaudeCodeIntegration implements ClientIntegration {
  readonly name = 'Claude Code'

  private get settingsPath(): string {
    return join(homedir(), '.claude', 'settings.json')
  }

  /** Default install bundle: MCP server + skill file. Hook is opt-in via setupAtInit. */
  async install(): Promise<void> {
    await this.installMcpServer()
    await this.installSkill()
  }

  /** Remove MCP entry, every hook kind, and the skill file. Idempotent. */
  async uninstall(): Promise<void> {
    await this.removeMcpServer().catch(() => {})
    await this.hooks.disableAllHooks()
    await this.uninstallSkill()
  }

  /** Whether Claude Code currently has a mementos MCP server registered (user scope). */
  async isInstalled(): Promise<boolean> {
    return probeCli(() => claudeMcp(['get', 'mementos']))
  }

  async isClientPresent(): Promise<boolean> {
    return pathExists(join(homedir(), '.claude'))
  }

  /**
   * Init-time flow. Each prompt defaults to its CURRENT state so `--reinit` is a real
   * reconfigure (Enter keeps, No turns off).
   */
  async setupAtInit(ctx: InitContext): Promise<void> {
    await withInstallShell(
      { name: this.name, install: () => this.installMcpServer(), isInstalled: () => this.isInstalled() },
      ctx,
      async () => {
        await this.promptSkill(ctx)
        await this.promptHooks(ctx)
      },
    )
  }

  /** Real toggle — answering No to an installed skill removes it. */
  private async promptSkill(ctx: InitContext): Promise<void> {
    const skillOn = await this.isSkillInstalled()
    const wantSkill = await resolveYesNo(ctx, `${type}-skill`, skillOn,
      'Install the Claude Code skill file? (teaches Claude when/how to use the memory tools)')
    if (wantSkill) {
      await this.installSkill()
      ctx.print('Skill on — installed at ~/.claude/skills/mementos.md')
    } else {
      await this.uninstallSkill()
      ctx.print('Skill off — not installed.')
    }
  }

  /** Real toggle — answering No to an enabled hook disables it. */
  private async promptHooks(ctx: InitContext): Promise<void> {
    const steps = new StepCounter(3)
    await promptAutoRetrieveHook(ctx, this, type,
      'Enable auto-retrieval hook? (pre-injects memories before every message; costs tokens on trivial turns)', steps)
    await promptHookToggle({
      ctx, flag: `${type}-hook-session-start`, label: 'Session-start hook',
      integration: 'claude-code', kind: 'session-start',
      current: await this.hooks.isHookEnabled('session-start'),
      defaultYes: true,
      steps,
      promptText: 'Enable session-start hook? (loads the curated memory index ONCE at conversation start so you do not have to recall it; cheap.)',
      enable: () => this.hooks.enableHook('session-start'),
      disable: () => this.hooks.disableHook('session-start'),
    })
    await promptHookToggle({
      ctx, flag: `${type}-hook-pre-compact`, label: 'Pre-compact hook',
      integration: 'claude-code', kind: 'pre-compact',
      current: await this.hooks.isHookEnabled('pre-compact'),
      steps,
      promptText: 'Enable pre-compact hook? (snapshots the conversation into the vault before Claude Code compacts long context)',
      enable: () => this.hooks.enableHook('pre-compact'),
      disable: () => this.hooks.disableHook('pre-compact'),
    })
  }

  /**
   * Register the MCP server via `claude mcp add --scope user` so it lands in `~/.claude.json`
   * (Claude Code looks there, NOT `~/.claude/settings.json`, despite the latter accepting
   * an `mcpServers` key). No env block — the server reads its key from the keychain.
   */
  private async installMcpServer(): Promise<void> {
    await this.removeMcpServer().catch(() => {})
    await claudeMcp([
      'add',
      '--transport', 'stdio',
      '--scope', 'user',
      'mementos',
      '--',
      ...MCP_SERVER_COMMAND,
    ])
  }

  /** Remove the mementos MCP entry. Throws if not present — caller decides whether to tolerate. */
  private async removeMcpServer(): Promise<void> {
    await claudeMcp(['remove', 'mementos', '--scope', 'user'])
  }

  private async installSkill(): Promise<void> {
    await writeSkillFile(join(homedir(), '.claude', 'skills'), 'mementos.md', SKILL_BODY)
  }

  /** Remove the skill file. Idempotent — ENOENT-tolerant. */
  private async uninstallSkill(): Promise<void> {
    await safeUnlink(this.skillPath)
  }

  /** Whether the skill file is currently present on disk. */
  private async isSkillInstalled(): Promise<boolean> {
    return pathExists(this.skillPath)
  }

  private get skillPath(): string {
    return join(homedir(), '.claude', 'skills', 'mementos.md')
  }

  /** One entry per hook kind. */
  private static readonly HOOKS = {
    'auto-retrieve': {
      event: 'UserPromptSubmit',
      command: AUTO_RETRIEVE_COMMAND,
      baseCommand: AUTO_RETRIEVE_COMMAND,
    },
    'session-start': {
      event: 'SessionStart',
      command: SESSION_START_COMMAND,
      baseCommand: SESSION_START_COMMAND,
    },
    'pre-compact': {
      event: 'PreCompact',
      command: 'mementos snapshot',
      baseCommand: 'mementos snapshot',
    },
  } as const satisfies Record<string, HookSpec>

  readonly hooks = new HookRegistry(
    ClaudeCodeIntegration.HOOKS,
    jsonHooksAdapter(
      () => this.settingsPath,
      spec => ({ matcher: '', hooks: [{ type: 'command', command: spec.command }] }),
    ),
    this.name,
  )
}

