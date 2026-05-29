# `EmbeddingProvider` — how vectors are generated

An embedding turns text into a point in high-dimensional space where **semantically similar texts land near each other** — "prefer tabs" and "indentation style" end up close, "favorite color" ends up far. The Vault embeds every memento (and every chunk of a long memento) at write time, and embeds every query at read time, so cosine similarity over the resulting vectors is a meaningful relevance signal.

```typescript
interface EmbeddingProvider {
  readonly dimensions: number       // single source of truth for the vector index
  embed(text: string): Promise<Float32Array>
  embedBatch(texts: string[]): Promise<Float32Array[]>
}
```

`dimensions` is a property of the embedder; `buildVault` threads it into the vector index, so `vault.json` records only which embedder was chosen — not its dimensionality. The two cannot drift. Switching embedders is `mementos migrate --type=embedder` (the index is built for one dimensionality; can't be re-indexed in place).

Adding a new embedder is one folder under `src/embeddings/<name>/` — see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Implementations

| | Description |
|---|---|
| **`LocalEmbedder`** | `all-MiniLM-L6-v2` via the ONNX runtime. 384-dim, CPU-only, no API key, no network after the first model download. The model is lazy-loaded on first call (~150 MB) and cached on disk thereafter. Output is mean-pooled and L2-normalized so cosine distance is the natural metric. **Default.** |
| **`OpenAIEmbedder`** | `text-embedding-3-small` (512-dim default). API key from `OPENAI_API_KEY`, deferred to first network call (`buildVault` constructs the embedder just to read `.dimensions`). **Privacy warning** surfaced at `init` time: memory text is sent in plaintext to OpenAI's API for embedding — mementos's encryption protects data **at rest**, not the embedding call. |

## How similarity is measured

Vectors are compared by **cosine similarity**: the cosine of the angle between them. mementos uses cosine **distance** = `1 − similarity`: 0 = identical, 1 = unrelated. Two thresholds, each scoped to one operation:

- **Duplicate detection** — `0.08` distance (0.92 similarity). Write-time only: a new memento 92%+ similar to an existing one is rejected with a pointer to `update_memento`.
- **Retrieval relevance** — `0.5` distance. `recall` drops results beyond this so a cold query (something the vault doesn't know) returns "No memories found." instead of the *least bad* matches.

Both thresholds are empirically tuned for `all-MiniLM-L6-v2`; switching embedders may want re-tuning. The constants live in [src/core/vault/constants.ts](../core/vault/constants.ts).

## Batching

`embedBatch` accepts any number of texts — bulk ingest can hand it 10k+ — but the engines underneath have hard limits: ONNX runs the whole batch as one padded tensor (peak memory and the O(batch × seq²) attention matrix grow with the batch); OpenAI's endpoint caps a request at 2048 inputs / ~300k tokens. Both implementations sub-batch internally via the shared `embedInBatches` helper in [src/embeddings/_utils/batch.ts](_utils/batch.ts) so callers never have to think about it.
