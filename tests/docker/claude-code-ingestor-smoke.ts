/// <reference types="node" />
/**
 * Claude Code INGESTOR drift test — runs inside docker/integration-test.Dockerfile.
 *
 * Installs the latest `claude` CLI, points it at a keyless mock Anthropic endpoint, runs
 * `claude -p` so it writes a REAL session JSONL, then runs ClaudeCodeIngestor on that
 * freshly-produced transcript. If a Claude Code release changes the JSONL schema, the
 * ingestor fails to parse it and this test catches the drift — which a frozen fixture
 * never would.
 *
 * Keyless: the mock removes the need for an Anthropic API key, so this runs in CI.
 */
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'
import { create as createClaudeCodeIngestor } from '../../src/ingestors/claude-code/index.js'

const execFileP = promisify(execFile)
const MOCK_PORT = 8080
const PROMPT = 'Remember this: I prefer tabs over spaces, and I use Zustand for state.'

function pass(msg: string): void { console.log(`  ✓ ${msg}`) }
function fail(msg: string): never { console.error(`\n  ✗ FAILED: ${msg}\n`); process.exit(1) }

async function waitForMock(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${MOCK_PORT}/`)
      return
    } catch {
      await new Promise(r => setTimeout(r, 100))
    }
  }
  fail('mock Anthropic endpoint did not come up')
}

/** Every `.jsonl` written under `~/.claude/projects/<dir>/`. */
async function findTranscripts(): Promise<string[]> {
  const projects = join(homedir(), '.claude', 'projects')
  const out: string[] = []
  let dirs: string[]
  try { dirs = await readdir(projects) } catch { return out }
  for (const d of dirs) {
    let files: string[]
    try { files = await readdir(join(projects, d)) } catch { continue }
    for (const f of files) if (f.endsWith('.jsonl')) out.push(join(projects, d, f))
  }
  return out.sort()
}

console.log('=== Claude Code ingestor drift test ===\n')

const mock = spawn('tsx', ['tests/docker/mock-anthropic.ts'], {
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
  stdio: ['ignore', 'inherit', 'inherit'],
})
await waitForMock()
pass('mock Anthropic endpoint up')

try {
  console.log(`\nrunning: claude -p "${PROMPT}"`)
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    ANTHROPIC_API_KEY: 'mock-key-not-validated',
  }
  try {
    const { stdout, stderr } = await execFileP('claude', ['-p', PROMPT], { env, timeout: 120_000 })
    const out = (stdout + stderr).trim()
    if (out) console.log(`  claude said: ${out.slice(0, 200)}`)
  } catch (e) {
    fail(`'claude -p' did not complete: ${String(e)}`)
  }
  pass('claude -p completed against the mock endpoint')

  const transcripts = await findTranscripts()
  if (transcripts.length === 0) fail('claude wrote no .jsonl transcript under ~/.claude/projects/')
  const jsonl = transcripts[transcripts.length - 1]
  pass(`transcript written: ${jsonl}`)

  const ingestor = createClaudeCodeIngestor()
  if (!await ingestor.detects(jsonl)) fail(`ClaudeCodeIngestor.detects() rejected ${jsonl}`)
  pass('ingestor.detects() recognises the transcript')

  const sessions = await ingestor.parse(jsonl)
  if (sessions.length === 0) fail('ingestor.parse() produced no sessions')
  const mementos = sessions.flatMap(s => s.mementos)
  if (mementos.length === 0) fail('ingestor.parse() produced a session with no mementos')
  pass(`ingestor.parse() produced ${sessions.length} session(s), ${mementos.length} memento(s)`)

  const allText = mementos.map(p => p.text).join('\n')
  if (!allText.includes('tabs over spaces')) {
    fail(`parsed mementos do not contain the prompt text. First 500 chars:\n${allText.slice(0, 500)}`)
  }
  pass('parsed memory contains the original prompt text')

  console.log('\n=== ALL CHECKS PASSED ===')
} finally {
  mock.kill()
}
