/// <reference types="node" />
/**
 * Shared LongMemEval plumbing for the benchmark tools.
 *
 * Both `bench-retrieval.ts` (retrieval recall) and `bench-qa.ts` (end-to-end QA accuracy)
 * need the same first stage: download the dataset, embed every haystack session, and hand
 * back a list of per-question structures ready to retrieve over. That stage lives here so
 * the two tools don't drift.
 *
 * Dataset: the CLEANED LongMemEval-S (`longmemeval_s_cleaned.json`, ~277 MB) from
 * huggingface.co/datasets/xiaowu0162/longmemeval-cleaned. The original release was
 * deprecated 2025/09 and gives non-comparable numbers. No HF auth required.
 *
 * Embedding cache: each unique session/question text is embedded once and cached to
 * ~/.cache/mementos/ keyed by SHA-256 of the text. Append-only and written incrementally,
 * so an interrupted run keeps its progress and a re-run is near-instant.
 */
import { performance } from 'node:perf_hooks'
import { mkdir, readFile, stat, appendFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { join } from 'node:path'
import os from 'node:os'
import process from 'node:process'

// ─── CLI helper ───────────────────────────────────────────────────────────────

/** Read a `--name=value` flag from argv. Returns undefined if absent. */
export function flag(name: string): string | undefined {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`))
  return arg ? arg.slice(name.length + 3) : undefined
}

// ─── Small numeric / formatting helpers ───────────────────────────────────────

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

export function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)]
}

export function pctStr(x: number): string {
  return (x * 100).toFixed(1) + '%'
}

export function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length)
}

// ─── Deterministic sampling (seeded Fisher-Yates) ─────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return function () {
    s = s + 0x6D2B79F5 | 0
    let t = Math.imul(s ^ s >>> 15, 1 | s)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

export function sample<T>(arr: T[], n: number, seed: number): T[] {
  if (n >= arr.length) return arr.slice()
  const rng = mulberry32(seed)
  const idxs = Array.from({ length: arr.length }, (_, i) => i)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[idxs[i], idxs[j]] = [idxs[j], idxs[i]]
  }
  return idxs.slice(0, n).map(i => arr[i])
}

// ─── Dataset ──────────────────────────────────────────────────────────────────

const DATASET_URL = 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json'
export const CACHE_DIR = join(os.homedir(), '.cache', 'mementos')
const CACHE_PATH = join(CACHE_DIR, 'longmemeval_s_cleaned.json')

export interface LongMemEvalTurn { role: string; content: string; has_answer?: true }
export interface LongMemEvalQuestion {
  question_id: string
  question_type: string
  question: string
  answer: string
  question_date: string
  haystack_session_ids: string[]
  haystack_dates: string[]
  haystack_sessions: LongMemEvalTurn[][]
  answer_session_ids: string[]
}

/** Abstention instances are flagged purely by a `_abs` suffix on the question id. */
export function isAbstention(q: LongMemEvalQuestion): boolean {
  return q.question_id.includes('_abs')
}

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

export async function loadDataset(
  opts: { datasetOverride?: string; noDownload: boolean },
): Promise<LongMemEvalQuestion[]> {
  const path = opts.datasetOverride ?? CACHE_PATH
  const exists = await fileExists(path)

  if (!exists) {
    if (opts.datasetOverride) {
      throw new Error(`Dataset file not found at ${path}. Check the --dataset path.`)
    }
    if (opts.noDownload) {
      throw new Error(
        `Dataset not cached at ${path} and --no-download was passed.\n` +
        `Download manually:\n` +
        `  mkdir -p ${CACHE_DIR}\n` +
        `  curl -L -o ${CACHE_PATH} ${DATASET_URL}\n`
      )
    }
    await mkdir(CACHE_DIR, { recursive: true })
    console.log(`Downloading LongMemEval-S (cleaned, ~277 MB) from HuggingFace…`)
    const t0 = performance.now()
    const res = await fetch(DATASET_URL)
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`)
    if (!res.body) throw new Error('No response body from HuggingFace')
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(path))
    console.log(`  done in ${((performance.now() - t0) / 1000).toFixed(1)}s → ${path}`)
  }

  console.log(`  parsing ${path}…`)
  const raw = await readFile(path, 'utf8')
  const data = JSON.parse(raw) as LongMemEvalQuestion[]
  if (!Array.isArray(data) || !data.length) {
    throw new Error('Dataset is not a non-empty JSON array')
  }
  return data
}

// ─── Document composition ─────────────────────────────────────────────────────

export type DocMode = 'full' | 'user-only'

/**
 * Flatten a session into one document to embed.
 *   full       — every turn as `role: content`, joined. What mementos ingests in production.
 *   user-only  — user turns only, content joined, no role prefix. MemPalace's raw protocol.
 */
export function sessionText(session: LongMemEvalTurn[], docMode: DocMode): string {
  if (docMode === 'user-only') {
    return session.filter(t => t.role === 'user').map(t => t.content).join('\n')
  }
  return session.map(t => `${t.role}: ${t.content}`).join('\n')
}

// ─── Embedding cache ──────────────────────────────────────────────────────────
//
// Append-only binary file: an 8-byte header [magic u32][dim u32] then fixed-size records
// [32-byte SHA-256 of text][dim × float32 vector]. The loader reads as many whole records
// as the file length permits, so a torn tail from an interrupted write is ignored.

const EMB_MAGIC = 0x4d454d31 // "MEM1"
const EMB_CACHE_PATH = join(CACHE_DIR, 'longmemeval_embcache_local.bin')

interface EmbCache {
  map: Map<string, Float32Array>
  dim: number
  headerReady: boolean
}

function textHashHex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function loadEmbCache(path: string, dim: number): Promise<EmbCache> {
  const map = new Map<string, Float32Array>()
  let buf: Buffer
  try {
    buf = await readFile(path)
  } catch {
    return { map, dim, headerReady: false }
  }
  if (buf.length < 8 || buf.readUInt32LE(0) !== EMB_MAGIC || buf.readUInt32LE(4) !== dim) {
    return { map, dim, headerReady: false }
  }
  const recSize = 32 + dim * 4
  let off = 8
  while (off + recSize <= buf.length) {
    const hash = buf.subarray(off, off + 32).toString('hex')
    const vec = new Float32Array(dim)
    for (let i = 0; i < dim; i++) vec[i] = buf.readFloatLE(off + 32 + i * 4)
    map.set(hash, vec)
    off += recSize
  }
  return { map, dim, headerReady: true }
}

async function appendEmbRecords(
  cache: EmbCache,
  records: Array<{ hash: string; vec: Float32Array }>,
): Promise<void> {
  if (records.length === 0) return
  const recSize = 32 + cache.dim * 4
  const headerBytes = cache.headerReady ? 0 : 8
  const buf = Buffer.alloc(headerBytes + records.length * recSize)
  let off = 0
  if (!cache.headerReady) {
    buf.writeUInt32LE(EMB_MAGIC, 0)
    buf.writeUInt32LE(cache.dim, 4)
    off = 8
  }
  for (const { hash, vec } of records) {
    Buffer.from(hash, 'hex').copy(buf, off)
    off += 32
    for (let i = 0; i < cache.dim; i++) buf.writeFloatLE(vec[i], off + i * 4)
    off += cache.dim * 4
  }
  await mkdir(CACHE_DIR, { recursive: true })
  await appendFile(EMB_CACHE_PATH, buf)
  cache.headerReady = true
  for (const { hash, vec } of records) cache.map.set(hash, vec)
}

// ─── Embedding pass ───────────────────────────────────────────────────────────

export interface PreparedQuestion {
  docs: Array<{ id: string; vec: Float32Array }>
  docTexts: Map<string, string>
  question: string
  queryVec: Float32Array
  truthIds: Set<string>
  type: string
  abstention: boolean
  /** The raw dataset entry — the QA stage needs full sessions, dates, the gold answer. */
  raw: LongMemEvalQuestion
}

export interface Embedder {
  embed(t: string): Promise<Float32Array>
  embedBatch(ts: string[]): Promise<Float32Array[]>
  readonly dimensions: number
}

/**
 * Embed every haystack session + every question, using the on-disk cache. Unique texts
 * (deduplicated by hash) are embedded once; misses are batched, embedded, and appended to
 * the cache as we go so progress survives an interrupt.
 */
export async function prepareQuestions(
  questions: LongMemEvalQuestion[],
  embedder: Embedder,
  docMode: DocMode,
): Promise<PreparedQuestion[]> {
  const cache = await loadEmbCache(EMB_CACHE_PATH, embedder.dimensions)
  console.log(`  embedding cache: ${cache.map.size} vectors already cached`)

  const wanted = new Map<string, string>()    // hash -> text, misses only
  const seen = new Set<string>()              // every distinct hash this run needs
  const perQ = questions.map(q => {
    const docs = q.haystack_sessions.map((session, i) => {
      const text = sessionText(session, docMode)
      const hash = textHashHex(text)
      seen.add(hash)
      if (!cache.map.has(hash)) wanted.set(hash, text)
      return { id: q.haystack_session_ids[i], text, hash }
    })
    const qHash = textHashHex(q.question)
    seen.add(qHash)
    if (!cache.map.has(qHash)) wanted.set(qHash, q.question)
    return { q, docs, qHash }
  })

  const misses = [...wanted.entries()]
  console.log(`  ${seen.size} distinct texts needed — ${misses.length} to embed, ${seen.size - misses.length} reused from cache`)

  const BATCH = 256
  let done = 0
  for (let start = 0; start < misses.length; start += BATCH) {
    const chunk = misses.slice(start, start + BATCH)
    const vecs = await embedder.embedBatch(chunk.map(([, text]) => text))
    await appendEmbRecords(cache, chunk.map(([hash], i) => ({ hash, vec: vecs[i] })))
    done += chunk.length
    process.stdout.write(`  embed: ${done}/${misses.length}\r`)
  }
  if (misses.length) process.stdout.write(' '.repeat(60) + '\r')

  const mustGet = (hash: string): Float32Array => {
    const v = cache.map.get(hash)
    if (!v) throw new Error(`embedding missing for hash ${hash} — cache assembly bug`)
    return v
  }
  return perQ.map(({ q, docs, qHash }) => {
    const docTexts = new Map<string, string>()
    for (const d of docs) docTexts.set(d.id, d.text)
    return {
      docs: docs.map(d => ({ id: d.id, vec: mustGet(d.hash) })),
      docTexts,
      question: q.question,
      queryVec: mustGet(qHash),
      truthIds: new Set(q.answer_session_ids),
      type: q.question_type,
      abstention: isAbstention(q),
      raw: q,
    }
  })
}

// ─── Retriever helper ─────────────────────────────────────────────────────────

export interface RetrieverInstance {
  add(id: string, decryptText: () => string): void
  retrieve(
    query: string, queryVector: Float32Array, k: number, allowed?: ReadonlySet<string>,
  ): Array<{ id: string; distance: number }>
}

/** Load an auto-discovered retriever implementation by name (`semantic`, `hybrid`, …). */
export async function loadRetrieverFactory(name: string): Promise<(idx: unknown) => RetrieverInstance> {
  const mod = await import(`../src/retrievers/${name}/index.js`) as {
    create: (idx: unknown) => RetrieverInstance
  }
  return mod.create
}

/** Parse `--doc-mode`, throwing on an invalid value. */
export function parseDocMode(): DocMode {
  const v = flag('doc-mode') ?? 'full'
  if (v !== 'full' && v !== 'user-only') {
    throw new Error(`--doc-mode must be 'full' or 'user-only', got '${v}'`)
  }
  return v
}

/** Parse `--questions` (positive integer or 'all') against a dataset size. */
export function parseQuestionLimit(datasetSize: number): number {
  const raw = flag('questions') ?? '100'
  if (raw === 'all') return datasetSize
  const n = parseInt(raw, 10)
  if (isNaN(n) || n <= 0) throw new Error(`--questions must be a positive integer or 'all'`)
  return n
}
