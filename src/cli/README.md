# CLI + MCP reference

Mementos is built on a **single persistent daemon** (`mementos start`) that holds the vault in memory and exposes a plain HTTP API on `127.0.0.1:47899`. Every other piece — the MCP server AI clients launch, the CLI commands you type, the snapshot/ingest hook subprocesses — is a thin client that POSTs to the daemon. **Exactly one vault in memory across the machine.**

- **`mementos start`** runs the daemon (and `mementos stop` shuts it down).
- **`mementos mcp`** is a stdio MCP shim AI clients register; it forwards every MCP tool call to the daemon over plain HTTP.
- **CLI commands** (`mementos recall`, `mementos write`, etc.) also POST to the daemon; they error with a clear "Run `mementos start` first" if no daemon is listening.

The CLI dispatcher is [src/cli/index.ts](index.ts); subcommand handlers live under [src/cli/commands/](commands/). The tool registry (descriptions, schemas, daemon-side implementations) is one file: [src/core/tools.ts](../core/tools.ts).

## Auth

Every HTTP request requires `Authorization: Bearer <token>`. The daemon generates a fresh 256-bit token at startup, writes it to `~/.config/mementos/daemon.token` with `0600` perms, and deletes it on shutdown. Clients (CLI, MCP shim, hooks) read the file before each request. Other local users on the machine can't read the token file and so can't talk to the daemon — `127.0.0.1` binding rejects external network, the token rejects everything else.

---

## CLI commands

```bash
# Setup
mementos init [--mode=new|join] [--reinit] [--full]
                                # interactive setup; --mode=join attaches this machine to
                                # a vault that exists elsewhere; --full pre-installs every
                                # optional backend and warms the MiniLM embedding model

# Daemon lifecycle
mementos start [--foreground]   # start the daemon (default: detach into background;
                                # `--foreground` keeps stdio for debugging).
                                # Generates ~/.config/mementos/daemon.token (0600) and
                                # binds 127.0.0.1:47899 (override with MEMENTOS_PORT).
mementos stop                   # SIGTERM the daemon via PID file
mementos mcp                    # stdio MCP shim AI clients launch via `claude mcp add`.
                                # Auto-starts the daemon if not running.

# Recall + write (mirror the MCP tools — shell-capable AI clients can invoke
# these directly when MCP is opted out at install time)
mementos recall <query> [--k=N] [--tags=a,b] [--exclude-tags=a,b] [--chronicle=id]
                                # semantic search for relevant mementos
mementos write <text> [--tags=a,b]
                                # store a new memento (text via positional or piped stdin)
mementos update <id> <text> [--tags=a,b]
                                # replace a memento's text (id + un-passed tags preserved)
mementos tags                   # list every tag with its usage count

# Read paths
mementos list [tag...] [--tags=a,b] [--start=YYYY-MM-DD] [--end=...] [--query=...] [--k=N]
                                # list mementos by recency, optionally by date range / query
mementos get <id>               # print the full decrypted text of one memento
mementos chronicle <id>         # read every memento of one chronicle in order
mementos chronicles             # list every chronicle with memento count + start time
mementos index [<text>]         # read the curated memory-index memento, or replace its
                                # body when text is given (positional or piped stdin)
mementos delete <id>            # delete a memento
mementos search <query>         # exact / regex text search (needs --searcher=scan|trigram)
mementos sync                   # pull the latest mementos from storage now

# Import past conversations
mementos ingest [path] [--tag=…] [--dry-run]
                                # bulk-import transcripts via the ingestors;
                                # no path → interactive (scans known sources)
mementos snapshot               # PreCompact-hook subprocess (not run by hand)

# Vault lifecycle
mementos migrate [--type=storage|key|embedder] [--abort]
                                # staged, crash-safe migration; --abort to discard
mementos backup [dir]           # export the vault (encrypted) to a directory
mementos restore <dir>          # import a backup directory back into the vault
mementos share-key              # transfer the vault key to another device (show / LAN pair)
mementos doctor                 # dependency-ordered health check; scriptable exit code
mementos uninstall              # (alias: destroy) interactive cleanup — run before npm uninstall

# Integrations
mementos integration list
mementos integration enable <name>
mementos integration disable <name>
mementos integration hook enable|disable|status <name> [--type=session-start|pre-compact]
```

`mementos --help` prints the full reference; `mementos doctor` is the dependency-ordered health check (machine config → vault path → key → storage → vault config → decrypt probe → embedder → index cache → integrations), short-circuiting cleanly on prereq failure.

---

## MCP tools reference

The tools any MCP-compatible AI can call. Vocabulary: a **memento** is one memory, a **chronicle** is an imported conversation.

### `write_memento(text, tags?)`
Store a new memento. Long text is chunked internally — still one file. If a near-identical memento exists (cosine distance < 0.08), the call is rejected with a pointer to `update_memento`. Returns `Stored memento (id=…)`. Read-only annotations: `idempotentHint: false`.

### `recall(query, k?, tags?, exclude_tags?, chronicle_id?)`
Semantic search. Embeds the query, retrieves top-k, collapses chunk hits to mementos, and returns the best-matching chunk of each:

```
[MEMENTO id=c98d92… tags=preference]: "prefer tabs over spaces"
[MEMENTO id=b71e44… chronicle=xyz123… tags=decision]: "we chose React because…"
  (matched chunk 2/4 — call get_memento("b71e44…") for the full text)
```

`tags` keeps only mementos with at least one listed tag; `exclude_tags` drops any with a listed tag (exclude beats include); `chronicle_id` scopes to one conversation. The `source:*` tag convention pairs with this — `exclude_tags=["source:claude-code"]` returns only direct writes, not imported chat history.

### `search(query, k?, regex?, ignore_case?, context_chars?, tags?, exclude_tags?, chronicle_id?)`
Exact lexical search — a literal substring, or a regular expression with `regex=true`. Where `recall` ranks by *meaning*, `search` finds the *exact* string semantic search misses: an error message, a code identifier, a UUID, a phrase. Returns short match snippets with surrounding context plus a total count — never whole mementos:

```
Found 15 matches in 7 mementos. Showing first 5:
1. [MEMENTO id=a3c8e7…]: …converged after refuse→reverse→«backup»→staged. Don't…
```

Registered only when a searcher is configured (`--searcher=scan|trigram` — not `none`).

### `get_memento(memento_id)`
The full text of one memento (all chunks joined). `recall` shows only the best chunk of a long memento — call this for the whole thing.

### `update_memento(memento_id, text, tags?)`
Replace a memento's text (re-chunked + re-embedded) and optionally its tags. `tags` omitted = keep the existing tag set; `tags=[]` clears all tags; `tags=[...]` replaces wholesale. The id is always preserved. If the file changed since you last read it (another device synced, a concurrent agent), the update is rejected and you're told to re-read it and re-apply — first writer wins.

### `delete_memento(memento_id)`
Delete one memento (its single file). Prefer `update_memento` to revise — that path keeps the same id (so references stay valid) and detects concurrent edits. Annotations: `destructiveHint: true`, `idempotentHint: false`.

### `get_chronicle(chronicle_id)`
Every memento of one imported conversation, in order; forks (edited / re-rolled turns) annotated inline.

### `list_chronicles()`
Every imported conversation, with its memento count and start time.

### `get_tags()`
All tags in use, with counts. The AI is told to call this before tagging, to reuse tags rather than invent near-duplicates.

### `list_mementos(start?, end?, query?, k?, tags?)`
Mementos in reverse-chronological order by `updated_at`, optionally bounded by a date window, ranked by a semantic `query` (reorder hint, NOT a filter — see `recall` for filtered semantic search), and/or filtered by a `tags` set (mementos carrying any of those tags). All filters STACK. With no params: the k most-recently-touched mementos overall (session bootstrap). With `start`/`end`: "what did we work on last week?" — an old memento edited inside the window is in range. With `tags=["recipes"]`: just the recipe mementos in the window, by recency.

### `get_memory_index()` / `update_memory_index(text)`
The vault keeps ONE curated summary memento — a hand-curated top-level view of what's worth knowing. The session-start hook loads its body once per conversation under a `[MEMORY-INDEX]` heading; `get_memory_index` re-reads it on demand and `update_memory_index(text)` revises it. There is only one index memento; its id is resolved internally — no need to track it.

### `sync()`
Pull the latest mementos from storage immediately, instead of waiting for the ~10-minute auto-sync. The AI is told to use this only when you insist a memory exists but `recall` came up empty — it may have been written on another device.

---

## Migrations

`mementos migrate` changes one of three things — the **storage backend**, the **key**, or the **embedder** — and all three run on one **staged model**:

1. **Stage** — build the fully-migrated vault in a staging directory, reading the live vault but never writing to it.
2. **Commit** — back the originals up, swap the staged files into place, finalise (keychain swap for key; `vault.json` for embedder; machine config for storage).

A manifest at `~/.config/mementos/migration-pending.json` fences the whole operation: while it exists, every other command refuses to touch the vault. It is deleted only as the last step — *manifest absent ⇒ vault fully consistent*.

This makes the lifecycle robust:
- **Resume** — re-run `mementos migrate`; it picks up where it crashed (the stage step is idempotent).
- **Abort** — `mementos migrate --abort`. During staging this just discards the staging directory — the live vault was never touched. During the brief commit it restores from the backup.
- A **typed new key** is entered twice and must match (a mistyped, unrecoverable mnemonic would otherwise be silent data loss), and the pre-migration vault is kept as a backup.
- `migrate` refuses while the daemon (`mementos start`) is running and syncs the source first.

`mementos backup [dir]` / `mementos restore <dir>` export the vault to a plain directory of encrypted files and import it back — a manual safety copy independent of migrations.

---

## Uninstalling

mementos installs more than an npm package. It writes machine config, an index cache, and the daemon's PID + token files under `~/.config/mementos/`; registers an MCP server (and skills/hooks) inside each AI client's own config; and stores the vault key in the OS keychain. **`npm uninstall` removes none of that** — npm only manages files inside the package, and modern npm (v7+) runs no uninstall lifecycle script.

Removal is a two-step process, and the order matters:

```bash
mementos uninstall          # (alias of `mementos destroy`) — run this FIRST
npm uninstall -g mementos   # then remove the package
```

`mementos uninstall` is interactive: multi-select toggles for the machine config & local state, the vault key, and the AI-client integrations. It deliberately does **not** delete vault data (the `.mem` files) — it prints where they live so you remove them deliberately, since `rm` means different things for a local vault versus a git-backed one.

If you already ran `npm uninstall` and the CLI is gone, `npx mementos uninstall` still works — it fetches the package transiently just to run the cleanup.
