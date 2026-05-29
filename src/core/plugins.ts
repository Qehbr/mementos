/**
 * On-demand package installer for optional dependencies.
 *
 * mementos ships without native/heavyweight optional dependencies bundled. Each optional
 * impl declares its requirement as a peerDependency (optional: true) — npm advertises
 * the version range without auto-installing it. When the user picks that impl during
 * `mementos init`, its setupAtInit calls ensurePackage() to install once into a
 * machine-local plugins directory.
 *
 * Applies to every optional peerDep declared in package.json — currently: hnswlib-node
 * (vector index), simple-git (git backend), openai SDK, re2 (ReDoS-safe regex for scan /
 * trigram searcher), bonjour-service (LAN key pairing).
 *
 * Install target: ~/.config/mementos/plugins/
 *   - Machine-local (never synced, never in git)
 *   - User-owned — no elevated permissions required for nvm/fnm setups
 *
 * Loading: requireFromPlugins() uses createRequire anchored to the plugins dir.
 * Dynamic import() cannot be used here — it would not resolve packages installed in a
 * different directory from the globally-installed mementos CLI.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire, Module } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathExists } from './_utils/fs.js'
import type { InitContext } from './init-context/interface.js'

const execFileP = promisify(execFile)

/** Machine-local directory where optional packages are installed on demand. */
export function pluginsDir(): string {
  return join(homedir(), '.config', 'mementos', 'plugins')
}

/**
 * Load a package from the plugins directory using CJS require.
 * The anchor file does not need to exist — createRequire only uses it to anchor
 * node_modules/ lookup (finds plugins/node_modules/<name>/ from there).
 */
export function requireFromPlugins(name: string): unknown {
  const req = createRequire(join(pluginsDir(), '_anchor.js'))
  return req(name)
}

/**
 * Drop Node's process-wide CJS path-resolution cache. `Module._pathCache` caches *negative*
 * lookups too — so a `requireFromPlugins(name)` attempted while `name` was absent poisons
 * the cache, and every later attempt in the same process keeps failing even after npm has
 * written the package. Call this right after an install so the new package is visible.
 * `_pathCache` is an undocumented Node internal, but it has been stable for many majors.
 */
function clearModuleResolutionCache(): void {
  const m = Module as unknown as { _pathCache?: Record<string, unknown> }
  if (m._pathCache) m._pathCache = Object.create(null) as Record<string, unknown>
}

/** Read the version range declared in mementos peerDependencies for `name`. */
async function peerVersion(name: string): Promise<string> {
  // In dist: dist/core/plugins.js → ../.. → package root
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as {
    peerDependencies?: Record<string, string>
  }
  const version = pkg.peerDependencies?.[name]
  if (!version) throw new Error(`${name} is not declared in mementos peerDependencies`)
  return version
}

/** True if `name` has an installed package directory under the plugins dir. */
async function isPluginInstalled(name: string): Promise<boolean> {
  return pathExists(join(pluginsDir(), 'node_modules', name))
}

/**
 * Write the plugins package.json (listing `deps`) and run `npm install --prefix` into it,
 * then clear Node's resolution cache and verify every name in `verifyNames` loads.
 *
 * The package.json must list every plugin we want to keep — a bare `npm install <pkg>`
 * into a package.json-less prefix treats every previously-installed plugin as extraneous
 * and prunes it. No --no-package-lock either: per-machine package-lock.json pins
 * transitive deps after the first install, closing the going-forward "compromised
 * transitive dep ships into every fresh install" window.
 *
 * `permissionFallback` is shown after "Run manually:" when npm trips EACCES.
 */
async function installAndVerify(
  deps: Record<string, string>,
  verifyNames: string[],
  failLabel: string,
  permissionFallback: string,
): Promise<void> {
  const dir = pluginsDir()
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'mementos-plugins', private: true, dependencies: deps }, null, 2),
  )
  try {
    await execFileP('npm', ['install', '--prefix', dir])
  } catch (e) {
    const msg = (e as NodeJS.ErrnoException).message ?? String(e)
    if (msg.includes('EACCES') || msg.includes('permission')) {
      throw new Error(`Permission denied installing ${failLabel}.\nRun manually: ${permissionFallback}`)
    }
    throw new Error(`Failed to install ${failLabel}: ${msg}`)
  }
  clearModuleResolutionCache()
  for (const name of verifyNames) {
    try {
      requireFromPlugins(name)
    } catch (e) {
      throw new Error(`Installed ${failLabel} but still cannot load ${name}: ${(e as Error).message}`)
    }
  }
}

/**
 * Ensure `name` is loadable from the plugins directory, installing the declared peer
 * version if not. Idempotent — exits immediately if the package already resolves.
 */
export async function ensurePackage(name: string, print: (msg: string) => void): Promise<void> {
  try {
    requireFromPlugins(name)
    return
  } catch {
    // not installed (or not loadable) — fall through
  }

  const version = await peerVersion(name)
  const deps: Record<string, string> = { [name]: version }
  for (const other of await optionalPluginNames()) {
    if (other !== name && await isPluginInstalled(other)) {
      deps[other] = await peerVersion(other)
    }
  }

  print(`Installing ${name}@${version} (one-time setup — may take a minute)...`)
  await installAndVerify(deps, [name], `${name}@${version}`, `npm install --prefix ${pluginsDir()} ${name}@${version}`)
  print(`${name}@${version} ready.`)
}

/**
 * A `setupAtInit` that only ensures one plugin package is installed — the discovery hook
 * shared by every plugin-backed vector index / searcher. Mirrors `defaultSetupAtInit`.
 */
export const ensurePluginSetup = (pkg: string) =>
  (ctx: InitContext): Promise<void> => ensurePackage(pkg, s => ctx.print(s))

/**
 * Every package mementos can install on demand — i.e. its optional peerDependencies.
 * Single source of truth for `init --full`: the full-install set is exactly what the
 * package declares, so a newly-added optional backend is picked up automatically.
 */
export async function optionalPluginNames(): Promise<string[]> {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as {
    peerDependencies?: Record<string, string>
  }
  return Object.keys(pkg.peerDependencies ?? {})
}

/**
 * Install every optional peerDependency into the plugins directory in one shot. Backs
 * `init --full`. Idempotent: if every package already loads, does nothing.
 */
export async function ensureAllPlugins(print: (msg: string) => void): Promise<void> {
  const names = await optionalPluginNames()
  const missing = names.filter(name => {
    try { requireFromPlugins(name); return false } catch { return true }
  })
  if (missing.length === 0) return

  const deps: Record<string, string> = {}
  for (const name of names) deps[name] = await peerVersion(name)

  print(`Installing optional packages: ${missing.join(', ')} (one-time setup — may take a minute)...`)
  await installAndVerify(deps, missing, 'optional packages', `npm install --prefix ${pluginsDir()}`)
  print('All optional packages ready.')
}
