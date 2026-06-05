/**
 * GitBackend — vault contents versioned in a git repository.
 *
 * On `init`, clones the remote. On every write/delete of a versioned file, commits locally
 * and pushes to `origin/<branch>`. On `sync`, runs `git pull --rebase --autostash`.
 *
 * Versioned files: `*.mem` and `vault.json`. Per-machine state (HNSW cache) lives outside
 * the vault directory — see `indexCacheFile()` in `core/config.ts`.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { SimpleGit } from 'simple-git'
import type { StorageBackend, FileStat } from '../interface.js'
import type { MachineConfig } from '../../core/types.js'
import type { InitContext } from '../../core/init-context/interface.js'
import type { StorageImplementationModule } from '../registry.js'
import { safeUnlink } from '../../core/_utils/fs.js'
import { pathExists } from '../../core/_utils/fs.js'
import { stagedRenameTransform } from '../_utils/staged-rename.js'
import { assertIfMatch, EtagMismatchError } from '../_utils/check-if-match.js'
import { writeAndStat } from '../_utils/write-and-stat.js'
import { MEM_EXTENSION } from '../../core/vault/constants.js'
import { VAULT_CONFIG_FILENAME } from '../../core/config.js'
import { readWithEtag, listMemFiles, statMtime } from '../_utils/fs-ops.js'
import { ensurePackage, requireFromPlugins } from '../../core/plugins.js'
import { summarizeMemDir } from '../_utils/data-summary.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'git'

/** Parse and validate the git-specific shape inside the opaque `backendConfig` blob. */
function readGitConfig(machine: MachineConfig): { remote: string; sshKeyPath?: string } {
  const cfg = tryReadGitConfig(machine.backendConfig)
  if (!cfg.remote) {
    throw new Error(
      `GitBackend requires backendConfig.remote in MachineConfig — set it via ` +
      `'mementos init --backend=git --git-remote=URL'.`,
    )
  }
  return { remote: cfg.remote, sshKeyPath: cfg.sshKeyPath }
}

/**
 * Non-throwing reader of the same git-backend shape. Use this from CLI surfaces (destroy
 * print recipe, migrate print, manifest read-back) that need the fields opportunistically
 * but shouldn't crash on a malformed/missing blob — every site stays in one place so a
 * future field rename (e.g. `remote` → `url`, nesting under `git: {…}`) lands here only.
 */
export function tryReadGitConfig(
  backendConfig: unknown,
): { remote?: string; sshKeyPath?: string } {
  const cfg = backendConfig as { remote?: unknown; sshKeyPath?: unknown } | undefined
  const remote = typeof cfg?.remote === 'string' && cfg.remote ? cfg.remote : undefined
  const sshKeyPath = typeof cfg?.sshKeyPath === 'string' && cfg.sshKeyPath ? cfg.sshKeyPath : undefined
  return { remote, sshKeyPath }
}

export function create(machine: MachineConfig): StorageBackend {
  const { remote, sshKeyPath } = readGitConfig(machine)
  return new GitBackend({ localPath: machine.vaultPath, remoteUrl: remote, sshKeyPath })
}

export async function setupAtInit(ctx: InitContext): Promise<void> {
  await ensurePackage('simple-git', s => ctx.print(s))

  let remote = await promptRemoteUrl(ctx)
  const { sshKeyPath, finalRemote } = await promptSshKey(ctx, remote)
  remote = finalRemote

  ctx.patchMachineConfig({
    backendConfig: {
      remote: remote.trim(),
      ...(sshKeyPath ? { sshKeyPath } : {}),
    },
  })
}

/** Remote-URL prompt (flag-aware). Inquirer's `input.validate` rejects empty. */
async function promptRemoteUrl(ctx: InitContext): Promise<string> {
  const fromFlag = ctx.getFlag('git-remote')
  if (fromFlag !== undefined && fromFlag !== '') return fromFlag
  const { input } = await import('@inquirer/prompts')
  return await input({
    message: 'Git remote URL (e.g. git@github.com:user/vault.git):',
    validate: (v: string) => v.trim().length > 0 || 'Remote URL is required',
  })
}

/**
 * SSH-key flow. Returns the chosen `sshKeyPath` (or undefined for inherit) and the
 * `finalRemote` — which may have been rewritten from HTTPS → SSH form when the user opted
 * in to per-vault key auth against a GitHub HTTPS remote.
 *
 *   --git-ssh-key=generate    generate a new ed25519 keypair under ~/.ssh/, no prompts
 *   --git-ssh-key=<path>      use the existing private key at <path>, no prompts
 *   --git-ssh-key=inherit     skip per-vault key, use host ssh-agent / ~/.ssh/config
 *   (absent)                  interactive: prompts with `generate` as the default
 */
async function promptSshKey(
  ctx: InitContext, remote: string,
): Promise<{ sshKeyPath: string | undefined; finalRemote: string }> {
  const flag = ctx.getFlag('git-ssh-key')
  let choice: 'generate' | 'existing' | 'inherit'
  let providedPath: string | undefined
  if (flag === 'inherit') choice = 'inherit'
  else if (flag === 'generate') choice = 'generate'
  else if (flag !== undefined && flag !== '') { choice = 'existing'; providedPath = flag }
  // Non-TTY (CI / scripted / piped) defaults to inherit silently — same posture as
  // `git config` and `npm` do for prompts. Users opting in non-interactively pass the flag.
  else if (!process.stdin.isTTY) choice = 'inherit'
  else choice = await selectSshKeyChoice()

  if (choice === 'inherit') return { sshKeyPath: undefined, finalRemote: remote }

  // SSH-key auth requires an SSH remote. For convertible HTTPS URLs (github.com), offer
  // to rewrite; otherwise warn and fall back to inherit.
  const parsed = parseRemote(remote)
  let effectiveRemote = remote
  if (!parsed.isSsh) {
    if (parsed.sshUrl) {
      const { confirm } = await import('@inquirer/prompts')
      const ok = await confirm({
        message: `SSH-key auth needs an SSH remote URL. Rewrite ${remote} → ${parsed.sshUrl}?`,
        default: true,
      })
      if (!ok) {
        ctx.warn('Keeping HTTPS remote — skipping SSH key setup (using inherited git auth).')
        return { sshKeyPath: undefined, finalRemote: remote }
      }
      effectiveRemote = parsed.sshUrl
    } else {
      ctx.warn(`Remote ${remote} is not SSH and not convertible — skipping SSH key setup.`)
      return { sshKeyPath: undefined, finalRemote: remote }
    }
  }

  const keyPath = choice === 'generate'
    ? await generateSshKey(ctx, effectiveRemote)
    : await resolveExistingKey(ctx, providedPath)

  const reparsed = parseRemote(effectiveRemote)
  await displayPubkey(ctx, keyPath, reparsed)
  await verifySshConnection(ctx, effectiveRemote, keyPath)

  return { sshKeyPath: keyPath, finalRemote: effectiveRemote }
}

async function selectSshKeyChoice(): Promise<'generate' | 'existing' | 'inherit'> {
  const { select } = await import('@inquirer/prompts')
  return await select<'generate' | 'existing' | 'inherit'>({
    message: 'Per-vault SSH key (recommended: scopes write access to this repo only)',
    choices: [
      { name: 'Generate a new key (recommended)', value: 'generate' },
      { name: 'Use an existing key file', value: 'existing' },
      { name: 'Inherit from system git (no per-vault key)', value: 'inherit' },
    ],
    default: 'generate',
  })
}

/** Parsed remote-URL view: SSH form, deploy-keys URL hint for github.com. Exported for tests. */
export interface ParsedRemote {
  isSsh: boolean
  /** SSH form for HTTPS github.com remotes — for the rewrite confirmation. */
  sshUrl?: string
  /** github.com deploy-keys "new" URL, when the remote is on github.com. */
  deployKeysUrl?: string
}

export function parseRemote(url: string): ParsedRemote {
  const isSsh = url.startsWith('git@') || url.startsWith('ssh://')
  // GitHub HTTPS: https://github.com/owner/repo[.git]
  const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (httpsMatch) {
    const [, owner, repo] = httpsMatch
    return {
      isSsh: false,
      sshUrl: `git@github.com:${owner}/${repo}.git`,
      deployKeysUrl: `https://github.com/${owner}/${repo}/settings/keys/new`,
    }
  }
  // GitHub SSH: git@github.com:owner/repo[.git]
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (sshMatch) {
    const [, owner, repo] = sshMatch
    return { isSsh: true, deployKeysUrl: `https://github.com/${owner}/${repo}/settings/keys/new` }
  }
  return { isSsh }
}

/**
 * Default key path: ~/.ssh/mementos_vault_<8-hex-of-remote>. Hash makes two vaults on the
 * same machine produce distinct paths so a re-init for a different remote doesn't clobber
 * the first vault's key. Reuses an existing key at the same path instead of regenerating —
 * an existing key is a deliberate artifact (already paired with a deploy key on the host).
 */
export function defaultSshKeyPath(remote: string): string {
  const hash = createHash('sha256').update(remote).digest('hex').slice(0, 8)
  return join(homedir(), '.ssh', `mementos_vault_${hash}`)
}

async function generateSshKey(ctx: InitContext, remote: string): Promise<string> {
  const keyPath = defaultSshKeyPath(remote)
  if (await pathExists(keyPath)) {
    ctx.print(`SSH key already exists at ${keyPath} — reusing it.`)
    return keyPath
  }
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 })
  ctx.print(`Generating SSH key at ${keyPath}…`)
  await runCmd('ssh-keygen', [
    '-t', 'ed25519',
    '-f', keyPath,
    '-N', '',
    '-C', `mementos vault ${remote}`,
  ])
  return keyPath
}

async function resolveExistingKey(ctx: InitContext, providedPath: string | undefined): Promise<string> {
  let raw: string
  if (providedPath !== undefined) raw = providedPath
  else {
    const { input } = await import('@inquirer/prompts')
    raw = await input({
      message: 'Path to your SSH private key:',
      validate: (v: string) => v.trim().length > 0 || 'Key path is required',
    })
  }
  const expanded = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
  if (!await pathExists(expanded)) {
    throw new Error(`SSH key not found at ${expanded} — re-run with a valid path.`)
  }
  if (expanded.endsWith('.pub')) {
    throw new Error(`Expected a PRIVATE key path, got what looks like a public key: ${expanded}`)
  }
  ctx.print(`Using SSH key at ${expanded}.`)
  return expanded
}

async function displayPubkey(ctx: InitContext, keyPath: string, parsed: ParsedRemote): Promise<void> {
  const pubPath = `${keyPath}.pub`
  if (!await pathExists(pubPath)) {
    throw new Error(`Public key not found at ${pubPath} — every private key needs its .pub companion to register on the remote.`)
  }
  const pub = (await readFile(pubPath, 'utf8')).trim()
  ctx.print('')
  if (parsed.deployKeysUrl) {
    ctx.print('Add this public key to your vault repo as a deploy key:')
    ctx.print(`  → ${parsed.deployKeysUrl}`)
    ctx.print('  ☑ Allow write access')
  } else {
    ctx.print('Add this public key as a deploy key on your git host (write access enabled):')
  }
  ctx.print('')
  ctx.print('──── public key (copy below) ────')
  ctx.print(pub)
  ctx.print('─────────────────────────────────')
  ctx.print('')
  const { input } = await import('@inquirer/prompts')
  await input({ message: 'Press Enter once added' })
}

async function verifySshConnection(ctx: InitContext, remote: string, keyPath: string): Promise<void> {
  ctx.print('Testing the connection…')
  const { simpleGit } = requireFromPlugins('simple-git') as typeof import('simple-git')
  const sg = simpleGit({ config: GIT_CONFIG, unsafe: { allowUnsafeSshCommand: true } })
  sg.env(curatedSshEnv(keyPath))
  try {
    await sg.listRemote(['-h', remote])
  } catch (e) {
    throw new Error(
      `SSH key did not authenticate against ${remote}:\n  ${(e as Error).message}\n` +
      `Check that the deploy key is registered on the remote with write access enabled, then re-run init.`,
    )
  }
  ctx.print('✓ Authenticated.')
}

/** Spawn a command, fail-loud on non-zero exit with stderr in the message. */
async function runCmd(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim() || '(no stderr)'}`))
    })
  })
}

const _shape: StorageImplementationModule = { type, create, setupAtInit }

/** Files that should be committed and synced to the remote (vs. per-device cache files). */
function isVersioned(path: string): boolean {
  return path.endsWith(MEM_EXTENSION) || path === VAULT_CONFIG_FILENAME
}

/** Configuration for a GitBackend instance. */
export interface GitBackendConfig {
  /** Local working tree where `.mem` files live. Created on first `init` if absent. */
  localPath: string
  /** Remote URL (e.g. `git@github.com:user/vault.git`). Cloned on first `init`. */
  remoteUrl: string
  /**
   * Absolute path to an SSH private key used for every git operation against the remote.
   * When set, GIT_SSH_COMMAND is applied with `-o IdentitiesOnly=yes` so ssh-agent can't
   * substitute the user's default identity. When unset, git falls back to the host's
   * ssh-agent / ~/.ssh/config (current behavior). HTTPS remotes ignore this — `setupAtInit`
   * refuses or rewrites HTTPS remotes to SSH form before persisting the field.
   */
  sshKeyPath?: string
}

/**
 * Thrown by `sync()` when a `git pull --rebase` left the working tree mid-conflict — two
 * devices wrote the same file(s) concurrently. The conflict is the cross-device analogue
 * of an etag mismatch; `put` catches this and, if the conflict is on the path it tried to
 * write, converts to `EtagMismatchError` so Vault's standard stale-write retry applies.
 * The rebase is always aborted before this is thrown — the working tree is back to clean.
 */
export class GitRebaseConflictError extends Error {
  constructor(public readonly conflictedPaths: string[]) {
    super(`git rebase conflict on: ${conflictedPaths.join(', ')}`)
    this.name = 'GitRebaseConflictError'
  }
}

const BRANCH = 'main'
const GIT_CONFIG = ['user.name=mementos', 'user.email=mementos@vault']

/**
 * GIT_SSH_COMMAND for a configured per-vault key. `IdentitiesOnly=yes` is critical: without
 * it, ssh-agent silently substitutes the user's default identity when this key is rejected,
 * defeating the "scoped to vault" purpose.
 */
export function sshCommand(keyPath: string): string {
  return `ssh -i ${keyPath} -o IdentitiesOnly=yes`
}

/**
 * Minimal env for git child-processes when SSH-key auth is configured. We can't pass
 * `{...process.env, GIT_SSH_COMMAND}` because simple-git's safety plugin blocks several
 * inherited vars (EDITOR, PAGER, GIT_EDITOR, GIT_PAGER, …) categorised as env-injection
 * vectors. Instead we forward only what git/ssh genuinely need: PATH (find binaries),
 * HOME (find ~/.ssh and ~/.gitconfig), USER and SHELL (some git ops), SSH_AUTH_SOCK
 * (ssh-agent if running), and the LANG/LC_/TZ locale family. Plus our explicit
 * GIT_SSH_COMMAND. Nothing else inherits.
 */
export function curatedSshEnv(keyPath: string): Record<string, string> {
  const env: Record<string, string> = { GIT_SSH_COMMAND: sshCommand(keyPath) }
  const passthrough = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TZ', 'SSH_AUTH_SOCK']
  for (const k of passthrough) {
    const v = process.env[k]
    if (v !== undefined) env[k] = v
  }
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('LC_')) {
      const v = process.env[k]
      if (v !== undefined) env[k] = v
    }
  }
  return env
}

export class GitBackend implements StorageBackend {
  private sg: SimpleGit | null = null

  constructor(private readonly config: GitBackendConfig) {}

  /**
   * Build a new SimpleGit instance with the per-vault GIT_SSH_COMMAND applied when
   * `sshKeyPath` is configured. Used at every site that constructs simple-git so the SSH
   * key is honored uniformly — clone, ls-remote, status, push, pull all go through it.
   *
   * When sshKeyPath is set, opt in to `allowUnsafeSshCommand` — simple-git defensively
   * refuses GIT_SSH_COMMAND by default to defeat env-injection attacks; we're the producer
   * of the value (from a mementos-owned config field), so the gate is met.
   */
  private newSimpleGit(baseDir: string | undefined, simpleGit: typeof import('simple-git').simpleGit): SimpleGit {
    const opts = this.config.sshKeyPath
      ? { config: GIT_CONFIG, unsafe: { allowUnsafeSshCommand: true } }
      : { config: GIT_CONFIG }
    const sg = baseDir === undefined ? simpleGit(opts) : simpleGit(baseDir, opts)
    if (this.config.sshKeyPath) {
      sg.env(curatedSshEnv(this.config.sshKeyPath))
    }
    return sg
  }

  /** Lazy-initialise the simple-git handle, scoped to the local working tree. */
  private async git(): Promise<SimpleGit> {
    if (this.sg) return this.sg
    const { simpleGit } = requireFromPlugins('simple-git') as typeof import('simple-git')
    this.sg = this.newSimpleGit(this.config.localPath, simpleGit)
    return this.sg
  }

  async init(): Promise<void> {
    const { simpleGit, CheckRepoActions } = requireFromPlugins('simple-git') as typeof import('simple-git')

    await mkdir(this.config.localPath, { recursive: true })

    // IS_REPO_ROOT, not IN_TREE — a vaultPath INSIDE another repo (e.g. inside the
    // user's dotfiles) must clone fresh, not adopt the outer repo.
    const isRepoRoot = await this.newSimpleGit(this.config.localPath, simpleGit)
      .checkIsRepo(CheckRepoActions.IS_REPO_ROOT)
      .catch(() => false)

    if (!isRepoRoot) {
      // Let clone failures propagate — do NOT silently fall back to local `git init`.
      await this.newSimpleGit(undefined, simpleGit).clone(this.config.remoteUrl, this.config.localPath)
    }

    this.sg = this.newSimpleGit(this.config.localPath, simpleGit)
    // Pull on every init so a re-launched server picks up commits made while it was off.
    await this.sync()
    // Reconcile crash leftovers: prior writes that landed on disk via writeAndStat
    // but never reached git.add+commit, plus any local commits that never pushed.
    // Otherwise vault.startup() would see those files via storage.list(), populate
    // metaById with their IDs, and the next ingest would mark them "already present"
    // — silently keeping them off the remote forever.
    await this.recoverUnpushedWrites()
  }

  /**
   * One-shot reconciliation at init. Stages any uncommitted versioned files,
   * commits them, then pushes (covering both "files on disk but never committed"
   * and "committed locally but push failed previously"). No-op when clean.
   */
  private async recoverUnpushedWrites(): Promise<void> {
    const git = await this.git()
    const status = await git.status()
    const dirty = [
      ...status.not_added, ...status.modified, ...status.deleted,
    ].filter(isVersioned)

    if (dirty.length === 0 && status.ahead === 0 && !await this.hasStagedChanges()) return

    if (dirty.length > 0) await git.add(dirty)
    if (await this.hasStagedChanges()) {
      await git.commit('recover: bring remote in sync after prior crash')
    }
    if (status.ahead > 0 || dirty.length > 0) {
      await this.pushWithRetry()
    }
  }

  async sync(): Promise<void> {
    const git = await this.git()
    // ls-remote: empty stdout = empty remote (fresh repo, no main yet) → skip pull.
    const heads = await git.raw(['ls-remote', '--heads', 'origin', BRANCH])
    if (heads.trim().length === 0) return

    try {
      await git.pull('origin', BRANCH, ['--rebase', '--autostash'])
    } catch (e) {
      // Map a rebase-conflicted working tree to the typed error — the caller's standard
      // stale-read retry applies instead of leaving git mid-rebase.
      const status = await git.status().catch(() => null)
      if (status && status.conflicted.length > 0) {
        const conflicted = [...status.conflicted]
        await git.raw(['rebase', '--abort']).catch(() => { /* best effort */ })
        throw new GitRebaseConflictError(conflicted)
      }
      throw e
    }
  }

  async get(path: string, opts?: { etag?: boolean }): Promise<{ data: Buffer; etag: string }> {
    return readWithEtag(this.config.localPath, path, opts)
  }

  async put(path: string, data: Buffer, opts?: { ifMatch?: string }): Promise<{ mtimeMs: number }> {
    if (opts?.ifMatch !== undefined) await assertIfMatch(this, path, opts.ifMatch)

    await mkdir(this.config.localPath, { recursive: true })
    const written = await writeAndStat(join(this.config.localPath, path), data)

    if (!isVersioned(path)) return written

    const git = await this.git()
    await git.add(path)
    if (!await this.hasStagedChanges()) return written

    await git.commit(`memory: ${path}`)
    try {
      await this.pushWithRetry()
      return written
    } catch (e) {
      if (e instanceof GitRebaseConflictError && e.conflictedPaths.includes(path)) {
        // Cross-device etag mismatch. Reset surgically (not `reset --hard`) so any
        // unrelated working-tree edits the user has are preserved.
        await git.raw(['reset', '--mixed', 'HEAD~1'])
        await git.raw(['checkout', `origin/${BRANCH}`, '--', path])
        throw new EtagMismatchError(`etag mismatch on ${path}: remote diverged after read`)
      }
      await this.rollbackLastCommit()
      throw e
    }
  }

  async putBatch(files: Array<{ path: string; data: Buffer }>): Promise<Array<{ path: string; mtimeMs: number }>> {
    await mkdir(this.config.localPath, { recursive: true })
    // Parallel writes — independent paths/inodes, no fsync ordering required. Each FD
    // captures its own mtime so the caller skips a second `stat` round-trip.
    const written = await Promise.all(files.map(async ({ path, data }) => {
      const { mtimeMs } = await writeAndStat(join(this.config.localPath, path), data)
      return { path, mtimeMs }
    }))

    const versionedPaths = files.map(f => f.path).filter(isVersioned)
    if (versionedPaths.length === 0) return written

    const git = await this.git()
    await git.add(versionedPaths)
    const summary = versionedPaths.length === 1
      ? versionedPaths[0]
      : `${versionedPaths.length} mementos`
    await this.commitAndPush(`memory: ${summary}`)
    return written
  }

  async list(): Promise<string[]> {
    return listMemFiles(this.config.localPath)
  }

  async stat(path: string): Promise<FileStat> {
    return statMtime(this.config.localPath, path)
  }

  async delete(path: string): Promise<void> {
    const git = await this.git()
    // `git rm` errors on missing files — fall through to unlink (also ENOENT-tolerant).
    await git.rm(path).catch(() => safeUnlink(join(this.config.localPath, path)))
    await this.commitAndPush(`remove: ${path}`)
  }

  async describeStoredData(): Promise<string> {
    const base = await summarizeMemDir(this.config.localPath)
    return `${base} (git clone at ${this.config.localPath}, remote: ${this.config.remoteUrl})`
  }

  describeManualRemoval(localPath: string): string[] {
    return [
      'To delete it permanently you must remove BOTH locations:',
      `  Local clone:  rm -rf ${localPath}`,
      `  Git remote:   delete ${this.config.remoteUrl} via your git host`,
      '                — `rm -rf` does NOT touch the remote, and any other device',
      '                  paired to this vault still has full read access.',
    ]
  }

  describeDoctorHint(): string {
    return 'Verify the git remote is reachable and you have credentials.'
  }

  /**
   * On destroy: remove the per-vault SSH key only when WE generated it — i.e. the
   * path matches `defaultSshKeyPath(remote)` for the configured remote. A user-
   * supplied existing key (via `--git-ssh-key=<path>`) is left alone; we never
   * touch keys we didn't generate.
   */
  async cleanupOnDestroy(print: (msg: string) => void): Promise<void> {
    const sshKeyPath = this.config.sshKeyPath
    if (!sshKeyPath) return
    if (sshKeyPath !== defaultSshKeyPath(this.config.remoteUrl)) return  // user-owned key — skip
    await safeUnlink(sshKeyPath)
    await safeUnlink(`${sshKeyPath}.pub`)
    print(`Removed SSH key: ${sshKeyPath} (+ .pub)`)
  }

  /**
   * Staged file-transform (via the shared two-phase rename) plus one commit+push for the
   * whole batch — only one network round-trip regardless of file count.
   */
  async migrate(
    transformFn: (path: string, oldBytes: Buffer) => Promise<Buffer | null>,
    commitMessage: string,
  ): Promise<void> {
    await stagedRenameTransform(this.config.localPath, await this.list(), transformFn)

    const git = await this.git()
    await git.add('.')
    await this.commitAndPush(commitMessage)
  }

  /**
   * Commit the staged index and push, rolling the commit back if the push fails. No-op if
   * nothing is staged. (`put` does NOT use this — its single-path write needs the
   * rebase-conflict → EtagMismatchError translation that this generic rollback can't carry.)
   */
  private async commitAndPush(message: string): Promise<void> {
    if (!await this.hasStagedChanges()) return
    await (await this.git()).commit(message)
    try {
      await this.pushWithRetry()
    } catch (e) {
      await this.rollbackLastCommit()
      throw e
    }
  }

  /** True only if the git index has changes ready to commit. Guards against empty commits. */
  private async hasStagedChanges(): Promise<boolean> {
    const git = await this.git()
    const status = await git.status()
    return status.staged.length > 0
        || status.created.length > 0
        || status.deleted.length > 0
        || status.renamed.length > 0
  }

  /**
   * Push to origin with bounded exponential backoff (200ms, 600ms; max 3 attempts).
   * Re-syncs between attempts so non-fast-forward failures from a concurrent peer push
   * resolve without operator intervention. A sync between attempts can throw
   * `GitRebaseConflictError` on an unrelated file; falls through to rollback and recovers
   * on the next sync.
   */
  private async pushWithRetry(maxAttempts = 3): Promise<void> {
    const git = await this.git()
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await git.push('origin', BRANCH)
        return
      } catch (e) {
        if (attempt === maxAttempts - 1) throw e
        const wait = 200 * Math.pow(3, attempt)
        await new Promise(r => setTimeout(r, wait))
        await this.sync()
      }
    }
  }

  /**
   * Revert (not reset) the last commit — preserves unrelated unstaged user changes. A
   * failed revert is shouted, not swallowed: the working tree is in a degraded state.
   */
  private async rollbackLastCommit(): Promise<void> {
    const git = await this.git()
    try {
      await git.raw(['revert', '--no-edit', 'HEAD'])
    } catch (e) {
      console.error(
        `Warning: rollback failed in vault ${this.config.localPath}: ${(e as Error).message}. ` +
        `Run 'git status' there and resolve before further mementos operations.`
      )
    }
  }
}
