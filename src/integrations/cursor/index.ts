/**
 * CursorIntegration — MCP entry in `~/.cursor/mcp.json`. MCP only (Cursor's hook can't
 * inject context; no global skill convention).
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ClientIntegration } from '../interface.js'
import type { IntegrationImplementationModule } from '../registry.js'
import { defaultSetupAtInit } from '../_utils/default-setup.js'
import { standardJsonIntegration } from '../_utils/standard-json-integration.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'cursor'
export function create(): ClientIntegration {
  return standardJsonIntegration('Cursor', () => join(homedir(), '.cursor', 'mcp.json'))
}
export const setupAtInit = defaultSetupAtInit(create)
const _shape: IntegrationImplementationModule = { type, create, setupAtInit }
