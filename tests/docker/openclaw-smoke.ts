/// <reference types="node" />
/**
 * OpenClaw integration smoke test — runs inside the docker/openclaw.Dockerfile container.
 *
 * The unit tests (`src/__tests__/integrations-openclaw.test.ts`) mock the `openclaw`
 * subprocess, so they prove mementos *calls* the CLI as intended but not that the real
 * CLI accepts those calls. This script runs the integration against the genuine `openclaw`
 * CLI and cross-checks the result with `openclaw mcp list` and the on-disk skill file.
 *
 * Exit 0 = every check passed; exit 1 = a check failed (with a diagnostic).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'
import { OpenClawIntegration } from '../../src/integrations/openclaw/index.js'

const execFileP = promisify(execFile)
const integration = new OpenClawIntegration()
const skillPath = join(homedir(), '.openclaw', 'workspace', 'skills', 'mementos', 'SKILL.md')

function pass(msg: string): void { console.log(`  ✓ ${msg}`) }
function fail(msg: string): never { console.error(`\n  ✗ FAILED: ${msg}\n`); process.exit(1) }

async function openclaw(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileP('openclaw', args)
  return stdout + stderr
}

async function pathExists(p: string): Promise<boolean> {
  return stat(p).then(() => true).catch(() => false)
}

console.log('=== OpenClaw integration smoke test ===\n')

const version = await openclaw(['--version']).catch(() => '(unknown)')
console.log(`openclaw CLI: ${version.trim()}\n`)

try {
  // ── install ──────────────────────────────────────────────────────────────
  console.log('install()')
  await integration.install()
  pass('install() completed without throwing')

  const listAfterInstall = await openclaw(['mcp', 'list'])
  if (!listAfterInstall.includes('mementos')) {
    fail(`'openclaw mcp list' does not show mementos after install:\n${listAfterInstall}`)
  }
  pass("'openclaw mcp list' shows the mementos server")

  if (!await integration.isInstalled()) fail('isInstalled() is false right after install()')
  pass('isInstalled() reports true')

  if (!await pathExists(skillPath)) fail(`skill file not written at ${skillPath}`)
  const skill = await readFile(skillPath, 'utf8')
  if (!skill.includes('retrieve_memories')) fail('SKILL.md is missing expected guidance')
  if (!skill.startsWith('---\nname: mementos\n')) fail('SKILL.md is missing the OpenClaw frontmatter')
  pass('SKILL.md written with frontmatter + shared body')

  // install() must be idempotent — running it twice should not error or duplicate.
  await integration.install()
  pass('install() is idempotent (second run clean)')

  // ── uninstall ────────────────────────────────────────────────────────────
  console.log('\nuninstall()')
  await integration.uninstall()
  pass('uninstall() completed without throwing')

  if (await integration.isInstalled()) fail('isInstalled() is still true after uninstall()')
  pass('isInstalled() reports false')

  const listAfterUninstall = await openclaw(['mcp', 'list'])
  if (listAfterUninstall.includes('mementos')) {
    fail(`'openclaw mcp list' still shows mementos after uninstall:\n${listAfterUninstall}`)
  }
  pass("'openclaw mcp list' no longer shows the mementos server")

  if (await pathExists(skillPath)) fail('SKILL.md still present after uninstall()')
  pass('SKILL.md removed')

  // uninstall() must be idempotent too.
  await integration.uninstall()
  pass('uninstall() is idempotent (second run clean)')

  console.log('\n=== ALL CHECKS PASSED ===')
} catch (e) {
  fail(`unexpected error: ${(e as Error).stack ?? String(e)}`)
}
