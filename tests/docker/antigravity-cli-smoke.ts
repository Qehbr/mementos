/// <reference types="node" />
/**
 * Antigravity CLI integration smoke test — runs inside tests/docker/antigravity-cli.Dockerfile.
 *
 * Exercises AntigravityCliIntegration against the REAL `agy` CLI: writes the plugin
 * bundle (plugin.json + skills/), adds the import-manifest entry, verifies discovery via
 * `agy plugin list`, toggles the BeforeAgent hook, and confirms `agy plugin uninstall`
 * cleanup. The unit tests run pure filesystem I/O; this proves the genuine CLI
 * discovers what we write and still starts with our config present.
 *
 * Exit 0 = every check passed; exit 1 = a check failed (with a diagnostic).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'
import { AntigravityCliIntegration } from '../../src/integrations/antigravity-cli/index.js'

const execFileP = promisify(execFile)
const integration = new AntigravityCliIntegration()
const geminiDir = join(homedir(), '.gemini')
const pluginDir = join(geminiDir, 'config', 'plugins', 'mementos')
const pluginManifestPath = join(pluginDir, 'plugin.json')
const skillPath = join(pluginDir, 'skills', 'mementos', 'SKILL.md')
const importManifestPath = join(geminiDir, 'config', 'import_manifest.json')

function pass(msg: string): void { console.log(`  ✓ ${msg}`) }
function fail(msg: string): never { console.error(`\n  ✗ FAILED: ${msg}\n`); process.exit(1) }

async function agy(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileP('agy', args)
  return stdout + stderr
}
async function pathExists(p: string): Promise<boolean> {
  return stat(p).then(() => true).catch(() => false)
}

console.log('=== Antigravity CLI integration smoke test ===\n')
const version = await agy(['--version']).catch(() => '(unknown)')
console.log(`agy CLI: ${version.trim()}\n`)

try {
  console.log('install()')
  await integration.install()
  pass('install() completed without throwing')

  if (!await integration.isInstalled()) fail('isInstalled() is false right after install()')
  pass('isInstalled() reports true')

  if (!await pathExists(pluginManifestPath)) fail(`plugin.json not written at ${pluginManifestPath}`)
  const manifest = JSON.parse(await readFile(pluginManifestPath, 'utf8')) as {
    name?: string; mcpServers?: Record<string, { command?: string; args?: string[] }>
  }
  const server = manifest.mcpServers?.['mementos']
  if (manifest.name !== 'mementos' || server?.command !== 'mementos' || server.args?.[0] !== 'serve') {
    fail(`plugin.json is malformed:\n${JSON.stringify(manifest, null, 2)}`)
  }
  pass('plugin.json declares the mementos MCP server')

  const skill = await readFile(skillPath, 'utf8').catch(() => fail(`SKILL.md not written at ${skillPath}`))
  if (!skill.includes('recall')) fail('SKILL.md is missing expected guidance')
  if (!skill.startsWith('---')) fail('SKILL.md is missing required YAML frontmatter')
  pass('SKILL.md written with frontmatter + shared skill body')

  const importManifest = JSON.parse(await readFile(importManifestPath, 'utf8')) as {
    imports?: Array<{ name?: string }>
  }
  if (!importManifest.imports?.some(e => e.name === 'mementos')) {
    fail(`import_manifest.json missing our entry:\n${JSON.stringify(importManifest, null, 2)}`)
  }
  pass('import_manifest.json carries our entry')

  const list = await agy(['plugin', 'list']).catch(e => fail(`'agy plugin list' failed: ${String(e)}`))
  if (!list.includes('mementos')) fail(`'agy plugin list' does not show mementos:\n${list}`)
  pass("'agy plugin list' shows the mementos plugin")

  await integration.install()
  pass('install() is idempotent (second run clean)')

  // ─── Hook lifecycle ────────────────────────────────────────────────────────
  console.log('\nhook lifecycle (auto-retrieve → plugin.json BeforeAgent)')
  if (integration.hooks.supportedHooks().join() !== 'auto-retrieve') {
    fail(`supportedHooks() should be exactly ['auto-retrieve'], got [${integration.hooks.supportedHooks().join()}]`)
  }
  pass("supportedHooks() reports ['auto-retrieve']")

  await integration.hooks.enableHook('auto-retrieve')
  if (!await integration.hooks.isHookEnabled('auto-retrieve')) fail('isHookEnabled() false right after enableHook()')
  pass('enableHook() registered the hook')

  const afterEnable = JSON.parse(await readFile(pluginManifestPath, 'utf8')) as {
    name?: string; hooks?: Record<string, Array<{ hooks?: Array<{ type?: string; command?: string }> }>>
  }
  const handler = afterEnable.hooks?.['BeforeAgent']?.[0]?.hooks?.[0]
  if (handler?.type !== 'command' || handler?.command !== 'mementos retrieve --format=gemini') {
    fail(`plugin.json BeforeAgent entry is wrong:\n${JSON.stringify(afterEnable, null, 2)}`)
  }
  if (afterEnable.name !== 'mementos') fail('enableHook() clobbered the plugin name field')
  pass('plugin.json has a BeforeAgent "mementos retrieve --format=gemini" hook (and name preserved)')

  await agy(['plugin', 'list']).catch(e => fail(`agy CLI failed with our plugin + hook present: ${String(e)}`))
  pass('agy plugin list still runs with the hook present')

  // `agy plugin validate` on our plugin dir — definitive contract check.
  const validateOut = await agy(['plugin', 'validate', pluginDir]).catch(e => fail(`'agy plugin validate' failed: ${String(e)}`))
  if (!validateOut.includes('[ok]')) fail(`'agy plugin validate' did not return ok:\n${validateOut}`)
  pass("'agy plugin validate' accepts our plugin layout")

  await integration.hooks.enableHook('auto-retrieve')
  const afterDouble = JSON.parse(await readFile(pluginManifestPath, 'utf8')) as {
    hooks?: Record<string, unknown[]>
  }
  if (afterDouble.hooks?.['BeforeAgent']?.length !== 1) {
    fail(`enableHook() not idempotent — got ${JSON.stringify(afterDouble.hooks?.['BeforeAgent'])}`)
  }
  pass('enableHook() is idempotent (second call leaves one entry)')

  await integration.hooks.disableHook('auto-retrieve')
  if (await integration.hooks.isHookEnabled('auto-retrieve')) fail('isHookEnabled() still true after disableHook()')
  pass('disableHook() removed the hook')

  console.log('\nuninstall()')
  await integration.hooks.enableHook('auto-retrieve')
  await integration.uninstall()
  if (await integration.isInstalled()) fail('isInstalled() is still true after uninstall()')
  pass('isInstalled() reports false')

  if (await pathExists(pluginDir)) fail('plugin directory still present after uninstall()')
  pass('plugin directory removed')

  const importAfter = JSON.parse(await readFile(importManifestPath, 'utf8')) as { imports?: Array<{ name?: string }> }
  if (importAfter.imports?.some(e => e.name === 'mementos')) {
    fail(`import_manifest.json still has our entry after uninstall:\n${JSON.stringify(importAfter, null, 2)}`)
  }
  pass('import_manifest.json entry removed')

  if (await integration.hooks.isHookEnabled('auto-retrieve')) fail('hook still enabled after uninstall()')
  pass('uninstall() stripped the hook')

  const listAfter = await agy(['plugin', 'list']).catch(() => '')
  if (listAfter.includes('mementos')) fail(`'agy plugin list' still shows mementos after uninstall:\n${listAfter}`)
  pass("'agy plugin list' no longer shows the mementos plugin")

  await integration.uninstall()
  pass('uninstall() is idempotent (second run clean)')

  console.log('\n=== ALL CHECKS PASSED ===')
} catch (e) {
  fail(`unexpected error: ${(e as Error).stack ?? String(e)}`)
}
