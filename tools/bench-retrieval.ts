#!/usr/bin/env node
/// <reference types="node" />
/**
 * mementos retrieval-quality benchmark — LongMemEval adapter.
 *
 * Runs LongMemEval-S (Xu et al., ICLR 2025 — 500 multi-session memory questions) through
 * every configured Retriever and reports retrieval recall. The retrievers are exercised
 * directly against the Retriever interface — no Vault, no encryption, no storage. This is
 * retrieval quality in isolation.
 *
 * This tool measures RETRIEVAL ONLY. For end-to-end QA accuracy (retrieval + an LLM
 * reader answering, scored by the official judge), see `tools/bench-qa.ts`.
 *
 * ── Metrics (matched to the official LongMemEval scoring) ────────────────────
 *   recall_any@k  — at least ONE evidence session in top-k. (What MemPalace reports.)
 *   recall_all@k  — ALL evidence sessions in top-k. (The LongMemEval paper's headline.)
 *   MRR           — reciprocal rank of the first evidence session.
 * Reported at k = 5 and k = 10.
 *
 * Abstention: 30 of the 500 questions are abstention instances (`question_id` ends `_abs`);
 * the official retrieval eval excludes them. Both scopes are reported.
 *
 * Granularity: one document per session. A result is correct iff its session id is in
 * `answer_session_ids`.
 *
 * Usage:
 *   npx tsx tools/bench-retrieval.ts                       # 100 questions, semantic+hybrid
 *   npx tsx tools/bench-retrieval.ts --questions=all       # full 500-question eval
 *   npx tsx tools/bench-retrieval.ts --questions=2         # tiny test run
 *   npx tsx tools/bench-retrieval.ts --retrievers=hybrid   # one retriever only
 *   npx tsx tools/bench-retrieval.ts --doc-mode=user-only  # match MemPalace's raw protocol
 *   npx tsx tools/bench-retrieval.ts --dataset=/path.json  # local file (skip download)
 *   npx tsx tools/bench-retrieval.ts --no-download         # error if cache missing
 *   npx tsx tools/bench-retrieval.ts --seed=42             # question-sampling seed
 *
 * ── --doc-mode ───────────────────────────────────────────────────────────────
 *   full       (default) — every turn `role: content`. What mementos ingests in production.
 *   user-only             — user turns only, no role prefix. MemPalace's raw protocol; use
 *                           it for a like-for-like comparison against their 96.6%.
 */
import { performance } from 'node:perf_hooks'
import os from 'node:os'
import process from 'node:process'
import { ensurePackage } from '../src/core/plugins.js'
import {
  flag, mean, pct, pctStr, pad, sample,
  loadDataset, prepareQuestions, parseDocMode, parseQuestionLimit, isAbstention,
  loadRetrieverFactory,
  type PreparedQuestion,
} from './longmemeval-common.js'

// ─── CLI args ─────────────────────────────────────────────────────────────────

const NO_DOWNLOAD = process.argv.includes('--no-download')
const DATASET_OVERRIDE = flag('dataset')
const RETRIEVERS = (flag('retrievers') ?? 'semantic,hybrid').split(',').map(s => s.trim()).filter(Boolean)
const SEED = parseInt(flag('seed') ?? '0', 10)
const DOC_MODE = parseDocMode()

/** We report recall at these k. Retrieval depth must cover the largest. */
const REPORT_KS = [5, 10] as const
const RETRIEVE_DEPTH = Math.max(...REPORT_KS)

// ─── Eval ─────────────────────────────────────────────────────────────────────

interface PerQuestion {
  type: string
  abstention: boolean
  /** 1-indexed rank of each ground-truth session id; Infinity if not in top-RETRIEVE_DEPTH. */
  hitRanks: number[]
}

async function evalRetriever(
  name: string,
  prepared: PreparedQuestion[],
): Promise<{ results: PerQuestion[]; queryMs: number[]; setupMs: number[] }> {
  const { HNSWIndex } = await import('../src/vector/hnsw/index.js')
  const create = await loadRetrieverFactory(name)

  const results: PerQuestion[] = []
  const queryMs: number[] = []
  const setupMs: number[] = []

  for (let qi = 0; qi < prepared.length; qi++) {
    const q = prepared[qi]

    const setupT0 = performance.now()
    const index = new HNSWIndex(q.docs[0]?.vec.length ?? 384)
    await index.init()
    const retriever = create(index)
    for (const d of q.docs) {
      index.add(d.id, d.vec)
      const text = q.docTexts.get(d.id) ?? ''
      retriever.add(d.id, () => text)
    }
    setupMs.push(performance.now() - setupT0)

    const queryT0 = performance.now()
    // The question string is load-bearing — HybridRetriever tokenises it for the BM25 leg.
    const top = retriever.retrieve(q.question, q.queryVec, RETRIEVE_DEPTH)
    queryMs.push(performance.now() - queryT0)

    // Rank of each ground-truth session within the retrieved list.
    const rankById = new Map<string, number>()
    top.forEach((r, i) => { if (!rankById.has(r.id)) rankById.set(r.id, i + 1) })
    const hitRanks = [...q.truthIds].map(id => rankById.get(id) ?? Infinity)

    results.push({ type: q.type, abstention: q.abstention, hitRanks })

    if ((qi + 1) % 25 === 0 || qi + 1 === prepared.length) {
      process.stdout.write(`  ${name}: ${qi + 1}/${prepared.length}\r`)
    }
  }
  process.stdout.write(' '.repeat(60) + '\r')
  return { results, queryMs, setupMs }
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/** A question is scorable for retrieval only if it has at least one evidence session. */
function scorable(q: PerQuestion): boolean {
  return q.hitRanks.length > 0
}

function recallAny(qs: PerQuestion[], k: number): number {
  return mean(qs.map(q => q.hitRanks.some(r => r <= k) ? 1 : 0))
}

function recallAll(qs: PerQuestion[], k: number): number {
  return mean(qs.map(q => q.hitRanks.every(r => r <= k) ? 1 : 0))
}

function mrr(qs: PerQuestion[]): number {
  return mean(qs.map(q => {
    const best = Math.min(...q.hitRanks)
    return Number.isFinite(best) ? 1 / best : 0
  }))
}

function printScopeTable(
  label: string,
  perRetriever: Array<{ name: string; results: PerQuestion[] }>,
  keep: (q: PerQuestion) => boolean,
): void {
  const cols = ['retriever', ...REPORT_KS.flatMap(k => [`any@${k}`, `all@${k}`]), 'MRR', 'n']
  const w = [12, ...REPORT_KS.flatMap(() => [9, 9]), 8, 7]

  const sample0 = perRetriever[0].results.filter(q => keep(q) && scorable(q))
  console.log(`\n─── ${label}  (${sample0.length} scorable questions) ───\n`)
  console.log(cols.map((c, i) => pad(c, w[i])).join(''))
  console.log(w.map(x => '─'.repeat(Math.max(0, x - 1)) + ' ').join(''))

  for (const { name, results } of perRetriever) {
    const qs = results.filter(q => keep(q) && scorable(q))
    const cells = [name]
    for (const k of REPORT_KS) {
      cells.push(pctStr(recallAny(qs, k)))
      cells.push(pctStr(recallAll(qs, k)))
    }
    cells.push(mrr(qs).toFixed(3))
    cells.push(String(qs.length))
    console.log(cells.map((c, i) => pad(c, w[i])).join(''))
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('=== mementos Retrieval Quality Benchmark (LongMemEval-S, cleaned) ===')
console.log(`node ${process.version}  ·  ${process.platform} ${os.arch()}  ·  ${new Date().toISOString().slice(0, 10)}`)
console.log(`cpu:  ${os.cpus()[0].model} ×${os.cpus().length}`)
console.log(`retrievers: ${RETRIEVERS.join(', ')}  ·  recall reported @ ${REPORT_KS.join(',')}  ·  seed=${SEED}  ·  doc-mode=${DOC_MODE}`)

console.log('\nEnsuring optional packages in plugins dir…')
await ensurePackage('hnswlib-node', msg => console.log(' ', msg))
console.log(' ✓ ready')

console.log('\nLoading dataset…')
const dataset = await loadDataset({ datasetOverride: DATASET_OVERRIDE, noDownload: NO_DOWNLOAD })
console.log(`  ${dataset.length} questions in dataset  (${dataset.filter(isAbstention).length} abstention)`)

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

const perRetriever: Array<{ name: string; results: PerQuestion[]; queryMs: number[]; setupMs: number[] }> = []
for (const r of RETRIEVERS) {
  console.log(`\nEvaluating ${r}…`)
  const t0 = performance.now()
  const ev = await evalRetriever(r, prepared)
  console.log(`  done in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
  perRetriever.push({ name: r, ...ev })
}

// ─── Results ──────────────────────────────────────────────────────────────────

console.log('\n══════════════ RESULTS ══════════════')

printScopeTable('Abstention EXCLUDED — official LongMemEval scope', perRetriever, q => !q.abstention)
printScopeTable('Abstention INCLUDED — all questions with an evidence session', perRetriever, () => true)

// ─── Per-question-type breakdown (abstention excluded, recall_all@5) ──────────

const types = Array.from(new Set(prepared.map(q => q.type))).sort()
if (types.length > 1) {
  console.log(`\n─── recall_all@5 by question_type  (abstention excluded) ───\n`)
  const typeW = Math.max('question_type'.length, ...types.map(t => t.length)) + 2
  const w = [typeW, ...perRetriever.map(() => 12), 7]
  const hdr = ['question_type', ...perRetriever.map(r => r.name), 'n']
  console.log(hdr.map((h, i) => pad(h, w[i])).join(''))
  console.log(w.map(x => '─'.repeat(Math.max(0, x - 1)) + ' ').join(''))
  for (const t of types) {
    const cells = [t]
    let n = 0
    for (const r of perRetriever) {
      const qs = r.results.filter(q => !q.abstention && q.type === t && scorable(q))
      n = qs.length
      cells.push(pctStr(recallAll(qs, 5)))
    }
    cells.push(String(n))
    console.log(cells.map((c, i) => pad(c, w[i])).join(''))
  }
}

// ─── Latency ──────────────────────────────────────────────────────────────────

console.log(`\n─── Retrieval latency ───\n`)
const lw = [12, 14, 14, 14]
console.log(['retriever', 'query p50', 'query p95', 'setup p50'].map((c, i) => pad(c, lw[i])).join(''))
console.log(lw.map(x => '─'.repeat(Math.max(0, x - 1)) + ' ').join(''))
for (const r of perRetriever) {
  console.log([
    r.name,
    `${pct(r.queryMs, 50).toFixed(3)} ms`,
    `${pct(r.queryMs, 95).toFixed(3)} ms`,
    `${pct(r.setupMs, 50).toFixed(0)} ms`,
  ].map((c, i) => pad(c, lw[i])).join(''))
}

console.log('\nDone.\n')
