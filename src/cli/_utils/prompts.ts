/**
 * Interactive init prompts (backed by `@inquirer/prompts`) and the shared path validator.
 */
import { select, input } from '@inquirer/prompts'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import type { DiscoveredImpl } from '../../core/discovery.js'
import type { InitContext } from '../../core/init-context/interface.js'

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
  registry: Map<string, DiscoveredImpl<F>>, defaultType: string,
): Promise<string> {
  const choice = await pickChoice(ctx, label, flag, registry, defaultType)
  // Selection-time tip — per-impl trade-off surface (e.g. openai's privacy note,
  // local backend's OS-sync tip). The discovery registry passes the function
  // through if the impl module exports it; otherwise this is a no-op.
  const tip = registry.get(choice)?.describeSelectionTip
  if (typeof tip === 'function') (tip as (c: InitContext) => void)(ctx)
  return choice
}

async function pickChoice<F>(
  ctx: InitContext, label: string, flag: string,
  registry: Map<string, DiscoveredImpl<F>>, defaultType: string,
): Promise<string> {
  const fromFlag = ctx.getFlag(flag)
  if (fromFlag !== undefined && fromFlag !== '') return fromFlag
  // No choice to make: auto-pick the only option and tell the user what we did.
  // Stays correct automatically as impls are added/removed.
  const keys = [...registry.keys()]
  if (keys.length === 1) {
    ctx.print(`${label}: ${keys[0]} (only option)`)
    return keys[0]
  }
  // List the default first and label it `(default)` so the recommended choice is
  // unmistakable — registry iteration order is otherwise arbitrary.
  const ordered = keys.includes(defaultType)
    ? [defaultType, ...keys.filter(k => k !== defaultType)]
    : keys
  return await select({
    message: label,
    choices: ordered.map(k => ({
      name: k === defaultType ? `${k} (default)` : k,
      value: k,
    })),
    default: defaultType,
  })
}

/** Like promptChoice for a filesystem path. Expands `~/` to homedir before validating. */
export async function promptPath(
  ctx: InitContext, label: string, flag: string, defaultPath: string,
): Promise<string> {
  const fromFlag = ctx.getFlag(flag)
  const raw = fromFlag !== undefined && fromFlag !== ''
    ? fromFlag
    : await input({ message: label, default: defaultPath })
  return validatePath(raw)
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
