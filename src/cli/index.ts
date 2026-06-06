#!/usr/bin/env node
/**
 * mementos CLI — entry point and dispatcher only. Subcommand handlers live in cli/commands/.
 *
 *   init                     → commands/init.ts        first-time setup, interactive
 *   serve | retrieve         → commands/runtime.ts     vault runtime (AI-facing)
 *   list  | get | delete     → commands/runtime.ts     vault inspection (user-facing)
 *   hook  | integration      → commands/admin.ts       post-init administration
 *
 * The CLI is fully driven by auto-discovery: implementations live in `src/<abstraction>/<name>/`
 * and export `type` + `create` (and optionally `setupAtInit`). The CLI scans those folders
 * at runtime to find what's available.
 */
import { runInit } from './commands/init.js'
import {
  runSessionStart,
  runList, runGet, runDelete, runSync, runSearch,
  runRecall, runWrite, runUpdate, runTags, runChronicle, runChronicles, runIndex,
} from './commands/runtime.js'
import { runStart, runStop } from './commands/daemon.js'
import { runMcp } from './commands/mcp-shim.js'
import { runIntegration } from './commands/admin.js'
import { runShareKey } from './commands/share-key.js'
import { runDestroy } from './commands/destroy.js'
import { runMigrate } from './commands/migrate.js'
import { runDoctor } from './commands/doctor.js'
import { runIngest } from './commands/ingest.js'
import { runSnapshot } from './commands/snapshot.js'
import { runBackup, runRestore } from './commands/backup.js'
import { printBanner } from './_utils/banner.js'

// A failed subcommand rejects the top-level await below — most often `buildVault()`
// reporting an uninitialised vault or a pending migration, whose Error message already
// names the next command to run. Without this handler Node prints a raw "unhandled
// rejection" stack and buries that message; here we surface just the message and exit 1.
// MEMENTOS_DEBUG re-enables the full stack for diagnosing an unexpected failure.
//
// Ctrl-C inside an interactive `@inquirer/prompts` call rejects with `ExitPromptError`
// — that's not an error worth a stack trace; the user intentionally aborted. Exit 130
// (the POSIX convention for SIGINT-terminated programs) with no output.
process.on('unhandledRejection', (reason: unknown) => {
  if (reason instanceof Error && reason.name === 'ExitPromptError') process.exit(130)
  const err = reason instanceof Error ? reason : new Error(String(reason))
  console.error(err.message)
  if (process.env['MEMENTOS_DEBUG']) console.error(err.stack)
  process.exit(1)
})

const [, , command, subcommand, ...args] = process.argv

// Top-level try/catch belt-and-braces alongside the unhandledRejection handler
// above. In Node 22's default `--unhandled-rejections=throw` mode the runtime
// can still print an ExitPromptError trace BEFORE the rejection handler runs;
// catching here suppresses it cleanly and exits 130 (POSIX SIGINT convention).
try {
  switch (command) {
    case 'init':        await runInit(); break
    case 'mcp':         await runMcp(); break
    // `serve` is a back-compat alias of `mcp` for one minor version — old
    // integration configs that still say `mementos serve` continue to work.
    case 'serve':       await runMcp(); break
    case 'start':       await runStart(); break
    case 'stop':        await runStop(); break
    case 'session-start': await runSessionStart(); break
    case 'list':        await runList(subcommand, args); break
    case 'get':         await runGet(subcommand); break
    case 'delete':      await runDelete(subcommand); break
    case 'search':      await runSearch(subcommand, args); break
    case 'sync':        await runSync(); break
    case 'recall':      await runRecall(subcommand, args); break
    case 'write':       await runWrite(subcommand, args); break
    case 'update':      await runUpdate(subcommand, args); break
    case 'tags':        await runTags(); break
    case 'chronicle':   await runChronicle(subcommand); break
    case 'chronicles':  await runChronicles(); break
    case 'index':       await runIndex(subcommand, args); break
    case 'integration': await runIntegration(subcommand, args); break
    case 'share-key':   await runShareKey(); break
    case 'destroy':     await runDestroy(); break
    case 'uninstall':   await runDestroy(); break
    case 'migrate':     await runMigrate(); break
    case 'backup':      await runBackup(subcommand); break
    case 'restore':     await runRestore(subcommand); break
    case 'doctor':      await runDoctor(); break
    case 'ingest':      await runIngest(subcommand, args); break
    case 'snapshot':    await runSnapshot(); break
    case undefined:
      printBanner()
      printQuickstart()
      break
    case 'help':
    case '--help':
    case '-h':
      printBanner()
      printFullHelp()
      break
    default:
      // Unknown command — show the quickstart so the user sees a path forward, but exit 1
      // so scripting doesn't silently treat a typo as success.
      printBanner()
      console.error(`Unknown command: \`${command}\`. See the quickstart below; run \`mementos --help\` for the full reference.\n`)
      printQuickstart()
      process.exitCode = 1
  }
} catch (e) {
  if (e instanceof Error && e.name === 'ExitPromptError') process.exit(130)
  throw e
}

/**
 * Friendly first-screen for `mementos` with no args — the four primary entry points
 * (init / integration / ingest / serve) plus pointers to full help and doctor. Tight by
 * design; the full reference is one keystroke away via `mementos --help`.
 */
function printQuickstart(): void {
  console.log(`encrypted AI memory vault

Get started:
  mementos init                       Set up a vault on this machine (interactive)
  mementos integration enable <name>  Connect an AI tool
                                        (claude-code, codex, antigravity-cli, claude-desktop, …)
  mementos ingest                     Import past conversations (interactive)
  mementos serve                      Start the MCP server (usually called by your AI client)

  mementos --help                     Full command reference
  mementos doctor                     Check installation health
`)
}

/** The full command reference — `mementos --help` / `mementos help` / `mementos -h`. */
function printFullHelp(): void {
  console.log(`encrypted AI memory vault

Usage:
  mementos init [--reinit] [--full]            Interactive first-time setup. Refuses if a
                                               vault is already initialised on this machine.
                                               Use --reinit to re-prompt configs without
                                               regenerating the vault key (memories stay
                                               readable). By default only the backends you
                                               pick are installed (thin, on demand); --full
                                               pre-fetches every optional backend + the
                                               MiniLM embedding model so the vault then runs
                                               fully offline. Flags below skip prompts:
    --full                  pre-install all optional backends + model (offline-ready)
    --mode=new|join
    --vault-path=DIR
    --backend=local|git
    --git-remote=URL
    --git-ssh-key=generate|<path>|inherit
                            per-vault SSH key for the git backend. 'generate' makes a fresh
                            ed25519 key at ~/.ssh/mementos_vault_<hash>; <path> uses your
                            own private key; 'inherit' (or absent in scripted mode) falls
                            back to the host ssh-agent / ~/.ssh/config.
    --embedder=minilm|openai
    --index=hnsw
    --retriever=semantic|hybrid
    --searcher=scan|trigram|none
    --key=keychain|env
    --keychain-fallback=ask|allow|refuse
                            policy when the OS keychain is unavailable. 'ask' (default)
                            prompts before downgrading to ~/.local/share/mementos/key
                            (chmod 600); 'allow' silently downgrades (CI / scripted);
                            'refuse' aborts so the user installs a keychain backend first.
    --integrations=name1,name2|none
    --<integration>-skill=on|off            install a client's skill file
    --<integration>-hook-<kind>=on|off       toggle a client's hook
                            e.g. --claude-code-hook-auto-retrieve=on
                                 --codex-hook-auto-retrieve=off

  mementos serve                               Start the MCP server (called by AI tools)

  # Recall + write (mirror the MCP tools; shell-capable AI clients can use these
  # instead of MCP via their Bash/Shell tool).
  mementos recall <query> [--k=N] [--tags=a,b] [--exclude-tags=a,b] [--chronicle=id]
                                               Semantic search for relevant mementos.
  mementos write <text> [--tags=a,b]           Store a new memento. Text via positional
                                               OR piped stdin: \`echo "text" | mementos write\`.
  mementos update <id> <text> [--tags=a,b]     Replace a memento's text (id and any
                                               un-passed tags preserved). Text via positional
                                               OR piped stdin.
  mementos tags                                List every tag in use with its usage count.

  # Read paths
  mementos list [tag...] [--tags=a,b] [--start=YYYY-MM-DD] [--end=...] [--query=...] [--k=N]
                                               List mementos. With dates/query: ranked by
                                               recency or semantic relevance over a range.
                                               With tags: filter by tag (positional or --tags).
  mementos get <id>                            Show full text of a memory by id
  mementos chronicle <id>                      Read every memento of one conversation
                                               (chronicle) in order, with forks annotated.
  mementos chronicles                          List every chronicle with memento count + start time.
  mementos index [<text>]                      Read the curated memory-index memento, or
                                               replace its body when text is given (positional
                                               or piped stdin).
  mementos delete <id>                         Delete a memory by id.
  mementos search <query> [--regex] [--k=N] [--context=N] [--case-sensitive]
                                               Exact-text search across all mementos —
                                               literal substring, or regex with --regex.
                                               Prints match snippets with context, not
                                               whole mementos. Complements semantic recall.
                                               Needs a searcher (init --searcher=scan|trigram).
  mementos sync                                Pull the latest memories from storage now
                                               (instead of waiting for the ~10-min auto-sync).

  mementos integration list                    List all known integrations
  mementos integration enable <name>           Install mementos into an integration
  mementos integration disable <name>          Uninstall from an integration
  mementos integration configure               Re-run the interactive integration selection
                                               (same prompts as init's integrations step; pre-checks
                                               what's already installed, blind Enter keeps it).
  mementos integration hook enable | disable | status <name> [--type=auto-retrieve|pre-compact]
                                               Manage a client's hooks. claude-code, codex and
                                               antigravity-cli support the auto-retrieve hook (pre-inject
                                               memories before each message); claude-code also has
                                               a pre-compact hook (snapshot before context compaction).

  mementos share-key                           Transfer the vault key to another device,
                                               either by showing it on screen (mnemonic
                                               or raw base64) or by LAN pairing — both
                                               machines on the same network confirm a
                                               6-digit code matches and the key is sent
                                               over an ECDH-encrypted channel. TTY-only.
                                               The receiving side is 'mementos init
                                               --mode=join', which prompts for the key.

  mementos destroy   (alias: uninstall)        Interactive cleanup of this machine's
                                               mementos setup — machine config & local
                                               state, vault key, and the MCP entries /
                                               skills / hooks installed into AI clients.
                                               Vault data (.mem files) is preserved; its
                                               location is printed for manual removal.
                                               TO FULLY REMOVE MEMENTOS: run this FIRST,
                                               THEN 'npm uninstall -g mementos'. npm
                                               cannot run cleanup on uninstall, so the
                                               order matters — once the CLI is gone you
                                               can no longer run it.

  mementos migrate [--type=storage|key|embedder] [--abort]
                                               Migrate the vault. Three types: move
                                               between storage backends, rotate the
                                               vault key, or switch the embedder.
                                               Crash-safe via a small manifest at
                                               ~/.config/mementos/migration-pending.json;
                                               re-run to resume an interrupted
                                               migration, or --abort to scrap it. The
                                               old vault is left in place; mementos
                                               does NOT delete it automatically.

  mementos backup [dir]                        Export the vault (encrypted .mem files +
                                               vault.json) to a directory. Defaults to
                                               ~/mementos-backup-<timestamp>.
  mementos restore <dir>                       Write a backup directory's files back
                                               into the vault.

  mementos ingest [path] [--tag=t1,t2] [--dry-run]
                                               Bulk-import past content into the vault.
                                               No path → interactive: scan known sources
                                               (Claude Code transcripts today; more
                                               ingestors can be added under
                                               src/ingestors/<name>/), pick which to
                                               ingest, then prompt for tags one at a
                                               time. With a path: ingest that file or
                                               directory directly. Re-running is
                                               idempotent: mementos already in the vault
                                               are skipped automatically, so an
                                               interrupted run resumes cleanly.

  mementos doctor                              Dependency-ordered health check: config,
                                               vault path, key, storage, vault.json,
                                               decrypt probe, embedder, index cache,
                                               integrations. Short-circuits cleanly on
                                               prereq failure. Exit code 0 if all OK,
                                               1 if any check failed — scriptable.

  (Internal: \`mementos session-start\` and \`mementos snapshot\` are hook subprocesses
   invoked by AI clients. \`session-start\` fires once per conversation (loads the
   curated memory index); \`snapshot\` fires before context compaction (pre-compact).
   Enable each via \`mementos integration hook enable <name> --type=session-start\`
   or \`--type=pre-compact\`.)
`)
}
