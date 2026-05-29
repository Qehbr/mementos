/// <reference types="node" />
/**
 * OpenClaw INGESTOR drift test — runs inside tests/docker/integration-test.Dockerfile.
 *
 * Installs the latest `openclaw` (+ the `@openclaw/codex` harness plugin and the `codex`
 * CLI it drives), points everything at a keyless mock OpenAI endpoint, runs one
 * `openclaw agent` turn so OpenClaw writes a REAL session transcript, then runs
 * OpenClawIngestor on it. If an OpenClaw release changes the transcript JSONL schema, the
 * ingestor fails to parse it and this test catches the drift — which a frozen fixture
 * never would.
 *
 * OpenClaw is an orchestrator: `agent` delegates to a coding-agent "harness" (here Codex),
 * which makes the model call. We register an `openai` provider model on the plain
 * `openai-responses` API and point it at the mock — OpenClaw hands that URL to Codex, the
 * mock answers the Responses-API call, and OpenClaw records a full user+assistant exchange.
 * The test then asserts the ingestor parses both turns out of OpenClaw's real
 * `type:"session"` / `type:"message"` JSONL — so a schema change is caught.
 *
 * Keyless: the mock removes the need for an OpenAI API key, so this runs in CI.
 */
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'
import { create as createOpenClawIngestor } from '../../src/ingestors/openclaw/index.js'

const execFileP = promisify(execFile)
const MOCK_PORT = 8090
const SESSION_ID = 'driftcheck1'
const PROMPT = 'Remember this exact phrase: I prefer tabs over spaces for indentation.'

function pass(msg: string): void { console.log(`  ✓ ${msg}`) }
function fail(msg: string): never { console.error(`\n  ✗ FAILED: ${msg}\n`); process.exit(1) }

async function waitForMock(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${MOCK_PORT}/`); return } catch { await sleep(100) }
  }
  fail('mock OpenAI endpoint did not come up')
}
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

/** Every session `.jsonl` under each agent's `sessions` dir, excluding trajectory traces. */
async function findTranscripts(): Promise<string[]> {
  const agents = join(homedir(), '.openclaw', 'agents')
  const out: string[] = []
  let agentDirs: string[]
  try { agentDirs = await readdir(agents) } catch { return out }
  for (const a of agentDirs) {
    const sessions = join(agents, a, 'sessions')
    let files: string[]
    try { files = await readdir(sessions) } catch { continue }
    for (const f of files) {
      if (f.endsWith('.jsonl') && !f.endsWith('.trajectory.jsonl')) out.push(join(sessions, f))
    }
  }
  return out.sort()
}

console.log('=== OpenClaw ingestor drift test ===\n')

console.log('installing the @openclaw/codex harness plugin…')
try {
  await execFileP('openclaw', ['plugins', 'install', 'clawhub:@openclaw/codex'], { timeout: 180_000 })
} catch (e) {
  fail(`could not install the @openclaw/codex plugin: ${String(e)}`)
}
pass('@openclaw/codex harness plugin installed')

// Point OpenClaw's `openai` provider at the keyless mock. OpenClaw resolves the provider
// endpoint from `models.providers.openai` in its config; the Codex harness hands that URL
// to the codex CLI. The whole provider object is set in one `config set` call — its schema
// requires `baseUrl` + a `models` array together. We register `gpt-4o-mini` with the plain
// `openai-responses` API on purpose: OpenClaw hardwires the base URL for its codex-transport
// models (gpt-5.x) to OpenAI's OAuth-gated Codex backend, but honours the configured URL
// for ordinary models.
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`
const openaiProvider = JSON.stringify({
  baseUrl: MOCK_URL,
  apiKey: 'mock-key-not-validated',
  models: [{ id: 'gpt-4o-mini', name: 'Mock GPT-4o-mini', api: 'openai-responses' }],
})
try {
  await execFileP('openclaw', ['config', 'set', 'models.providers.openai', openaiProvider])
} catch (e) {
  fail(`could not configure the openai provider: ${String(e)}`)
}
pass('OpenClaw openai provider pointed at the mock')

const mock = spawn('tsx', ['tests/docker/mock-openai.ts'], {
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
  stdio: ['ignore', 'inherit', 'inherit'],
})
await waitForMock()
pass('mock OpenAI endpoint up')

try {
  console.log(`\nrunning: openclaw agent --local --model openai/gpt-4o-mini --message "${PROMPT}"`)
  const env = { ...process.env, OPENAI_API_KEY: 'mock-key-not-validated' }
  // Tolerate a non-zero exit / timeout: even if the harness's model call falls short,
  // OpenClaw still records the user turn, and the transcript is what the ingestor needs.
  try {
    await execFileP('openclaw',
      ['agent', '--local', '--agent', 'main', '--session-id', SESSION_ID,
       '--model', 'openai/gpt-4o-mini', '--message', PROMPT],
      { env, timeout: 180_000 })
  } catch (e) {
    console.log(`  (openclaw agent exited non-clean — expected; checking the transcript anyway)`)
    void e
  }
  pass('openclaw agent turn ran')

  const transcripts = await findTranscripts()
  const jsonl = transcripts.at(-1)
  if (!jsonl) fail('openclaw wrote no session transcript under any agent sessions dir')
  pass(`transcript written: ${jsonl}`)

  const ingestor = createOpenClawIngestor()
  if (!ingestor.detects(jsonl)) fail(`OpenClawIngestor.detects() rejected ${jsonl}`)
  pass('ingestor.detects() recognises the transcript')

  // The sibling trajectory-trace file must NOT be claimed.
  if (ingestor.detects(jsonl.replace(/\.jsonl$/, '.trajectory.jsonl'))) {
    fail('ingestor.detects() wrongly claimed the .trajectory.jsonl trace file')
  }
  pass('ingestor.detects() rejects the sibling .trajectory.jsonl trace')

  const sessions = await ingestor.parse(jsonl)
  const session = sessions[0]
  if (!session) fail('ingestor.parse() produced no sessions')
  const mementos = sessions.flatMap(s => s.mementos)
  if (mementos.length === 0) fail('ingestor.parse() produced a session with no mementos')
  pass(`ingestor.parse() produced ${sessions.length} session(s), ${mementos.length} memento(s)`)

  const allText = mementos.map(p => p.text).join('\n')
  if (!allText.includes('tabs over spaces')) {
    fail(`parsed mementos do not contain the prompt text. First 500 chars:\n${allText.slice(0, 500)}`)
  }
  pass('parsed memory contains the user turn (the original prompt)')

  // The mock answers the model call, so OpenClaw records an assistant turn too — confirm
  // the ingestor captures both roles, not just the user side.
  if (!mementos.some(p => p.text.startsWith('USER: '))) fail('no USER turn among the parsed mementos')
  if (!mementos.some(p => p.text.startsWith('ASSISTANT: '))) {
    fail(`no ASSISTANT turn among the parsed mementos. Mementos:\n${mementos.map(p => p.text.slice(0, 80)).join('\n')}`)
  }
  pass('parsed memory contains both the USER and ASSISTANT turns')

  if (session.tags?.includes('source:openclaw') !== true) {
    fail('parsed session is not tagged source:openclaw')
  }
  pass('parsed session carries the source:openclaw tag')

  console.log('\n=== ALL CHECKS PASSED ===')
} finally {
  mock.kill()
}
