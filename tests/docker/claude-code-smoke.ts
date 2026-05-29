/// <reference types="node" />
/**
 * Claude Code integration smoke test — runs inside docker/integration-test.Dockerfile.
 *
 * Exercises ClaudeCodeIntegration against the REAL `claude` CLI: MCP registration (via
 * `claude mcp`), the skill file, and both hook kinds (settings.json edits). The unit tests
 * mock the `claude` subprocess; this proves the genuine CLI accepts our calls.
 *
 * Exit 0 = every check passed; exit 1 = a check failed (with a diagnostic).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'
import { ClaudeCodeIntegration } from '../../src/integrations/claude-code/index.js'

const execFileP = promisify(execFile)
const integration = new ClaudeCodeIntegration()
const skillPath = join(homedir(), '.claude', 'skills', 'mementos.md')
const settingsPath = join(homedir(), '.claude', 'settings.json')

function pass(msg: string): void { console.log(`  ✓ ${msg}`) }
function fail(msg: string): never { console.error(`\n  ✗ FAILED: ${msg}\n`); process.exit(1) }

async function claude(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileP('claude', args)
  return stdout + stderr
}
async function pathExists(p: string): Promise<boolean> {
  return stat(p).then(() => true).catch(() => false)
}

console.log('=== Claude Code integration smoke test ===\n')
const version = await claude(['--version']).catch(() => '(unknown)')
console.log(`claude CLI: ${version.trim()}\n`)

try {
  // ── install: MCP server + skill ──────────────────────────────────────────
  console.log('install()')
  await integration.install()
  pass('install() completed without throwing')

  // The genuine `claude` CLI must find the server we registered.
  await claude(['mcp', 'get', 'mementos']).catch((e: unknown) => fail(`'claude mcp get mementos' failed after install: ${String(e)}`))
  pass("'claude mcp get mementos' finds the server")

  if (!await integration.isInstalled()) fail('isInstalled() is false right after install()')
  pass('isInstalled() reports true')

  if (!await pathExists(skillPath)) fail(`skill file not written at ${skillPath}`)
  const skill = await readFile(skillPath, 'utf8')
  if (!skill.includes('retrieve_memories')) fail('skill file is missing expected guidance')
  pass('skill file written')

  // ── hooks (auto-retrieve, pre-compact) — settings.json edits ─────────────
  console.log('\nhooks')
  for (const kind of integration.hooks.supportedHooks()) {
    await integration.hooks.enableHook(kind)
    if (!await integration.hooks.isHookEnabled(kind)) fail(`isHookEnabled('${kind}') false after enableHook`)
    const settings = await readFile(settingsPath, 'utf8').catch(() => '')
    if (!settings.includes('mementos')) fail(`settings.json carries no mementos entry after enabling '${kind}'`)
    pass(`enableHook('${kind}') registered in settings.json`)
  }
  for (const kind of integration.hooks.supportedHooks()) {
    await integration.hooks.disableHook(kind)
    if (await integration.hooks.isHookEnabled(kind)) fail(`isHookEnabled('${kind}') still true after disableHook`)
    pass(`disableHook('${kind}') cleared`)
  }

  // ── uninstall ────────────────────────────────────────────────────────────
  console.log('\nuninstall()')
  await integration.uninstall()
  if (await integration.isInstalled()) fail('isInstalled() still true after uninstall()')
  if (await pathExists(skillPath)) fail('skill file still present after uninstall()')
  pass('uninstall() removed the MCP server + skill')

  // ── idempotency ──────────────────────────────────────────────────────────
  await integration.install()
  await integration.install()
  pass('install() is idempotent (second run clean)')
  await integration.uninstall()
  await integration.uninstall()
  pass('uninstall() is idempotent (second run clean)')

  console.log('\n=== ALL CHECKS PASSED ===')
} catch (e) {
  fail(`unexpected error: ${(e as Error).stack ?? String(e)}`)
}
