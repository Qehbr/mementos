/**
 * Shared yes/no resolver for integration init prompts.
 *
 * `--<flag>=on|off` overrides the prompt entirely (non-interactive init — CI, scripted
 * setup); otherwise it falls through to inquirer's `confirm` (single keypress, no
 * free-text parser to mis-read). inquirer rather than readline because the init flow has
 * already used inquirer for the top-level prompts — mixing readline with stdin-in-raw-mode
 * hangs the process.
 */
import { confirm } from '@inquirer/prompts'
import { promptTheme } from '../../cli/_utils/style.js'
import type { InitContext } from '../../core/init-context/interface.js'
import type { StepCounter } from '../../cli/_utils/prompts.js'

export async function resolveYesNo(
  ctx: InitContext, flag: string, defaultYes: boolean, message: string,
): Promise<boolean> {
  const f = ctx.getFlag(flag)
  if (f === 'on') return true
  if (f === 'off') return false
  return confirm({ message, default: defaultYes, theme: promptTheme })
}

/**
 * Generic binary-toggle prompt — drives any `BinarySurface` field on an
 * integration (skill, MCP server, …). Same shape as `promptHookToggle` but
 * single-resource instead of kind-keyed.
 *
 * `--<flag>=on|off` skips the prompt for scripted setup. `defaultYes` overrides
 * the prompt's default Yes/No regardless of `current` — use for foundational
 * pieces like the skill that we want on by default for new installs.
 * `current` (omitted = read from surface) drives the default when `defaultYes`
 * isn't set, so blind Enter keeps a user's existing choice on `--reinit`.
 *
 * The action is ALWAYS invoked (both install + uninstall are required to be
 * idempotent) — integrations may need a side-effect even when the abstract
 * "installed" state already matches (e.g. Antigravity's plugin.json carries
 * name/version metadata alongside the MCP entry, so a fresh MCP-off install
 * still needs the file written).
 */
/**
 * Standard pair of installed/removed messages for a hook toggle — keeps the
 * "Disable later with: mementos integration hook ..." phrasing consistent
 * across every hook-having integration. Pass the result's `installedMsg` /
 * `removedMsg` straight into `promptBinaryToggle`.
 *
 *   const msgs = hookToggleMessages('Session-start hook', 'claude-code', 'session-start')
 *   await promptBinaryToggle({ ..., installedMsg: msgs.installedMsg, removedMsg: msgs.removedMsg })
 */
export function hookToggleMessages(
  label: string, integration: string, kind: string,
): { installedMsg: string; removedMsg: string } {
  const suffix = ` --type=${kind}`
  return {
    installedMsg: `${label} on. Disable later with: mementos integration hook disable ${integration}${suffix}`,
    removedMsg: `${label} off. Enable later with: mementos integration hook enable ${integration}${suffix}`,
  }
}

/**
 * Standard MCP-server toggle prompt — every hook/MCP-having integration uses
 * the same wording for "Register the X MCP server?", differing only in the
 * client's full name (`clientName`, e.g. `'Claude Code'`), the short
 * possessive form used in the prompt (`agentName`, e.g. `'Claude'`), and the
 * shell-like tool name that integration exposes (`toolWord`, e.g.
 * `'Bash tool'` or `'shell tool'`). `installedMsg` / `removedMsg` are fixed.
 *
 * Returns the `{flag, promptText, installedMsg, removedMsg}` bag to spread
 * straight into `promptBinaryToggle`:
 *
 *   await promptBinaryToggle({
 *     ctx, surface: this.mcp,
 *     ...mcpToggleOptions({ integrationType: type, clientName: 'Codex',
 *                           agentName: 'Codex', toolWord: 'shell tool' }),
 *   })
 *
 * Same precedent as `hookToggleMessages` — one home for the rule so the next
 * rephrasing lands in one place instead of 4 integrations.
 */
export function mcpToggleOptions(opts: {
  integrationType: string
  clientName: string
  agentName: string
  toolWord: string
}): { flag: string; promptText: string; installedMsg: string; removedMsg: string } {
  return {
    flag: `${opts.integrationType}-mcp`,
    promptText: `Register the ${opts.clientName} MCP server? (Yes; or No to use the mementos CLI from ${opts.agentName}'s ${opts.toolWord} instead)`,
    installedMsg: 'MCP server: registered',
    removedMsg: 'MCP server: removed (CLI + skill mode)',
  }
}

/**
 * Standard skill-file toggle prompt — sibling to `mcpToggleOptions` for the
 * "Install the X skill file?" prompt. `clientName` names the client for the
 * prompt ("Install the X skill file?"); `agentName` names what the skill is
 * teaching ("teaches X when/how"); `skillPath` is the on-disk path to mention
 * in the success message. `defaultYes: true` — the skill is foundational, so
 * blind Enter installs it.
 */
export function skillToggleOptions(opts: {
  integrationType: string
  clientName: string
  agentName: string
  skillPath: string
}): { flag: string; promptText: string; installedMsg: string; removedMsg: string; defaultYes: true } {
  return {
    flag: `${opts.integrationType}-skill`,
    promptText: `Install the ${opts.clientName} skill file? (teaches ${opts.agentName} when/how to use the memory tools)`,
    installedMsg: `Skill: installed at ${opts.skillPath}`,
    removedMsg: 'Skill: not installed',
    defaultYes: true,
  }
}

export async function promptBinaryToggle(opts: {
  ctx: InitContext
  surface: import('../interface.js').BinarySurface
  /** CLI flag suffix for scripted setup — e.g. `'claude-code-mcp'`. */
  flag: string
  /** Client-facing prompt sentence (e.g. "Register the Claude Code MCP server?"). */
  promptText: string
  /** Message printed when the component ends up installed (in past tense). */
  installedMsg: string
  /** Message printed when the component ends up removed. */
  removedMsg: string
  /** Per-integration step counter for the `[bar] N/M` prefix. */
  steps?: StepCounter
  /** Force the default Yes for foundational components (skill); omit to track `current`. */
  defaultYes?: boolean
}): Promise<void> {
  const installed = await opts.surface.isInstalled()
  const promptText = opts.steps ? opts.steps.next(opts.promptText) : opts.promptText
  const want = await resolveYesNo(opts.ctx, opts.flag, opts.defaultYes ?? installed, promptText)
  if (want) {
    await opts.surface.install()
    opts.ctx.print(opts.installedMsg)
  } else {
    await opts.surface.uninstall()
    opts.ctx.print(opts.removedMsg)
  }
}
