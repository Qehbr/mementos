# mementos — Benchmarks

## What's measured here

mementos is an end-to-end-encrypted, cross-device memory vault built from **swappable abstractions** (embedder, vector index, retriever, storage backend), each auto-discovered at runtime. The numbers in this document measure the *out-of-the-box* capability of the default stack — `all-MiniLM-L6-v2` embeddings + HNSW + a BM25/dense hybrid retriever — fully local, no API calls, no per-question tuning, no heuristics.

**These numbers are a floor, not a ceiling.** They reflect a fixed choice of default blocks. Swap any block (a stronger embedder, a different retriever, a different vector index) and the numbers move. The product is the vault and the swappable architecture; the defaults are tuned to be solid but not chase a leaderboard. Anyone publishing a higher retrieval number is, almost always, making different trade-offs (heavier model, hand-tuned heuristics, an LLM reranker on every query). Read the numbers below in that light.

> **Reproduce everything:** exact commands in [§6](#6-reproducing-these-results).
> Hardware: Intel Core i9-14900K ×32 · 64 GB RAM · SATA SSD · Linux x64 · Node v22.

---

## TL;DR

On **LongMemEval-S** (cleaned, 500 questions), the default local retriever (`all-MiniLM-L6-v2` + HNSW + hybrid BM25/RRF), one document per session, **`recall_any@5`**:

| Retriever (default impls) | `recall_any@5` |
|---|---|
| **hybrid** (BM25 + RRF — no heuristics, no LLM, no tuning) | **97.2%** |
| semantic (pure vector search) | 95.4% |

By the LongMemEval authors' stricter headline metric `recall_all@5` (official scope, abstention excluded), the hybrid default scores **87.0%** (`recall_all@10`: 92.6%).

End-to-end QA accuracy — retrieval **+** an LLM answering — is [§5](#5-end-to-end-qa-accuracy): 61–64% under the official gpt-4o judge, where the *reader* is the limiting factor (and the reader, in production, is whatever AI the user plugs in).

[§3](#3-where-the-default-stack-sits) places the defaults next to a directly-comparable system and the standard academic baselines.

---

## 1. Methodology

### Dataset

[**LongMemEval**](https://github.com/xiaowu0162/LongMemEval) (Xu et al., ICLR 2025) — 500 questions, each embedded in a "haystack" of ~50 past chat sessions with realistic distractors. I use the **`-S` (small) cleaned** variant (`xiaowu0162/longmemeval-cleaned/longmemeval_s_cleaned.json`); the original release was deprecated 2025/09 and gives non-comparable numbers.

Each question carries `answer_session_ids` — the ground-truth evidence session(s). 30 of the 500 are **abstention** questions (`question_id` ends `_abs`); the official retrieval eval excludes them.

### Harness

`tools/bench-retrieval.ts`. It exercises the `Retriever` interface **directly** — a fresh `HNSWIndex` per question, the retriever built on top, the question retrieved, the result scored. No `Vault`, no encryption, no storage: this isolates *retrieval quality*. The production stack adds overhead and a different document pipeline (see caveats below).

### Metrics

For a question with evidence sessions `E` and a top-k retrieved set `R`:

- **`recall_any@k`** — hit if `E ∩ R ≠ ∅` (at least one evidence session retrieved). The metric most published memory-system numbers report.
- **`recall_all@k`** — hit if `E ⊆ R` (every evidence session retrieved). The metric the **LongMemEval authors** headline. Strictly harder — a question with 4 evidence sessions needs 4 of your 5 slots correct.
- **`MRR`** — mean reciprocal rank of the first evidence session.

Reported at `k = 5` and `k = 10`.

### `--doc-mode` — what a "session document" contains

A session is multi-turn. How you flatten it into one document to embed materially affects retrieval, because `all-MiniLM-L6-v2` truncates input at ~256 tokens — far shorter than an average session. Both modes reported:

- **`full`** — every turn as `role: content`, joined. This is what mementos actually ingests in production (`ClaudeCodeIngestor` keeps user *and* assistant turns).
- **`user-only`** — user turns only, content joined, no role prefix. The protocol most published LongMemEval numbers use; included here for like-for-like comparison.

### Abstention scopes

- **excluded** (470 questions) — the official LongMemEval retrieval scope.
- **included** (500 questions) — the abstention questions counted alongside the rest; reported for completeness.

### What these numbers do NOT measure

- **End-to-end QA accuracy** — whether an LLM, given the retrieved context, produces the correct *answer*. Different metric (always lower than retrieval recall) and requires an LLM reader + judge — see [§5](#5-end-to-end-qa-accuracy).
- **mementos in production** — the harness indexes one un-chunked document per session to match the standard LongMemEval evaluation protocol. Real mementos *chunks* long memories into ~400-token pieces, each embedded separately, which avoids the 256-token truncation loss. Production retrieval therefore behaves differently from this benchmark.

---

## 2. Retrieval quality — LongMemEval-S

### 2.1 `doc-mode=user-only` (user turns only — like-for-like with most published numbers)

| Scope | Retriever | `any@5` | `all@5` | `any@10` | `all@10` | MRR |
|---|---|---|---|---|---|---|
| abstention excluded (470) | semantic | 95.5% | 84.9% | 98.5% | 93.0% | 0.876 |
| abstention excluded (470) | **hybrid** | **97.2%** | **87.0%** | 98.5% | 92.6% | **0.908** |
| abstention included (500) | semantic | 95.4% | 84.6% | 98.4% | 92.6% | 0.870 |
| abstention included (500) | **hybrid** | **97.2%** | **86.2%** | 98.6% | 92.6% | **0.906** |

### 2.2 `doc-mode=full` — mementos-faithful indexing (user + assistant turns)

| Scope | Retriever | `any@5` | `all@5` | `any@10` | `all@10` | MRR |
|---|---|---|---|---|---|---|
| abstention excluded (470) | semantic | 92.6% | 75.7% | 95.1% | 86.0% | 0.811 |
| abstention excluded (470) | **hybrid** | 96.6% | 85.3% | 98.5% | 93.4% | 0.891 |
| abstention included (500) | semantic | 92.6% | 75.0% | 95.2% | 86.2% | 0.804 |
| abstention included (500) | **hybrid** | 96.8% | 85.2% | 98.6% | 93.0% | 0.889 |

**Why `user-only` scores higher than `full`.** Counterintuitive — `full` mode has *more* text. But `all-MiniLM-L6-v2` only embeds the first ~256 tokens; in `full` mode the long assistant turns consume that budget, so the vector "sees" less of the conversation. User turns are denser with answerable signal. The exception is `single-session-assistant` questions (about what the *assistant* said), where `full` mode wins because `user-only` discards the relevant turns — visible in §2.3.

### 2.3 By question type — `recall_all@5`, abstention excluded (470)

| question_type | n | semantic (user-only) | hybrid (user-only) | semantic (full) | hybrid (full) |
|---|---|---|---|---|---|
| knowledge-update | 72 | 95.8% | 100.0% | 76.4% | 91.7% |
| multi-session | 121 | 77.7% | 76.9% | 71.1% | 76.0% |
| single-session-assistant | 56 | 96.4% | 94.6% | 98.2% | 100.0% |
| single-session-preference | 30 | 86.7% | 83.3% | 83.3% | 86.7% |
| single-session-user | 64 | 93.8% | 100.0% | 79.7% | 93.8% |
| temporal-reasoning | 127 | 75.6% | 80.3% | 66.1% | 79.5% |

`recall_all` per-type is noisy at these counts; `multi-session` and `temporal-reasoning` are the hardest categories (multiple, time-spread evidence sessions).

### 2.4 Retrieval latency (`bench-retrieval.ts`, per query, in-memory index)

| doc-mode | Retriever | query p50 | query p95 | index build p50 |
|---|---|---|---|---|
| user-only | semantic | 0.022 ms | 0.026 ms | 2 ms |
| user-only | hybrid | 0.057 ms | 0.094 ms | 3 ms |
| full | semantic | 0.022 ms | 0.025 ms | 2 ms |
| full | hybrid | 0.076 ms | 0.109 ms | 12 ms |

Per-question haystacks are small (~50 sessions); hybrid's BM25 leg adds a fraction of a millisecond. Latency at vault scale is in [§4](#4-retrieval-performance-through-the-vault).

---

## 3. Where the default stack sits

### 3.1 Academic retrieval baselines

On LongMemEval session-level retrieval recall, classic retrievers land roughly at BM25 ≈ 70%, Contriever ≈ 78%, dense `Stella` ≈ 85% (approximate, compiled from the LongMemEval paper — not re-run here). mementos's hybrid at 97.2% and semantic at 95.4% sit well above these baselines.

### 3.2 Directly comparable — MemPalace

[MemPalace](https://github.com/MemPalace/mempalace) publishes `recall_any@5` on LongMemEval-S (cleaned), one document per session, **user turns only**, `all-MiniLM-L6-v2`, all 500 questions — the same protocol my `--doc-mode=user-only` run uses. The numbers *are* like-for-like (mementos rows: 500-question scope to match MemPalace's denominator):

| System | `recall_any@5` | Heuristics / LLM | Notes |
|---|---|---|---|
| MemPalace hybrid v4 + LLM rerank | 100% | hand-tuned + LLM reranker | MemPalace state it is overfit — tuned on 3 specific failing questions |
| MemPalace hybrid v4, held-out 450 | 98.4% | hand-tuned heuristics | their honest generalisable hybrid figure |
| **mementos hybrid** | **97.2%** | **none** | BM25 + RRF — no heuristics, no LLM, no per-question tuning |
| MemPalace raw | 96.6% | none | semantic-only (ChromaDB default embeddings) |
| **mementos semantic** | **95.4%** | **none** | pure HNSW vector search |

The mementos defaults sit alongside the equivalent untuned baseline, with no per-question tuning and no LLM in the loop. The 98.4–100% rows are a different system: hand-tuned heuristics + an LLM reranker that adds a paid API call and ~3–4 s of latency per query (by MemPalace's own numbers) — and for an encrypted vault, also a privacy regression, since the retrieved plaintext memories stream to a third-party API. mementos optimises for *local, sub-millisecond, zero-API* retrieval; that's a different optimisation target, not a worse one.

mementos and MemPalace are also solving different problems: MemPalace is a retrieval research benchmark; mementos is an encrypted, cross-device memory vault that happens to ship a strong default retriever. The comparison is useful precisely because the protocols line up — not because the products do.

### 3.3 Other memory systems — non-comparable

These projects publish end-to-end QA accuracy (retrieval *plus* LLM-generated answer, graded by an LLM judge), often on a different dataset. QA accuracy and retrieval recall are different axes — listed here only so readers can find them.

| System | Reported | Metric | Dataset |
|---|---|---|---|
| Supermemory ASMR | ~99% | QA accuracy (agent ensemble) | LongMemEval |
| Mastra | 94.87% | QA accuracy (reader: GPT-5-mini) | LongMemEval |
| Hindsight | 91.4% | unverified | LongMemEval |
| Mem0 | ~66.9% | QA accuracy | LoCoMo |

mementos's own end-to-end QA numbers are in [§5](#5-end-to-end-qa-accuracy), measured under LongMemEval's official judge protocol with the reader disclosed.

---

## 4. Retrieval performance through the Vault

`tools/bench.ts` §7 runs both retrievers through the **full Vault stack** (AES-256-GCM encryption + storage + index + retriever) over a synthetic corpus — this is the production code path, unlike `bench-retrieval.ts` which isolates the retriever.

| Memories | Retriever | Cold start | Warm start | `recall` p50 | p95 |
|---|---|---|---|---|---|
| 1,000 | semantic | 377 ms | 65 ms | 0.08 ms | 0.10 ms |
| 1,000 | hybrid | 145 ms | 72 ms | 0.59 ms | 1.11 ms |
| 10,000 | semantic | 3.1 s | 693 ms | 0.15 ms | 0.18 ms |
| 10,000 | hybrid | 3.2 s | 771 ms | 2.41 ms | 3.26 ms |

`HybridRetriever` rebuilds its BM25 inverted index in RAM at every startup (no persistent sparse cache), so warm start is comparable to `SemanticRetriever`'s warm start despite the encrypted HNSW cache hit (the cache only restores the dense leg). Per-query cost grows with corpus size — the BM25 leg currently scans postings per query — noticeable at 10k memories (~2 ms). Both are well within interactive latency.

### Cold vs warm startup (semantic, raw vault)

`tools/bench.ts` §6 measures startup without a retriever's RAM rebuild — pure "decrypt + populate metadata + restore HNSW from cache" cost:

| Memories | Populate (one-time) | Cold start | Warm start | Speedup |
|---|---|---|---|---|
| 1,000 | 87 ms | 194 ms | 67 ms | 2.9× |
| 5,000 | 406 ms | 1.2 s | 329 ms | 3.6× |
| 10,000 | 816 ms | 3.0 s | 658 ms | 4.6× |
| 100,000 | 8.1 s | 81.9 s | 8.2 s | **10×** |

The warm path scales linearly with corpus size (each `.mem` still has to be authenticated and its metadata decrypted into `metaById`) but skips the HNSW rebuild — which is what dominates cold at 100k.

### Lexical search — `searcher` RAM & latency

`recall` is semantic; the `search` tool / `mementos search` is **lexical** — exact substring and regex matching, backed by a separately-chosen `searcher`. `tools/bench.ts` §8 exercises the three searchers directly over synthetic corpora of 10,000 and 50,000 mementos, measuring retained heap and query latency on a *rare* term (one matching memento) versus a *common* term (in nearly every memento):

| Searcher | Corpus | Retained RAM | Rare-term p50 | Common-term p50 |
|---|---|---|---|---|
| `none` | — | ~1 MB | — | — |
| `scan` | 10k (~18 MB text) | ~13 MB | 1 ms | 9 ms |
| `scan` | 50k (~90 MB text) | ~90 MB ¹ | 15 ms | 44 ms |
| `trigram` | 10k (~18 MB text) | ~171 MB | 0.35 ms | 10 ms |
| `trigram` | 50k (~90 MB text) | ~543 MB | 1.28 ms | 46 ms |

> ¹ `scan` at 50k retains roughly the text-bytes count (~90 MB). Direct heap-sample is unstable without `--expose-gc` (GC-timing artifact); the structural relationship — retained ≈ text size — holds.

- **`none`** — search disabled; no resident state, no `search` tool exposed.
- **`scan`** — holds the corpus text once; retained RAM tracks text size. Every query is a full linear scan, so latency scales with the corpus: ~44 ms for a common term at 50k. Low RAM, predictable — the default.
- **`trigram`** — adds an inverted trigram index *on top of* the text map, costing ~13× `scan`'s RAM. In return a *selective* query is reduced to its handful of candidate mementos before scanning, and resolves in single-digit milliseconds **at either scale** — ~35× faster than `scan` at 50k for rare terms. A *non-selective* query cannot be narrowed, so it matches `scan` (the candidate filter costs a hair of overhead).

The trade-off: `trigram` spends roughly an order of magnitude more RAM than `scan` to make *selective* lookups effectively scale-independent, while `scan`'s latency grows linearly with the vault. For a personal-scale vault `scan`'s tens-of-milliseconds worst case is imperceptible, so `scan` is the default; `trigram` is opt-in for large or search-heavy workloads.

---

## 5. End-to-end QA accuracy

Retrieval recall is the *ceiling* of QA accuracy, not QA accuracy itself. The QA stage — `tools/bench-qa.ts` (`npm run bench:qa`) — follows LongMemEval's official protocol:

1. **Reader** — an LLM answers each question from the top-k retrieved sessions. The reader is disclosed and *not* fixed by the benchmark — it may be a local model (e.g. Qwen on a 24 GB GPU) or an API model. Reader prompt ported verbatim from `run_generation.py`.
2. **Judge** — `gpt-4o-2024-08-06` with LongMemEval's verbatim per-question-type judge prompts (`evaluate_qa.py`), `temperature 0`, `max_tokens 10`, label = substring "yes". The judge is fixed by the benchmark — substituting it breaks comparability.
3. **Report** — QA accuracy micro-averaged over the 6 question types, with abstention scored separately.

Reader and judge are reached over the OpenAI-compatible chat API, so a local server (Ollama / vLLM / LM Studio) is a drop-in. Runs are idempotent — every result is checkpointed, so an interrupted run resumes where it stopped.

### Measured

Retriever `hybrid`, `doc-mode=full`, `qa-k=5`, judge **gpt-4o-2024-08-06**, all 500 questions. Two readers — one local, one API:

| Reader | overall (n=500) | non-abstention (n=470) | abstention (n=30) |
|---|---|---|---|
| Qwen2.5-14B-Instruct (local, 4-bit / Ollama) | **61.2%** | 60.6% | 70.0% |
| gpt-4o-mini | **63.8%** | 63.2% | 73.3% |

By question type:

| question_type | n | Qwen2.5-14B | gpt-4o-mini |
|---|---|---|---|
| single-session-assistant | 56 | 94.6% | 98.2% |
| single-session-user | 70 | 88.6% | 90.0% |
| knowledge-update | 78 | 73.1% | 76.9% |
| multi-session | 133 | 42.9% | 52.6% |
| temporal-reasoning | 133 | 51.1% | 51.9% |
| single-session-preference | 30 | 30.0% | 6.7% |

**Reading the result:**

- **The reader barely moves the number within a tier.** gpt-4o-mini beats a 14B local model by only +2.6 pp overall. mementos's fully-local stack is competitive with an API reader — retrieval is doing the work.
- **It's reasoning-bound, not retrieval-bound.** Retrieval put a correct session in the top-5 ~97% of the time (§2), yet QA tops out at ~64%. The ~35% gap is the *reading* step — answering multi-hop (`multi-session`) and `temporal-reasoning` questions, both stuck near 50% for either reader. This matches the LongMemEval paper, where full-context GPT-4o also lands ~60–64%. Beating ~64% needs a frontier reader, not just a bigger small one.
- **The `multi-session` gap (42% → 53%) is largely a truncation artifact.** The Qwen run capped context at `num_ctx 16384`; the longest haystacks were truncated. gpt-4o-mini's 128k context has no such cap — so ~10 pp of Qwen's multi-session deficit was truncation, not model quality.
- `single-session-preference` is the weakest category for both (30% / 7%, n=30) — the rubric-based judge prompt is the most subjective and the sample is small.

### Why the judge is gpt-4o, not a local model

A first run used a local `llama3.1:8b` judge and reported 70.6%. Re-judging the *identical* 500 reader answers with the official `gpt-4o-2024-08-06` judge gave **61.2%** — the local judge agreed with gpt-4o on only **87%** of verdicts and was systematically **lenient** (+9.4 pp). A local judge is free but not reliable enough to publish; the official judge is the measuring instrument, so 61.2% is the number that counts.

### Caveats

- **Reader context truncation.** The local run used `num_ctx 16384`; reader prompts averaged ~14k tokens, so the longest haystacks (multi-session, temporal) were partly truncated — some of those low scores are truncation, not reader quality.
- **Not cross-comparable to other systems' QA numbers** unless the reader matches. mementos's 61.2% is a Qwen2.5-14B reader; Mastra's 94.87% (§3.2) is a GPT-5-mini reader.

---

## 6. Reproducing these results

```bash
git clone <repo> && cd mementos && npm install

# Retrieval quality — user turns only (like-for-like with most published numbers)
npm run bench:retrieval -- --questions=all --doc-mode=user-only

# Retrieval quality — mementos-faithful indexing (user + assistant turns)
npm run bench:retrieval -- --questions=all --doc-mode=full

# Quick check on a handful of questions
npm run bench:retrieval -- --questions=2

# Retrieval performance through the Vault (§4)
npm run bench -- --no-embed --no-scale --no-cold

# End-to-end QA accuracy (§5) — needs OPENAI_API_KEY for the gpt-4o judge
npm run bench:qa -- --questions=all                        # gpt-4o-mini reader (~$2)
npm run bench:qa -- --questions=all \
  --qa-reader-url=http://localhost:11434/v1 \
  --qa-reader-model=qwen-reader                            # local reader (judge still API)

# Re-judge an existing run's answers with a different judge (no reader calls) — used to
# get the official gpt-4o number from a local-judge run, and to measure judge agreement
npm run bench:qa -- --rejudge \
  --rejudge-from=~/.cache/mementos/qa_hybrid_full_r-qwen-reader_j-llama3.1_8b_k5.jsonl \
  --qa-judge-model=gpt-4o-2024-08-06
```

First run downloads `longmemeval_s_cleaned.json` (~277 MB) into `~/.cache/mementos/` and embeds ~19k unique sessions (~12 min with `LocalEmbedder`). Embeddings are cached incrementally (keyed by SHA-256 of each document), so re-runs are near-instant and an interrupted run resumes. `--doc-mode=full` and `--doc-mode=user-only` produce different document text and therefore cache separately.

The harness is deterministic: same dataset + same flags ⇒ same result.
