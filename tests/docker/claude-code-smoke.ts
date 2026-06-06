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
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'
import { ClaudeCodeIntegration } from '../../src/integrations/claude-code/index.js'

const execFileP = promisify(execFile)
const integration = new ClaudeCodeIntegration()
// Spec-compliant per-folder layout: ~/.claude/skills/<name>/SKILL.md with YAML frontmatter.
// See https://code.claude.com/docs/en/skills. The pre-1.0.2 flat path
// (~/.claude/skills/mementos.md) is no longer recognised by Claude Code.
const skillDir = join(homedir(), '.claude', 'skills', 'mementos')
const skillPath = join(skillDir, 'SKILL.md')
const legacySkillPath = join(homedir(), '.claude', 'skills', 'mementos.md')
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
  if (!skill.startsWith('---\nname: mementos\n')) fail('SKILL.md missing the required Agent-Skills YAML frontmatter')
  if (!skill.includes('recall(')) fail('SKILL.md body missing expected `recall(...)` guidance')
  pass('SKILL.md written with frontmatter at the spec-compliant per-folder path')

  // ── hooks (session-start, pre-compact) — settings.json edits ────────────
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

  // ── legacy-path migration: install must sweep the old flat file ─────────
  // Simulate an existing pre-1.0.2 vault that has the flat mementos.md lying
  // around; re-install should clear it so Claude Code doesn't see two skills.
  console.log('\nlegacy-path migration')
  await mkdir(join(homedir(), '.claude', 'skills'), { recursive: true })
  await writeFile(legacySkillPath, '# stale flat-file skill from <1.0.2', 'utf8')
  await integration.install()
  if (await pathExists(legacySkillPath)) fail('install() did not sweep the legacy ~/.claude/skills/mementos.md flat file')
  if (!await pathExists(skillPath)) fail('install() did not write the new per-folder SKILL.md')
  pass('install() swept the legacy flat file and wrote the per-folder SKILL.md')

  // ── uninstall ────────────────────────────────────────────────────────────
  console.log('\nuninstall()')
  await integration.uninstall()
  if (await integration.isInstalled()) fail('isInstalled() still true after uninstall()')
  if (await pathExists(skillPath)) fail('skill file still present after uninstall()')
  if (await pathExists(legacySkillPath)) fail('legacy flat file still present after uninstall()')
  pass('uninstall() removed the MCP server + skill (both new and legacy paths)')

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
