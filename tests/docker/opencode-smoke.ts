/// <reference types="node" />
/**
 * opencode integration smoke test — runs inside tests/docker/integration-test.Dockerfile.
 *
 * Exercises OpenCodeIntegration against the REAL `opencode` CLI: the MCP entry written
 * into `~/.config/opencode/opencode.json` and the skill file. The unit tests run pure
 * filesystem I/O; this proves the genuine CLI parses the config we write and reports the
 * server via `opencode mcp list`.
 *
 * Exit 0 = every check passed; exit 1 = a check failed (with a diagnostic).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'
import { OpenCodeIntegration } from '../../src/integrations/opencode/index.js'

const execFileP = promisify(execFile)
const integration = new OpenCodeIntegration()
const configDir = join(homedir(), '.config', 'opencode')
const configPath = join(configDir, 'opencode.json')
const skillPath = join(configDir, 'skills', 'mementos', 'SKILL.md')

function pass(msg: string): void { console.log(`  ✓ ${msg}`) }
function fail(msg: string): never { console.error(`\n  ✗ FAILED: ${msg}\n`); process.exit(1) }

async function opencode(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileP('opencode', args)
  return stdout + stderr
}
async function pathExists(p: string): Promise<boolean> {
  return stat(p).then(() => true).catch(() => false)
}

console.log('=== opencode integration smoke test ===\n')
const version = await opencode(['--version']).catch(() => '(unknown)')
console.log(`opencode CLI: ${version.trim()}\n`)

try {
  console.log('install()')
  await integration.install()
  pass('install() completed without throwing')

  if (!await integration.isInstalled()) fail('isInstalled() is false right after install()')
  pass('isInstalled() reports true')

  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    mcp?: Record<string, { type?: string; command?: string[]; enabled?: boolean }>
  }
  const server = config.mcp?.['mementos']
  if (server?.type !== 'local' || server.command?.join(' ') !== 'mementos mcp' || server.enabled !== true) {
    fail(`opencode.json mcp entry is wrong:\n${JSON.stringify(config, null, 2)}`)
  }
  pass('opencode.json has a local "mementos mcp" MCP entry')

  if (!await pathExists(skillPath)) fail(`skill file not written at ${skillPath}`)
  const skill = await readFile(skillPath, 'utf8')
  if (!skill.startsWith('---\nname: mementos\n')) fail('SKILL.md is missing the frontmatter')
  if (!skill.includes('recall(')) fail('SKILL.md body missing expected `recall(...)` guidance')
  pass('SKILL.md written with frontmatter + shared body')

  const list = await opencode(['mcp', 'list']).catch(e => fail(`'opencode mcp list' failed: ${String(e)}`))
  if (!list.includes('mementos')) fail(`'opencode mcp list' does not show mementos:\n${list}`)
  pass("'opencode mcp list' shows the mementos server")

  await integration.install()
  pass('install() is idempotent (second run clean)')

  console.log('\nuninstall()')
  await integration.uninstall()
  if (await integration.isInstalled()) fail('isInstalled() is still true after uninstall()')
  pass('isInstalled() reports false')

  const listAfter = await opencode(['mcp', 'list']).catch(() => '')
  if (listAfter.includes('mementos')) fail(`'opencode mcp list' still shows mementos after uninstall:\n${listAfter}`)
  pass("'opencode mcp list' no longer shows the mementos server")

  if (await pathExists(skillPath)) fail('SKILL.md still present after uninstall()')
  pass('SKILL.md removed')

  await integration.uninstall()
  pass('uninstall() is idempotent (second run clean)')

  console.log('\n=== ALL CHECKS PASSED ===')
} catch (e) {
  fail(`unexpected error: ${(e as Error).stack ?? String(e)}`)
}
