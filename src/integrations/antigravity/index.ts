/**
 * AntigravityIntegration — MCP entry in `~/.gemini/config/mcp_config.json`,
 * the central MCP config file shared by Antigravity 2.0, IDE, and CLI (per
 * https://antigravity.google/docs/mcp + Google Cloud Community 2026 docs).
 * MCP only here (no hook system, no skill convention — those live in the
 * `antigravity-cli` plugin-model integration).
 *
 * The pre-1.0.2 integration wrote to `~/.gemini/antigravity/mcp_config.json`
 * which Antigravity does not read — our MCP server was registered but
 * invisible to the IDE/web client. Fixed.
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
    () => join(homedir(), '.gemini', 'config', 'mcp_config.json'),
  )
}
export const setupAtInit = defaultSetupAtInit(create)
const _shape: IntegrationImplementationModule = { type, create, setupAtInit }
