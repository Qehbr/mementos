/**
 * Unit tests for the migration-manifest helper.
 *
 * Covers: round-trip read/write/delete, ENOENT-tolerance on delete, malformed-JSON
 * surfacing (refuse rather than silently lose an in-progress migration), and the
 * discriminated-union shapes (storage / key / embedder).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readManifest, writeManifest, deleteManifest, manifestFile,
  type MigrationManifest,
} from '../cli/_utils/migration-manifest.js'

describe('migration-manifest helper', () => {
  let homeDir: string
  let origHome: string | undefined

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'migration-manifest-'))
    origHome = process.env['HOME']
    process.env['HOME'] = homeDir
  })

  afterEach(async () => {
    if (origHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = origHome
    await rm(homeDir, { recursive: true, force: true })
  })

  it('returns null when no manifest exists', async () => {
    expect(await readManifest()).toBeNull()
  })

  it('round-trips a storage manifest', async () => {
    const m: MigrationManifest = {
      type: 'storage',
      startedAt: '2026-05-12T18:00:00Z',
      targetBackend: 'git',
      targetVaultPath: '/tmp/new-vault',
      targetBackendConfig: { remote: 'git@github.com:user/vault.git' },
    }
    await writeManifest(m)
    expect(await readManifest()).toEqual(m)
  })

  it('round-trips an embedder manifest', async () => {
    const m: MigrationManifest = {
      type: 'embedder',
      startedAt: '2026-05-12T18:00:00Z',
      targetEmbedder: 'openai',
    }
    await writeManifest(m)
    expect(await readManifest()).toEqual(m)
  })

  it('round-trips a key manifest (no secret material)', async () => {
    const m: MigrationManifest = {
      type: 'key',
      startedAt: '2026-05-12T18:00:00Z',
    }
    await writeManifest(m)
    const read = await readManifest()
    expect(read).toEqual(m)
    // Sanity: the on-disk file must NOT contain any key/mnemonic field even by name.
    const fs = await import('node:fs/promises')
    const raw = await fs.readFile(manifestFile(), 'utf8')
    expect(raw.toLowerCase()).not.toMatch(/mnemonic|new[-_]?key|entropy|raw[-_]?key/)
  })

  it('deleteManifest is idempotent (no error if absent)', async () => {
    await expect(deleteManifest()).resolves.toBeUndefined()
    await writeManifest({ type: 'key', startedAt: '2026-05-12T00:00:00Z' })
    await deleteManifest()
    expect(await readManifest()).toBeNull()
    await expect(deleteManifest()).resolves.toBeUndefined()
  })

  it('refuses to silently lose state when the manifest is malformed JSON', async () => {
    // Hand-write a broken manifest. readManifest should throw with a clear message
    // rather than treating it as "no migration in progress."
    await mkdir(join(homeDir, '.config', 'mementos'), { recursive: true })
    await writeFile(manifestFile(), '{not json', 'utf8')
    await expect(readManifest()).rejects.toThrow(/not valid JSON/)
  })
})
