# `ClientIntegration` — how each AI tool is wired up

Each integration registers mementos's MCP server with one AI client, and where the client supports it, a skill file and/or hooks. The `mementos init` flow iterates over every discovered integration to install them all (or a user-filtered subset via `--integrations=name1,name2`).

```typescript
interface ClientIntegration {
  readonly name: string
  install(): Promise<void>          // wire up MCP server + skill (idempotent)
  uninstall(): Promise<void>        // remove everything we installed (idempotent)
  isInstalled(): Promise<boolean>   // is mementos currently registered with this client?
  isClientPresent(): Promise<boolean>   // heuristic: does the client appear to exist?
  readonly mcp?: BinarySurface      // optional: per-component MCP-server toggle
  readonly skill?: BinarySurface    // optional: per-component skill toggle
  readonly hooks?: HookSurface      // optional: registry of shell-command hooks
}

// Single `install / uninstall / isInstalled` shape used by skill, MCP, and each hook kind.
interface BinarySurface {
  isInstalled(): Promise<boolean>
  install(): Promise<void>
  uninstall(): Promise<void>
}

// HookSurface is a registry of BinarySurfaces, one per hook kind.
interface HookSurface {
  supportedHooks(): readonly string[]
  hook(kind: string): BinarySurface       // throws on unknown kinds
  disableAllHooks(): Promise<void>        // batched uninstall — the clean-slate
}
```

Adding a new integration is one folder under `src/integrations/<name>/` — see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Implementations (eight ship today)

| | What it wires up |
|---|---|
| **`claude-code`** | MCP server (`~/.claude.json` via `claude mcp add --scope user`) + skill at `~/.claude/skills/mementos/SKILL.md` (per-folder, with YAML frontmatter) + opt-in hooks (`session-start` / `pre-compact`) in `~/.claude/settings.json` |
| **`codex`** | MCP server (via `codex mcp add`) + skill at `~/.agents/skills/mementos/SKILL.md` + opt-in `session-start` hook in `~/.codex/hooks.json` |
| **`antigravity-cli`** | Plugin bundle at `~/.gemini/config/plugins/mementos/` (`plugin.json` with MCP, `skills/mementos/SKILL.md`) + entry in `~/.gemini/config/import_manifest.json`. No hooks — Antigravity has no session-lifecycle event. |
| **`openclaw`** | MCP server (via `openclaw mcp set`) + skill at `<state>/workspace/skills/mementos/SKILL.md` |
| **`opencode`** | MCP server (direct JSON edit of `~/.config/opencode/opencode.json`) + skill at `~/.config/opencode/skills/mementos/SKILL.md` |
| **`claude-desktop`** | MCP server entry only — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `~/.config/Claude/claude_desktop_config.json` (Linux), `%APPDATA%\Claude\claude_desktop_config.json` (Windows) |
| **`cursor`** | MCP server entry only — `~/.cursor/mcp.json` |
| **`antigravity`** (IDE) | MCP server entry only — `~/.gemini/config/mcp_config.json` (the shared MCP config for Antigravity 2.0, IDE, and CLI; separate product from the Antigravity CLI plugin integration) |

MCP, skill, and hooks are each independently toggleable in `setupAtInit` (via `promptBinaryToggle` driving the integration's `mcp` / `skill` / `hooks.hook(kind)` `BinarySurface`s). Skill defaults Yes (foundational); MCP defaults to the current state; hooks vary per-kind (session-start defaults Yes, pre-compact No). Picking No to MCP puts the integration in **CLI mode** — the AI invokes `mementos recall "..."`, `mementos write "..."`, etc. via its shell tool instead of MCP. Works on every shell-capable client (Claude Code, Codex, Antigravity CLI, OpenCode).

## What `mementos init` does

Interactive by default — every choice has a sensible default you accept with Enter. It asks for the storage backend (`local`/`git`), embedder (`minilm`/`openai`), vector index, key provider (`keychain`/`env`), and retriever; generates the vault key (shown once — write it down); offers to set up the AI-client integrations; then writes two config files:

- **`~/.config/mementos/config.json`** — per-device: `vaultPath`, `backend`, `vectorIndex`, `retriever`, `searcher`, `keyProvider`, plus the backend's `backendConfig` blob (e.g. `{ remote, sshKeyPath? }` for git). Outside the vault directory so it never pollutes `git status` or lands in a shared repo.
- **`<vaultPath>/vault.json`** — per-vault: `embedder`. Written **through the storage backend** (so `GitBackend` commits + pushes it) — it travels with the vault to every device.

Flags skip prompts for CI/scripting: `--backend=`, `--embedder=`, `--index=`, `--retriever=`, `--searcher=`, `--key=`, `--integrations=`, `--git-remote=`, `--git-ssh-key=generate|<path>|inherit`, `--mode=new|join`. Per-integration component toggles use the integration's name: `--claude-code-mcp=on|off`, `--claude-code-skill=on|off`, `--claude-code-hook-session-start=on|off`, etc. — one flag per (integration, component) pair.

Running `init` on an already-initialised machine **refuses** (pointing at `mementos integration enable` / `mementos integration hook enable`); `--reinit` re-runs anyway, and even then the vault key is **never** regenerated.

## Hooks vs MCP server

Two short-lived hook subprocesses + one long-lived server:

- **`mementos session-start`** — opt-in, fires once at conversation start. Emits the curated memory-index memento under a `[MEMORY-INDEX]` prelude so the AI knows what's in the vault without having to call `recall` first. Used by `claude-code` (`SessionStart`, matcher `startup|resume`) and `codex` (`SessionStart`).
- **`mementos snapshot`** — opt-in, fires before context compaction. Ingests the in-progress transcript into the vault so a long conversation doesn't get lost when the client compacts. Used by `claude-code` only (`PreCompact`, matcher `auto`).
- **MCP server → `mementos mcp`** — stdio MCP shim AI clients register via `claude mcp add ... mementos mcp`. The shim forwards every tool call (`recall`, `write_memento`, `search`, …) to the running daemon (`mementos start`) over plain HTTP. Auto-starts the daemon if not already up — AI clients don't see startup latency. When MCP mode is off, the AI invokes the equivalent CLI commands (`mementos recall "..."`, etc.) via its shell tool — those hit the SAME daemon over the SAME HTTP API, so both paths share one vault. (`mementos serve` is a back-compat alias of `mementos mcp` for one minor version.)

Both hook subprocesses also auto-start the daemon. The daemon is **the** vault on this machine; no subprocess builds its own copy. Hook commands carry no secrets — they read the bearer token from `~/.config/mementos/daemon.token` (which the daemon writes `0600` at startup). The per-prompt auto-retrieve hook was retired (the skill + session-start prelude cover the same UX without burning tokens on trivial turns).

## Shared helpers

The `_utils/` folder centralises the shapes every integration uses:

- `promptBinaryToggle` — single prompt helper that drives any `BinarySurface` (skill, MCP, per-hook). Replaces the per-component prompt helpers that existed before unification.
- `hookToggleMessages(label, integration, kind)` — returns the consistent `"<label> on/off. Disable later with: mementos integration hook (en|dis)able <integration> --type=<kind>"` pair for hook toggles. Pass straight into `promptBinaryToggle`.
- `jsonMcpConfigOps` — install/uninstall/isInstalled against a JSON config with an MCP-server map (used by claude-desktop / cursor / opencode / antigravity IDE).
- `standardJsonIntegration` — wraps `jsonMcpConfigOps` into a full `ClientIntegration` for MCP-only-JSON clients.
- `HookRegistry` + `jsonHooksAdapter` — hook lifecycle for the `event → groups → hooks → command` config shape every hook-bearing integration uses. Implements `HookSurface` so `hook(kind)` returns a ready-to-use `BinarySurface`.
- `writeSkillFile` + `SKILL_BODY` / `SKILL_MD` — skill content (one source of truth across every integration).
- `withInstallShell` — the standard `try { install + prompt } catch { skip }` shape for `setupAtInit`. Used by `defaultSetupAtInit` for the GUI-only integrations that have no per-component toggles.
- `cliRunner` + `probeCli` — talking to a client's own CLI.
- `readJsonConfig` / `writeJsonConfig` — atomic JSON read/write with the malformed-file-refuse rule.

## Docker drift tests

Where the client ships a runnable CLI, a Docker drift test installs the real CLI in a container and exercises the integration end-to-end against the genuine binary — so an upstream CLI / schema change is caught before publish. Run via `npm run test:docker:<name>`. See [tests/docker/](../../tests/docker/).
