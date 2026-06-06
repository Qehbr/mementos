/**
 * ClaudeCodeIntegration — MCP server (via `claude mcp add --scope user` → ~/.claude.json),
 * skill at ~/.claude/skills/mementos/SKILL.md, opt-in UserPromptSubmit + PreCompact hooks
 * in ~/.claude/settings.json. Hooks default OFF (pre-injection burns tokens on trivial turns).
 *
 * Skill layout: per the 2026 Agent-Skills spec
 * (https://code.claude.com/docs/en/skills), every skill is a directory whose
 * entrypoint is `SKILL.md` with YAML frontmatter — the older flat
 * `~/.claude/skills/<name>.md` form no longer registers in Claude Code.
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
import { SKILL_MD, writeSkillFile } from '../_utils/skill.js'
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
      ctx.print(`Skill on — installed at ${this.skillPath}`)
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
    // Clean up the pre-1.0.2 flat-file path before writing the per-folder one —
    // otherwise re-init leaves a no-op file Claude Code ignores.
    await safeUnlink(join(homedir(), '.claude', 'skills', 'mementos.md'))
    await writeSkillFile(this.skillDir, 'SKILL.md', SKILL_MD)
  }

  /**
   * Remove the skill file. Idempotent — ENOENT-tolerant.
   *
   * Also sweeps the legacy `~/.claude/skills/mementos.md` flat-file path used by
   * mementos ≤ 1.0.1 — Claude Code stopped honouring that layout when it adopted
   * the per-skill-folder Agent-Skills spec. Leaving the file orphaned is harmless
   * but confusing if the user greps their skills dir.
   */
  private async uninstallSkill(): Promise<void> {
    await safeUnlink(this.skillPath)
    await safeUnlink(join(homedir(), '.claude', 'skills', 'mementos.md'))
  }

  /** Whether the skill file is currently present on disk. */
  private async isSkillInstalled(): Promise<boolean> {
    return pathExists(this.skillPath)
  }

  /** Per-skill folder Claude Code watches for the SKILL.md entrypoint. */
  private get skillDir(): string {
    return join(homedir(), '.claude', 'skills', 'mementos')
  }

  private get skillPath(): string {
    return join(this.skillDir, 'SKILL.md')
  }

  /**
   * One entry per hook kind. Each spec carries its own `matcher` so the same
   * registry can produce the right Claude Code source-filter per event:
   *
   *  - `auto-retrieve`  → `UserPromptSubmit`, no source filter (matcher: '')
   *  - `session-start`  → `SessionStart`, only `startup|resume` (skip `/clear`
   *                       and `/compact` source — we don't want to re-load the
   *                       memory index on every conversation reset)
   *  - `pre-compact`    → `PreCompact`, only `auto` (skip manual `/compact` —
   *                       the user explicitly chose to compact, no need to
   *                       snapshot mid-flow)
   */
  private static readonly HOOKS = {
    'auto-retrieve': {
      event: 'UserPromptSubmit',
      command: AUTO_RETRIEVE_COMMAND,
      baseCommand: AUTO_RETRIEVE_COMMAND,
      matcher: '',
    },
    'session-start': {
      event: 'SessionStart',
      command: SESSION_START_COMMAND,
      baseCommand: SESSION_START_COMMAND,
      matcher: 'startup|resume',
    },
    'pre-compact': {
      event: 'PreCompact',
      command: 'mementos snapshot',
      baseCommand: 'mementos snapshot',
      matcher: 'auto',
    },
  } as const satisfies Record<string, HookSpec>

  readonly hooks = new HookRegistry(
    ClaudeCodeIntegration.HOOKS,
    jsonHooksAdapter(
      () => this.settingsPath,
      spec => ({ matcher: spec.matcher ?? '', hooks: [{ type: 'command', command: spec.command }] }),
    ),
    this.name,
  )
}

