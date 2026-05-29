/**
 * `mementos ingest` — bulk-import past content into the vault.
 *
 * Two ways to invoke:
 *
 *   1. **Interactive** (no positional arg): scan every registered `Ingestor`'s
 *      `defaultPath` on this machine, present the ones that have content as a checkbox,
 *      then loop a tag prompt one-at-a-time. Best UX for "I have years of past chats
 *      sitting around — pull them in."
 *
 *   2. **Scripted** (positional path): `mementos ingest <path> [--tag=foo,bar] [--dry-run]`
 *      — path is a file or directory. Tag list takes precedence over interactive prompt.
 *
 * Every supported file under a chosen path is routed to the matching Ingestor (each
 * ingestor's `detects(filePath)` decides whether to claim it). The ingestor returns
 * one or more `IngestSession`s; the CLI hands each to `vault.ingest` which gives
 * idempotency, atomic transactions, internal chunking of long mementos, and
 * parent_memento_id preservation in one call.
 *
 * Crash recovery falls out automatically: re-running ingest skips mementos whose
 * `mementoId` already exists, so a partial prior run resumes cleanly. No manifest needed.
 */
import { readdir, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { checkbox, input, confirm } from '@inquirer/prompts'
import { buildVault } from '../_utils/vault.js'
import { parseFlag } from '../_utils/flags.js'
import { loadIngestors } from '../../ingestors/registry.js'
import { findIngestor } from '../../ingestors/_utils/dispatch.js'
import type { Ingestor } from '../../ingestors/interface.js'

interface IngestStats {
  written: number      // sessions where at least one new part landed
  duplicates: number   // sessions where every part was already present
  errors: number       // files where parse or write threw
}

export async function runIngest(positional: string | undefined, _rest: string[]): Promise<void> {
  const dryRun = parseFlag('dry-run') !== undefined
  const tagFlag = parseFlag('tag')

  const ingestorReg = await loadIngestors()
  if (ingestorReg.size === 0) {
    console.error('No ingestors registered. Drop an implementation under src/ingestors/<name>/.')
    process.exit(1)
  }
  const ingestors = [...ingestorReg.values()].map(impl => impl.create())

  const paths = positional ? [positional] : await interactiveDiscovery(ingestors)
  if (paths.length === 0) {
    console.log('Nothing to ingest.')
    return
  }

  const matches: Array<{ file: string; ingestor: Ingestor }> = []
  for (const p of paths) {
    for await (const f of walkFiles(p)) {
      const ing = await findIngestor(f, ingestors)
      if (ing) matches.push({ file: f, ingestor: ing })
    }
  }
  if (matches.length === 0) {
    console.error(`No ingestible files found under: ${paths.join(', ')}`)
    process.exit(1)
  }

  const userTags = tagFlag !== undefined
    ? tagFlag.split(',').map(t => t.trim()).filter(Boolean)
    : await promptTagsInteractive()

  console.log(`\nIngesting ${matches.length} file(s)${dryRun ? ' (dry-run — nothing will be written)' : ''}…`)

  let vault: Awaited<ReturnType<typeof buildVault>> | null = null
  if (!dryRun) {
    vault = await buildVault()
    await vault.startup()
  }

  const stats: IngestStats = { written: 0, duplicates: 0, errors: 0 }

  const runOne = async (file: string, ingestor: Ingestor): Promise<void> => {
    try {
      const sessions = await ingestor.parse(file)
      if (sessions.length === 0) {
        console.log(`  skip ${displayName(file)} (no content after filtering)`)
        return
      }
      for (const s of sessions) {
        if (dryRun) {
          console.log(`  would ingest ${displayName(file)} → chronicle ${s.chronicleId}, ${s.mementos.length} memento(s)`)
          stats.written++
          continue
        }
        const tags = [...(s.tags ?? []), ...userTags]
        const r = await vault!.ingest(s.chronicleId, s.mementos, { tags, createdAt: s.createdAt })
        if (r.added > 0) {
          console.log(`  ${displayName(file)} → chronicle ${s.chronicleId}: +${r.added} new, ${r.skipped} already present`)
          stats.written++
        } else {
          console.log(`  ${displayName(file)} → chronicle ${s.chronicleId}: all ${r.skipped} mementos already present`)
          stats.duplicates++
        }
      }
    } catch (e) {
      console.error(`  error ${displayName(file)}: ${(e as Error).message}`)
      stats.errors++
    }
  }

  // Batch ingest is one logical write — hold the lock ONCE for the whole loop
  // rather than acquire/release per session. Thousands of acquire/release cycles
  // would otherwise create a race window where a concurrent process (e.g. an
  // active MCP server) could steal the lock between cycles, ECOMPROMISED-crash
  // the watchdog, and tear down the ingest mid-batch.
  if (vault && !dryRun) {
    await vault.writeLock.run(async () => {
      for (const { file, ingestor } of matches) await runOne(file, ingestor)
    })
  } else {
    for (const { file, ingestor } of matches) await runOne(file, ingestor)
  }

  if (vault) await vault.close()
  console.log(
    `\nDone. sessions_written=${stats.written} all_already_present=${stats.duplicates} errors=${stats.errors}`,
  )
  if (stats.errors > 0) process.exit(1)
}

// ─── Discovery + walk ─────────────────────────────────────────────────────────

interface Source {
  ingestor: Ingestor
  path: string
  fileCount: number
}

/** Scan every registered ingestor's defaultPath and count detected files there. */
async function discoverSources(ingestors: Ingestor[]): Promise<Source[]> {
  const out: Source[] = []
  for (const ing of ingestors) {
    if (!ing.defaultPath) continue
    let count = 0
    try {
      for await (const f of walkFiles(ing.defaultPath)) {
        if (await ing.detects(f)) count++
      }
    } catch { /* path missing or unreadable — skip */ }
    if (count > 0) out.push({ ingestor: ing, path: ing.defaultPath, fileCount: count })
  }
  return out
}

/**
 * Interactive flow when no positional path is given. Detect known sources, present a
 * checkbox; "Custom path" is always offered as the fallback for sources without a
 * default location (raw markdown, ad-hoc directories) or files outside the canonical
 * layout.
 */
async function interactiveDiscovery(ingestors: Ingestor[]): Promise<string[]> {
  const sources = await discoverSources(ingestors)
  console.log('Scanning for ingestible content…\n')
  if (sources.length === 0) {
    console.log('  No known sources detected on this machine.')
  } else {
    for (const s of sources) console.log(`  ✓ ${s.ingestor.name}   ${s.path}   ${s.fileCount} file(s)`)
    console.log('')
  }

  type Choice = { name: string; value: string }
  const choices: Choice[] = sources.map(s => ({
    name: `${s.ingestor.name}   ${s.path}   ${s.fileCount} file(s)`,
    value: s.path,
  }))
  choices.push({ name: 'Custom path (enter a file or directory)', value: '__custom__' })

  const chosen = await checkbox<string>({
    message: 'Which sources to ingest?',
    choices,
    required: false,
  })
  const paths: string[] = []
  for (const c of chosen) {
    if (c === '__custom__') {
      const custom = await input({ message: 'Path to file or directory:' })
      if (custom.trim()) paths.push(custom.trim())
    } else {
      paths.push(c)
    }
  }
  return paths
}

/**
 * Yield every file under `path`, recursing one level deep — matches the two-level layout
 * of the supported sources (e.g. Claude Code's `~/.claude/projects/<encoded-cwd>/*.jsonl`).
 * Single-file paths yield themselves. Deeper recursion is intentionally skipped — walking
 * into `node_modules` or similar by accident would be catastrophic.
 */
async function* walkFiles(path: string): AsyncGenerator<string> {
  let s
  try { s = await stat(path) } catch { return }
  if (s.isFile()) { yield path; return }
  if (!s.isDirectory()) return

  const top = await readdir(path, { withFileTypes: true })
  for (const e of top) {
    if (e.name.startsWith('.')) continue
    const sub = join(path, e.name)
    if (e.isFile()) { yield sub; continue }
    if (e.isDirectory()) {
      const inner = await readdir(sub, { withFileTypes: true }).catch(() => [])
      for (const i of inner) {
        if (!i.name.startsWith('.') && i.isFile()) yield join(sub, i.name)
      }
    }
  }
}

// ─── Tag prompt ────────────────────────────────────────────────────────────────

/**
 * Prompt for tags one at a time. Blank entry triggers a confirmation ("Done?" default
 * yes) — so an intentional Enter exits cleanly but an accidental Enter doesn't lose
 * progress; the user answers `n` and the loop keeps going.
 */
async function promptTagsInteractive(): Promise<string[]> {
  console.log('')
  const tags: string[] = []
  for (;;) {
    const t = (await input({ message: `Tag ${tags.length + 1} (blank to finish):` })).trim()
    if (t) {
      tags.push(t)
      continue
    }
    const done = await confirm({
      message: `Done adding tags?${tags.length > 0 ? ` (current: ${tags.join(', ')})` : ''}`,
      default: true,
    })
    if (done) return tags
  }
}

/** Pretty file path for logs — last two path segments. */
function displayName(p: string): string {
  const parts = p.split(sep)
  return parts.slice(-2).join('/')
}
