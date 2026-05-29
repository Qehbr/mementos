#!/usr/bin/env node
/// <reference types="node" />
/**
 * mementos end-to-end QA benchmark — LongMemEval adapter.
 *
 * This tool measures END-TO-END QA ACCURACY: retrieve → an LLM "reader" answers the
 * question from the retrieved sessions → the official LongMemEval "judge" scores the
 * answer. For retrieval recall in isolation, see `tools/bench-retrieval.ts`.
 *
 * Prompts and call configs are ported VERBATIM from LongMemEval (ICLR 2025):
 *   - reader prompt — `run_generation.py` `prepare_prompt` (flat-session, nl, non-CoT)
 *   - judge prompts — `evaluate_qa.py` `get_anscheck_prompt` (5 per-question-type templates)
 *   - judge call    — temperature 0, max_tokens 10, label = substring "yes"
 *
 * Reader and judge are reached over the OpenAI-compatible chat-completions API, so the
 * reader can be a LOCAL model (Ollama / vLLM / LM Studio) or an API model. The judge
 * defaults to `gpt-4o-2024-08-06` — the benchmark's official judge; changing it breaks
 * comparability with published LongMemEval numbers.
 *
 * Idempotent: every (question → answer, verdict) is appended to a JSONL checkpoint as it
 * completes. Re-running skips questions already done, so an interrupted run (rate limit,
 * out of credit) resumes exactly where it stopped.
 *
 * Usage:
 *   npx tsx tools/bench-qa.ts --questions=2                       # tiny test run
 *   npx tsx tools/bench-qa.ts --questions=all                     # full 500-question eval
 *   npx tsx tools/bench-qa.ts --qa-reader-model=gpt-4o-mini       # API reader (default)
 *   npx tsx tools/bench-qa.ts --qa-reader-url=http://localhost:11434/v1 \
 *                             --qa-reader-model=qwen2.5:32b       # local 4090 reader
 *   npx tsx tools/bench-qa.ts --retrievers=semantic,hybrid        # QA for both (2× cost)
 *
 * Flags:
 *   --qa-reader-model=  reader model     (default gpt-4o-mini)
 *   --qa-reader-url=    reader endpoint  (default https://api.openai.com/v1)
 *   --qa-judge-model=   judge model      (default gpt-4o-2024-08-06 — the official judge)
 *   --qa-judge-url=     judge endpoint   (default https://api.openai.com/v1)
 *   --qa-k=             retrieved sessions fed to the reader (default 5)
 *   --retrievers=       which retriever(s) to run QA over (default hybrid)
 *   --doc-mode=         full | user-only (default full)
 *   --questions=        N | all (default 100)   --dataset=  --no-download  --seed=
 *
 * Set OPENAI_API_KEY for any OpenAI endpoint. A local endpoint ignores the key.
 *
 * ── --rejudge ────────────────────────────────────────────────────────────────
 * Re-score an existing run's reader answers with a different judge — no reader calls, no
 * retrieval, no embedding. Use it to get the official gpt-4o-judged number from a run done
 * with a local judge, and to measure how far the two judges agree.
 *   npx tsx tools/bench-qa.ts --rejudge \
 *     --rejudge-from=~/.cache/mementos/qa_hybrid_full_r-qwen-reader_j-llama3.1_8b_k5.jsonl \
 *     --qa-judge-model=gpt-4o-2024-08-06
 */
import { performance } from 'node:perf_hooks'
import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { ensurePackage } from '../src/core/plugins.js'
import {
  flag, mean, pad, pctStr, sample,
  loadDataset, prepareQuestions, parseDocMode, parseQuestionLimit,
  loadRetrieverFactory, CACHE_DIR,
  type PreparedQuestion, type LongMemEvalQuestion, type LongMemEvalTurn,
} from './longmemeval-common.js'

// ─── CLI args ─────────────────────────────────────────────────────────────────

const NO_DOWNLOAD = process.argv.includes('--no-download')
const DATASET_OVERRIDE = flag('dataset')
const SEED = parseInt(flag('seed') ?? '0', 10)
const DOC_MODE = parseDocMode()
// QA runs cost money, so default to a single retriever (our best) rather than both.
const RETRIEVERS = (flag('retrievers') ?? 'hybrid').split(',').map(s => s.trim()).filter(Boolean)
const QA_READER_MODEL = flag('qa-reader-model') ?? 'gpt-4o-mini'
const QA_READER_URL = flag('qa-reader-url') ?? 'https://api.openai.com/v1'
const QA_JUDGE_MODEL = flag('qa-judge-model') ?? 'gpt-4o-2024-08-06'
const QA_JUDGE_URL = flag('qa-judge-url') ?? 'https://api.openai.com/v1'
const QA_K = parseInt(flag('qa-k') ?? '5', 10)
const REJUDGE = process.argv.includes('--rejudge')
const REJUDGE_FROM = flag('rejudge-from')

// ─── OpenAI-compatible chat client ────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? ''

/** OpenAI endpoints need a real key; local OpenAI-compatible servers ignore it. */
function keyFor(url: string): string {
  if (/openai\.com/.test(url)) {
    if (!OPENAI_KEY) throw new Error(`OPENAI_API_KEY is not set — required for ${url}`)
    return OPENAI_KEY
  }
  return OPENAI_KEY || 'local'
}

interface ChatResult { content: string; promptTokens: number; completionTokens: number }

/**
 * One chat-completion call. Retries network errors, 429s and 5xx with exponential backoff;
 * a 4xx (bad key, bad request) throws immediately.
 */
async function chatComplete(
  baseUrl: string, apiKey: string, model: string, prompt: string, maxTokens: number,
): Promise<ChatResult> {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions'
  let lastErr: unknown
  for (let attempt = 0; attempt < 7; attempt++) {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          max_tokens: maxTokens,
          n: 1,
        }),
      })
    } catch (e) {
      lastErr = e
      await sleep(Math.min(60_000, 2_000 * 2 ** attempt))
      continue
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`HTTP ${res.status}`)
      await sleep(Math.min(60_000, 2_000 * 2 ** attempt))
      continue
    }
    if (!res.ok) {
      throw new Error(`chat completion HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
    }
    const j = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    return {
      content: (j.choices?.[0]?.message?.content ?? '').trim(),
      promptTokens: j.usage?.prompt_tokens ?? 0,
      completionTokens: j.usage?.completion_tokens ?? 0,
    }
  }
  throw new Error(`chat completion failed after retries: ${String(lastErr)}`)
}

// ─── Verbatim LongMemEval prompts ─────────────────────────────────────────────

/**
 * The LongMemEval reader prompt — ported verbatim from `run_generation.py` `prepare_prompt`
 * (`flat-session` retriever, `nl` history format, non-CoT, no key expansion). Retrieved
 * sessions are rendered with their dates and sorted chronologically; the question's date
 * is appended — both load-bearing for temporal-reasoning questions.
 */
function buildReaderPrompt(q: LongMemEvalQuestion, rankedSessionIds: string[]): string {
  const idIndex = new Map<string, number>()
  q.haystack_session_ids.forEach((sid, i) => idIndex.set(sid, i))

  const chunks: Array<{ date: string; turns: LongMemEvalTurn[] }> = []
  for (const sid of rankedSessionIds) {
    const idx = idIndex.get(sid)
    if (idx === undefined) continue
    chunks.push({ date: q.haystack_dates[idx], turns: q.haystack_sessions[idx] })
  }
  // Sort sessions by date — plain string sort, matching LongMemEval's `sort(key=x[0])`.
  chunks.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  let history = ''
  chunks.forEach((c, i) => {
    let sess = ''
    for (const t of c.turns) sess += `\n\n${t.role}: ${t.content.trim()}`
    history += `\n### Session ${i + 1}:\nSession Date: ${c.date}\nSession Content:\n${sess}\n`
  })

  return 'I will give you several history chats between you and a user. Please answer the question based on the relevant chat history.'
    + `\n\n\nHistory Chats:\n\n${history}\n\nCurrent Date: ${q.question_date}\nQuestion: ${q.question}\nAnswer:`
}

/**
 * The LongMemEval judge prompt — ported verbatim from `evaluate_qa.py` `get_anscheck_prompt`.
 * Five templates: a base form for single-session / multi-session, a temporal variant that
 * forgives off-by-one day errors, a knowledge-update variant, a preference (rubric) variant,
 * and the abstention variant. The verbatim whitespace matters — do not "tidy" it.
 */
function buildJudgePrompt(
  task: string, question: string, answer: string, response: string, abstention: boolean,
): string {
  if (abstention) {
    return 'I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.'
      + `\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`
  }
  if (task === 'single-session-user' || task === 'single-session-assistant' || task === 'multi-session') {
    return 'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. '
      + `\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
  }
  if (task === 'temporal-reasoning') {
    return 'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model\'s response is still correct. '
      + `\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
  }
  if (task === 'knowledge-update') {
    return 'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.'
      + `\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
  }
  if (task === 'single-session-preference') {
    return 'I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user\'s personal information correctly.'
      + `\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
  }
  throw new Error(`unknown question_type for judge: ${task}`)
}

// ─── Checkpointing ────────────────────────────────────────────────────────────

interface QaRecord {
  question_id: string
  question_type: string
  abstention: boolean
  hypothesis: string
  judge_label: boolean
  /** Provenance — which models produced this hypothesis and verdict. */
  reader_model: string
  judge_model: string
}

/**
 * Checkpoint path — keyed by retriever, doc-mode, reader model AND judge model. The judge
 * key matters: a local-judge run and a gpt-4o-judge run (same reader) must not clobber
 * each other's verdicts.
 */
function qaCheckpointPath(retriever: string): string {
  const slug = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_')
  return join(
    CACHE_DIR,
    `qa_${slug(retriever)}_${DOC_MODE}_r-${slug(QA_READER_MODEL)}_j-${slug(QA_JUDGE_MODEL)}_k${QA_K}.jsonl`,
  )
}

async function loadQaCheckpoint(path: string): Promise<Map<string, QaRecord>> {
  const map = new Map<string, QaRecord>()
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch { return map }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const rec = JSON.parse(t) as QaRecord
      if (rec.question_id) map.set(rec.question_id, rec)
    } catch { /* torn final line from an interrupted write — ignore */ }
  }
  return map
}

// ─── QA run ───────────────────────────────────────────────────────────────────

async function runQa(retrieverName: string, prepared: PreparedQuestion[]): Promise<QaRecord[]> {
  const { HNSWIndex } = await import('../src/vector/hnsw/index.js')
  const create = await loadRetrieverFactory(retrieverName)
  const readerKey = keyFor(QA_READER_URL)
  const judgeKey = keyFor(QA_JUDGE_URL)

  const ckptPath = qaCheckpointPath(retrieverName)
  const done = await loadQaCheckpoint(ckptPath)
  console.log(`  checkpoint: ${done.size} already scored — ${ckptPath}`)
  await mkdir(CACHE_DIR, { recursive: true })

  const records: QaRecord[] = []
  let readerIn = 0, readerOut = 0, judgeIn = 0, judgeOut = 0, fresh = 0

  for (let qi = 0; qi < prepared.length; qi++) {
    const pq = prepared[qi]
    const qid = pq.raw.question_id

    const cached = done.get(qid)
    if (cached) { records.push(cached); continue }

    // Retrieve the top-QA_K session ids to feed the reader.
    const index = new HNSWIndex(pq.docs[0]?.vec.length ?? 384)
    await index.init()
    const retriever = create(index)
    for (const d of pq.docs) {
      index.add(d.id, d.vec)
      const text = pq.docTexts.get(d.id) ?? ''
      retriever.add(d.id, () => text)
    }
    const rankedIds = retriever.retrieve(pq.question, pq.queryVec, QA_K).map(r => r.id)

    // Reader: answer from the retrieved sessions. The reader gets FULL sessions (user +
    // assistant) regardless of the retrieval doc-mode — it needs every turn to answer.
    const reader = await chatComplete(
      QA_READER_URL, readerKey, QA_READER_MODEL, buildReaderPrompt(pq.raw, rankedIds), 500,
    )
    readerIn += reader.promptTokens; readerOut += reader.completionTokens

    // Judge: official LongMemEval scoring.
    const judge = await chatComplete(
      QA_JUDGE_URL, judgeKey, QA_JUDGE_MODEL,
      buildJudgePrompt(pq.raw.question_type, pq.raw.question, pq.raw.answer, reader.content, pq.abstention),
      10,
    )
    judgeIn += judge.promptTokens; judgeOut += judge.completionTokens

    const rec: QaRecord = {
      question_id: qid,
      question_type: pq.raw.question_type,
      abstention: pq.abstention,
      hypothesis: reader.content,
      judge_label: judge.content.toLowerCase().includes('yes'),
      reader_model: QA_READER_MODEL,
      judge_model: QA_JUDGE_MODEL,
    }
    await appendFile(ckptPath, JSON.stringify(rec) + '\n')
    records.push(rec)
    fresh++

    if (fresh % 10 === 0 || qi + 1 === prepared.length) {
      process.stdout.write(`  qa ${retrieverName}: ${qi + 1}/${prepared.length}  (${fresh} new this run)\r`)
    }
  }
  process.stdout.write(' '.repeat(70) + '\r')
  if (fresh > 0) {
    console.log(`  tokens this run — reader ${readerIn} in / ${readerOut} out · judge ${judgeIn} in / ${judgeOut} out`)
  }
  return records
}

function printQaResults(retrieverName: string, records: QaRecord[]): void {
  const acc = (rs: QaRecord[]) => mean(rs.map(r => r.judge_label ? 1 : 0))
  // Prefer the models recorded on the data — correct for both fresh and --rejudge runs.
  const readerLabel = records[0]?.reader_model ?? QA_READER_MODEL
  const judgeLabel = records[0]?.judge_model ?? QA_JUDGE_MODEL
  console.log(`\n─── QA accuracy · ${retrieverName} · reader=${readerLabel} · judge=${judgeLabel} ───\n`)
  console.log(`  overall (micro):     ${pctStr(acc(records))}  (n=${records.length})`)
  const nonAbs = records.filter(r => !r.abstention)
  const abs = records.filter(r => r.abstention)
  console.log(`  non-abstention:      ${pctStr(acc(nonAbs))}  (n=${nonAbs.length})`)
  if (abs.length) {
    console.log(`  abstention:          ${pctStr(acc(abs))}  (n=${abs.length})`)
  }
  console.log(`\n  by question_type:`)
  for (const t of Array.from(new Set(records.map(r => r.question_type))).sort()) {
    const rs = records.filter(r => r.question_type === t)
    console.log(`    ${pad(t, 28)}${pctStr(acc(rs))}  (n=${rs.length})`)
  }
}

// ─── Re-judge ─────────────────────────────────────────────────────────────────
//
// Re-score an existing run's reader answers with a different judge. Reads the source
// checkpoint's stored hypotheses, re-judges each one, writes a new checkpoint (judge in
// the filename), and reports both the new QA accuracy and the agreement with the source
// run's judge — the calibration that tells us how far to trust a local-judge number.

async function runRejudge(): Promise<void> {
  if (!REJUDGE_FROM) {
    throw new Error('--rejudge requires --rejudge-from=<path to an existing qa_*.jsonl checkpoint>')
  }
  const judgeKey = keyFor(QA_JUDGE_URL)

  const src = await loadQaCheckpoint(REJUDGE_FROM)
  if (src.size === 0) throw new Error(`no records found in ${REJUDGE_FROM}`)

  console.log('\nLoading dataset (for questions + gold answers)…')
  const dataset = await loadDataset({ datasetOverride: DATASET_OVERRIDE, noDownload: NO_DOWNLOAD })
  const byId = new Map(dataset.map(q => [q.question_id, q]))

  // Output path = the source path with the judge segment swapped.
  const slug = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_')
  const outPath = REJUDGE_FROM.replace(/_j-.+(_k\d+\.jsonl)$/, `_j-${slug(QA_JUDGE_MODEL)}$1`)
  if (outPath === REJUDGE_FROM) {
    throw new Error(`could not derive an output path from ${REJUDGE_FROM} — expected a qa_*_j-<judge>_k<N>.jsonl name`)
  }
  const done = await loadQaCheckpoint(outPath)
  await mkdir(CACHE_DIR, { recursive: true })

  console.log('\n══════════════ RE-JUDGE ══════════════')
  console.log(`source:      ${src.size} hypotheses · ${REJUDGE_FROM}`)
  console.log(`re-judging:  ${QA_JUDGE_MODEL} @ ${QA_JUDGE_URL}`)
  console.log(`output:      ${outPath}  (${done.size} already done)`)

  const records: QaRecord[] = []
  let agree = 0, fresh = 0, judgeIn = 0, judgeOut = 0, missing = 0, i = 0
  for (const [qid, srcRec] of src) {
    i++
    let rec = done.get(qid)
    if (!rec) {
      const q = byId.get(qid)
      if (!q) { missing++; continue }
      const judge = await chatComplete(
        QA_JUDGE_URL, judgeKey, QA_JUDGE_MODEL,
        buildJudgePrompt(srcRec.question_type, q.question, q.answer, srcRec.hypothesis, srcRec.abstention),
        10,
      )
      judgeIn += judge.promptTokens; judgeOut += judge.completionTokens
      rec = { ...srcRec, judge_label: judge.content.toLowerCase().includes('yes'), judge_model: QA_JUDGE_MODEL }
      await appendFile(outPath, JSON.stringify(rec) + '\n')
      fresh++
    }
    records.push(rec)
    if (rec.judge_label === srcRec.judge_label) agree++
    if (fresh % 10 === 0 || i === src.size) {
      process.stdout.write(`  rejudge: ${i}/${src.size}  (${fresh} new this run)\r`)
    }
  }
  process.stdout.write(' '.repeat(60) + '\r')
  if (fresh > 0) console.log(`  judge tokens this run — ${judgeIn} in / ${judgeOut} out`)
  if (missing > 0) console.log(`  warning: ${missing} checkpoint id(s) not found in the dataset — skipped`)

  printQaResults(RETRIEVERS[0], records)

  const srcJudge = [...src.values()][0]?.judge_model ?? 'the source run\'s judge'
  console.log(`\n  judge agreement:     ${pctStr(agree / records.length)}  (${agree}/${records.length})`)
  console.log(`    — ${QA_JUDGE_MODEL} vs ${srcJudge}, on identical reader hypotheses`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('=== mementos End-to-End QA Benchmark (LongMemEval-S, cleaned) ===')
console.log(`node ${process.version}  ·  ${process.platform} ${os.arch()}  ·  ${new Date().toISOString().slice(0, 10)}`)
console.log(`cpu:  ${os.cpus()[0].model} ×${os.cpus().length}`)
console.log(`reader: ${QA_READER_MODEL} @ ${QA_READER_URL}`)
console.log(`judge:  ${QA_JUDGE_MODEL} @ ${QA_JUDGE_URL}`)
console.log(`retrievers: ${RETRIEVERS.join(', ')}  ·  qa-k=${QA_K}  ·  doc-mode=${DOC_MODE}  ·  seed=${SEED}`)

if (isNaN(QA_K) || QA_K <= 0) throw new Error(`--qa-k must be a positive integer`)

if (REJUDGE) {
  // Re-judge mode: re-score an existing run's answers with a different judge. No reader,
  // no retrieval, no embedding — just judge calls.
  keyFor(QA_JUDGE_URL)
  await runRejudge()
} else {
  // Pre-flight — fail before the long embed pass if a required key is missing.
  keyFor(QA_READER_URL)
  keyFor(QA_JUDGE_URL)

  console.log('\nEnsuring optional packages in plugins dir…')
  await ensurePackage('hnswlib-node', msg => console.log(' ', msg))
  console.log(' ✓ ready')

  console.log('\nLoading dataset…')
  const dataset = await loadDataset({ datasetOverride: DATASET_OVERRIDE, noDownload: NO_DOWNLOAD })
  console.log(`  ${dataset.length} questions in dataset`)

  const subset = sample(dataset, parseQuestionLimit(dataset.length), SEED)
  console.log(`  using ${subset.length} questions`)

  console.log('\nWarming embedder…')
  const { LocalEmbedder } = await import('../src/embeddings/local/index.js')
  const embedder = new LocalEmbedder()
  await embedder.embed('warmup')

  console.log(`\nEmbedding haystacks…  (${subset.reduce((s, q) => s + q.haystack_sessions.length, 0)} sessions across ${subset.length} questions)`)
  const embedT0 = performance.now()
  const prepared = await prepareQuestions(subset, embedder, DOC_MODE)
  console.log(`  done in ${((performance.now() - embedT0) / 1000).toFixed(1)}s`)

  console.log('\n══════════════ END-TO-END QA ══════════════')
  console.log(`${subset.length} question(s) × ${RETRIEVERS.length} retriever(s) — ${subset.length * RETRIEVERS.length} reader calls + ${subset.length * RETRIEVERS.length} judge calls`)
  console.log(`resumable — per-question results checkpoint to ${CACHE_DIR}/qa_*.jsonl`)

  for (const r of RETRIEVERS) {
    console.log(`\nQA · ${r}…`)
    const t0 = performance.now()
    const records = await runQa(r, prepared)
    console.log(`  done in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
    printQaResults(r, records)
  }
}

console.log('\nDone.\n')
