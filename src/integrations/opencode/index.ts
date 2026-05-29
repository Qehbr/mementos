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
import type { ClientIntegration } from '../interface.js'
import { MCP_SERVER_COMMAND } from '../interface.js'
import type { IntegrationImplementationModule } from '../registry.js'
import { SKILL_MD, writeSkillFile } from '../_utils/skill.js'
import { defaultSetupAtInit } from '../_utils/default-setup.js'
import { jsonMcpConfigOps } from '../_utils/json-mcp-config.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'opencode'
export function create(): ClientIntegration {
  return new OpenCodeIntegration()
}
export const setupAtInit = defaultSetupAtInit(create)
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

  private readonly mcp = jsonMcpConfigOps({
    configPath: () => this.configPath,
    mcpKey: 'mcp',
    entry: () => ({ type: 'local', command: [...MCP_SERVER_COMMAND], enabled: true }),
  })

  async install(): Promise<void> {
    await this.mcp.install()
    await writeSkillFile(this.skillDir, 'SKILL.md', SKILL_MD)
  }

  async uninstall(): Promise<void> {
    await this.mcp.uninstall()
    await rm(this.skillDir, { recursive: true, force: true })
  }

  isInstalled(): Promise<boolean> { return this.mcp.isInstalled() }

  async isClientPresent(): Promise<boolean> {
    return pathExists(this.configDir)
  }
}
