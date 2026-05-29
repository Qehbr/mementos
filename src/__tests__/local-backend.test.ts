import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalBackend } from '../storage/local/index.js'

let dir: string
let backend: LocalBackend

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mementos-storage-'))
  backend = new LocalBackend(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('LocalBackend', () => {
  it('put and get roundtrip', async () => {
    const data = Buffer.from('hello encrypted world')
    await backend.put('abc123.mem', data)
    const { data: out } = await backend.get('abc123.mem')
    expect(out).toEqual(data)
  })

  it('get returns stable etag for same content', async () => {
    const data = Buffer.from('stable')
    await backend.put('x.mem', data)
    const { etag: e1 } = await backend.get('x.mem', { etag: true })
    const { etag: e2 } = await backend.get('x.mem', { etag: true })
    expect(e1).toBe(e2)
  })

  it('get returns different etag after content changes', async () => {
    await backend.put('x.mem', Buffer.from('v1'))
    const { etag: e1 } = await backend.get('x.mem', { etag: true })
    await backend.put('x.mem', Buffer.from('v2'))
    const { etag: e2 } = await backend.get('x.mem', { etag: true })
    expect(e1).not.toBe(e2)
  })

  it('get without etag opt-in returns empty etag (default is no-MD5 for perf)', async () => {
    await backend.put('x.mem', Buffer.from('v1'))
    const { etag } = await backend.get('x.mem')
    expect(etag).toBe('')
  })

  it('list returns only .mem files', async () => {
    await backend.put('a.mem', Buffer.from('a'))
    await backend.put('b.mem', Buffer.from('b'))
    await backend.put('_index.hnsw.enc', Buffer.from('cache'))
    const files = await backend.list()
    expect(files.sort()).toEqual(['a.mem', 'b.mem'])
  })

  it('list returns empty array when vault is empty', async () => {
    expect(await backend.list()).toEqual([])
  })

  it('list throws on a non-ENOENT readdir failure (must not silently report empty)', async () => {
    // Replace the dir with a regular file → readdir throws ENOTDIR — same shape as any other
    // "I don't know what's there" error (EACCES on a chmod'd dir, EIO on a flaky mount, an
    // SMB/Dropbox sync transiently hiding the dir). A silent [] here would make Vault.doSync
    // interpret the empty result as "every memento was deleted" and unregister the whole
    // vault — a destructive misreport on a transient infra glitch. Fail-loud is required.
    const { rm, writeFile } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true })
    await writeFile(dir, 'not a directory')
    await expect(backend.list()).rejects.toThrow()
  })

  it('delete removes the file', async () => {
    await backend.put('gone.mem', Buffer.from('bye'))
    await backend.delete('gone.mem')
    expect(await backend.list()).toEqual([])
  })

  it('get throws on missing file', async () => {
    await expect(backend.get('missing.mem')).rejects.toThrow()
  })

  it('put with ifMatch succeeds when etag matches current file', async () => {
    await backend.put('cas.mem', Buffer.from('v1'))
    const { etag } = await backend.get('cas.mem', { etag: true })
    await expect(backend.put('cas.mem', Buffer.from('v2'), { ifMatch: etag })).resolves.not.toThrow()
    const { data } = await backend.get('cas.mem')
    expect(data.toString()).toBe('v2')
  })

  it('put with ifMatch throws when etag is stale (concurrent write detected)', async () => {
    await backend.put('cas.mem', Buffer.from('v1'))
    const { etag: oldEtag } = await backend.get('cas.mem', { etag: true })
    // Someone else writes the file
    await backend.put('cas.mem', Buffer.from('v2-from-someone-else'))
    // Our put with the stale etag must reject
    await expect(
      backend.put('cas.mem', Buffer.from('v3-ours'), { ifMatch: oldEtag })
    ).rejects.toThrow(/etag mismatch/)
    // File still holds the other writer's content
    const { data } = await backend.get('cas.mem')
    expect(data.toString()).toBe('v2-from-someone-else')
  })

  it('put with ifMatch on a non-existent file rejects (file deleted is a conflict)', async () => {
    // ifMatch is the optimistic-concurrency check on update_memory. If another writer
    // deleted the file between our read and our write, that's exactly the conflict the
    // check is supposed to catch — silent re-creation would lose information.
    await expect(
      backend.put('new.mem', Buffer.from('v1'), { ifMatch: 'irrelevant' })
    ).rejects.toThrow(/etag mismatch.*no longer exists/)
  })

  it('put with ifMatch propagates a real OS read error (not converted to EtagMismatchError)', async () => {
    // Regression: assertIfMatch used to bare-catch every error from the re-get, so a real
    // EACCES/EIO/ENOTDIR was masquerading as 'file no longer exists' → StaleMementoError →
    // AI followed the re-read-and-retry playbook for a permissions bug. Now ENOENT is the
    // ONLY fail-soft; everything else propagates as itself.
    await backend.put('locked.mem', Buffer.from('v1'))
    const { chmod } = await import('node:fs/promises')
    const filePath = join(dir, 'locked.mem')
    await chmod(filePath, 0o000)
    try {
      // Real OS error (EACCES) — must NOT be EtagMismatchError.
      await expect(
        backend.put('locked.mem', Buffer.from('v2'), { ifMatch: 'something' }),
      ).rejects.not.toThrow(/etag mismatch/)
    } finally {
      // Restore so afterEach can rm the temp dir cleanly.
      await chmod(filePath, 0o644)
    }
  })

  it('stat returns mtimeMs', async () => {
    await backend.put('s.mem', Buffer.from('hello'))
    const s = await backend.stat('s.mem')
    expect(s.mtimeMs).toBeGreaterThan(0)
  })

  it('putBatch writes multiple files', async () => {
    await backend.putBatch([
      { path: 'a.mem', data: Buffer.from('a') },
      { path: 'b.mem', data: Buffer.from('b') },
    ])
    expect((await backend.list()).sort()).toEqual(['a.mem', 'b.mem'])
  })

})
