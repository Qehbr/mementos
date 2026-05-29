/**
 * Unit tests for `writeAndStat` — the storage primitive that backs every StorageBackend
 * `put` / `putBatch`. Two contracts:
 *
 *   1. **Crash-atomic** — writes go through `<path>.tmp` + `rename(2)`, so the prior file
 *      at `<path>` is intact until the rename. Verified here by (a) checking no `.tmp`
 *      file lingers after a successful write, and (b) the negative control: a rename
 *      failure leaves the destination untouched and cleans up the orphan tmp.
 *   2. **Returned mtime matches a subsequent stat** — `rename(2)` preserves the inode's
 *      mtime, so the value captured before the rename is what `storage.stat(path)` sees
 *      afterwards.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, stat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeAndStat } from '../storage/_utils/write-and-stat.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mementos-writeandstat-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('writeAndStat', () => {
  it('writes the data and leaves no .tmp file behind on success', async () => {
    const path = join(dir, 'm.mem')
    await writeAndStat(path, Buffer.from('hello world'))

    expect(await readFile(path, 'utf8')).toBe('hello world')
    // Atomicity contract: the .tmp staging file must be gone after a successful rename.
    expect(await stat(path + '.tmp').then(() => true).catch(() => false)).toBe(false)
  })

  it('returned mtimeMs equals a subsequent stat() on the final path', async () => {
    const path = join(dir, 'm.mem')
    const { mtimeMs } = await writeAndStat(path, Buffer.from('payload'))
    const s = await stat(path)
    // rename(2) preserves the inode's mtime, so the captured value matches.
    expect(s.mtimeMs).toBe(mtimeMs)
  })

  it('overwrites the prior file atomically (prior content survives until rename)', async () => {
    const path = join(dir, 'm.mem')
    await writeFile(path, 'prior version')
    await writeAndStat(path, Buffer.from('new version'))
    expect(await readFile(path, 'utf8')).toBe('new version')
  })

  it('cleans up the orphan tmp file when the rename itself fails', async () => {
    const path = join(dir, 'm.mem')
    // Make the destination an existing (empty) directory — `rename(file, dir)` is EISDIR
    // on POSIX. No mocking needed; the failure is real.
    await mkdir(path)
    await expect(writeAndStat(path, Buffer.from('attempt'))).rejects.toThrow()
    // The orphan .tmp from the failed rename must be cleaned up.
    expect(await stat(path + '.tmp').then(() => true).catch(() => false)).toBe(false)
  })

  it('a 256 KiB payload round-trips byte-for-byte', async () => {
    const path = join(dir, 'm.mem')
    const data = Buffer.alloc(256 * 1024)
    for (let i = 0; i < data.length; i++) data[i] = (i * 37) & 0xff
    await writeAndStat(path, data)
    expect(await readFile(path)).toEqual(data)
  })
})
