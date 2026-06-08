/**
 * OpenClawIntegration — wires mementos into OpenClaw (github.com/openclaw/openclaw),
 * the open-source personal AI agent.
 *
 * OpenClaw is an MCP client: it keeps an MCP-server registry under `mcp.servers` in its
 * config, and its embedded agent runtimes consume those definitions. We register mementos
 * there using OpenClaw's own CLI (`openclaw mcp set` / `unset`) rather than editing
 * `~/.openclaw/openclaw.json` ourselves — the CLI owns the config schema and normalises
 * transport shapes, so this survives schema drift between versions.
 *
 * We also drop a skill at `<state>/workspace/skills/mementos/SKILL.md` — OpenClaw loads
 * SKILL.md-based skills from the workspace; it teaches the agent when and how to use the
 * memory tools.
 *
 * No hook: OpenClaw's hooks are TypeScript handler modules run inside its Gateway, not
 * shell commands — a different contract from Claude Code's. AI-driven retrieval via the
 * MCP tools, guided by the skill, is the mechanism here.
 *
 * The MCP entry carries no secrets — the daemon reads the vault key from the OS
 * keychain at startup.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'
import { pathExists } from '../../core/_utils/fs.js'
import type { ClientIntegration } from '../interface.js'
import { mcpServerEntry } from '../interface.js'
import type { IntegrationImplementationModule } from '../registry.js'
import { writeSkill } from '../_utils/skill.js'
import { defaultSetupAtInit } from '../_utils/default-setup.js'
import { cliRunner, probeCli } from '../_utils/cli-runner.js'

const openclaw = cliRunner('openclaw')

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'openclaw'
export function create(): ClientIntegration {
  return new OpenClawIntegration()
}
export const setupAtInit = defaultSetupAtInit(create)
const _shape: IntegrationImplementationModule = { type, create, setupAtInit }


export class OpenClawIntegration implements ClientIntegration {
  readonly name = 'OpenClaw'

  /** OpenClaw's per-user state directory; overridable via `$OPENCLAW_STATE_DIR`. */
  private get stateDir(): string {
    return process.env['OPENCLAW_STATE_DIR'] ?? join(homedir(), '.openclaw')
  }

  /** Skill directory — OpenClaw loads `<state>/workspace/skills/<name>/SKILL.md`. */
  private get skillDir(): string {
    return join(this.stateDir, 'workspace', 'skills', 'mementos')
  }

  /** Install bundle: MCP server registration + skill file. Idempotent. */
  async install(): Promise<void> {
    await this.installMcpServer()
    await this.installSkill()
  }

  /** Remove both artifacts. Idempotent — tolerates an already-absent server / skill. */
  async uninstall(): Promise<void> {
    // `openclaw mcp unset` errors if the server isn't registered — tolerate that.
    await openclaw(['mcp', 'unset', 'mementos']).catch(() => { /* not registered — fine */ })
    await rm(this.skillDir, { recursive: true, force: true })
  }

  /** Whether OpenClaw currently has a mementos MCP server registered. */
  async isInstalled(): Promise<boolean> {
    return probeCli(() => openclaw(['mcp', 'show', 'mementos']))
  }

  async isClientPresent(): Promise<boolean> {
    return pathExists(this.stateDir)
  }

  /**
   * Register the MCP server via `openclaw mcp set`. OpenClaw stores the definition under
   * `mcp.servers`; its embedded agent runtimes pick it up. `set` overwrites an existing
   * definition of the same name, so this is idempotent.
   */
  private async installMcpServer(): Promise<void> {
    await openclaw(['mcp', 'set', 'mementos', JSON.stringify(mcpServerEntry())])
  }

  private async installSkill(): Promise<void> {
    await writeSkill(this.skillDir)
  }
}
