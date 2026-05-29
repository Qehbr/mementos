<p align="center">
  <img src="assets/logo.png" alt="mementos" width="420">
</p>

<p align="center">
  <b>Encrypted, model-agnostic AI memory vault.</b><br>
  Works on any device. Private by design.
</p>

## How it works

<p align="center">
  <img src="assets/diagram.svg" alt="mementos: encrypted memories shared across devices and AI tools" width="900">
</p>

On the laptop, the user asks Claude *"Why's Yuki always so active at night?"* — **the message never explicitly says "I have a cat."** That's just context from the question and the photo. mementos still extracts the fact (*user has a cat named Yuki*), encrypts it, and stores it.

Days later, on a different machine, talking to a different AI (ChatGPT), the user asks about flowers — and the AI knows to avoid lilies because they're toxic to Yuki. **Different device, different AI tool, different conversation, no re-explaining.** That cross-cut is the whole product.

Everything on disk is AES-256-GCM encrypted with a key that lives only on your devices. No mementos server in the middle: the encrypted vault syncs via git or any folder-replication tool (Dropbox, iCloud, Drive). Nothing for anyone to host, breach, or subpoena on your behalf.

## Install

```bash
npm install -g mementos
mementos init       # interactive — write down the 24-word vault key
```

`mementos init` walks you through it: storage backend, embedder, vector index, key provider. Every choice has a sensible default — press Enter to accept. The vault key is shown once — **write it down**; it's the only thing that can decrypt your memories.

After init, mementos auto-detects the AI clients on your machine and wires itself in. Open Claude Code / Cursor / Codex / Antigravity CLI / Claude Desktop / opencode / OpenClaw and start chatting — mementos is already there. The AI calls `recall` when past context would help, and `write_memento` when it learns something worth remembering.

## What it does

- **One install, no infrastructure.** No Docker, no Postgres, no Qdrant. `npm install -g` and you're done.
- **Encrypted by default — including the vectors.** Most "encrypted" memory tools leave embedding vectors in plaintext, but [Morris et al., EMNLP 2023](https://arxiv.org/abs/2310.06816) showed embeddings can be inverted back to the original text with 92% exact recovery for 32-token inputs. mementos encrypts the text *and* the vectors. Your key never leaves your device.
- **Cross-device, your way.** Sync via git (full version history) or a cloud folder you already use (Dropbox, iCloud, Google Drive). No mementos server in the middle.
- **Works with every MCP-compatible AI tool.** Claude Code, Cursor, Codex, Claude Desktop, Antigravity CLI, opencode, OpenClaw, Antigravity IDE — one install wires them all up.
- **Imports your past conversations.** Bulk-ingest existing transcripts from Claude Code, ChatGPT exports, Slack, Telegram, WhatsApp, Cursor, opencode, OpenClaw — so the AI starts with your history, not a blank slate.

## Benchmarks

Measured on an i9-14900K / SATA SSD. Full tables + methodology in [BENCHMARKS.md](./BENCHMARKS.md).

**Retrieval quality** on LongMemEval-S (500 questions) — **no heuristics, no LLM reranker, no per-question tuning**, all fully local:

| Retriever | `recall_any@5` | `recall_all@5` |
|---|---:|---:|
| **hybrid** (BM25 + RRF) | **97.2%** | **87.0%** |
| semantic (pure HNSW) | 95.5% | 84.9% |

**HNSW search latency** (k=5, p50):

| Vault size | Latency |
|---:|---:|
| 1,000 | 0.047 ms |
| 10,000 | 0.076 ms |
| 50,000 | 0.189 ms |

**Startup time** (warm = HNSW cache hit, cold = rebuild from `.mem` files):

| Vault size | Cold | Warm | Speedup |
|---:|---:|---:|---:|
| 1,000 | 194 ms | 67 ms | 2.9× |
| 10,000 | 3.0 s | 658 ms | 4.6× |
| 100,000 | 81.9 s | 8.2 s | **10×** |

## Architecture

mementos is built around **eight auto-discovered abstractions**. The core (`Vault`, `crypto`, `chunker`) depends only on these — never on concrete implementations — so a new backend, embedder, retriever, searcher, ingestor, key provider, or integration is one folder, no core edits.

| | What it owns | Read more |
|---|---|---|
| **`StorageBackend`** | Where `.mem` files live (local FS, git remote, …) | [src/storage/](./src/storage/) |
| **`EmbeddingProvider`** | How text becomes a vector (local ONNX, OpenAI API) | [src/embeddings/](./src/embeddings/) |
| **`VectorIndex`** | The ANN data structure for top-k cosine search (HNSW) | [src/vector/](./src/vector/) |
| **`Retriever`** | The retrieval strategy over the index (pure semantic, hybrid BM25+RRF) | [src/retrievers/](./src/retrievers/) |
| **`Searcher`** | Exact lexical search (literal / regex via RE2 — scan, trigram, none) | [src/searchers/](./src/searchers/) |
| **`KeyProvider`** | Where the AES key comes from (OS keychain, env var, mnemonic) | [src/keys/](./src/keys/) |
| **`Ingestor`** | Bulk-import transcript parsers (Claude Code, ChatGPT export, Slack, …) | [src/ingestors/](./src/ingestors/) |
| **`ClientIntegration`** | How each AI tool gets wired up (MCP server + skill file + optional hooks) | [src/integrations/](./src/integrations/) |

Plus two cross-cutting pieces:

- **Encryption & on-disk format** (AES-256-GCM, AAD scheme, what's never plaintext) — [src/core/vault/](./src/core/vault/)
- **CLI commands + MCP tools reference** — [src/cli/](./src/cli/)

## Contributing

Adding a new storage backend, embedder, retriever, searcher, key provider, ingestor, or AI-client integration is **one folder under `src/<abstraction>/<name>/`** — no edits to `core/`, no edits to the CLI, no registry entries. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the discovery contract and per-abstraction guides.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
