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
import type { InitContext } from '../../core/init-context/interface.js'
import type { HookSurface } from '../interface.js'
import type { StepCounter } from '../../cli/_utils/prompts.js'

export async function resolveYesNo(
  ctx: InitContext, flag: string, defaultYes: boolean, message: string,
): Promise<boolean> {
  const f = ctx.getFlag(flag)
  if (f === 'on') return true
  if (f === 'off') return false
  return confirm({ message, default: defaultYes })
}

/**
 * Standard hook-toggle prompt: resolve yes/no, apply, then print a consistent "Disable
 * later with: mementos integration hook ..." follow-up. Locks the user-facing phrasing
 * to one place across every hook-having integration.
 */
export async function promptHookToggle(opts: {
  ctx: InitContext
  flag: string
  /** Sentence-case label that opens the printed status (e.g. "Auto-retrieval hook"). */
  label: string
  /** Integration name as it appears in the `mementos integration hook (en|dis)able <X>` command. */
  integration: string
  /** Hook kind for the `--type=K` suffix on the follow-up command; omitted = no suffix. */
  kind?: string
  current: boolean
  /**
   * Override the prompt's default Yes/No regardless of `current`. Use for hooks
   * we want enabled by default for new installs (e.g. session-start, which is
   * cheap and high-value). When omitted, the default tracks `current` — i.e.
   * blind-Enter keeps the user's existing choice on re-init.
   */
  defaultYes?: boolean
  /**
   * Optional per-integration step counter — prefixes the prompt with
   * `[▰▰▱▱] N/M` so the user sees where they are inside ONE integration's
   * questions. Distinct from the global init step counter and the per-loop
   * integration counter (each tracks a different scope).
   */
  steps?: StepCounter
  promptText: string
  enable: () => Promise<void>
  disable: () => Promise<void>
}): Promise<void> {
  const promptText = opts.steps ? opts.steps.next(opts.promptText) : opts.promptText
  const want = await resolveYesNo(opts.ctx, opts.flag, opts.defaultYes ?? opts.current, promptText)
  const suffix = opts.kind ? ` --type=${opts.kind}` : ''
  if (want) {
    await opts.enable()
    opts.ctx.print(`${opts.label} on. Disable later with: mementos integration hook disable ${opts.integration}${suffix}`)
  } else {
    await opts.disable()
    opts.ctx.print(`${opts.label} off. Enable later with: mementos integration hook enable ${opts.integration}${suffix}`)
  }
}

/**
 * The auto-retrieval hook toggle — keyed `auto-retrieve`, flagged `<type>-hook-auto-retrieve`,
 * labelled "Auto-retrieval hook". Shared by every integration that wires the hook; only the
 * prompt sentence varies. (`integration` = `type` here; the kind suffix is intentionally
 * omitted since `auto-retrieve` is the only hook these integrations carry.)
 */
export async function promptAutoRetrieveHook(
  ctx: InitContext,
  self: { hooks: HookSurface },
  type: string,
  promptText: string,
  steps?: StepCounter,
): Promise<void> {
  await promptHookToggle({
    ctx,
    flag: `${type}-hook-auto-retrieve`,
    label: 'Auto-retrieval hook',
    integration: type,
    current: await self.hooks.isHookEnabled('auto-retrieve'),
    steps,
    promptText,
    enable: () => self.hooks.enableHook('auto-retrieve'),
    disable: () => self.hooks.disableHook('auto-retrieve'),
  })
}
