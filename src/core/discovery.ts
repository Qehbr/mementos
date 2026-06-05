/**
 * Generic implementation discovery — scan a directory at runtime, dynamic-import every
 * `<name>/index.js`, build a `Map<type, factory>` from modules that export the right shape.
 *
 * The contract for being discoverable:
 *
 *     // src/<abstraction>/<name>/index.ts
 *     export const type = 'name'                        // unique identifier within the abstraction
 *     export function create(...): T { ... }            // factory; signature is per-abstraction
 *     export async function setupAtInit?(ctx): void     // optional first-run setup
 *
 * Anything missing `type` or `create` is silently skipped — that lets shared utility
 * folders (like `_utils/derivation/`) coexist with implementations without special-casing.
 *
 * Folders whose name starts with `_` are skipped unconditionally. This is the convention
 * for internal utilities that should never be discovered as implementations.
 *
 * Adding a new implementation = drop a folder, run the program. No registry edits, no
 * core/types.ts edits, no CLI edits.
 */
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { InitContext } from './init-context/interface.js'

/**
 * The shape an implementation's `index.ts` exports to be discoverable. Each abstraction's
 * registry aliases this with its own factory type (`ImplementationModule<StorageFactory>`,
 * etc.) and a `const _shape: …` annotation in the implementation then catches contract
 * drift — a renamed or wrongly-typed export — at compile time.
 */
export interface ImplementationModule<F> {
  type: string
  create: F
  setupAtInit?: (ctx: InitContext) => Promise<void>
  /**
   * Optional one-shot text fired IMMEDIATELY after the user picks this
   * implementation in the init prompt — for surfacing trade-offs at the moment
   * of decision (e.g. the openai embedder's privacy implications, the local
   * storage backend's cloud-sync tip). Distinct from `setupAtInit` (which runs
   * later, after all selections, and does actual setup work). Sync `void` —
   * just emit lines via `ctx.print`; no I/O.
   */
  describeSelectionTip?: (ctx: InitContext) => void
}

/** Result row for `discoverImplementations` — paired type-string and factory function. */
export interface DiscoveredImpl<F> {
  type: string
  create: F
  /**
   * Optional first-run setup. Called by the CLI's init flow when this implementation is
   * the chosen one for its abstraction. Signature: `(ctx: InitContext) => Promise<void>`.
   * Kept as `unknown` here because each abstraction has its own ctx shape and we don't
   * want this generic utility coupled to any one of them.
   */
  setupAtInit?: unknown
  /** Optional selection-time tip. Signature `(ctx: InitContext) => void`. */
  describeSelectionTip?: unknown
}

/**
 * Scan the directory of the file that called this function (via `import.meta.url`),
 * dynamic-import every `<name>/index.js`, and return a map of `type` → factory for any
 * module that exports both `type` (string) and `create` (function).
 *
 * @param callerUrl - Pass `import.meta.url` from the registry file inside the abstraction.
 *                    The directory of THIS file is what gets scanned.
 */
export async function discoverImplementations<F>(
  callerUrl: string,
): Promise<Map<string, DiscoveredImpl<F>>> {
  const here = dirname(fileURLToPath(callerUrl))
  const entries = await readdir(here, { withFileTypes: true }).catch(() => [])
  const registry = new Map<string, DiscoveredImpl<F>>()

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // Convention: leading underscore = internal/utility, never a discoverable implementation.
    if (entry.name.startsWith('_')) continue

    // Use an absolute file:// URL so the dynamic import resolves to the implementation's
    // index.js — NOT relative to this file, which is the surprising default behaviour for
    // dynamic `import('./...')` and would silently miss every implementation.
    const implUrl = pathToFileURL(join(here, entry.name, 'index.js')).href

    // Import failure here is "impl exists but module-level code threw" (syntax error,
    // missing dep, top-level await failure) — never "impl chose not to register". A silent
    // skip would hide the real problem behind an unhelpful "Unknown backend" downstream.
    // Implementations that need optional deps must lazy-import inside `create()`, not at
    // module top level (every shipped impl already does).
    const mod = await import(implUrl) as Record<string, unknown>

    if (typeof mod.type !== 'string' || typeof mod.create !== 'function') continue

    registry.set(mod.type, {
      type: mod.type,
      create: mod.create as F,
      setupAtInit: typeof mod.setupAtInit === 'function' ? mod.setupAtInit : undefined,
      describeSelectionTip: typeof mod.describeSelectionTip === 'function' ? mod.describeSelectionTip : undefined,
    })
  }

  return registry
}
