#!/usr/bin/env node
/// <reference types="node" />
/**
 * mementos performance benchmark.
 *
 * Usage:  npx tsx tools/bench.ts [--no-embed] [--no-scale] [--no-cold] [--no-retrievers]
 *
 * Installs hnswlib-node into ~/.config/mementos/plugins/ on first run (same location
 * as `mementos init`). Subsequent runs skip the install step.
 *
 * Sections:
 *   1. MinilmEmbedder  — cold start, warm single embed, embedBatch throughput
 *   2. HNSWIndex      — build 10K, serialize, load, search k=5/20 (p50/p95/p99)
 *   3. Memory RAM     — RSS delta for a 10K HNSW index
 *   4. Scale curve    — search p50 at 1K / 5K / 10K / 50K
 *                       (pass --no-scale to skip; each scale builds a fresh index)
 *   5. Cold start     — real vault startup: read N encrypted .mem files from disk,
 *                       decrypt, rebuild index (cold) vs load cache (warm).
 *                       Uses a tmp dir; cleaned up after each run.
 *   6. Retrievers     — Semantic vs Hybrid through the full Vault stack: cold start cost
 *                       (Hybrid pays extra to tokenise every memory's text into BM25),
 *                       vault.recall p50/p95, RSS delta.
 *                       For retrieval *quality* numbers (R@5/MRR on LongMemEval),
 *                       see `tools/bench-retrieval.ts`.
 *   8. Searchers      — none / scan / trigram lexical searchers: retained RAM over a 10K
 *                       corpus and query latency on a rare term (trigram's best case) vs
 *                       a common term (trigram cannot narrow). Run with `--expose-gc`
 *                       for stable retained-RAM numbers.
 *
 * Skip flags:
 *   --no-embed       skip the MinilmEmbedder section (saves ~30s first run)
 *   --no-scale       skip the scaling curve (saves several minutes)
 *   --no-cold        skip the cold/warm startup section
 *   --no-retrievers  skip the retriever comparison section
 *   --no-searchers   skip the searcher comparison section
 */
import { performance } from 'node:perf_hooks'
import { randomBytes, randomUUID } from 'node:crypto'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { ensurePackage } from '../src/core/plugins.js'

const NO_EMBED      = process.argv.includes('--no-embed')
const NO_SCALE      = process.argv.includes('--no-scale')
const NO_COLD       = process.argv.includes('--no-cold')
const NO_RETRIEVERS = process.argv.includes('--no-retrievers')
const NO_SEARCHERS  = process.argv.includes('--no-searchers')

// ─── Utilities ────────────────────────────────────────────────────────────────

function pct(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)]
}

function ms(n: number, dp = 2): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n.toFixed(dp)} ms`
}

function fmtN(n: number): string {
  return n.toLocaleString('en-US')
}

function col(s: string, w: number, right = false): string {
  return right ? s.padStart(w) : s.padEnd(w)
}

async function timeIt(fn: () => unknown): Promise<number> {
  const t0 = performance.now()
  await fn()
  return performance.now() - t0
}

async function timeSamples(fn: () => unknown, n: number): Promise<number[]> {
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    await fn()
    out.push(performance.now() - t0)
  }
  return out
}

function randVec(dim: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) v[i] = Math.random() * 2 - 1
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  for (let i = 0; i < dim; i++) v[i] /= norm
  return v
}

function section(title: string): void {
  const bar = '─'.repeat(60)
  console.log(`\n${bar}`)
  console.log(` ${title}`)
  console.log(bar)
}

function row(label: string, value: string): void {
  console.log(` ${col(label, 38)} ${value}`)
}

// ─── Header ───────────────────────────────────────────────────────────────────

console.log('=== mementos Performance Benchmark ===')
console.log(`node ${process.version}  ·  ${process.platform} ${os.arch()}  ·  ${new Date().toISOString().slice(0, 10)}`)
console.log(`cpu:  ${os.cpus()[0].model} ×${os.cpus().length}`)
console.log(`ram:  ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(0)} GB`)

// ─── Install optional packages ────────────────────────────────────────────────

console.log('\nEnsuring optional packages in plugins dir…')
await ensurePackage('hnswlib-node', msg => console.log(' ', msg))
console.log(' ✓ all packages ready')

// ─── Constants ────────────────────────────────────────────────────────────────

const DIM = 384            // all-MiniLM-L6-v2 output dimension
const N_MAIN = 10_000      // entries for the main index benchmarks
const N_SEARCH = 1_000     // search queries per benchmark
const N_EMBED_WARM = 100   // warm embed samples

// ─── 1. MinilmEmbedder ─────────────────────────────────────────────────────────

if (!NO_EMBED) {
  section(`MinilmEmbedder  (all-MiniLM-L6-v2 · ONNX · ${DIM}-dim)`)

  const { MinilmEmbedder } = await import('../src/embeddings/minilm/index.js')
  const embedder = new MinilmEmbedder()

  const TEXTS = [
    'The user prefers dark mode in all editors.',
    'TypeScript strict mode should always be enabled.',
    'Always write tests before shipping to production.',
    'Coffee preference: oat milk flat white.',
    'Preferred keyboard layout is QWERTY with Vim motions.',
    'Never use var — use const by default, let when needed.',
    'Design decisions should be documented in DESIGN.md.',
    'The project uses vitest for all unit and integration tests.',
    'Commit messages should be short — 1 or 2 sentences max.',
    'The API uses MCP for AI tool integration.',
  ]

  const coldMs = await timeIt(() => embedder.embed(TEXTS[0]))
  row('cold start (first embed)', ms(coldMs, 0))

  const warmSamples = await timeSamples(
    () => embedder.embed(TEXTS[Math.floor(Math.random() * TEXTS.length)]),
    N_EMBED_WARM,
  )
  row(
    `warm single embed  (p50/p95/p99, n=${N_EMBED_WARM})`,
    `${ms(pct(warmSamples, 50))} / ${ms(pct(warmSamples, 95))} / ${ms(pct(warmSamples, 99))}`,
  )

  // Sequential vs batch
  const SEQ_N = 20
  const seqTexts = Array.from({ length: SEQ_N }, (_, i) => TEXTS[i % TEXTS.length])
  const seqMs = await timeIt(async () => {
    for (const t of seqTexts) await embedder.embed(t)
  })
  const batchMs = await timeIt(() => embedder.embedBatch(seqTexts))
  row(`sequential (${SEQ_N} calls)`, `${ms(seqMs, 0)}  →  ${ms(seqMs / SEQ_N)} / text`)
  row(`embedBatch  (${SEQ_N} texts, 1 call)`, `${ms(batchMs, 0)}  →  ${ms(batchMs / SEQ_N)} / text  (${(seqMs / batchMs).toFixed(1)}× faster)`)
}

// ─── Build helpers ────────────────────────────────────────────────────────────

function makeIds(n: number): string[] {
  return Array.from({ length: n }, () => randomBytes(8).toString('hex'))
}

function makeVecs(n: number, dim: number): Float32Array[] {
  return Array.from({ length: n }, () => randVec(dim))
}

const ids = makeIds(N_MAIN)
const vecs = makeVecs(N_MAIN, DIM)
const queryVecs = makeVecs(N_SEARCH, DIM)

// ─── 2. HNSWIndex ─────────────────────────────────────────────────────────────

section(`HNSWIndex  (hnswlib-node · cosine · ${DIM}-dim · n=${fmtN(N_MAIN)})`)

const { HNSWIndex } = await import('../src/vector/hnsw/index.js')
const hnsw = new HNSWIndex(DIM)
await hnsw.init()

const hnswBuildMs = await timeIt(() => { for (let i = 0; i < N_MAIN; i++) hnsw.add(ids[i], vecs[i]) })
row(`build  ${fmtN(N_MAIN)} vectors`, `${ms(hnswBuildMs, 0)}  →  ${(N_MAIN / hnswBuildMs * 1000).toFixed(0)} vec/s`)

let hnswBytes!: Buffer
const hnswSerMs = await timeIt(async () => { hnswBytes = await hnsw.serialize() })
row(`serialize`, `${ms(hnswSerMs)}  (${(hnswBytes.byteLength / 1024 / 1024).toFixed(1)} MB on disk)`)

const hnswLoad = new HNSWIndex(DIM)
await hnswLoad.init()
const hnswLoadMs = await timeIt(() => hnswLoad.load(hnswBytes))
row(`load (warm cache)`, ms(hnswLoadMs))

const hnswS5 = await timeSamples(() => hnsw.search(queryVecs[Math.floor(Math.random() * N_SEARCH)], 5), N_SEARCH)
row(`search k=5   (p50/p95/p99, n=${fmtN(N_SEARCH)})`, `${ms(pct(hnswS5, 50), 3)} / ${ms(pct(hnswS5, 95), 3)} / ${ms(pct(hnswS5, 99), 3)}`)

const hnswS20 = await timeSamples(() => hnsw.search(queryVecs[Math.floor(Math.random() * N_SEARCH)], 20), N_SEARCH)
row(`search k=20  (p50/p95/p99)`, `${ms(pct(hnswS20, 50), 3)} / ${ms(pct(hnswS20, 95), 3)} / ${ms(pct(hnswS20, 99), 3)}`)

// ─── 3. RAM footprint ─────────────────────────────────────────────────────────

section(`RAM footprint  (${fmtN(N_MAIN)} vectors · ${DIM}-dim)`)

// Measure RSS before and after building a fresh index (GC first for a cleaner baseline)
;(globalThis as { gc?: () => void }).gc?.()
const rssBefore = process.memoryUsage().rss

const hnswRam = new HNSWIndex(DIM)
await hnswRam.init()
for (let i = 0; i < N_MAIN; i++) hnswRam.add(ids[i], vecs[i])
const rssAfterHnsw = process.memoryUsage().rss
row(`HNSWIndex RSS delta`, `~${((rssAfterHnsw - rssBefore) / 1024 / 1024).toFixed(0)} MB`)

// ─── 4. Scaling curve ─────────────────────────────────────────────────────────

if (!NO_SCALE) {
  section('Search latency scaling  (k=5 · cosine · 384-dim · p50)')

  const SCALES = [1_000, 5_000, 10_000, 50_000]
  const SCALE_Q = 200

  console.log(` ${'vectors'.padStart(8)}   ${'build'.padStart(12)}   ${'k=5 p50'.padStart(10)}`)
  for (const scale of SCALES) {
    const sIds = makeIds(scale)
    const sVecs = makeVecs(scale, DIM)
    const sQ = makeVecs(SCALE_Q, DIM)

    const h = new HNSWIndex(DIM)
    await h.init()
    const hBuild = await timeIt(() => { for (let i = 0; i < scale; i++) h.add(sIds[i], sVecs[i]) })
    const hSamples = await timeSamples(() => h.search(sQ[Math.floor(Math.random() * SCALE_Q)], 5), SCALE_Q)

    console.log(
      ` ${fmtN(scale).padStart(8)}` +
      `   ${ms(hBuild, 0).padStart(12)}` +
      `   ${ms(pct(hSamples, 50), 3).padStart(10)}`,
    )
  }
}

// ─── 6. Cold / warm startup ───────────────────────────────────────────────────
//
// Simulates the real first-boot experience: N encrypted .mem files already on disk
// (written by a prior session), no index cache. Measures how long vault.startup()
// takes to read all files, decrypt each one, and rebuild the vector index.
//
// Files are written directly (bypassing Vault's lock/dedup) so the setup phase is
// fast. Startup() itself uses Promise.all internally — same as production code.
// A second startup() on the same dir measures the warm (cache hit) path.
//
// Each scale runs in its own tmp dir and is cleaned up before the next scale.

if (!NO_COLD) {
  section('Cold / warm startup  (disk read + decrypt + index rebuild)')

  const { Vault } = await import('../src/core/vault/index.js')
  const { LocalBackend } = await import('../src/storage/local/index.js')
  const { MnemonicKeyProvider } = await import('../src/keys/mnemonic/index.js')
  const { SemanticRetriever } = await import('../src/retrievers/semantic/index.js')
  const { NoneSearcher } = await import('../src/searchers/none/index.js')
  const { encryptMemPayloads } = await import('../src/core/vault/aad.js')
  const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'

  // Throwaway embedder — startup() reads stored vectors, never calls embed()
  const benchEmbedder = {
    dimensions: DIM,
    async embed(_: string) { return randVec(DIM) },
    async embedBatch(ts: string[]) { return ts.map(() => randVec(DIM)) },
  }

  // Pre-derive the key once (avoids paying key-derivation cost inside the timed section)
  const keyProvider = new MnemonicKeyProvider(MNEMONIC)
  const key = await keyProvider.getKey()

  async function populateDir(dir: string, n: number, batchSize = 200): Promise<void> {
    // Write in bounded batches to avoid creating thousands of in-flight allocations
    // (each file needs a randVec + encrypted buffers — unbounded Promise.all at 100K
    // exhausts memory before the first file finishes writing).
    for (let start = 0; start < n; start += batchSize) {
      const end = Math.min(start + batchSize, n)
      await Promise.all(Array.from({ length: end - start }, async () => {
        const id = randomUUID()
        const now = new Date().toISOString()
        const chunks = [{ text: `bench memory ${id}`, vector: Array.from(randVec(DIM)) }]
        const meta = { created_at: now, updated_at: now, tags: [] }
        const encrypted = encryptMemPayloads(id, key, {
          chunks: Buffer.from(JSON.stringify(chunks), 'utf8'),
          meta: Buffer.from(JSON.stringify(meta), 'utf8'),
        })
        const mem = { id, ...encrypted }
        await writeFile(join(dir, `${id}.mem`), JSON.stringify(mem))
      }))
    }
  }

  // 100K is opt-in: pass --with-100k to include it (takes several minutes to populate)
  const WITH_100K = process.argv.includes('--with-100k')
  const COLD_SCALES = WITH_100K ? [1_000, 5_000, 10_000, 100_000] : [1_000, 5_000, 10_000]
  console.log(` ${'memories'.padStart(10)}   ${'populate'.padStart(10)}   ${'cold start'.padStart(12)}   ${'warm start'.padStart(12)}`)

  for (const n of COLD_SCALES) {
    const dir = await mkdtemp(join(os.tmpdir(), 'mementos-bench-'))
    try {
      // Setup: write files (not timed as "startup" — this is a one-time population cost)
      const populateMs = await timeIt(() => populateDir(dir, n))

      // Cold startup: no cache exists yet
      const coldIndex = new HNSWIndex(DIM)
      const coldVault = new Vault({
        storage: new LocalBackend(dir),
        embedder: benchEmbedder,
        index: coldIndex,
        retriever: new SemanticRetriever(coldIndex),
        searcher: new NoneSearcher(),
        keys: new MnemonicKeyProvider(MNEMONIC),
        lockPath: dir,
        syncIntervalMs: Infinity,  // disable periodic sync during bench
      })
      const coldMs = await timeIt(() => coldVault.startup())

      // Flush + close the cold vault so the encrypted HNSW cache is actually on disk
      // before the warm vault opens. Without this, warm.startup() finds no cache and
      // pays the full rebuild cost again — and the "warm" number is a second cold run.
      await coldVault.close()

      // Warm startup: cache written by coldVault.close() above
      const warmIndex = new HNSWIndex(DIM)
      const warmVault = new Vault({
        storage: new LocalBackend(dir),
        embedder: benchEmbedder,
        index: warmIndex,
        retriever: new SemanticRetriever(warmIndex),
        searcher: new NoneSearcher(),
        keys: new MnemonicKeyProvider(MNEMONIC),
        lockPath: dir,
        syncIntervalMs: Infinity,
      })
      const warmMs = await timeIt(() => warmVault.startup())
      await warmVault.close()

      console.log(
        ` ${fmtN(n).padStart(10)}` +
        `   ${ms(populateMs, 0).padStart(10)}` +
        `   ${ms(coldMs, 0).padStart(12)}` +
        `   ${ms(warmMs, 0).padStart(12)}`,
      )
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      // proper-lockfile leaves a sibling .lock dir
      await rm(dir + '.lock', { recursive: true, force: true }).catch(() => {})
    }
  }
}

// ─── 7. Retrievers through Vault ──────────────────────────────────────────────
//
// Compares SemanticRetriever and HybridRetriever exercised through the full Vault stack
// (encryption + storage + index + retriever). Each variant pays Vault's per-memory
// decrypt cost at startup; HybridRetriever additionally tokenises every memory's
// plaintext into its BM25 inverted index, so its startup is meaningfully slower.
//
// We measure:
//   - cold startup        (no cache exists; rebuild HNSW + retriever-add for every memory)
//   - warm startup        (cached HNSW; retriever-add still runs because the BM25
//                          inverted index is RAM-only with no persistent cache)
//   - vault.recall p50/p95   (over the same query distribution per variant)
//
// We deliberately don't report a per-retriever RSS delta here — variants share one node
// process, allocator state and GC timing leak across them, and the delta misrepresents
// real RAM cost. The dense-index RAM cost is already covered in section 4; the extra
// cost of HybridRetriever is dominated by BM25 postings (~O(unique tokens × avg postings)),
// in the low-tens-of-MB range at personal-vault scales.
//
// Per-variant flow: encrypted .mem files are populated ONCE per scale, then each variant
// gets its own fresh Vault on a copy of that dir (the HNSW cache from one variant must
// not leak into the next — both variants start from the same cold baseline).

if (!NO_RETRIEVERS) {
  section('Retrievers through Vault  (semantic vs hybrid — full encrypt + storage stack)')

  const { Vault } = await import('../src/core/vault/index.js')
  const { LocalBackend } = await import('../src/storage/local/index.js')
  const { MnemonicKeyProvider } = await import('../src/keys/mnemonic/index.js')
  const { SemanticRetriever } = await import('../src/retrievers/semantic/index.js')
  const { HybridRetriever } = await import('../src/retrievers/hybrid/index.js')
  const { NoneSearcher } = await import('../src/searchers/none/index.js')
  const { encryptMemPayloads } = await import('../src/core/vault/aad.js')
  const { copyFile, readdir } = await import('node:fs/promises')

  const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'
  const benchEmbedder = {
    dimensions: DIM,
    async embed(_: string) { return randVec(DIM) },
    async embedBatch(ts: string[]) { return ts.map(() => randVec(DIM)) },
  }

  const keyProvider = new MnemonicKeyProvider(MNEMONIC)
  const key = await keyProvider.getKey()

  // ── Vocabulary-driven text generator ──
  // Hybrid retriever wants tokenisable, varied text — `bench memory ${id}` would just
  // fill the BM25 inverted index with shared boilerplate and tell us nothing. A small
  // vocabulary (~200 words) drawn into 20-word sentences gives BM25 something to index
  // while keeping the corpus deterministic.
  const VOCAB = (
    'project user device sync hook embedder retriever vault config storage backend ' +
    'memory encrypted vector index query token corpus fusion semantic hybrid keyword ' +
    'session conversation message turn assistant role context window history transcript ' +
    'commit branch remote pull push clone migrate destroy doctor init share mount cache ' +
    'design decision document module factory implementation registry contract interface ' +
    'fast slow build serialize deserialize load search add remove update insert delete ' +
    'json file directory path absolute relative encoding base random uuid hash hex bytes ' +
    'lockfile semaphore mutex thread process worker queue stream chunk buffer batch parallel ' +
    'docker postgres sqlite redis kafka mongo nginx envoy linker compiler typescript node ' +
    'darwin linux windows arm intel apple silicon network wifi ethernet latency throughput ' +
    'pipeline benchmark percentile median average mean rolling window observe metric report'
  ).split(/\s+/)

  function makeText(seed: number): string {
    // Deterministic 20-word sentence from VOCAB. Same `seed` → same text, so a single
    // randomised seed-stream produces a stable corpus per run.
    const out: string[] = []
    let s = seed | 0
    for (let i = 0; i < 20; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) | 0
      out.push(VOCAB[(s >>> 0) % VOCAB.length])
    }
    return out.join(' ')
  }

  async function populateCorpus(dir: string, n: number, batchSize = 200): Promise<void> {
    for (let start = 0; start < n; start += batchSize) {
      const end = Math.min(start + batchSize, n)
      await Promise.all(Array.from({ length: end - start }, async (_, k) => {
        const id = randomUUID()
        const now = new Date().toISOString()
        const chunks = [{ text: makeText(start + k), vector: Array.from(randVec(DIM)) }]
        const meta = { created_at: now, updated_at: now, tags: [] }
        const encrypted = encryptMemPayloads(id, key, {
          chunks: Buffer.from(JSON.stringify(chunks), 'utf8'),
          meta: Buffer.from(JSON.stringify(meta), 'utf8'),
        })
        const mem = { id, ...encrypted }
        await writeFile(join(dir, `${id}.mem`), JSON.stringify(mem))
      }))
    }
  }

  async function cloneCorpusDir(src: string): Promise<string> {
    const dst = await mkdtemp(join(os.tmpdir(), 'mementos-bench-r-'))
    const entries = await readdir(src)
    await Promise.all(entries.map(name => copyFile(join(src, name), join(dst, name))))
    return dst
  }

  function makeRetriever(kind: 'semantic' | 'hybrid', index: InstanceType<typeof HNSWIndex>) {
    return kind === 'hybrid' ? new HybridRetriever(index) : new SemanticRetriever(index)
  }

  // Pre-generate one query pool drawn from the same vocab so BM25 has real matches.
  const QUERIES = 200
  const queryTexts = Array.from({ length: QUERIES }, (_, i) => makeText(0x5A5A5A5A ^ i))

  const SCALES = [1_000, 10_000]
  console.log(
    ` ${'memories'.padStart(8)}   ${'retriever'.padStart(10)}` +
    `   ${'cold start'.padStart(10)}   ${'warm start'.padStart(10)}` +
    `   ${'retrieve p50'.padStart(12)}   ${'retrieve p95'.padStart(12)}`,
  )

  for (const n of SCALES) {
    const sourceDir = await mkdtemp(join(os.tmpdir(), 'mementos-bench-r-src-'))
    try {
      await populateCorpus(sourceDir, n)

      for (const kind of ['semantic', 'hybrid'] as const) {
        // Each variant gets a fresh dir so the cache from the previous variant doesn't
        // leak in. Copying is much cheaper than re-populating (no encrypt work).
        const dir = await cloneCorpusDir(sourceDir)
        try {
          // Cold: no cache yet
          const coldIndex = new HNSWIndex(DIM)
          const coldVault = new Vault({
            storage: new LocalBackend(dir),
            embedder: benchEmbedder,
            index: coldIndex,
            retriever: makeRetriever(kind, coldIndex),
            searcher: new NoneSearcher(),
            keys: new MnemonicKeyProvider(MNEMONIC),
            lockPath: dir,
            syncIntervalMs: Infinity,
          })
          const coldMs = await timeIt(() => coldVault.startup())

          // Warm queries: replay the same Vault — HNSW cache + retriever state both live.
          const queryMs = await timeSamples(
            () => coldVault.recall(queryTexts[Math.floor(Math.random() * QUERIES)], 5),
            QUERIES,
          )

          // Flush + close so the encrypted HNSW cache is on disk before the warm vault
          // opens. Without this, warm.startup() finds no cache and pays the full rebuild
          // cost — the "warm" number is a second cold run.
          await coldVault.close()

          // Warm startup: fresh Vault over the same dir — HNSW cache was saved by the
          // cold run's close, but the retriever has to rebuild its in-RAM state either way.
          const warmIndex = new HNSWIndex(DIM)
          const warmVault = new Vault({
            storage: new LocalBackend(dir),
            embedder: benchEmbedder,
            index: warmIndex,
            retriever: makeRetriever(kind, warmIndex),
            searcher: new NoneSearcher(),
            keys: new MnemonicKeyProvider(MNEMONIC),
            lockPath: dir,
            syncIntervalMs: Infinity,
          })
          const warmMs = await timeIt(() => warmVault.startup())
          await warmVault.close()

          console.log(
            ` ${fmtN(n).padStart(8)}   ${kind.padStart(10)}` +
            `   ${ms(coldMs, 0).padStart(10)}   ${ms(warmMs, 0).padStart(10)}` +
            `   ${ms(pct(queryMs, 50)).padStart(12)}   ${ms(pct(queryMs, 95)).padStart(12)}`,
          )
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => {})
          await rm(dir + '.lock', { recursive: true, force: true }).catch(() => {})
        }
      }
    } finally {
      await rm(sourceDir, { recursive: true, force: true }).catch(() => {})
      await rm(sourceDir + '.lock', { recursive: true, force: true }).catch(() => {})
    }
  }
}

// ─── 8. Searchers ─────────────────────────────────────────────────────────────
//
// Lexical-search backends exercised directly (no Vault): build a 10K-memento text corpus,
// feed it to each Searcher, and measure the two things that decide whether `trigram` is
// worth choosing over `scan`:
//
//   - retained RAM    heapUsed delta after the searcher has indexed the whole corpus.
//                     Text is regenerated lazily inside the `add` thunk so the searcher
//                     holds the ONLY reference — the delta therefore counts the text.
//                     Run with `--expose-gc` for stable numbers (gc is forced around the
//                     measurement; without it the figure is approximate).
//   - query latency   p50 on a rare term (one matching memento — trigram narrows to it)
//                     and on a common term (matches almost everything — trigram cannot
//                     narrow, so it degrades to a scan plus index overhead).
//
// `scan` holds only the text map; `trigram` adds an inverted trigram index on top — the
// RAM/speed trade-off this section exists to quantify. `none` is the zero-cost baseline.

if (!NO_SEARCHERS) {
  section('Searchers  (lexical search — none / scan / trigram: retained RAM + query latency)')

  const { NoneSearcher } = await import('../src/searchers/none/index.js')
  const { ScanSearcher } = await import('../src/searchers/scan/index.js')
  const { TrigramSearcher } = await import('../src/searchers/trigram/index.js')

  // Vocabulary-driven corpus — varied text so the trigram index is realistic; boilerplate
  // would collapse the postings and understate trigram's RAM.
  const VOCAB = (
    'project user device sync hook embedder retriever vault config storage backend memory ' +
    'encrypted vector index query token corpus fusion semantic hybrid keyword session ' +
    'conversation message turn assistant role context window history transcript commit ' +
    'branch remote pull push clone migrate destroy doctor init share mount cache design ' +
    'decision document module factory implementation registry contract interface fast slow ' +
    'build serialize deserialize load search add remove update insert delete json file ' +
    'directory path absolute relative encoding base random uuid hash hex bytes lockfile ' +
    'docker postgres sqlite redis nginx compiler typescript node linux latency throughput'
  ).split(/\s+/)

  /** Deterministic ~240-word document (~1.6 KB) with a unique token appended. */
  function makeDoc(seed: number, tail: string): string {
    let s = seed | 0
    const out: string[] = []
    for (let i = 0; i < 240; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) | 0
      out.push(VOCAB[(s >>> 0) % VOCAB.length])
    }
    out.push(tail) // unique token ⇒ a "rare term" query has exactly one match
    return out.join(' ')
  }

  const opts = { contextChars: 48, regex: false, ignoreCase: true, maxPerMemento: 3, maxSnippets: 200 }
  const commonQueries = ['vector', 'storage', 'session', 'config', 'index', 'search']
  if (!globalThis.gc) console.log('  note: run with --expose-gc for stable retained-RAM numbers')

  for (const N of [10_000, 50_000]) {
    const corpus = Array.from({ length: N }, (_, i) => ({ id: randomUUID(), seed: i }))
    let corpusBytes = 0
    for (const d of corpus) corpusBytes += makeDoc(d.seed, d.id).length
    // Rare = a unique per-doc token (one match); common = a vocab word (matches ~everything).
    const rareQueries = corpus.filter((_, i) => i % 500 === 0).map(d => d.id)

    console.log(`\n  corpus: ${fmtN(N)} mementos, ${(corpusBytes / 1e6).toFixed(1)} MB of text`)
    console.log(
      ` ${'searcher'.padStart(10)}   ${'retained RAM'.padStart(13)}` +
      `   ${'rare q p50'.padStart(11)}   ${'common q p50'.padStart(13)}`,
    )

    for (const { name, make } of [
      { name: 'none', make: () => new NoneSearcher() },
      { name: 'scan', make: () => new ScanSearcher() },
      { name: 'trigram', make: () => new TrigramSearcher() },
    ]) {
      globalThis.gc?.()
      const heapBefore = process.memoryUsage().heapUsed
      const searcher = make()
      // Lazy thunk regenerates the text — the searcher becomes its sole owner.
      for (const d of corpus) searcher.add(d.id, () => makeDoc(d.seed, d.id))
      globalThis.gc?.()
      const ramMB = Math.max(0, process.memoryUsage().heapUsed - heapBefore) / 1e6

      const rareMs = await timeSamples(
        () => searcher.search(rareQueries[Math.floor(Math.random() * rareQueries.length)], opts), 200)
      const commonMs = await timeSamples(
        () => searcher.search(commonQueries[Math.floor(Math.random() * commonQueries.length)], opts), 100)

      console.log(
        ` ${name.padStart(10)}   ${(ramMB.toFixed(1) + ' MB').padStart(13)}` +
        `   ${ms(pct(rareMs, 50)).padStart(11)}   ${ms(pct(commonMs, 50)).padStart(13)}`,
      )
    }
  }
}

// ─── Done ─────────────────────────────────────────────────────────────────────

console.log('\nDone.')
