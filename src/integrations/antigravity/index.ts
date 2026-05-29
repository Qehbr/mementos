/**
 * AntigravityIntegration — MCP entry in `~/.gemini/antigravity/mcp_config.json`.
 * MCP only (no hook system, no skill convention).
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ClientIntegration } from '../interface.js'
import type { IntegrationImplementationModule } from '../registry.js'
import { defaultSetupAtInit } from '../_utils/default-setup.js'
import { standardJsonIntegration } from '../_utils/standard-json-integration.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'antigravity'
export function create(): ClientIntegration {
  return standardJsonIntegration(
    'Antigravity',
    () => join(homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
  )
}
export const setupAtInit = defaultSetupAtInit(create)
const _shape: IntegrationImplementationModule = { type, create, setupAtInit }
