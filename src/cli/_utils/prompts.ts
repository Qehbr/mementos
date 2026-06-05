/**
 * Interactive init prompts (backed by `@inquirer/prompts`) and the shared path validator.
 */
import { select, input } from '@inquirer/prompts'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import type { DiscoveredImpl } from '../../core/discovery.js'
import type { InitContext } from '../../core/init-context/interface.js'

/**
 * Counts question prompts in an init flow and renders a compact progress-bar
 * prefix the user sees next to every prompt: `[▰▰▱▱▱▱▱▱] 2/8 <label>`. Combines
 * the "X of Y" pattern (machine-readable, accessible to screen readers) with a
 * proportional bar (immediate visual sense of how much is left). 8 cells fits
 * comfortably alongside inquirer's question line on any terminal width.
 *
 * When `total` is 0 the prefix is omitted — useful for subcommands that reuse
 * the prompt helpers without wanting a wizard-style indicator.
 */
export class StepCounter {
  private current = 0
  private static readonly BAR_CELLS = 8
  constructor(private readonly total = 0) {}
  next(label: string): string {
    if (this.total === 0) return label
    this.current++
    return `${this.render()} ${label}`
  }
  private render(): string {
    const filledCells = Math.round((this.current / this.total) * StepCounter.BAR_CELLS)
    const bar = '▰'.repeat(filledCells) + '▱'.repeat(StepCounter.BAR_CELLS - filledCells)
    return `[${bar}] ${this.current}/${this.total}`
  }
}

/** Choice options passed to `promptChoice`. `currentValue` (when set) takes
 *  precedence over `defaultType` as the prompt's default AND is labelled
 *  `(current)` so re-init's "blind Enter keeps it" semantics are clear. */
export interface PromptChoiceOpts {
  /** Hardcoded fallback default used when no `currentValue` is provided. */
  defaultType: string
  /** Existing value (from `--reinit`'s read of MachineConfig). Wins over default. */
  currentValue?: string
}

/**
 * Prompt the user to choose a value from a registry of options, with a default.
 *
 * Backed by `@inquirer/prompts` `select` — arrow-key navigation, no typing required,
 * and invalid input is impossible by construction (the user can only pick from the
 * choice list). Flag overrides (`--<flag>=value`) skip the prompt entirely for CI.
 *
 * Bare flags (`--<flag>` with no value) — semantically "presence only" — fall through
 * to the interactive prompt; they're useful for "I want to be re-asked" but don't
 * supply a value themselves.
 */
export async function promptChoice<F>(
  ctx: InitContext, label: string, flag: string,
  registry: Map<string, DiscoveredImpl<F>>, opts: PromptChoiceOpts | string,
): Promise<string> {
  // Back-compat shorthand: a bare string is treated as `{ defaultType }`.
  const o: PromptChoiceOpts = typeof opts === 'string' ? { defaultType: opts } : opts
  const choice = await pickChoice(ctx, label, flag, registry, o)
  // Selection-time tip — per-impl trade-off surface (e.g. openai's privacy note,
  // local backend's OS-sync tip). The discovery registry passes the function
  // through if the impl module exports it; otherwise this is a no-op.
  const tip = registry.get(choice)?.describeSelectionTip
  if (typeof tip === 'function') (tip as (c: InitContext) => void)(ctx)
  return choice
}

async function pickChoice<F>(
  ctx: InitContext, label: string, flag: string,
  registry: Map<string, DiscoveredImpl<F>>, opts: PromptChoiceOpts,
): Promise<string> {
  const fromFlag = ctx.getFlag(flag)
  if (fromFlag !== undefined && fromFlag !== '') return fromFlag
  // No choice to make: auto-pick the only option and tell the user what we did.
  // Stays correct automatically as impls are added/removed. The leading `✔` mimics
  // inquirer's completed-prompt marker so this line lines up with the surrounding
  // prompts visually (otherwise it stands out as missing a checkmark).
  const keys = [...registry.keys()]
  if (keys.length === 1) {
    ctx.print(`✔ ${label}: ${keys[0]} (only option)`)
    return keys[0]
  }
  // currentValue (the user's existing setting on --reinit) takes precedence over
  // the hardcoded default. When present, the chosen entry is labelled `(current)`;
  // otherwise the original `(default)` framing applies. Same prompt code path —
  // just different label text and a different head-of-list value.
  const headValue = opts.currentValue && keys.includes(opts.currentValue)
    ? opts.currentValue
    : opts.defaultType
  const headTag = opts.currentValue && opts.currentValue === headValue ? '(current)' : '(default)'
  const ordered = keys.includes(headValue)
    ? [headValue, ...keys.filter(k => k !== headValue)]
    : keys
  return await select({
    message: label,
    choices: ordered.map(k => ({
      name: k === headValue ? `${k} ${headTag}` : k,
      value: k,
    })),
    default: headValue,
  })
}

/** Like promptChoice for a filesystem path. Expands `~/` to homedir before validating.
 *  When `currentValue` is supplied (re-init), it pre-fills the input AND the label is
 *  annotated `(current)` so blind Enter keeps the existing path. */
export async function promptPath(
  ctx: InitContext, label: string, flag: string, defaultPath: string, currentValue?: string,
): Promise<string> {
  const fromFlag = ctx.getFlag(flag)
  if (fromFlag !== undefined && fromFlag !== '') return validatePath(fromFlag)
  const seed = currentValue ?? defaultPath
  const renderedLabel = currentValue ? `${label} (current)` : label
  return validatePath(await input({ message: renderedLabel, default: seed }))
}

/** Expand `~/` and sanity-check the result. Exported for unit tests. */
export function validatePath(raw: string): string {
  let expanded = raw
  if (expanded === '~') expanded = homedir()
  else if (expanded.startsWith('~/')) expanded = join(homedir(), expanded.slice(2))
  if (expanded.includes('\0')) throw new Error(`Path contains null byte: ${JSON.stringify(raw)}`)
  if (!isAbsolute(expanded)) throw new Error(`Path must be absolute (got ${JSON.stringify(raw)}).`)
  return expanded
}
