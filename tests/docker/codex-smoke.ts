/// <reference types="node" />
/**
 * Codex integration smoke test — runs inside tests/docker/integration-test.Dockerfile.
 *
 * Exercises CodexIntegration against the REAL `codex` CLI: MCP registration (via
 * `codex mcp add` / `remove` / `list`) and the skill file. The unit tests mock the `codex`
 * subprocess; this proves the genuine CLI accepts our calls.
 *
 * Exit 0 = every check passed; exit 1 = a check failed (with a diagnostic).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'
import { CodexIntegration } from '../../src/integrations/codex/index.js'

const execFileP = promisify(execFile)
const integration = new CodexIntegration()
const skillPath = join(homedir(), '.agents', 'skills', 'mementos', 'SKILL.md')
const hooksPath = join(homedir(), '.codex', 'hooks.json')

function pass(msg: string): void { console.log(`  ✓ ${msg}`) }
function fail(msg: string): never { console.error(`\n  ✗ FAILED: ${msg}\n`); process.exit(1) }

async function codex(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileP('codex', args)
  return stdout + stderr
}
async function pathExists(p: string): Promise<boolean> {
  return stat(p).then(() => true).catch(() => false)
}

console.log('=== Codex integration smoke test ===\n')
const version = await codex(['--version']).catch(() => '(unknown)')
console.log(`codex CLI: ${version.trim()}\n`)

try {
  console.log('install()')
  await integration.install()
  pass('install() completed without throwing')

  const listAfter = await codex(['mcp', 'list']).catch(e => fail(`'codex mcp list' failed: ${String(e)}`))
  if (!listAfter.includes('mementos')) fail(`'codex mcp list' does not show mementos:\n${listAfter}`)
  pass("'codex mcp list' shows the mementos server")

  if (!await integration.isInstalled()) fail('isInstalled() is false right after install()')
  pass('isInstalled() reports true')

  if (!await pathExists(skillPath)) fail(`skill file not written at ${skillPath}`)
  const skill = await readFile(skillPath, 'utf8')
  if (!skill.startsWith('---\nname: mementos\n')) fail('SKILL.md is missing the frontmatter')
  if (!skill.includes('recall(')) fail('SKILL.md body missing expected `recall(...)` guidance')
  pass('SKILL.md written with frontmatter + shared body')

  await integration.install()
  pass('install() is idempotent (second run clean)')

  console.log('\nhook lifecycle (session-start → ~/.codex/hooks.json)')
  const expectedHooks = ['session-start']
  if (integration.hooks.supportedHooks().join() !== expectedHooks.join()) {
    fail(`supportedHooks() should be ${JSON.stringify(expectedHooks)}, got ${JSON.stringify(integration.hooks.supportedHooks())}`)
  }
  pass(`supportedHooks() reports ${JSON.stringify(expectedHooks)}`)

  await integration.hooks.enableHook('session-start')
  if (!await integration.hooks.isHookEnabled('session-start')) fail('isHookEnabled() false right after enableHook()')
  pass('enableHook() registered the hook')

  const hooksRaw = await readFile(hooksPath, 'utf8').catch(() => fail(`hooks.json not written at ${hooksPath}`))
  const hooksFile = JSON.parse(hooksRaw) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ type?: string; command?: string }> }>>
  }
  const handler = hooksFile.hooks?.['SessionStart']?.[0]?.hooks?.[0]
  if (handler?.type !== 'command' || handler?.command !== 'mementos session-start') {
    fail(`hooks.json SessionStart entry is wrong:\n${hooksRaw}`)
  }
  // The retired UserPromptSubmit event must never reappear in our entries.
  if (hooksFile.hooks?.['UserPromptSubmit']) {
    fail(`hooks.json still has a UserPromptSubmit entry — auto-retrieve was retired:\n${hooksRaw}`)
  }
  pass('hooks.json has a SessionStart "mementos session-start" command hook')

  // The real CLI must still parse its config with our hooks.json present.
  await codex(['mcp', 'list']).catch(e => fail(`'codex mcp list' failed with hooks.json present: ${String(e)}`))
  pass('codex CLI still runs with hooks.json present')

  await integration.hooks.disableHook('session-start')
  if (await integration.hooks.isHookEnabled('session-start')) fail('isHookEnabled() still true after disableHook()')
  pass('disableHook() removed the hook')

  console.log('\nuninstall()')
  await integration.hooks.enableHook('session-start')
  await integration.uninstall()
  if (await integration.isInstalled()) fail('isInstalled() is still true after uninstall()')
  pass('isInstalled() reports false')

  if (await integration.hooks.isHookEnabled('session-start')) fail('hook still enabled after uninstall()')
  pass('uninstall() stripped the hook')

  const listAfterUninstall = await codex(['mcp', 'list']).catch(() => '')
  if (listAfterUninstall.includes('mementos')) {
    fail(`'codex mcp list' still shows mementos after uninstall:\n${listAfterUninstall}`)
  }
  pass("'codex mcp list' no longer shows the mementos server")

  if (await pathExists(skillPath)) fail('SKILL.md still present after uninstall()')
  pass('SKILL.md removed')

  await integration.uninstall()
  pass('uninstall() is idempotent (second run clean)')

  console.log('\n=== ALL CHECKS PASSED ===')
} catch (e) {
  fail(`unexpected error: ${(e as Error).stack ?? String(e)}`)
}
