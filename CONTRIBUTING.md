# Contributing to mementos

mementos is built around **eight auto-discovered abstractions**. Adding a new backend, embedder, retriever, searcher, key provider, ingestor, or AI-client integration is **one folder under `src/<abstraction>/<name>/`** — no edits to `core/`, no edits to the CLI, no registry entries. Drop the folder, ship.

---

## Setup

```bash
git clone <repo>
cd mementos
npm install
npm test       # vitest — full suite, in-process
```

---

## The auto-discovery contract

Every implementation under `src/<abstraction>/<name>/index.ts` must export:

```typescript
export const type = 'unique-name'                                          // required
export function create(/* per-abstraction args */): TheInterface { … }     // required
export async function setupAtInit(ctx: InitContext): Promise<void> { … }   // optional
```

At runtime, each abstraction's `registry.ts` scans its directory, imports every `<name>/index.js`, and registers anything that exports both `type` and `create`. Folders whose name starts with `_` (e.g. `_utils/`) are skipped — they hold shared helpers, not implementations.

A `const _shape: ImplementationModule<Factory> = { type, create, setupAtInit }` line at the bottom of every implementation catches contract drift (renamed or wrongly-typed export) at compile time.

Tunables for an implementation live in a sibling `constants.ts` — `<name>/index.ts` holds logic, `<name>/constants.ts` holds the knobs.

---

## How to add a new …

### Storage backend

`src/storage/<name>/index.ts` implementing the `StorageBackend` interface ([src/storage/interface.ts](src/storage/interface.ts)). The `create(machine)` factory receives the per-machine config so it can read its own slice of `backendConfig`. Atomic-write helpers (`writeAndStat`, `assertIfMatch`) live in `src/storage/_utils/`; the rollback-friendly `stagedRenameTransform` powers `migrate`. Tests: `src/__tests__/<name>-backend.test.ts` exercises `get`/`put`/`ifMatch`/`putBatch`/`migrate` against a tmp dir. See [src/storage/README.md](src/storage/README.md).

### Embedder

`src/embeddings/<name>/index.ts` implementing `EmbeddingProvider`. Two methods (`embed`, `embedBatch`) plus a `readonly dimensions: number`. `embedBatch` must handle inputs of any size (the Vault can hand it 10k+ texts during bulk ingest) — sub-batch internally to respect the engine's per-request limits via `embedInBatches` in `src/embeddings/_utils/`. Tests: `src/__tests__/<name>-embedder.test.ts`. See [src/embeddings/README.md](src/embeddings/README.md).

### Vector index

`src/vector/<name>/index.ts` implementing `VectorIndex`. `create(dimensions)` receives the dimensionality from the chosen embedder. Must implement `init`/`add`/`search`/`filteredSearch`/`remove`/`serialize`/`load` and maintain a `mementoId → chunk-ids` map for native filtered search. The encrypted cache uses `serialize`/`load`, so they must produce/consume identical state. Tests: `src/__tests__/<name>-index.test.ts`. See [src/vector/README.md](src/vector/README.md).

### Retriever

`src/retrievers/<name>/index.ts` implementing `Retriever`. `create(vectorIndex)` receives the vector index so every retriever has dense search available; add additional state via `add`/`remove`. `decryptText` is a lazy thunk — only call it if your retriever needs the plaintext. Must support an optional `allowed: ReadonlySet<string>` for filtered retrieval. Tests: `src/__tests__/<name>-retriever.test.ts`. See [src/retrievers/README.md](src/retrievers/README.md).

### Searcher

`src/searchers/<name>/index.ts` implementing `Searcher`. Indexes memento text in RAM. `runTextSearch` and `compileMatcher` in `src/searchers/_utils/engine.ts` are the shared match engine — use them so the literal/regex contract stays uniform. Regex must go through RE2 (linear-time, ReDoS-proof) — never the native `RegExp` engine. Tests: `src/__tests__/searchers.test.ts`. See [src/searchers/README.md](src/searchers/README.md).

### Key provider

`src/keys/<name>/index.ts` implementing `KeyProvider`. `getKey()` returns a 32-byte AES-256 key; persistence + derivation strategy is the implementation's call. New providers should run their underlying entropy through `deriveKeyFromEntropy` in `src/keys/_utils/derivation/` so cross-provider key transfer stays trivial. `checkReachable`, `getCanonicalSecret`, and `clearStoredKey` are conventions the share-key / destroy / hook flows rely on — see [src/keys/interface.ts](src/keys/interface.ts) for the optional vs required split. Tests: `src/__tests__/<name>-key-provider.test.ts`. See [src/keys/README.md](src/keys/README.md).

### Ingestor

`src/ingestors/<name>/index.ts` implementing `Ingestor`. Parses one source's transcript format into `IngestSession`s. Use the shared helpers in `src/ingestors/_utils/` (`toUuid`, `roleLine`/`turnLine`, `fromIso`/`fromEpochMs`, `readJsonlRecords`, `withReadonlyDb`, `acceptRole`, `buildSession`, `joinTextBlocks`/`joinTextRuns`) — they encode the conventions every ingestor shares. Tests: `src/__tests__/ingestors-<name>.test.ts` parses a captured-shape fixture; if the source ships a runnable CLI, also add a Docker drift test under `tests/docker/<name>-ingestor-smoke.ts` and a `test:docker:<name>-ingestor` script. See [src/ingestors/README.md](src/ingestors/README.md).

### Client integration

`src/integrations/<name>/index.ts` implementing `ClientIntegration`. Each integration registers mementos's MCP server with one AI client, and optionally a skill file + hooks. The shared helpers in `src/integrations/_utils/` cover the common shapes: `jsonMcpConfigOps` for JSON-config MCP wiring, `HookRegistry` + `jsonHooksAdapter` for hook lifecycle, `writeSkillFile` + `SKILL_BODY` / `SKILL_MD` for skill content, `withInstallShell` for the install try/catch shape, `defaultSetupAtInit` for MCP-only integrations, `cliRunner` + `probeCli` for talking to the client's own CLI. If the client ships a runnable CLI, add a Docker drift test under `tests/docker/<name>-smoke.ts` and a `test:docker:<name>` script. Tests: `src/__tests__/integrations-<name>.test.ts` for the file-shape contract against a tmp `HOME`. See [src/integrations/README.md](src/integrations/README.md).

