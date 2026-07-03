import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

// simple-git is now an on-demand peer dep installed to pluginsDir. In tests,
// redirect requireFromPlugins to resolve from this project's own node_modules.
const localRequire = createRequire(import.meta.url)
vi.mock('../core/plugins.js', () => ({
  requireFromPlugins: (name: string) => localRequire(name),
  ensurePackage: vi.fn().mockResolvedValue(undefined),
  pluginsDir: () => '/tmp/mock-mementos-plugins',
}))

import { GitBackend, GitRebaseConflictError } from '../storage/git/index.js'
import { EtagMismatchError } from '../storage/_utils/check-if-match.js'

let bare: string   // bare repo acting as the "remote"
let local: string  // GitBackend working copy

function git(args: string[], cwd?: string) {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

async function makeBackend(localPath: string): Promise<GitBackend> {
  const b = new GitBackend({ localPath, remoteUrl: bare })
  await b.init()
  return b
}

beforeEach(async () => {
  // Create a bare repo with an initial commit so `main` branch exists
  bare = await mkdtemp(join(tmpdir(), 'mementos-git-bare-'))
  git(['init', '--bare', bare])
  // Point HEAD to main before any clone so clones check out main correctly
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare)

  const seed = bare + '-seed'
  git(['clone', bare, seed])
  git(['config', 'user.email', 'test@test.com'], seed)
  git(['config', 'user.name', 'Test'], seed)
  git(['commit', '--allow-empty', '-m', 'init'], seed)
  git(['push', '-u', 'origin', 'main'], seed)
  await rm(seed, { recursive: true, force: true })

  // local dir must not exist so GitBackend.init() can clone into it
  local = join(tmpdir(), 'mementos-git-local-' + Date.now())
})

afterEach(async () => {
  await rm(bare, { recursive: true, force: true })
  await rm(local, { recursive: true, force: true })
})

describe('GitBackend', () => {
  it('init clones the remote', async () => {
    await makeBackend(local)
    // directory was created by clone
    const files = await new GitBackend({ localPath: local, remoteUrl: bare }).list()
    expect(Array.isArray(files)).toBe(true)
  })

  it('put and get roundtrip', async () => {
    const b = await makeBackend(local)
    const data = Buffer.from('encrypted payload')
    await b.put('abc.mem', data)
    const { data: out } = await b.get('abc.mem')
    expect(out).toEqual(data)
  })

  it('put commits and pushes .mem files', async () => {
    const b = await makeBackend(local)
    await b.put('x.mem', Buffer.from('data'))

    // verify commit landed on the bare remote
    const log = execFileSync('git', ['log', '--oneline', 'main'], { cwd: bare }).toString()
    expect(log).toContain('x.mem')
  })

  it('put does not commit the per-device cache file', async () => {
    const b = await makeBackend(local)
    await b.put('_index.hnsw.enc', Buffer.from('cache'))

    const log = execFileSync('git', ['log', '--oneline', 'main'], { cwd: bare }).toString()
    expect(log).not.toContain('_index.hnsw.enc')
  })

  it('put commits vault.json so config syncs across devices', async () => {
    const b = await makeBackend(local)
    await b.put('vault.json', Buffer.from('{"embedder":"minilm"}'))

    const log = execFileSync('git', ['log', '--oneline', 'main'], { cwd: bare }).toString()
    expect(log).toContain('vault.json')
  })

  it('list returns only .mem files', async () => {
    const b = await makeBackend(local)
    await b.put('a.mem', Buffer.from('a'))
    await b.put('b.mem', Buffer.from('b'))
    await b.put('_index.hnsw.enc', Buffer.from('cache'))
    const files = await b.list()
    expect(files.sort()).toEqual(['a.mem', 'b.mem'])
  })

  it('delete removes the file and pushes', async () => {
    const b = await makeBackend(local)
    await b.put('gone.mem', Buffer.from('bye'))
    await b.delete('gone.mem')
    expect(await b.list()).toEqual([])

    const log = execFileSync('git', ['log', '--oneline', 'main'], { cwd: bare }).toString()
    expect(log).toContain('gone.mem')
  })

  it('stat returns mtimeMs', async () => {
    const b = await makeBackend(local)
    await b.put('s.mem', Buffer.from('hello'))
    const s = await b.stat('s.mem')
    expect(s.mtimeMs).toBeGreaterThan(0)
  })

  it('putBatch commits all files in a single commit and pushes', async () => {
    const b = await makeBackend(local)
    await b.putBatch([
      { path: 'p1.mem', data: Buffer.from('one') },
      { path: 'p2.mem', data: Buffer.from('two') },
    ])
    expect((await b.list()).sort()).toEqual(['p1.mem', 'p2.mem'])

    // verify it was a single commit on the remote
    const log = execFileSync('git', ['log', '--oneline', 'main'], { cwd: bare }).toString()
    const memCommits = log.split('\n').filter(line => line.includes('memory:'))
    expect(memCommits).toHaveLength(1)
  })

  it('second instance syncs via init pull', async () => {
    // device A writes
    const a = await makeBackend(local)
    await a.put('shared.mem', Buffer.from('synced content'))

    // device B: fresh clone of same remote
    const localB = local + '-b'
    const b = await makeBackend(localB)
    const { data } = await b.get('shared.mem')
    expect(data).toEqual(Buffer.from('synced content'))

    await rm(localB, { recursive: true, force: true })
  })

  it('second init on existing clone does a pull', async () => {
    // first init (clone)
    await makeBackend(local)

    // write via a second device
    const localB = local + '-b'
    const b = await makeBackend(localB)
    await b.put('remote.mem', Buffer.from('from b'))
    await rm(localB, { recursive: true, force: true })

    // re-init the first backend — should pull the new file
    const a2 = await makeBackend(local)
    const { data } = await a2.get('remote.mem')
    expect(data).toEqual(Buffer.from('from b'))
  })

  // Regression for a crash-recovery bug: writeAndStat lands the .mem on disk
  // before git.add+commit runs. If the process dies between those, the file is
  // present locally but never reaches the remote. On the next ingest,
  // vault.startup() sees the file via storage.list(), populates metaById, and
  // every future ingest marks the same memento "already present" — keeping it
  // off the remote forever. init() now reconciles uncommitted .mem files.
  it('init recovers uncommitted .mem files left by a prior crash', async () => {
    const { writeFile } = await import('node:fs/promises')

    // First init clones; simulate the crash by dropping a .mem file straight onto disk.
    await makeBackend(local)
    await writeFile(join(local, 'orphan.mem'), Buffer.from('stranded payload'))

    // Re-init: the recovery step should stage + commit + push the orphan.
    await makeBackend(local)

    // Confirm by cloning the remote fresh — the file must be there.
    const verify = join(tmpdir(), 'mementos-git-verify-' + Date.now())
    git(['clone', bare, verify])
    const out = await import('node:fs/promises').then(fs => fs.readFile(join(verify, 'orphan.mem')))
    expect(out).toEqual(Buffer.from('stranded payload'))
    await rm(verify, { recursive: true, force: true })
  })

  // Regression for the cross-device concurrent-edit handling — two devices both update
  // the same memento before either has synced the other's write. Before the fix, the
  // loser's push failed non-fast-forward, the rebase produced a conflict, and the user
  // was left with a degraded working tree to repair by hand. Now the loser's put aborts
  // the rebase and throws EtagMismatchError, which Vault.updateMemento converts to
  // StaleMementoError — the AI's standard "re-read and retry" flow applies.
  it('truly-concurrent cross-device edits on the same .mem throw EtagMismatchError, not a degraded tree', async () => {
    const localA = local
    const localB = local + '-b'
    const backendA = await makeBackend(localA)
    const backendB = await makeBackend(localB)

    // Both devices see the same baseline version of the memento.
    await backendA.put('x.mem', Buffer.from('v1'))
    await backendB.sync()
    const { etag: etagOnB } = await backendB.get('x.mem', { etag: true })

    // Device A updates first and pushes successfully.
    const { etag: etagOnA } = await backendA.get('x.mem', { etag: true })
    expect(etagOnA).toBe(etagOnB)  // both started from the same content
    await backendA.put('x.mem', Buffer.from('v2 from A'), { ifMatch: etagOnA })

    // Device B's update sees the old etag locally (it hasn't pulled A's update), passes
    // ifMatch, commits locally, then push fails non-fast-forward → pull-rebase produces
    // a conflict on x.mem. The fix: abort the rebase and surface EtagMismatchError.
    await expect(
      backendB.put('x.mem', Buffer.from('v3 from B'), { ifMatch: etagOnB }),
    ).rejects.toBeInstanceOf(EtagMismatchError)

    // After the throw the working tree is clean — not mid-rebase. A subsequent sync
    // pulls A's change without any operator intervention.
    await backendB.sync()
    const { data: afterSync } = await backendB.get('x.mem')
    expect(afterSync).toEqual(Buffer.from('v2 from A'))

    await rm(localB, { recursive: true, force: true })
  })

  // Direct unit test of GitRebaseConflictError shape — the typed class is the contract
  // sync() exposes to put(); a future refactor must keep the discriminator intact.
  it('GitRebaseConflictError carries the conflicted paths', () => {
    const e = new GitRebaseConflictError(['a.mem', 'b.mem'])
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('GitRebaseConflictError')
    expect(e.conflictedPaths).toEqual(['a.mem', 'b.mem'])
  })

  // GitBackend operates locally (bare repo on disk) so SSH never fires — we can pass a
  // bogus sshKeyPath and the local clone/push/pull still works. The point of this test
  // isn't to validate ssh-agent integration; it's to prove the env-application wiring
  // doesn't break the non-SSH path.
  it('constructs and operates with sshKeyPath set (does not break local operations)', async () => {
    const b = new GitBackend({ localPath: local, remoteUrl: bare, sshKeyPath: '/tmp/nonexistent-key' })
    await b.init()
    await b.put('with-key.mem', Buffer.from('hello'))
    const { data } = await b.get('with-key.mem')
    expect(data).toEqual(Buffer.from('hello'))
  })

  // Regression test for the Fable 5 audit finding: sync's "if ahead > 0
  // then pushWithRetry" branch used to call pushWithRetry which called
  // sync() between attempts, which would re-enter the same branch — a
  // mutual recursion that never terminated when the push persistently
  // failed but the pull succeeded (read-only deploy key, archived repo,
  // protected branch, …). Hangs the daemon under the WriteLock forever
  // and survives SIGTERM. Bound: sync MUST throw within seconds, not
  // recurse.
  it('sync throws within the 3-attempt cap when the remote rejects pushes (no mutual recursion)', async () => {
    const b = await makeBackend(local)
    // Stage a local commit that's not on the remote yet, so sync's
    // pushWithRetry path is the one we exercise. Using raw git rather
    // than b.put so we don't immediately push — that way sync()'s own
    // "ahead > 0" path is the actor.
    const memPath = join(local, 'wedge-test.mem')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(memPath, 'data')
    // Set identity on this clone — CI runners often have no global git
    // user.email/name, and unlike the other tests we commit via raw git
    // here (not through simple-git's commit path which evidently has a
    // fallback). Matches the seed-repo setup at the top of this file.
    git(['config', 'user.email', 'test@test.com'], local)
    git(['config', 'user.name', 'Test'], local)
    git(['add', 'wedge-test.mem'], local)
    git(['commit', '-m', 'memory: wedge-test', '--no-gpg-sign'], local)

    // Now install a pre-receive hook on the bare repo that rejects every
    // push. The hook script must be executable on POSIX; git-for-Windows
    // runs hooks through its bundled sh regardless (NTFS has no exec bit).
    const hookPath = join(bare, 'hooks', 'pre-receive')
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n')
    if (process.platform !== 'win32') execFileSync('chmod', ['+x', hookPath])

    // The contract: sync must throw within bounded time. With the bug
    // (pushWithRetry → sync → pushWithRetry mutual recursion), this hangs
    // forever; vitest's per-test timeout would surface the hang as a
    // failure. A 5s assertion-side cap is generous — the real bound is
    // 200ms + 600ms + epsilon = under 1s before the third attempt throws.
    const start = Date.now()
    await expect(b.sync()).rejects.toThrow()
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(5_000)
  }, 10_000)
})

describe('parseRemote', () => {
  it('detects github.com HTTPS and supplies the SSH-form rewrite + deploy-keys URL', async () => {
    const { parseRemote } = await import('../storage/git/index.js')
    expect(parseRemote('https://github.com/alice/vault.git')).toEqual({
      isSsh: false,
      sshUrl: 'git@github.com:alice/vault.git',
      deployKeysUrl: 'https://github.com/alice/vault/settings/keys/new',
    })
    // .git suffix optional
    expect(parseRemote('https://github.com/alice/vault')).toEqual({
      isSsh: false,
      sshUrl: 'git@github.com:alice/vault.git',
      deployKeysUrl: 'https://github.com/alice/vault/settings/keys/new',
    })
  })

  it('detects github.com SSH form and supplies the deploy-keys URL but no sshUrl rewrite', async () => {
    const { parseRemote } = await import('../storage/git/index.js')
    expect(parseRemote('git@github.com:alice/vault.git')).toEqual({
      isSsh: true,
      deployKeysUrl: 'https://github.com/alice/vault/settings/keys/new',
    })
  })

  it('marks generic SSH (gitlab, self-hosted) as ssh but supplies no deploy-keys hint', async () => {
    const { parseRemote } = await import('../storage/git/index.js')
    expect(parseRemote('git@gitlab.com:alice/vault.git')).toEqual({ isSsh: true })
    expect(parseRemote('ssh://git@code.internal/alice/vault.git')).toEqual({ isSsh: true })
  })

  it('marks non-github HTTPS as not-ssh with no rewrite hint (mementos refuses such combinations)', async () => {
    const { parseRemote } = await import('../storage/git/index.js')
    expect(parseRemote('https://gitlab.com/alice/vault.git')).toEqual({ isSsh: false })
  })
})

describe('defaultSshKeyPath', () => {
  it('is deterministic for the same remote and distinct across remotes', async () => {
    const { defaultSshKeyPath } = await import('../storage/git/index.js')
    const a = defaultSshKeyPath('git@github.com:alice/vault.git')
    const b = defaultSshKeyPath('git@github.com:bob/vault.git')
    expect(defaultSshKeyPath('git@github.com:alice/vault.git')).toBe(a)
    expect(a).not.toBe(b)
    // Lives under ~/.ssh and carries the mementos prefix so a future grep finds it.
    expect(a).toMatch(/\/\.ssh\/mementos_vault_[a-f0-9]{8}$/)
  })
})

// Security invariants for the SSH-key flow. These are the only place the
// "scoped-to-this-vault" property is enforced — drop IdentitiesOnly=yes and ssh-agent
// silently falls back to the user's default key; let EDITOR/PAGER leak into the curated
// env and simple-git's block-unsafe-operations-plugin refuses to spawn git. Both must
// be observable in tests, otherwise a refactor breaks the contract invisibly.
describe('sshCommand', () => {
  it('always sets IdentitiesOnly=yes (scoping to the configured key)', async () => {
    const { sshCommand } = await import('../storage/git/index.js')
    expect(sshCommand('/path/to/key')).toMatch(/-o IdentitiesOnly=yes/)
    expect(sshCommand('/path/to/key')).toContain('ssh -i /path/to/key')
  })
})

describe('curatedSshEnv', () => {
  const SAVED: Record<string, string | undefined> = {}
  const POLLUTED = ['EDITOR', 'VISUAL', 'PAGER', 'GIT_EDITOR', 'GIT_PAGER', 'GIT_SEQUENCE_EDITOR']

  beforeEach(() => {
    // Plant the unsafe vars in process.env so we can prove they're filtered out.
    for (const k of POLLUTED) {
      SAVED[k] = process.env[k]
      process.env[k] = 'value-that-should-not-leak'
    }
  })

  afterEach(() => {
    for (const k of POLLUTED) {
      if (SAVED[k] === undefined) delete process.env[k]
      else process.env[k] = SAVED[k]
    }
  })

  it('includes GIT_SSH_COMMAND with IdentitiesOnly=yes', async () => {
    const { curatedSshEnv } = await import('../storage/git/index.js')
    const env = curatedSshEnv('/path/to/key')
    expect(env.GIT_SSH_COMMAND).toBeDefined()
    expect(env.GIT_SSH_COMMAND).toContain('IdentitiesOnly=yes')
    expect(env.GIT_SSH_COMMAND).toContain('/path/to/key')
  })

  it('strips simple-git-unsafe inherited env vars (EDITOR, PAGER, GIT_EDITOR, …)', async () => {
    const { curatedSshEnv } = await import('../storage/git/index.js')
    const env = curatedSshEnv('/path/to/key')
    for (const k of POLLUTED) {
      expect(env[k]).toBeUndefined()
    }
  })

  it('preserves the variables git/ssh genuinely need (PATH, HOME)', async () => {
    const { curatedSshEnv } = await import('../storage/git/index.js')
    const env = curatedSshEnv('/path/to/key')
    expect(env.PATH).toBe(process.env.PATH)
    expect(env.HOME).toBe(process.env.HOME)
  })
})
