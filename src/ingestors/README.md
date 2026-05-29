# `Ingestor` — how external transcripts become mementos

`mementos ingest` (interactive bulk import) and the `mementos snapshot` pre-compaction hook route source-specific transcripts through `Ingestor` implementations. Each parses one file into `IngestSession`s — a `chronicleId` plus an ordered list of mementos — which `Vault.ingest` lands idempotently.

```typescript
interface Ingestor {
  readonly name: string                       // shown during interactive discovery
  readonly defaultPath?: string               // where this source typically stores transcripts
  detects(filePath: string): boolean | Promise<boolean>
  parse(filePath: string): Promise<IngestSession[]>
}

interface IngestSession {
  chronicleId: string                                          // stable UUID across re-runs
  mementos: Array<{
    mementoId: string                                          // stable UUID; re-ingest is idempotent
    parentMementoId?: string                                   // for sources that track a tree (Claude Code, ChatGPT, …)
    text: string
    createdAt?: string                                         // ISO 8601, falls back to session timestamp
  }>
  tags?: string[]                                              // applied to every memento in the session
  createdAt?: string
}
```

Adding a new ingestor is one folder under `src/ingestors/<name>/` — see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Implementations

Eight ship today. Each auto-applies a `source:<tool>` tag so an `exclude_tags=["source:claude-code"]` filter on `recall` returns only direct AI writes, not bulk-imported chat history.

| | Source | Detection |
|---|---|---|
| **`claude-code`** | Claude Code's per-session JSONL at `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` | `.jsonl` extension + lives under `.claude/projects/` |
| **`opencode`** | opencode's `~/.local/share/opencode/opencode.db` (SQLite — three tables: `session` / `message` / `part`) | filename = `opencode.db` |
| **`openclaw`** | OpenClaw's per-session JSONL at `<state>/agents/<id>/sessions/<sid>.jsonl` | path shape contains `/agents/` + `/sessions/`, `.jsonl`, not `.trajectory.jsonl` |
| **`cursor`** | Cursor's `state.vscdb` SQLite database | filename = `state.vscdb` |
| **`chatgpt-export`** | ChatGPT data export's `conversations.json` | filename = `conversations.json` |
| **`slack-export`** | Slack workspace export — `YYYY-MM-DD.json` files inside a per-channel directory | matches `YYYY-MM-DD.json` |
| **`telegram-export`** | Telegram Desktop export's `result.json` | filename = `result.json` |
| **`whatsapp-export`** | WhatsApp "Export chat" `.txt` (iOS + Android layouts) | `.txt` whose first content line matches a WhatsApp timestamped-message layout |

An `antigravity-cli` ingestor will land once Google publishes the transcript format.

## Idempotency + re-ingest

`Vault.ingest(chronicleId, mementos)` skips any memento whose `mementoId` already exists — so re-running an ingest converges on the same final state regardless of how many partial runs preceded it. No manifest needed. Each ingestor derives `mementoId` deterministically from the source's per-record id (often via `toUuid` to canonicalise non-UUID source ids), so re-ingest of a growing transcript adds only the new turns.

`parentMementoId` is hashed with the **same** function as `mementoId`, so a child's `parentMementoId` equals its parent's `mementoId` — the conversation tree structure (forks, regenerated answers, edited prompts) survives intact.

## Shared helpers

The `_utils/` folder encodes the conventions every ingestor shares:

- `toUuid(seed)` — deterministic SHA-256 → UUID v5 mapping for sources with non-UUID ids.
- `roleLine(role, body)` / `turnLine(speaker, body)` — the `"SPEAKER: body"` display convention every ingestor stores.
- `fromIso(value)` / `fromEpochMs(value)` / `fromEpochSeconds(value)` — timestamp coercion.
- `readJsonlRecords` / `readJsonFile` / `tryParseJson` — the file readers (malformed lines skipped, read errors propagated).
- `withReadonlyDb` — lazy-imported `node:sqlite` for the SQLite-backed sources.
- `acceptRole` — lowercase + keep only user/assistant turns.
- `buildSession` — the canonical session assembler (auto-applies `source:<tool>` tag, derives `createdAt`).
- `joinTextBlocks` / `joinTextRuns` — flatten the per-source content unions (`{type: 'text', text}` blocks, mixed string/object arrays).
- `pathContains` / `isNamedFile` — the `detects` predicates.

## Docker drift tests

Where the upstream ships a runnable CLI, a Docker drift test installs the real CLI in a container and verifies the matching ingestor still parses its output — so an upstream format change is caught. Run via `npm run test:docker:<name>-ingestor`. See [tests/docker/](../../tests/docker/).
