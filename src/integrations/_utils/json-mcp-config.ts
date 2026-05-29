import { readJsonConfig, writeJsonConfig } from './json-config.js'
import { pathExists } from '../../core/_utils/fs.js'

/**
 * The shared shape of install/uninstall/isInstalled for the four JSON-config integrations
 * (cursor, antigravity, claude-desktop, opencode). Variation collapses to two parameters:
 * the top-level MCP key in the config (`mcpServers` vs `mcp`) and the entry shape (plain
 * `{command, args}` vs `{type, command, enabled}`).
 */
export interface JsonMcpOps {
  install(): Promise<void>
  uninstall(): Promise<void>
  isInstalled(): Promise<boolean>
}

const SERVER_NAME = 'mementos'

export function jsonMcpConfigOps(opts: {
  /** Lazy so per-integration getters that depend on `platform()` resolve at call time. */
  configPath: () => string
  /** Top-level key the integration's config uses for its MCP server map. */
  mcpKey: string
  /** Build the entry value to register under `mcpKey['mementos']`. */
  entry: () => unknown
}): JsonMcpOps {
  return {
    async install() {
      const config = await readJsonConfig<Record<string, unknown>>(opts.configPath(), {})
      const mcp = (config[opts.mcpKey] as Record<string, unknown>) ?? {}
      mcp[SERVER_NAME] = opts.entry()
      config[opts.mcpKey] = mcp
      await writeJsonConfig(opts.configPath(), config)
    },
    async uninstall() {
      // Never create the config file just to delete an entry from it: uninstalling on a
      // never-installed system would otherwise write a fresh empty config.
      if (!await pathExists(opts.configPath())) return
      const config = await readJsonConfig<Record<string, unknown>>(opts.configPath(), {})
      delete (config[opts.mcpKey] as Record<string, unknown> | undefined)?.[SERVER_NAME]
      await writeJsonConfig(opts.configPath(), config)
    },
    async isInstalled() {
      const config = await readJsonConfig<Record<string, unknown>>(opts.configPath(), {})
      return SERVER_NAME in ((config[opts.mcpKey] as Record<string, unknown>) ?? {})
    },
  }
}
