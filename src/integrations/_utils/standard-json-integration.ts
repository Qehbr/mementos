import { dirname } from 'node:path'
import type { ClientIntegration } from '../interface.js'
import { mcpServerEntry } from '../interface.js'
import { jsonMcpConfigOps } from './json-mcp-config.js'
import { pathExists } from '../../core/_utils/fs.js'

/**
 * A ClientIntegration that only writes the standard MCP-server entry into one JSON config
 * file — no hooks, no skill. `configPath` is lazy so OS-specific paths resolve at call
 * time; the client counts as present iff that config's parent directory exists.
 */
export function standardJsonIntegration(name: string, configPath: () => string): ClientIntegration {
  const mcp = jsonMcpConfigOps({ configPath, mcpKey: 'mcpServers', entry: mcpServerEntry })
  return {
    name,
    install: () => mcp.install(),
    uninstall: () => mcp.uninstall(),
    isInstalled: () => mcp.isInstalled(),
    isClientPresent: () => pathExists(dirname(configPath())),
  }
}
