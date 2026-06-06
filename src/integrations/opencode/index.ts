/**
 * OpenCodeIntegration — wires mementos into opencode (opencode.ai), the open-source
 * terminal AI agent.
 *
 * Two artifacts installed idempotently:
 *   1. An MCP server entry under the `mcp` key of `~/.config/opencode/opencode.json`.
 *      opencode has no `mcp add` subcommand, so we edit the JSON directly.
 *   2. A skill at `~/.config/opencode/skills/mementos/SKILL.md`.
 *
 * No hook: opencode's extension point is JS/TS plugin modules, a different contract from
 * Claude Code's shell-command hooks.
 *
 * The MCP entry carries no secrets; `mementos serve` reads the vault key from the keychain.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathExists } from '../../core/_utils/fs.js'
import type { ClientIntegration, BinarySurface } from '../interface.js'
import { MCP_SERVER_COMMAND } from '../interface.js'
import type { IntegrationImplementationModule } from '../registry.js'
import type { InitContext } from '../../core/init-context/interface.js'
import { SKILL_MD, writeSkillFile } from '../_utils/skill.js'
import { promptBinaryToggle } from '../_utils/prompt.js'
import { jsonMcpConfigOps } from '../_utils/json-mcp-config.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'opencode'
export function create(): ClientIntegration {
  return new OpenCodeIntegration()
}
export const setupAtInit = (ctx: InitContext) => new OpenCodeIntegration().setupAtInit(ctx)
const _shape: IntegrationImplementationModule = { type, create, setupAtInit }

export class OpenCodeIntegration implements ClientIntegration {
  readonly name = 'opencode'

  private get configDir(): string {
    return join(homedir(), '.config', 'opencode')
  }

  private get configPath(): string {
    return join(this.configDir, 'opencode.json')
  }

  /** opencode loads global SKILL.md skills from `~/.config/opencode/skills/<name>/`. */
  private get skillDir(): string {
    return join(this.configDir, 'skills', 'mementos')
  }

  /** Underlying JSON-config ops over `~/.config/opencode/opencode.json`'s `mcp` key.
   *  The public `mcp: BinarySurface` field below delegates to this. */
  private readonly mcpOps = jsonMcpConfigOps({
    configPath: () => this.configPath,
    mcpKey: 'mcp',
    entry: () => ({ type: 'local', command: [...MCP_SERVER_COMMAND], enabled: true }),
  })

  async install(): Promise<void> {
    await this.mcpOps.install()
    await this.skill.install()
  }

  async uninstall(): Promise<void> {
    await this.mcpOps.uninstall()
    await this.skill.uninstall()
  }

  isInstalled(): Promise<boolean> { return this.mcpOps.isInstalled() }

  async isClientPresent(): Promise<boolean> {
    return pathExists(this.configDir)
  }

  readonly skill: BinarySurface = {
    isInstalled: () => pathExists(join(this.skillDir, 'SKILL.md')),
    install: () => writeSkillFile(this.skillDir, 'SKILL.md', SKILL_MD),
    uninstall: () => rm(this.skillDir, { recursive: true, force: true }),
  }

  readonly mcp: BinarySurface = {
    isInstalled: () => this.mcpOps.isInstalled(),
    install: () => this.mcpOps.install(),
    uninstall: () => this.mcpOps.uninstall(),
  }

  /**
   * Init-time flow. Two toggles: skill (defaults Yes — foundational) and MCP
   * server (defaults to current state — `--reinit` keeps it via blind Enter).
   * The skill teaches the AI to use MCP tools when registered, or matching CLI
   * commands when not — same skill, both modes.
   */
  async setupAtInit(ctx: InitContext): Promise<void> {
    try {
      await promptBinaryToggle({
        ctx, surface: this.mcp, flag: `${type}-mcp`,
        promptText: 'Register the opencode MCP server? (Yes; or No to use the mementos CLI from opencode\'s shell tool instead)',
        installedMsg: 'MCP server: registered',
        removedMsg: 'MCP server: removed (CLI + skill mode)',
      })
      await promptBinaryToggle({
        ctx, surface: this.skill, flag: `${type}-skill`,
        promptText: 'Install the opencode skill file? (teaches opencode when/how to use the memory tools)',
        installedMsg: `Skill: installed at ${join(this.skillDir, 'SKILL.md')}`,
        removedMsg: 'Skill: not installed',
        defaultYes: true,
      })
    } catch (e) {
      ctx.print(`Skipped ${this.name}: ${(e as Error).message}`)
    }
  }
}
