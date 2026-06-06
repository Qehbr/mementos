/**
 * AntigravityCliIntegration — installs mementos as an Antigravity plugin.
 *
 * Antigravity CLI (`agy`, the I/O 2026 successor to Gemini CLI) uses a plugin model:
 * each plugin lives at `~/.gemini/config/plugins/<name>/` and is tracked by
 * `~/.gemini/config/import_manifest.json`. A plugin is one `plugin.json` manifest plus
 * optional `skills/`, `agents/`, `commands/` subdirectories; MCP servers and hooks live
 * as keys INSIDE plugin.json. Our integration writes:
 *
 *   ~/.gemini/config/plugins/mementos/
 *     plugin.json                          (name + version + mcpServers)
 *     skills/mementos/SKILL.md             (the AI-facing skill, with YAML frontmatter)
 *   ~/.gemini/config/import_manifest.json  (entry so `agy plugin list` shows us)
 *
 * No hooks: Antigravity has no session-lifecycle event (only Pre/PostInvocation /
 * Pre/PostToolUse / Stop — verified by inspecting the agy 1.0.2 binary), and we dropped
 * the per-prompt auto-retrieve hook everywhere because it injected noise and ate tokens.
 * Users get the MCP server + the skill — the AI calls `recall()` explicitly when context
 * is needed, guided by the skill body.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathExists } from '../../core/_utils/fs.js'
import type { ClientIntegration } from '../interface.js'
import { mcpServerEntry } from '../interface.js'
import type { IntegrationImplementationModule } from '../registry.js'
import { defaultSetupAtInit } from '../_utils/default-setup.js'
import { SKILL_MD, writeSkillFile } from '../_utils/skill.js'
import { readJsonConfig, writeJsonConfig } from '../_utils/json-config.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'antigravity-cli'
export function create(): ClientIntegration {
  return new AntigravityCliIntegration()
}
export const setupAtInit = defaultSetupAtInit(create)
const _shape: IntegrationImplementationModule = { type, create, setupAtInit }

interface ImportManifestEntry {
  name: string
  source?: string
  importedAt?: string
  components?: string[]
}
interface ImportManifest {
  imports?: ImportManifestEntry[]
}

interface PluginManifest {
  name: string
  version: string
  description?: string
  mcpServers?: Record<string, unknown>
}

const PLUGIN_NAME = 'mementos'
const PLUGIN_VERSION = '0.1.0'
const PLUGIN_DESCRIPTION = 'Encrypted personal memory vault — recall past context and store durable facts.'

export class AntigravityCliIntegration implements ClientIntegration {
  readonly name = 'Antigravity CLI'

  /** Antigravity CLI's parent config dir; persisted state lives under `config/` below. */
  private get geminiDir(): string {
    return join(homedir(), '.gemini')
  }

  /** Where our plugin's files live. `agy plugin uninstall mementos` would also clear this. */
  private get pluginDir(): string {
    return join(this.geminiDir, 'config', 'plugins', PLUGIN_NAME)
  }

  private get pluginManifestPath(): string {
    return join(this.pluginDir, 'plugin.json')
  }

  /** The CLI loads our skill from `skills/<plugin>/<skill>/SKILL.md`. */
  private get skillDir(): string {
    return join(this.pluginDir, 'skills', PLUGIN_NAME)
  }

  /** The tracker `agy plugin list` reads; a plugin not listed here is invisible to it. */
  private get importManifestPath(): string {
    return join(this.geminiDir, 'config', 'import_manifest.json')
  }

  /** Install bundle: plugin manifest + skill file + import-manifest entry. Idempotent. */
  async install(): Promise<void> {
    await this.writePluginManifest()
    await writeSkillFile(this.skillDir, 'SKILL.md', SKILL_MD)
    await this.addToImportManifest()
  }

  /** Remove the plugin directory and the import-manifest entry. Idempotent. */
  async uninstall(): Promise<void> {
    await rm(this.pluginDir, { recursive: true, force: true })
    await this.removeFromImportManifest()
  }

  /** Whether our plugin.json is on disk — what `agy plugin list` ultimately reflects. */
  async isInstalled(): Promise<boolean> {
    return pathExists(this.pluginManifestPath)
  }

  async isClientPresent(): Promise<boolean> {
    return pathExists(this.geminiDir)
  }

  /**
   * Write plugin.json with the MCP server entry and our metadata. Reads the
   * existing file first so a malformed JSON (typo, partial write) fails loud
   * instead of being silently overwritten — same defensive posture as every
   * other config-touching path.
   */
  private async writePluginManifest(): Promise<void> {
    await readJsonConfig<Partial<PluginManifest>>(this.pluginManifestPath, {})
    const manifest: PluginManifest = {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      description: PLUGIN_DESCRIPTION,
      mcpServers: { [PLUGIN_NAME]: mcpServerEntry() },
    }
    await writeJsonConfig(this.pluginManifestPath, manifest)
  }

  /**
   * Add an entry to import_manifest.json so `agy plugin list` reports our plugin. Preserves
   * every other plugin entry — a user may have imported others via `agy plugin install`.
   */
  private async addToImportManifest(): Promise<void> {
    const manifest = await readJsonConfig<ImportManifest>(this.importManifestPath, {})
    const imports = manifest.imports ?? []
    if (!imports.some(e => e.name === PLUGIN_NAME)) {
      imports.push({
        name: PLUGIN_NAME,
        source: 'mementos-init',
        importedAt: new Date().toISOString(),
        components: ['installed'],
      })
    }
    await writeJsonConfig(this.importManifestPath, { ...manifest, imports })
  }

  private async removeFromImportManifest(): Promise<void> {
    if (!await pathExists(this.importManifestPath)) return
    const manifest = await readJsonConfig<ImportManifest>(this.importManifestPath, {})
    const imports = (manifest.imports ?? []).filter(e => e.name !== PLUGIN_NAME)
    await writeJsonConfig(this.importManifestPath, { ...manifest, imports })
  }
}
