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
 *     plugin.json                          (name + version + mcpServers + hooks)
 *     skills/mementos/SKILL.md             (the AI-facing skill, with YAML frontmatter)
 *   ~/.gemini/config/import_manifest.json  (entry so `agy plugin list` shows us)
 *
 * The `BeforeAgent` + `SessionStart` hook events are inherited from the Gemini CLI
 * contract Antigravity carries forward. Hook output is wrapped in the
 * `hookSpecificOutput.additionalContext` envelope by this integration's
 * `output-adapter.ts`, selected via the generic `--output-adapter=gemini-hook`
 * flag — the runtime never names "gemini" in core code.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathExists } from '../../core/_utils/fs.js'
import type { ClientIntegration } from '../interface.js'
import { mcpServerEntry, AUTO_RETRIEVE_COMMAND, SESSION_START_COMMAND } from '../interface.js'
import type { IntegrationImplementationModule } from '../registry.js'
import type { InitContext } from '../../core/init-context/interface.js'
import { promptAutoRetrieveHook, promptHookToggle } from '../_utils/prompt.js'
import { SKILL_MD, writeSkillFile } from '../_utils/skill.js'
import { HookRegistry, jsonHooksAdapter, type HookSpec, type HookConfigAdapter } from '../_utils/hook-registry.js'
import { withInstallShell } from '../_utils/install-shell.js'
import { readJsonConfig, writeJsonConfig } from '../_utils/json-config.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'antigravity-cli'
export function create(): ClientIntegration {
  return new AntigravityCliIntegration()
}
/** Module-level setupAtInit delegates into the class so install helpers can stay private. */
export const setupAtInit = (ctx: InitContext) => new AntigravityCliIntegration().setupAtInit(ctx)
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
  hooks?: Record<string, unknown>
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
   * Init-time flow. Install if not already installed, then prompt for the auto-retrieval
   * hook (default = current state). `--antigravity-cli-hook-auto-retrieve=on|off` skips the prompt.
   */
  async setupAtInit(ctx: InitContext): Promise<void> {
    await withInstallShell(
      { name: this.name, install: () => this.install(), isInstalled: () => this.isInstalled() },
      ctx,
      async () => {
        await promptAutoRetrieveHook(ctx, this, type,
          'Enable Antigravity CLI auto-retrieval hook? (pre-injects memories before every message; costs tokens on trivial turns)')
        await promptHookToggle({
          ctx, flag: `${type}-hook-session-start`, label: 'Session-start hook',
          integration: type, kind: 'session-start',
          current: await this.hooks.isHookEnabled('session-start'),
          promptText: 'Enable Antigravity CLI session-start hook? (loads the curated memory index ONCE at conversation start so you do not have to recall it; cheap.)',
          enable: () => this.hooks.enableHook('session-start'),
          disable: () => this.hooks.disableHook('session-start'),
        })
      },
    )
  }

  /**
   * Write plugin.json with MCP server and our metadata, preserving any existing `hooks`
   * key (so a re-install doesn't wipe a hook the user/AI toggled previously).
   */
  private async writePluginManifest(): Promise<void> {
    const existing = await readJsonConfig<Partial<PluginManifest>>(this.pluginManifestPath, {})
    const manifest: PluginManifest = {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      description: PLUGIN_DESCRIPTION,
      mcpServers: { [PLUGIN_NAME]: mcpServerEntry() },
      ...(existing.hooks ? { hooks: existing.hooks } : {}),
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

  // ─── Hook lifecycle ──────────────────────────────────────────────────────────

  /**
   * Both events inherited from the Gemini CLI hook system Antigravity carries forward:
   *   - `BeforeAgent` fires per user message (the auto-retrieve path).
   *   - `SessionStart` fires once at conversation start / `/clear` / resume — the
   *     intended event for "load initial context" (the memory-index prelude).
   * `--output-adapter=gemini-hook` selects this integration's adapter
   * (`output-adapter.ts`) which wraps stdout in the
   * `hookSpecificOutput.additionalContext` envelope Antigravity reads;
   * `--hook-event=<event>` flows through as the adapter's event-name param.
   */
  private static readonly HOOKS = {
    'auto-retrieve': {
      event: 'BeforeAgent',
      command: `${AUTO_RETRIEVE_COMMAND} --output-adapter=gemini-hook --hook-event=BeforeAgent`,
      baseCommand: AUTO_RETRIEVE_COMMAND,
    },
    'session-start': {
      event: 'SessionStart',
      command: `${SESSION_START_COMMAND} --output-adapter=gemini-hook --hook-event=SessionStart`,
      baseCommand: SESSION_START_COMMAND,
    },
  } as const satisfies Record<string, HookSpec>

  /**
   * HookRegistry edits the `hooks` key of plugin.json directly. The adapter wraps
   * `jsonHooksAdapter` so that a hook toggle on a not-yet-installed integration produces
   * a valid plugin.json (with name/version) rather than a `{ hooks: {…} }` orphan.
   */
  readonly hooks = new HookRegistry(
    AntigravityCliIntegration.HOOKS,
    this.pluginHooksAdapter(),
    this.name,
  )

  private pluginHooksAdapter(): HookConfigAdapter {
    const base = jsonHooksAdapter(
      () => this.pluginManifestPath,
      // The `name` field is the per-hook identifier inside one event's hook array.
      // Derive it from `baseCommand` so the kind ("retrieve" / "session-start") flows
      // through automatically — no per-kind switch to maintain.
      spec => ({ matcher: '*', hooks: [{ name: spec.baseCommand.replace(/\s+/g, '-'), type: 'command', command: spec.command }] }),
    )
    return {
      ...base,
      read: async () => {
        const raw = await base.read()
        if (typeof raw['name'] !== 'string') raw['name'] = PLUGIN_NAME
        if (typeof raw['version'] !== 'string') raw['version'] = PLUGIN_VERSION
        return raw
      },
    }
  }
}
