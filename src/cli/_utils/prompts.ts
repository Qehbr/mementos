/**
 * Interactive init prompts (backed by `@inquirer/prompts`) and the shared path validator.
 */
import { select, input } from '@inquirer/prompts'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import type { DiscoveredImpl } from '../../core/discovery.js'
import type { InitContext } from '../../core/init-context/interface.js'
import { accent, accentBold, dim, promptTheme } from './style.js'

/** Sentinel returned by `promptChoiceWithBack` when the user picked the
 *  `← back` option. The caller (a state-machine flow) sees this and rewinds
 *  one step instead of recording an answer. Distinct from any real choice
 *  because it's a symbol. */
export const BACK = Symbol('wizard.back')
export type BackOr<T> = T | typeof BACK

/**
 * Per-integration question counter. Renders `[▰▰▱▱] N/M` inline as a prefix
 * to the prompt label. Used inside an integration's setupAtInit to track
 * questions specific to that integration (e.g. Claude Code's 3 hook toggles).
 *
 * When `total === 0` the prefix is omitted — useful for subcommands that
 * reuse the prompt utilities without wanting a counter.
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

/**
 * Global wizard header — renders a title-bar line BEFORE each prompt, with
 * the title left-aligned and the progress bar right-aligned across the
 * terminal width. Used for the top-level `mementos init` flow.
 *
 *     ▸ mementos init                                  ████████░░░░░░░░ 3/8
 *     ? Embedder: …
 *
 * The bar reflects `step - 1` complete (what's actually DONE) — when you're
 * about to answer step N, only N-1 steps are committed. So step 1 paints an
 * empty bar (`0/8`), step 8 paints `7/8`, and you never see `8/8` because the
 * wizard exits after the last answer.
 *
 * Stateless — caller (the state-machine flow) owns the cursor and passes it
 * to `show()` before each prompt. When `total === 1` the bar is omitted (a
 * one-step flow has no meaningful progress to display); just the title prints.
 */
export class WizardHeader {
  private static readonly BAR_CELLS = 16
  constructor(private readonly title: string, private readonly total: number) {}

  /** Print the header line for step `step` of `this.total`. */
  show(step: number, print: (msg: string) => void): void {
    print('')
    if (this.total <= 1) {
      print(accentBold(`▸ ${this.title}`))
      return
    }
    const completed = Math.max(0, step - 1)
    const cols = process.stdout.columns || 80
    const left = accentBold(`▸ ${this.title}`)
    const filledCells = Math.round((completed / this.total) * WizardHeader.BAR_CELLS)
    const bar = accent('█'.repeat(filledCells)) + dim('░'.repeat(WizardHeader.BAR_CELLS - filledCells))
    const ratio = dim(` ${completed}/${this.total}`)
    const leftLen = `▸ ${this.title}`.length
    const rightLen = WizardHeader.BAR_CELLS + ` ${completed}/${this.total}`.length
    const gap = Math.max(2, cols - leftLen - rightLen)
    print(`${left}${' '.repeat(gap)}${bar}${ratio}`)
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
  /** Optional one-line dim subtitle rendered between the bold question and
   *  the choices. Use to disambiguate when the question alone is too terse
   *  (e.g. "Embedder" → "Converts memento text into vectors..."). */
  hint?: string
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
  const o: PromptChoiceOpts = typeof opts === 'string' ? { defaultType: opts } : opts
  const choice = await pickChoice(ctx, label, flag, registry, o, false)
  if (choice === BACK) throw new Error('Internal: promptChoice returned BACK without allowBack')
  const tip = registry.get(choice)?.describeSelectionTip
  if (typeof tip === 'function') (tip as (c: InitContext) => void)(ctx)
  return choice
}

/**
 * Variant of `promptChoice` that adds a `← back` row at the bottom. Selecting
 * it returns the BACK sentinel instead of a value, letting the caller's
 * state-machine flow rewind to the previous step. Used by `runInitNew` /
 * `runInitJoin`; standalone prompts (migrate, etc.) use `promptChoice`.
 */
export async function promptChoiceWithBack<F>(
  ctx: InitContext, label: string, flag: string,
  registry: Map<string, DiscoveredImpl<F>>, opts: PromptChoiceOpts | string,
): Promise<BackOr<string>> {
  const o: PromptChoiceOpts = typeof opts === 'string' ? { defaultType: opts } : opts
  const choice = await pickChoice(ctx, label, flag, registry, o, true)
  if (choice === BACK) return BACK
  const tip = registry.get(choice)?.describeSelectionTip
  if (typeof tip === 'function') (tip as (c: InitContext) => void)(ctx)
  return choice
}

const BACK_SENTINEL = '__back__'

async function pickChoice<F>(
  ctx: InitContext, label: string, flag: string,
  registry: Map<string, DiscoveredImpl<F>>, opts: PromptChoiceOpts, allowBack: boolean,
): Promise<BackOr<string>> {
  const fromFlag = ctx.getFlag(flag)
  if (fromFlag !== undefined && fromFlag !== '') return fromFlag
  const keys = [...registry.keys()]
  // No auto-skip when there's only one option — always prompt so the user
  // sees what's being chosen and can confirm explicitly.
  const headValue = opts.currentValue && keys.includes(opts.currentValue)
    ? opts.currentValue
    : opts.defaultType
  const headTag = opts.currentValue && opts.currentValue === headValue ? '(current)' : '(default)'
  const ordered = keys.includes(headValue)
    ? [headValue, ...keys.filter(k => k !== headValue)]
    : keys
  const choices = ordered.map(k => ({
    name: k === headValue ? `${k} ${dim(headTag)}` : k,
    value: k,
  }))
  if (allowBack) {
    choices.push({ name: dim('← back'), value: BACK_SENTINEL })
  }
  // Embed the optional hint as a second, dim line of the inquirer message —
  // sits between the bold question and the choices. `promptTheme.style.message`
  // bolds only the first line so the hint stays unbolded.
  const message = opts.hint ? `${label}\n${dim(`  ${opts.hint}`)}` : label
  const result = await select({
    message,
    choices,
    default: headValue,
    theme: promptTheme,
  })
  return result === BACK_SENTINEL ? BACK : result
}

/** Like promptChoice for a filesystem path. Expands `~/` to homedir before validating.
 *  When `currentValue` is supplied (re-init), it pre-fills the input AND the label is
 *  annotated `(current)` so blind Enter keeps the existing path.
 *
 *  No back option here — `input` is single-line text and a `← back` row would
 *  collide with normal editing. Users go back from the NEXT step. */
export async function promptPath(
  ctx: InitContext, label: string, flag: string, defaultPath: string, currentValue?: string,
): Promise<string> {
  const fromFlag = ctx.getFlag(flag)
  if (fromFlag !== undefined && fromFlag !== '') return validatePath(fromFlag)
  const seed = currentValue ?? defaultPath
  const renderedLabel = currentValue ? `${label} ${dim('(current)')}` : label
  return validatePath(await input({ message: renderedLabel, default: seed, theme: promptTheme }))
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
