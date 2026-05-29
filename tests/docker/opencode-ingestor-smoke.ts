/// <reference types="node" />
/**
 * opencode INGESTOR drift test — runs inside tests/docker/integration-test.Dockerfile.
 *
 * Installs the latest `opencode`, runs one `opencode run` turn so opencode writes a REAL
 * `opencode.db` SQLite database, then runs OpenCodeIngestor on it. If an opencode release
 * changes the `session`/`message`/`part` schema, the ingestor fails and this test catches
 * the drift — which a frozen fixture never would.
 *
 * Keyless: opencode records the user message into `opencode.db` before (and regardless of)
 * the model call, so no API key and no mock LLM are needed — the user turn is enough to
 * exercise the schema the ingestor depends on.
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'
import { create as createOpenCodeIngestor } from '../../src/ingestors/opencode/index.js'

const execFileP = promisify(execFile)
const PROMPT = 'Remember this exact phrase: I prefer tabs over spaces for indentation.'
const dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')

function pass(msg: string): void { console.log(`  ✓ ${msg}`) }
function fail(msg: string): never { console.error(`\n  ✗ FAILED: ${msg}\n`); process.exit(1) }

/**
 * Run `opencode run <prompt>` to completion. Spawned with discarded stdio — opencode
 * streams a verbose model reply, which would overflow `execFile`'s buffer and kill it
 * mid-write. We just need it to run long enough to persist the turn into opencode.db.
 */
function runOpencode(): Promise<void> {
  return new Promise<void>((resolve) => {
    const child = spawn('opencode', ['run', PROMPT], { stdio: 'ignore' })
    const timer = setTimeout(() => child.kill('SIGTERM'), 240_000)
    child.on('exit', () => { clearTimeout(timer); resolve() })
    child.on('error', () => { clearTimeout(timer); resolve() })
  })
}

console.log('=== opencode ingestor drift test ===\n')
const version = await execFileP('opencode', ['--version']).then(r => r.stdout.trim()).catch(() => '(unknown)')
console.log(`opencode CLI: ${version}\n`)

console.log(`running: opencode run "${PROMPT}"`)
await runOpencode()
pass('opencode run turn ran')

if (!await stat(dbPath).then(() => true).catch(() => false)) {
  fail(`opencode wrote no database at ${dbPath}`)
}
pass(`database written: ${dbPath}`)

const ingestor = createOpenCodeIngestor()
if (!ingestor.detects(dbPath)) fail(`OpenCodeIngestor.detects() rejected ${dbPath}`)
pass('ingestor.detects() recognises opencode.db')

const sessions = await ingestor.parse(dbPath)
const mementos = sessions.flatMap(s => s.mementos)
if (mementos.length === 0) fail('ingestor.parse() produced no mementos from the real database')
pass(`ingestor.parse() produced ${sessions.length} session(s), ${mementos.length} memento(s)`)

const allText = mementos.map(p => p.text).join('\n')
if (!allText.includes('tabs over spaces')) {
  fail(`parsed parts do not contain the prompt text. First 500 chars:\n${allText.slice(0, 500)}`)
}
pass('parsed memory contains the original prompt text')

if (sessions.some(s => s.tags?.includes('source:opencode')) !== true) {
  fail('no parsed session carries the source:opencode tag')
}
pass('parsed session carries the source:opencode tag')

console.log('\n=== ALL CHECKS PASSED ===')
