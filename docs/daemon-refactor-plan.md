# Daemon refactor — final design

> Reference for the architecture introduced in this refactor. Captures the WHY behind the choices so future-you can recover the reasoning without re-running the conversation.

## Goal

**Exactly one vault in memory across the machine.** Before this refactor each `mementos serve` instance (one per AI client) built its own vault — embedder model (~500 MB MiniLM) + HNSW index + meta store all duplicated. With 2-3 AI clients the cost added up to 1-1.5 GB of wasted memory plus per-session vault-startup latency.

The fix: **one persistent process (`mementos start`) owns the vault.** Everything else — AI clients via MCP, CLI commands, hook subprocesses — is a thin client of that process.

## Architecture

```
mementos start (the daemon)
  └─ Plain HTTP server on 127.0.0.1:47899
      Authorization: Bearer <token>   ← ~/.config/mementos/daemon.token (0600)
      POST /api/tools/<name>           ← one route per Vault op (13 tools)
      POST /api/hooks/ingest_chronicle ← batched chronicle ingest (snapshot, ingest)
      GET  /api/_meta/info             ← { version, searchEnabled, tools[] }

mementos mcp (the stdio MCP shim AI clients register)
  └─ Translates stdio MCP ↔ plain HTTP. NO vault state. Auto-starts daemon if absent.

mementos recall / write / update / get / delete / tags / chronicle / chronicles /
  index / list / search / sync
  └─ Plain `fetch()` POSTs to /api/tools/<name>. NO MCP SDK. NO vault.
     Strict mode: errors with "Run `mementos start` first" if no daemon.

mementos session-start (hook)
  └─ ensureDaemonRunning(); callTool('get_memory_index', {}); print prelude.

mementos snapshot, mementos ingest (hooks/CLI)
  └─ Parse transcript locally (ingestor); for each session POST
     /api/hooks/ingest_chronicle. Daemon does vault.ingest(...).
     NO own vault.
```

## Why plain HTTP and not MCP-over-HTTP between processes

The original plan had the daemon ALSO speak MCP (via the MCP SDK's `StreamableHTTPServerTransport`). The user pushed back: why pay JSON-RPC ceremony, session management, schema validation through SDK adapters, and undici dispatcher complexity for talking to your OWN daemon on localhost?

The split that emerged:

- **MCP is the protocol for AI clients** (they speak it natively; the SDK does what's needed)
- **Plain HTTP is the protocol between our own processes** (CLI ↔ daemon, hook ↔ daemon, shim ↔ daemon)

The MCP SDK lives **only in the shim**. Daemon, CLI, and hooks use Node's built-in `fetch`. Net effect: dropped ~290 lines of MCP-HTTP adapter code, added ~150 lines of plain HTTP plumbing, the daemon is curl-debuggable, hooks fit naturally as just another route.

## Why token auth + localhost port

Two threat-model facts:

1. `127.0.0.1` binding rejects external network at the kernel level (good baseline).
2. ANY local user could otherwise POST to the port if we left it open — same machine, different user, malicious script.

**Token bearer auth fixes (2)**:
- 256-bit hex generated at daemon startup, written to `~/.config/mementos/daemon.token` with `0600` perms.
- Other local users can't read the file → can't forge requests.
- Token regenerates on each daemon start — a leaked token from yesterday is dead today.
- Clients (CLI, shim, hook) read the file, send `Authorization: Bearer <token>` on every request.
- Constant-time compare on the daemon side (`tokensMatch`) — no timing side-channel.

**Future hosted mode reuses this**:
- Same Authorization-header validation, different token storage (per-user tokens in a real auth store).
- Bind `0.0.0.0` instead of `127.0.0.1`, add TLS in front.
- No throwaway auth code. Localhost case and hosted case share the path.

## Why TCP port and not unix socket

We considered unix socket — filesystem perms (0600) would replace the token, simpler in some ways. Two reasons we went with TCP port:

1. **Forward-compat with hosted mode**: unix socket forecloses ever exposing remotely without rewriting the transport. TCP port + token works identically local and remote.
2. **Cross-platform without branching**: TCP works the same on Linux / macOS / Windows. Unix socket needs Windows named-pipe code paths.

The default port is `47899` — chosen to avoid Ollama (11434), Postgres, Redis, Mongo, common dev-server ranges. Overridable via `MEMENTOS_PORT`.

## Tool registry — single source of truth

`src/core/tools.ts` exports `CORE_TOOLS`, `CONDITIONAL_TOOLS`, and `activeTools({ searchEnabled })`. Each tool is a `ToolDef`:

```typescript
interface ToolDef<A> {
  description: string                      // shown to the AI via MCP
  inputSchema: Record<string, ZodTypeAny>  // validation + MCP schema source
  annotations?: ToolAnnotations            // MCP hints (readOnly, destructive, ...)
  handler: (vault, args) => Promise<string> // daemon-side implementation
}
```

**Two consumers**:

- The **daemon** imports the registry, gets `activeTools`, registers one `POST /api/tools/<name>` per entry. Each route's logic: auth → JSON parse → Zod validate against `inputSchema` → `tool.handler(vault, validated)` → return `{text}`.
- The **MCP shim** also imports the registry. For each entry it registers an MCP tool with the SDK using `description` + `inputSchema` + `annotations`. The shim's MCP HANDLER (a hand-written arrow function in `mcp-shim.ts`) is a forwarder that calls `callTool(name, args)` from `api-client.ts` — which makes the HTTP POST. **The shim never invokes `tool.handler` itself** — it only uses the metadata.

The handler from `tools.ts` runs **only** in the daemon process. That's the architectural separation: the daemon is the only process that has a vault, and the only process that runs the handlers.

## Command catalog

| Command | Behavior |
|---|---|
| **`mementos init`** | First-time setup. Writes machine config, generates vault key. Does NOT start daemon. |
| **`mementos start`** | Run the daemon. Default = double-fork background. `--foreground` keeps stdio. |
| **`mementos stop`** | SIGTERM the daemon via PID file. Wait for port to free. |
| **`mementos mcp`** | Stdio MCP shim AI clients register via `claude mcp add ... mementos mcp`. Auto-starts daemon; proxies MCP tool calls to the daemon's HTTP API. |
| **`mementos recall / write / update / delete / get / tags / chronicle / chronicles / index / list / search / sync`** | Thin HTTP clients. POST `/api/tools/<name>`, print result. Error with `"Run mementos start first"` if no daemon. |
| **`mementos session-start`** | Hook. Auto-starts daemon; reads memory index via `callTool('get_memory_index', {})`; emits `[MEMORY-INDEX]` prelude. Fail-silent. |
| **`mementos snapshot`** | Hook. Parses transcript (ingestor); auto-starts daemon; for each session POSTs `/api/hooks/ingest_chronicle`. NO own vault. |
| **`mementos ingest [path]`** | CLI bulk import. Same shape as snapshot — parse + POST. NO own vault. |
| **`mementos doctor`** | Health check (config → vault → key → storage → decrypt → embedder → index cache → **daemon** → integrations). |
| **`mementos integration list/enable/disable/configure/hook`** | Edits AI-client config (skill, MCP shim registration, hook settings). |
| **`mementos share-key`** | LAN key transfer. |
| **`mementos migrate / backup / restore / destroy`** | **Refuse if daemon running** (via serve-registry). |

### Auto-start matrix

| Subprocess | Auto-starts daemon? | Why |
|---|---|---|
| `mementos start` | itself IS the daemon | — |
| `mementos mcp` | YES — `ensureDaemonRunning` waits up to 5s | AI client launched it expecting it to work |
| `mementos session-start`, `mementos snapshot`, `mementos ingest` | YES | Hooks fire without LLM intervention |
| All 12 CLI vault commands | NO | User typed it explicitly; clean error is honest |

## Mutual exclusion

- **One daemon at a time**: enforced by port binding. `assertPortFree` connect-probes the port at startup; if anything answers, refuse with an actionable error.
- **Migrate / backup / restore / destroy refuse if daemon alive**: enforced via the existing serve-registry — daemon writes `~/.config/mementos/serve/<PID>` and `assertNoServerRunning` checks the directory for live PIDs.

## Token lifecycle

- Generated at daemon startup with `randomBytes(32).toString('hex')`.
- Written `0600` to `~/.config/mementos/daemon.token` BEFORE port is bound (no race window).
- Read by clients on every request via `readToken()` (cheap — ~50µs).
- Deleted by daemon on graceful shutdown.
- Stale token after `kill -9`: `mementos doctor` flags it; `mementos start` overwrites on next run.

## Edge cases

- **Stale port** (daemon killed without releasing): TCP releases the port at the kernel level on process exit, no cleanup needed (unlike unix socket inodes).
- **Stale PID file**: `mementos stop` handles it (`ESRCH` on `kill`).
- **Token file with bad perms**: `mementos doctor`'s Daemon check flags it as `fail` with a `chmod 600` hint.
- **Token file missing while daemon running**: `mementos doctor` flags as `fail`; recommendation is restart the daemon.
- **Daemon dies mid-CLI call**: client gets `DaemonUnavailableError`; CLI command exits with the standard "Run `mementos start` first" message.

## What lives where

```
src/
  core/
    tools.ts                      ← registry: descriptions + schemas + handlers
    vault/index.ts                ← Vault class (unchanged)
    render.ts                     ← render functions (unchanged)
    mcp.ts                        ← DELETED (registry replaces it)
  daemon/
    runner.ts                     ← daemon main loop
    http-api.ts                   ← plain HTTP server, routes for tools + hooks + meta
    api-client.ts                 ← fetch-based client (callTool, ingestChronicle, ...)
    token.ts                      ← generate / read / delete / compare tokens
    endpoint.ts                   ← daemonHost / daemonPort / daemonUrl / pidFilePath
  cli/
    commands/
      daemon.ts                   ← runStart, runStop, ensureDaemonRunning
      mcp-shim.ts                 ← `mementos mcp` (stdio MCP server forwarding to daemon)
      runtime.ts                  ← 12 CLI vault commands (callTool wrappers)
      snapshot.ts                 ← PreCompact hook (parse + ingestChronicle)
      ingest.ts                   ← CLI bulk import (same shape as snapshot)
      doctor.ts                   ← health check, includes daemon diagnostic
      ... (init, migrate, backup, etc — unchanged)
    index.ts                      ← dispatcher
```

## Confirmed design decisions

1. ✅ Plain HTTP between our own processes (CLI / shim / hooks ↔ daemon), MCP only for AI ↔ shim
2. ✅ TCP port `127.0.0.1:47899` (overridable via `MEMENTOS_PORT`)
3. ✅ Token auth: random 256-bit hex, file `0600`, Authorization Bearer header
4. ✅ `mementos serve` retired; kept as a back-compat alias for `mementos mcp`
5. ✅ MCP shim auto-starts daemon
6. ✅ Hook subprocesses auto-start daemon
7. ✅ CLI commands error if no daemon (don't auto-start)
8. ✅ MCP / skill / hook toggles preserved (independent of daemon refactor)
9. ✅ Single tools.ts registry → daemon (handlers) + shim (metadata)
10. ✅ `core/mcp.ts` deleted; daemon has no MCP SDK dependency

## Future hosted mode (not built, but architecturally enabled)

- Bind `0.0.0.0` instead of `127.0.0.1`, add TLS in front (nginx/Caddy)
- Per-user tokens issued at sign-in, persisted in a real auth store
- Same `Authorization: Bearer` validation code
- Storage backend abstraction (current `local` and `git` backends → S3-per-user, Postgres, etc.)
- Multi-tenancy in the vault layer (per-user vault state in memory)

None of that requires changing the protocol or the tool registry. The hosted server's tool registry would be byte-identical to today's local daemon's. The hop the CLI/shim take is already plain HTTP; just point at a different URL via `MEMENTOS_URL`.
