import type { InitContext } from '../../core/init-context/interface.js'

/**
 * Outer wrap for an integration's setupAtInit: try/isInstalled/install/Configured/Skipped.
 * Threads an optional prompt body through for integrations that prompt after install (the
 * hook-bearing ones); without it, this is the bare shell every other integration uses
 * (see `defaultSetupAtInit`).
 *
 * Takes the three actions explicitly (not a full ClientIntegration) so callers can wire
 * `install` to whatever they actually want installed at init — e.g. claude-code's init
 * registers ONLY the MCP server and prompts for the skill separately.
 */
export async function withInstallShell(
  actions: { name: string; install: () => Promise<void>; isInstalled: () => Promise<boolean> },
  ctx: InitContext,
  doPrompts?: () => Promise<void>,
): Promise<void> {
  try {
    if (await actions.isInstalled()) {
      ctx.print(`${actions.name}: already configured`)
    } else {
      await actions.install()
      ctx.print(`Configured ${actions.name}`)
    }
    if (doPrompts) await doPrompts()
  } catch (e) {
    ctx.print(`Skipped ${actions.name}: ${(e as Error).message}`)
  }
}
