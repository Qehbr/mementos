# `ClientIntegration` — how each AI tool is wired up

Each integration registers mementos's MCP server with one AI client, and where the client supports it, a skill file and/or hooks. The `mementos init` flow iterates over every discovered integration to install them all (or a user-filtered subset via `--integrations=name1,name2`).

```typescript
interface ClientIntegration {
  readonly name: string
  install(): Promise<void>          // wire up MCP server + skill (idempotent)
  uninstall(): Promise<void>        // remove everything we installed (idempotent)
  isInstalled(): Promise<boolean>   // is mementos currently registered with this client?
  isClientPresent(): Promise<boolean>   // heuristic: does the client appear to exist?
  readonly hooks?: HookSurface      // optional: shell-command hooks around AI events
}
```

Adding a new integration is one folder under `src/integrations/<name>/` — see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Implementations (eight ship today)

| | What it wires up |
|---|---|
| **`claude-code`** | MCP server (`~/.claude.json` via `claude mcp add --scope user`) + skill at `~/.claude/skills/mementos.md` + opt-in hooks (`auto-retrieve` / `pre-compact`) in `~/.claude/settings.json` |
| **`codex`** | MCP server (via `codex mcp add`) + skill at `~/.agents/skills/mementos/SKILL.md` + opt-in `auto-retrieve` hook in `~/.codex/hooks.json` |
| **`antigravity-cli`** | Plugin bundle at `~/.gemini/config/plugins/mementos/` (`plugin.json` with MCP + hooks, `skills/mementos/SKILL.md`) + entry in `~/.gemini/config/import_manifest.json` |
| **`openclaw`** | MCP server (via `openclaw mcp set`) + skill at `<state>/workspace/skills/mementos/SKILL.md` |
| **`opencode`** | MCP server (direct JSON edit of `~/.config/opencode/opencode.json`) + skill at `~/.config/opencode/skills/mementos/SKILL.md` |
| **`claude-desktop`** | MCP server entry only — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `~/.config/Claude/claude_desktop_config.json` (Linux), `%APPDATA%\Claude\claude_desktop_config.json` (Windows) |
| **`cursor`** | MCP server entry only — `~/.cursor/mcp.json` |
| **`antigravity`** (IDE) | MCP server entry only — `~/.gemini/antigravity/mcp_config.json` (separate product from the Antigravity CLI) |

Hooks are always opt-in (`mementos integration hook enable <name>`); the default everywhere is AI-driven `recall`, guided by the skill file — works identically for every MCP-compatible client with no per-message token cost.

## What `mementos init` does

Interactive by default — every choice has a sensible default you accept with Enter. It asks for the storage backend (`local`/`git`), embedder (`local`/`openai`), vector index, key provider (`keychain`/`env`), and retriever; generates the vault key (shown once — write it down); offers to set up the AI-client integrations; then writes two config files:

- **`~/.config/mementos/config.json`** — per-device: `vaultPath`, `backend`, `vectorIndex`, `retriever`, `searcher`, `keyProvider`, plus the backend's `backendConfig` blob (e.g. `{ remote, sshKeyPath? }` for git). Outside the vault directory so it never pollutes `git status` or lands in a shared repo.
- **`<vaultPath>/vault.json`** — per-vault: `embedder`. Written **through the storage backend** (so `GitBackend` commits + pushes it) — it travels with the vault to every device.

Flags skip prompts for CI/scripting: `--backend=`, `--embedder=`, `--index=`, `--retriever=`, `--searcher=`, `--key=`, `--integrations=`, `--git-remote=`, `--git-ssh-key=generate|<path>|inherit`, `--mode=new|join`. Per-integration skill/hook toggles use the integration's name: `--claude-code-skill=on|off`, `--claude-code-hook-auto-retrieve=on|off`, etc. — one flag per (integration, hook-kind) pair.

Running `init` on an already-initialised machine **refuses** (pointing at `mementos integration enable` / `mementos integration hook enable`); `--reinit` re-runs anyway, and even then the vault key is **never** regenerated.

## Hook vs MCP server

- **Hook → `mementos retrieve`** — opt-in, short-lived. Fires once per user message via the client's hook mechanism, injects relevant mementos, exits. Used by `claude-code` (`UserPromptSubmit`), `codex` (`UserPromptSubmit`), `antigravity-cli` (`BeforeAgent`).
- **MCP server → `mementos serve`** — long-lived, started by the AI client. Provides all the MCP tools (`recall`, `write_memento`, `search`, …) over MCP stdio.

The hook command carries no secrets — `mementos retrieve` reads the vault key from the OS keychain itself.

## Shared helpers

The `_utils/` folder centralises the shapes every integration uses:

- `jsonMcpConfigOps` — install/uninstall/isInstalled against a JSON config with an MCP-server map (used by claude-desktop / cursor / opencode / antigravity IDE).
- `standardJsonIntegration` — wraps `jsonMcpConfigOps` into a full `ClientIntegration` for MCP-only-JSON clients.
- `HookRegistry` + `jsonHooksAdapter` — hook lifecycle for the `event → groups → hooks → command` config shape every hook-bearing integration uses.
- `writeSkillFile` + `SKILL_BODY` / `SKILL_MD` — skill content (one source of truth across every integration).
- `withInstallShell` — the standard `try { install + prompt } catch { skip }` shape for `setupAtInit`.
- `cliRunner` + `probeCli` — talking to a client's own CLI.
- `readJsonConfig` / `writeJsonConfig` — atomic JSON read/write with the malformed-file-refuse rule.

## Docker drift tests

Where the client ships a runnable CLI, a Docker drift test installs the real CLI in a container and exercises the integration end-to-end against the genuine binary — so an upstream CLI / schema change is caught before publish. Run via `npm run test:docker:<name>`. See [tests/docker/](../../tests/docker/).
