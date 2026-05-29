/**
 * ClaudeDesktopIntegration — MCP entry in `claude_desktop_config.json` (OS-specific path).
 * MCP only (no hook system, no skill file convention). Linux has no Claude Desktop, but the
 * config dir simply won't exist there, so `isClientPresent` returns false on its own.
 */
import { join } from 'node:path'
import { homedir, platform } from 'node:os'
import type { ClientIntegration } from '../interface.js'
import type { IntegrationImplementationModule } from '../registry.js'
import { defaultSetupAtInit } from '../_utils/default-setup.js'
import { standardJsonIntegration } from '../_utils/standard-json-integration.js'

/** OS-specific path to claude_desktop_config.json. */
function configPath(): string {
  switch (platform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    case 'win32':
      return join(process.env['APPDATA'] ?? homedir(), 'Claude', 'claude_desktop_config.json')
    default:
      return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json')
  }
}

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'claude-desktop'
export function create(): ClientIntegration {
  return standardJsonIntegration('Claude Desktop', configPath)
}
export const setupAtInit = defaultSetupAtInit(create)
const _shape: IntegrationImplementationModule = { type, create, setupAtInit }
