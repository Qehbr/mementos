/**
 * Unit tests for the serve registry — the per-PID marker files that let
 * `mementos migrate` detect a running `mementos serve` and refuse.
 *
 * HOME is pointed at a scratch dir so `registerServe` / `listLiveServes` operate on a
 * throwaway `~/.config/mementos/serve/`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerServe, listLiveServes } from '../cli/_utils/serve-registry.js'

let home: string
let origHome: string | undefined

beforeEach(async () => {
  origHome = process.env['HOME']
  home = await mkdtemp(join(tmpdir(), 'mementos-serve-'))
  process.env['HOME'] = home
})

afterEach(async () => {
  if (origHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = origHome
  await rm(home, { recursive: true, force: true })
})

describe('serve registry', () => {
  it('listLiveServes is empty when no server has registered', async () => {
    expect(await listLiveServes()).toEqual([])
  })

  it('registerServe records the current process as a live server', async () => {
    await registerServe()
    expect(await listLiveServes()).toContain(process.pid)
  })

  it('prunes a marker whose process is no longer alive', async () => {
    const deadPid = 999_999  // no process — `kill(pid, 0)` returns ESRCH
    const dir = join(home, '.config', 'mementos', 'serve')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, String(deadPid)), 'x', 'utf8')

    expect(await listLiveServes()).not.toContain(deadPid)
    // The stale marker file is removed as a side effect.
    expect(await readdir(dir)).not.toContain(String(deadPid))
  })
})
