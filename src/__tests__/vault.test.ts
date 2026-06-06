import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Vault } from '../core/vault/index.js'
import { LocalBackend } from '../storage/local/index.js'
import { MnemonicKeyProvider } from '../keys/mnemonic/index.js'
import { FakeEmbedder, BruteForceIndex, FAKE_DIMS } from './helpers/fake.js'
import { SemanticRetriever } from '../retrievers/semantic/index.js'
import { ScanSearcher } from '../searchers/scan/index.js'
import { CHUNK_CHAR_LIMIT } from '../core/vault/chunker.js'
import { INDEX_TAG, INDEX_SEED_TEXT } from '../core/vault/constants.js'
import { renderRecall } from '../core/render.js'

/**
 * Pair an index with a fresh SemanticRetriever pointing at the same instance — the
 * retriever needs the same VectorIndex object the Vault holds so that search() and
 * findDuplicate() see the same points.
 */
function indexAndRetriever(index: BruteForceIndex) {
  return { index, retriever: new SemanticRetriever(index), searcher: new ScanSearcher() }
}

// Fixed mnemonic so tests are deterministic
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'

let dir: string
let vault: Vault

async function makeVault(tmpDir: string): Promise<Vault> {
  const v = new Vault({
    storage: new LocalBackend(tmpDir),
    embedder: new FakeEmbedder(),
    ...indexAndRetriever(new BruteForceIndex(FAKE_DIMS)),
    keys: new MnemonicKeyProvider(MNEMONIC),
    lockPath: tmpDir,  // exercise the lock path, matching CLI configuration
  })
  await v.startup()
  return v
}

/** The memento id from a `writeMemento` / `updateMemento` outcome. */
function idOf(writeResult: { id: string }): string {
  return writeResult.id
}

/** recall + render to text — most tests assert on the AI-facing rendered output. */
async function recallText(v: Vault, ...args: Parameters<Vault['recall']>): Promise<string> {
  return renderRecall(await v.recall(...args))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mementos-vault-'))
  vault = await makeVault(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  // proper-lockfile creates `<lockPath>.lock` as a sibling of the locked dir; it lives
  // outside `dir` so the rm above doesn't catch it. Clean up explicitly.
  await rm(dir + '.lock', { recursive: true, force: true })
})

// ─── writeMemento ─────────────────────────────────────────────────────────────

describe('writeMemento', () => {
  it('returns the new memento id', async () => {
    const result = await vault.writeMemento({ text: 'prefer tabs over spaces' })
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('writes a .mem file to storage', async () => {
    await vault.writeMemento({ text: 'test memory' })
    const files = await new LocalBackend(dir).list()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/\.mem$/)
  })

  it('encrypts tags on disk but exposes them via listMementos', async () => {
    await vault.writeMemento({ text: 'tagged memory', tags: ['coding', 'prefs'] })
    const storage = new LocalBackend(dir)
    const files = await storage.list()
    const { data } = await storage.get(files[0])
    const mem = JSON.parse(data.toString()) as { meta?: { enc: string; iv: string; tag: string } }
    // On disk: tags live inside the encrypted `meta` payload — never plaintext.
    expect(mem.meta).toHaveProperty('enc')
    expect(mem.meta).toHaveProperty('iv')
    expect(mem.meta).toHaveProperty('tag')
    expect(data.toString()).not.toContain('coding')
    expect(data.toString()).not.toContain('prefs')

    // Decrypted into RAM and exposed via the API
    const items = await vault.listMementos()
    expect(items[0]?.tags).toEqual(['coding', 'prefs'])
  })

  it('encrypts chunk text on disk (no plaintext leakage)', async () => {
    await vault.writeMemento({ text: 'a very secret fact' })
    const storage = new LocalBackend(dir)
    const files = await storage.list()
    const { data } = await storage.get(files[0])
    expect(data.toString()).not.toContain('a very secret fact')
  })

  it('rejects path-traversal ids on update_memento (C1)', async () => {
    await expect(
      vault.updateMemento('../../etc/passwd', 'pwn')
    ).rejects.toThrow(/Invalid id/)
  })

  it('rejects path-traversal ids on delete_memento (C1)', async () => {
    await expect(vault.deleteMemento('../foo')).rejects.toThrow(/Invalid id/)
  })

  it('chunked writes detect duplicates of the first chunk (H6)', async () => {
    const longText = ('Each sentence adds to the total character count of this memory. ').repeat(40)
    await vault.writeMemento({ text: longText })
    await expect(vault.writeMemento({ text: longText })).rejects.toThrow(/Similar memento exists/)
  })

  it('field-swapped chunks↔meta ciphertext is skipped at startup, not loaded (H1)', async () => {
    await vault.writeMemento({ text: 'plain text content', tags: ['some-tag'] })
    const storage = new LocalBackend(dir)
    const files = (await storage.list()).filter(f => f.endsWith('.mem'))
    const { data } = await storage.get(files[0])
    const mem = JSON.parse(data.toString())
    // Swap the chunks and meta envelopes — both are AAD-bound to their field name, so
    // decrypting mem.chunks (field='chunks') under what is actually meta ciphertext fails.
    const swapped = { ...mem, chunks: mem.meta, meta: mem.chunks }
    await storage.put(files[0], Buffer.from(JSON.stringify(swapped)))

    // startup tolerates one bad file — it logs a warning and skips it rather than aborting
    // the whole vault. The swapped memento never enters the in-RAM index.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const v = await makeVault(dir)
    expect(await v.listMementos()).toEqual([])
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('a planted path-traversal id is skipped at startup, not loaded', async () => {
    await vault.writeMemento({ text: 'victim memory' })
    const storage = new LocalBackend(dir)
    const memFiles = (await storage.list()).filter(f => f.endsWith('.mem'))
    const { data } = await storage.get(memFiles[0])
    const mem = JSON.parse(data.toString())
    // Plant an id that passes validateId but does not match the filename.
    mem.id = '00000000-0000-4000-8000-000000000000'
    await storage.put(memFiles[0], Buffer.from(JSON.stringify(mem)))

    // The filename↔id check rejects the planted file; startup logs it and skips it.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const v = await makeVault(dir)
    expect(await v.listMementos()).toEqual([])
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('a .mem with the meta field stripped is skipped at startup (H2)', async () => {
    await vault.writeMemento({ text: 'with tags', tags: ['x', 'y'] })
    const storage = new LocalBackend(dir)
    const files = (await storage.list()).filter(f => f.endsWith('.mem'))
    const { data } = await storage.get(files[0])
    const mem = JSON.parse(data.toString())
    delete mem.meta  // strip the encrypted meta payload (timestamps + tags)
    await storage.put(files[0], Buffer.from(JSON.stringify(mem)))

    // meta is required on disk; decryptMeta throws, so the memento is logged and skipped.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const v = await makeVault(dir)
    expect(await v.listMementos()).toEqual([])
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('a tampered meta payload is skipped at startup', async () => {
    await vault.writeMemento({ text: 'aad-protected memory' })
    const storage = new LocalBackend(dir)
    const files = await storage.list()
    const { data } = await storage.get(files[0])
    const mem = JSON.parse(data.toString())

    // Flip the first byte of the meta ciphertext — GCM authentication must reject it.
    mem.meta.enc = (mem.meta.enc[0] === 'A' ? 'B' : 'A') + mem.meta.enc.slice(1)
    await storage.put(files[0], Buffer.from(JSON.stringify(mem)))

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const v = await makeVault(dir)
    expect(await v.listMementos()).toEqual([])
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('warns when writing a duplicate memory', async () => {
    await vault.writeMemento({ text: 'exact same text' })
    await expect(vault.writeMemento({ text: 'exact same text' })).rejects.toThrow(/Similar memento exists/)
  })

  // The duplicate-memento message is the AI's only steer when it tried to write a
  // near-dup. Prior wording said "use update_memento to modify it instead", which the
  // cheapest reading parses as "resend your new text via update_memento" — silently
  // overwriting the existing memento (possibly richer than what the AI just produced)
  // and losing information. The current wording must explicitly name the two-step
  // read-then-merge flow; a revert would re-introduce the silent-overwrite trap.
  it('duplicate-memento message names get_memento BEFORE update_memento (no silent-overwrite trap)', async () => {
    await vault.writeMemento({ text: 'exact same text for the regression check' })
    try {
      await vault.writeMemento({ text: 'exact same text for the regression check' })
      throw new Error('expected DuplicateMementoError')
    } catch (e) {
      const msg = (e as Error).message
      const getIdx = msg.indexOf('get_memento')
      const updateIdx = msg.indexOf('update_memento')
      expect(getIdx).toBeGreaterThan(-1)
      expect(updateIdx).toBeGreaterThan(-1)
      expect(getIdx).toBeLessThan(updateIdx)  // read-then-merge order
      expect(msg).toMatch(/overwrite|lose/i)   // failure mode is called out by name
    }
  })
})

// ─── recall ───────────────────────────────────────────────────────────────────

describe('recall', () => {
  it('returns the stored memento as a structured result', async () => {
    await vault.writeMemento({ text: 'the sky is blue' })
    const results = await vault.recall('the sky is blue')
    expect(results[0]?.text).toBe('the sky is blue')
  })

  it('returns an empty array on an empty vault', async () => {
    expect(await vault.recall('anything')).toEqual([])
  })

  it('a result carries the memento id', async () => {
    const id = idOf(await vault.writeMemento({ text: 'some fact' }))
    const results = await vault.recall('some fact')
    expect(results[0]?.id).toBe(id)
  })

  it('returns multiple results up to k', async () => {
    await vault.writeMemento({ text: 'memory one about coding' })
    await vault.writeMemento({ text: 'memory two about testing' })
    await vault.writeMemento({ text: 'memory three about deployment' })
    const results = await vault.recall('memory', 2)
    expect(results.length).toBeLessThanOrEqual(2)
  })
})

// ─── updateMemento ────────────────────────────────────────────────────────────

describe('updateMemento', () => {
  it('replaces the memento text', async () => {
    const id = idOf(await vault.writeMemento({ text: 'old text' }))
    await vault.updateMemento(id, 'new text')
    const result = await recallText(vault, 'new text')
    expect(result).toContain('new text')
  })

  it('old text is no longer retrievable after an update', async () => {
    const id = idOf(await vault.writeMemento({ text: 'old specific phrase' }))
    await vault.updateMemento(id, 'completely different content')
    await vault.writeMemento({ text: 'unrelated filler memory here' })
    const result = await recallText(vault, 'old specific phrase', 5)
    expect(result).not.toContain('old specific phrase')
  })

  it('preserves existing tags when the tags argument is omitted', async () => {
    // Default semantics: text-only update leaves the tag set untouched.
    const id = idOf(await vault.writeMemento({ text: 'with tags', tags: ['preference', 'project:foo'] }))
    await vault.updateMemento(id, 'updated text')
    const tags = (await vault.getMemento(id))!.tags
    expect(tags).toEqual(['preference', 'project:foo'])
  })

  it('replaces tags wholesale when a tags array is passed', async () => {
    // Update can revise both axes at once — text AND tags.
    const id = idOf(await vault.writeMemento({ text: 'original', tags: ['old-a', 'old-b'] }))
    await vault.updateMemento(id, 'revised', ['new-a', 'new-b', 'new-c'])
    const tags = (await vault.getMemento(id))!.tags
    expect(tags).toEqual(['new-a', 'new-b', 'new-c'])
  })

  it('clears all tags when an empty array is passed', async () => {
    // Empty array is distinct from "omitted" — explicit instruction to drop every tag.
    const id = idOf(await vault.writeMemento({ text: 'tagged', tags: ['drop-me'] }))
    await vault.updateMemento(id, 'same text', [])
    const tags = (await vault.getMemento(id))!.tags
    expect(tags).toEqual([])
  })

  it('the tag index reflects the new tag set after replacement', async () => {
    // Edited tags must update getTags()/recall(tags=…) — not just the file on disk.
    const id = idOf(await vault.writeMemento({ text: 'edit-tags', tags: ['stale-tag'] }))
    await vault.updateMemento(id, 'edit-tags', ['fresh-tag'])
    const tags = (await vault.getTags()).map(t => t.tag)
    expect(tags).not.toContain('stale-tag')
    expect(tags).toContain('fresh-tag')
    void id
  })

  it('tag-filtered recall sees the new tag and not the old after an update', async () => {
    // Exercise the recall() filter path — the inverted-index update must reach
    // the filtered-search route too, not just the getTags() listing.
    const id = idOf(await vault.writeMemento({ text: 'unique-filter-content', tags: ['filter-old'] }))
    await vault.updateMemento(id, 'unique-filter-content', ['filter-new'])

    const found = await vault.recall('unique-filter-content', 5, undefined, ['filter-new'])
    expect(found.map(r => r.id)).toContain(id)

    const empty = await vault.recall('unique-filter-content', 5, undefined, ['filter-old'])
    expect(empty.map(r => r.id)).not.toContain(id)
  })

  it('rejects updateMemento when the .mem file changed externally between read and write', async () => {
    const id = idOf(await vault.writeMemento({ text: 'original text' }))

    // Embedder that interposes a concurrent external write between the read and the put.
    // The vault embeds AFTER reading and BEFORE writing, so an embed-time hook lands in
    // exactly the read→write window.
    const interruptingEmbedder = new FakeEmbedder()
    let interrupted = false
    const originalEmbed = interruptingEmbedder.embed.bind(interruptingEmbedder)
    interruptingEmbedder.embed = async (text: string) => {
      if (!interrupted && text.includes('updated')) {
        interrupted = true
        // External write — bypasses our lock, simulates a sync client delivering a
        // different version of the file mid-update.
        const externalStorage = new LocalBackend(dir)
        const { data } = await externalStorage.get(`${id}.mem`)
        const tampered = JSON.parse(data.toString())
        // Any byte change → new etag. racedVault read this file BEFORE this write and
        // never decrypts this version — it only needs a differing etag to trip ifMatch.
        tampered.meta.enc = (tampered.meta.enc[0] === 'A' ? 'B' : 'A') + tampered.meta.enc.slice(1)
        await externalStorage.put(`${id}.mem`, Buffer.from(JSON.stringify(tampered)))
      }
      return originalEmbed(text)
    }

    const racedVault = new Vault({
      storage: new LocalBackend(dir),
      embedder: interruptingEmbedder,
      ...indexAndRetriever(new BruteForceIndex(FAKE_DIMS)),
      keys: new MnemonicKeyProvider(MNEMONIC),
      lockPath: dir,
    })
    await racedVault.startup()

    await expect(
      racedVault.updateMemento(id, 'updated text')
    ).rejects.toThrow(/changed since you read it/)
  })
})

// ─── deleteMemento ────────────────────────────────────────────────────────────

describe('deleteMemento', () => {
  it('deletes a memento by id', async () => {
    const id = idOf(await vault.writeMemento({ text: 'to be deleted' }))
    await vault.deleteMemento(id)
    const files = await new LocalBackend(dir).list()
    expect(files).toHaveLength(0)
  })

  it('deleted memento is not retrievable', async () => {
    const id = idOf(await vault.writeMemento({ text: 'ephemeral memory content' }))
    await vault.deleteMemento(id)
    await vault.writeMemento({ text: 'filler so index has something' })
    const result = await recallText(vault, 'ephemeral memory content')
    expect(result).not.toContain('ephemeral memory content')
  })

  it('throws when the memento id is unknown', async () => {
    await expect(
      vault.deleteMemento('00000000-0000-4000-8000-000000000000')
    ).rejects.toThrow(/not found/)
  })
})

// ─── getTags ──────────────────────────────────────────────────────────────────

describe('getTags', () => {
  it('returns an empty array on an empty vault', async () => {
    expect(await vault.getTags()).toEqual([])
  })

  it('lists unique tags with counts', async () => {
    await vault.writeMemento({ text: 'one', tags: ['coding', 'typescript'] })
    await vault.writeMemento({ text: 'two', tags: ['coding'] })
    const result = await vault.getTags()
    expect(result).toContainEqual({ tag: 'coding', count: 2 })
    expect(result).toContainEqual({ tag: 'typescript', count: 1 })
  })

  it('returns tags sorted alphabetically', async () => {
    await vault.writeMemento({ text: 'a', tags: ['zebra'] })
    await vault.writeMemento({ text: 'b', tags: ['apple'] })
    const tags = await vault.getTags()
    expect(tags.map(t => t.tag)).toEqual(['apple', 'zebra'])
  })

  it('decrements the count after a delete', async () => {
    const { id: a } = await vault.writeMemento({ text: 'one', tags: ['shared'] })
    await vault.writeMemento({ text: 'two', tags: ['shared'] })
    await vault.deleteMemento(a)
    expect(await vault.getTags()).toContainEqual({ tag: 'shared', count: 1 })
  })

  it('removes the tag entirely when the last bearer is deleted (no count:0 entry left behind)', async () => {
    const { id } = await vault.writeMemento({ text: 'only carrier', tags: ['ephemeral'] })
    await vault.deleteMemento(id)
    const tags = await vault.getTags()
    expect(tags.map(t => t.tag)).not.toContain('ephemeral')
  })
})

// ─── recall — tag filter ──────────────────────────────────────────────────────

describe('recall — tag filter', () => {
  it('returns only mementos matching the given tags', async () => {
    await vault.writeMemento({ text: 'a python fact', tags: ['python'] })
    await vault.writeMemento({ text: 'a typescript fact', tags: ['typescript'] })
    const result = await recallText(vault, 'fact', 5, undefined, ['typescript'])
    expect(result).toContain('typescript fact')
    expect(result).not.toContain('python fact')
  })

  it('returns "No memories found" when no mementos match the tag filter', async () => {
    await vault.writeMemento({ text: 'some coding memory', tags: ['coding'] })
    const result = await recallText(vault, 'coding', 5, undefined, ['nonexistent'])
    expect(result).toBe('No memories found.')
  })

  it('excludeTags drops mementos matching ANY excluded tag', async () => {
    await vault.writeMemento({ text: 'directly written by the AI', tags: ['preference'] })
    await vault.writeMemento({ text: 'imported from claude code', tags: ['source:claude-code'] })
    const result = await recallText(vault, 'written', 5, undefined, undefined, ['source:claude-code'])
    expect(result).toContain('directly written by the AI')
    expect(result).not.toContain('imported from claude code')
  })

  it('excludeTags overrides include — a memento with both an included AND excluded tag is dropped', async () => {
    await vault.writeMemento({ text: 'fact one', tags: ['preference', 'source:claude-code'] })
    await vault.writeMemento({ text: 'fact two', tags: ['preference'] })
    const result1 = await recallText(vault, 'fact one', 5, undefined, ['preference'], ['source:claude-code'])
    expect(result1).not.toContain('fact one')
    const result2 = await recallText(vault, 'fact two', 5, undefined, ['preference'], ['source:claude-code'])
    expect(result2).toContain('fact two')
  })

  // ─── exact-filtered contract (dual-mode rankSemantic + idsMatchingFilter) ──
  //
  // These pin the post-rewire contract: when a filter is active, recall asks the retriever
  // for exact top-k restricted to the allowed memento-id set (computed once via MetaStore's
  // inverted indexes), so EVERY returned memento is in that set AND the result count is
  // exactly min(k, |allowed-passing-relevance|). The pre-rewire heuristic (over-fetch +
  // post-filter) could silently under-return when the filter was selective; reverting
  // `rankSemantic` to ignore `allowed` makes these tests fail (verified by negative control).

  it('tag filter is the only thing scoping the result when distractors match equally well', async () => {
    // 5 untagged distractors AND 3 rare-tagged items all share the same query words —
    // semantically indistinguishable. The tag filter is the ONLY thing that should keep
    // distractors out. Reverting `rankSemantic` to ignore `allowed` lets the 5 untagged
    // items flood the top-3 ahead of the rare ones, and this assertion fails.
    for (let i = 0; i < 5; i++) {
      await vault.writeMemento({ text: `target words content version ${i}`, tags: ['untagged'] })
    }
    await vault.writeMemento({ text: 'target words rare alpha', tags: ['rare'] })
    await vault.writeMemento({ text: 'target words rare beta', tags: ['rare'] })
    await vault.writeMemento({ text: 'target words rare gamma', tags: ['rare'] })

    const results = await vault.recall('target words', 3, undefined, ['rare'])
    expect(results.length).toBe(3)
    for (const r of results) expect(r.tags).toContain('rare')
  })

  it('singleton tag returns exactly 1 even when k is larger (bounded by |allowed|)', async () => {
    for (let i = 0; i < 5; i++) await vault.writeMemento({ text: `noise word ${i}`, tags: ['common'] })
    await vault.writeMemento({ text: 'singleton special text', tags: ['singleton'] })
    // k=10 but only 1 singleton-tagged exists; result count is bounded by |allowed|.
    const results = await vault.recall('singleton special text', 10, undefined, ['singleton'])
    expect(results.length).toBe(1)
    expect(results[0].tags).toContain('singleton')
  })

  it('filter that matches nothing short-circuits before any retrieval work', async () => {
    await vault.writeMemento({ text: 'something stored here', tags: ['existing'] })
    const results = await vault.recall('anything goes', 5, undefined, ['nonexistent-tag'])
    expect(results).toEqual([])
  })
})

// ─── listMementos ─────────────────────────────────────────────────────────────

describe('listMementos', () => {
  it('returns an empty array on an empty vault', async () => {
    expect(await vault.listMementos()).toEqual([])
  })

  it('lists stored mementos', async () => {
    await vault.writeMemento({ text: 'first memory', tags: ['work'] })
    await vault.writeMemento({ text: 'second memory', tags: ['personal'] })
    const allTags = (await vault.listMementos()).flatMap(m => m.tags)
    expect(allTags).toContain('work')
    expect(allTags).toContain('personal')
  })

  it('filters by tag', async () => {
    await vault.writeMemento({ text: 'work memory', tags: ['work'] })
    await vault.writeMemento({ text: 'personal memory', tags: ['personal'] })
    const allTags = (await vault.listMementos(['work'])).flatMap(m => m.tags)
    expect(allTags).toContain('work')
    expect(allTags).not.toContain('personal')
  })
})

// ─── chunked mementos ─────────────────────────────────────────────────────────

describe('chunked mementos', () => {
  const LONG_TEXT = ('Each sentence adds to the total character count of this memory. ').repeat(40)

  it('long text stays one .mem file with multiple chunks', async () => {
    expect(LONG_TEXT.length).toBeGreaterThan(CHUNK_CHAR_LIMIT)
    const result = await vault.writeMemento({ text: LONG_TEXT })
    expect(result.chunkCount).toBeGreaterThan(1)
    const files = await new LocalBackend(dir).list()
    expect(files).toHaveLength(1)
  })

  it('getMemento returns the full joined text of a chunked memento', async () => {
    const id = idOf(await vault.writeMemento({ text: LONG_TEXT }))
    const detail = await vault.getMemento(id)
    expect(detail?.text).toContain('Each sentence adds to the total character count')
  })

  it('getMemento returns null for an unknown id', async () => {
    expect(await vault.getMemento('00000000-0000-4000-8000-000000000000')).toBeNull()
  })

  it('deleting a chunked memento removes its one file and every chunk key', async () => {
    const id = idOf(await vault.writeMemento({ text: LONG_TEXT }))
    await vault.deleteMemento(id)
    const files = await new LocalBackend(dir).list()
    expect(files).toHaveLength(0)
  })

  it('listMementos shows a chunked memento as a single entry noting its chunk count', async () => {
    await vault.writeMemento({ text: LONG_TEXT })
    const items = await vault.listMementos()
    expect(items).toHaveLength(1)
    expect(items[0].chunkCount).toBeGreaterThan(1)
  })
})

// ─── Curated memory-index memento (the `_index` tag) ─────────────────────────

describe('memory-index memento', () => {
  it('seedIndexIfMissing creates exactly one _index memento on an empty vault', async () => {
    expect(await vault.listMementos([INDEX_TAG])).toEqual([])
    await vault.seedIndexIfMissing()
    const seeded = await vault.listMementos([INDEX_TAG])
    expect(seeded).toHaveLength(1)
    expect(seeded[0].tags).toContain(INDEX_TAG)
  })

  it('seedIndexIfMissing is a no-op when an _index memento already exists', async () => {
    await vault.seedIndexIfMissing()
    await vault.seedIndexIfMissing()
    await vault.seedIndexIfMissing()
    expect(await vault.listMementos([INDEX_TAG])).toHaveLength(1)
  })

  it('getIndexText returns null on a fresh vault and the seed body once seeded', async () => {
    expect(await vault.getIndexText()).toBeNull()
    await vault.seedIndexIfMissing()
    expect(await vault.getIndexText()).toBe(INDEX_SEED_TEXT)
  })

  it('writeMemento rejects a second _index with ReservedIndexTagError naming the existing id', async () => {
    const first = await vault.writeMemento({ text: 'index v1', tags: [INDEX_TAG] })
    await expect(vault.writeMemento({ text: 'index v2', tags: [INDEX_TAG] }))
      .rejects.toThrow(new RegExp(`_index.*update_memento\\('${first.id}'\\)`))
  })

  it('update_memento on the index revises its text without a second memento appearing', async () => {
    const first = await vault.writeMemento({ text: 'initial index', tags: [INDEX_TAG] })
    await vault.updateMemento(first.id, 'revised index')
    expect(await vault.listMementos([INDEX_TAG])).toHaveLength(1)
    expect(await vault.getIndexText()).toBe('revised index')
  })

  it('after deleting the _index, writeMemento with the tag is allowed again', async () => {
    const first = await vault.writeMemento({ text: 'orig', tags: [INDEX_TAG] })
    await vault.deleteMemento(first.id)
    const second = await vault.writeMemento({ text: 'rebuilt', tags: [INDEX_TAG] })
    expect(second.id).not.toBe(first.id)
    expect(await vault.getIndexText()).toBe('rebuilt')
  })
})

// ─── ID format ────────────────────────────────────────────────────────────────

describe('memento IDs', () => {
  it('produces UUID v4 IDs', async () => {
    const id = idOf(await vault.writeMemento({ text: 'something' }))
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})

// ─── cross-device update propagation ──────────────────────────────────────────

describe('cross-device update propagation', () => {
  it('picks up an updated memento (same ID, new content) on next sync', async () => {
    const id = idOf(await vault.writeMemento({ text: 'original text' }))

    // Device B (same storage dir) updates the memento
    const deviceB = await makeVault(dir)
    await deviceB.updateMemento(id, 'updated text from device B')

    const syncingVault = new Vault({
      storage: new LocalBackend(dir),
      embedder: new FakeEmbedder(),
      ...indexAndRetriever(new BruteForceIndex(FAKE_DIMS)),
      keys: new MnemonicKeyProvider(MNEMONIC),
      syncIntervalMs: 0,
    })
    await syncingVault.startup()

    // Update again after syncingVault startup so the file mtime exceeds lastSyncAt.
    await new Promise(r => setTimeout(r, 10))
    const deviceC = await makeVault(dir)
    await deviceC.updateMemento(id, 'final updated text')

    const result = await recallText(syncingVault, 'final updated text')
    expect(result).toContain('final updated text')
    expect(result).not.toContain('original text')
  })
})

// ─── cross-device delete (H3) ─────────────────────────────────────────────────

describe('cross-device delete (H3)', () => {
  it('does not return ENOENT-erroring results when an id was deleted on another device', async () => {
    const id = idOf(await vault.writeMemento({ text: 'some content here for sync test' }))

    const syncing = new Vault({
      storage: new LocalBackend(dir),
      embedder: new FakeEmbedder(),
      ...indexAndRetriever(new BruteForceIndex(FAKE_DIMS)),
      keys: new MnemonicKeyProvider(MNEMONIC),
      syncIntervalMs: 0,
    })
    await syncing.startup()

    // Another device deletes the .mem file directly (simulating remote git delete)
    await new LocalBackend(dir).delete(`${id}.mem`)

    const result = await syncing.recall('some content here for sync test')
    expect(result).toBeDefined()
  })

  it('sync acquires the per-vault lock — concurrent write does not race the index update (CQ1)', async () => {
    const syncing = new Vault({
      storage: new LocalBackend(dir),
      embedder: new FakeEmbedder(),
      ...indexAndRetriever(new BruteForceIndex(FAKE_DIMS)),
      keys: new MnemonicKeyProvider(MNEMONIC),
      syncIntervalMs: 0,
      lockPath: dir,
    })
    await syncing.startup()

    const id = idOf(await syncing.writeMemento({ text: 'original content' }))

    // Fire write and read concurrently. With the lock around doSync, recall's sync either
    // runs before or after the update — never interleaves with it.
    const update = syncing.updateMemento(id, 'updated content')
    const recall = syncing.recall('content')
    const [, result] = await Promise.all([update, recall])

    const after = await recallText(syncing, 'updated content')
    expect(after).toContain('updated content')
    expect(result).toBeDefined()
  })

  it('recall tolerates ENOENT mid-loop without sync rescuing it', async () => {
    const id = idOf(await vault.writeMemento({ text: 'only-on-disk memory' }))

    const noSync = new Vault({
      storage: new LocalBackend(dir),
      embedder: new FakeEmbedder(),
      ...indexAndRetriever(new BruteForceIndex(FAKE_DIMS)),
      keys: new MnemonicKeyProvider(MNEMONIC),
      syncIntervalMs: 60 * 60 * 1000,  // 1 hour — won't fire in this test
    })
    await noSync.startup()

    // Delete the .mem file behind the vault's back; the vault's index still has it.
    await new LocalBackend(dir).delete(`${id}.mem`)

    const result = await recallText(noSync, 'only-on-disk memory')
    expect(result).toBe('No memories found.')
  })
})

// ─── live sync ────────────────────────────────────────────────────────────────

describe('live sync', () => {
  it('picks up externally written mementos after the sync interval elapses', async () => {
    const syncingVault = new Vault({
      storage: new LocalBackend(dir),
      embedder: new FakeEmbedder(),
      ...indexAndRetriever(new BruteForceIndex(FAKE_DIMS)),
      keys: new MnemonicKeyProvider(MNEMONIC),
      syncIntervalMs: 0,
    })
    await syncingVault.startup()

    const vault3 = await makeVault(dir)
    await vault3.writeMemento({ text: 'written after startup' })

    const result = await recallText(syncingVault, 'written after startup')
    expect(result).toContain('written after startup')
  })

  it('does not sync again before the interval elapses', async () => {
    const syncingVault = new Vault({
      storage: new LocalBackend(dir),
      embedder: new FakeEmbedder(),
      ...indexAndRetriever(new BruteForceIndex(FAKE_DIMS)),
      keys: new MnemonicKeyProvider(MNEMONIC),
      syncIntervalMs: 60_000,  // 1 minute — won't fire in this test
    })
    await syncingVault.startup()

    const vault2 = await makeVault(dir)
    await vault2.writeMemento({ text: 'should not appear yet' })

    const result = await recallText(syncingVault, 'should not appear yet')
    expect(result).toBe('No memories found.')
  })

  it('sync() forces an immediate reconcile regardless of the staleness throttle', async () => {
    // A vault on the default (10-minute) interval — syncIfStale would NOT fire here.
    const stale = new Vault({
      storage: new LocalBackend(dir),
      embedder: new FakeEmbedder(),
      ...indexAndRetriever(new BruteForceIndex(FAKE_DIMS)),
      keys: new MnemonicKeyProvider(MNEMONIC),
      syncIntervalMs: 60_000,
    })
    await stale.startup()

    // Another device writes a memento after `stale` started up.
    const other = await makeVault(dir)
    await other.writeMemento({ text: 'written by another device' })

    // sync() bypasses the throttle and reports what changed.
    expect(await stale.sync()).toEqual({ added: 1, updated: 0, removed: 0 })
    expect(await recallText(stale, 'written by another device')).toContain('written by another device')
  })

  it('sync() reports no changes when the vault is already up to date', async () => {
    expect(await vault.sync()).toEqual({ added: 0, updated: 0, removed: 0 })
  })
})

// ─── startup / index persistence ──────────────────────────────────────────────

describe('startup', () => {
  it('rebuilds the index from .mem files on a fresh start', async () => {
    await vault.writeMemento({ text: 'persisted memory' })
    const vault2 = await makeVault(dir)
    const result = await recallText(vault2, 'persisted memory')
    expect(result).toContain('persisted memory')
  })

  it('starts cleanly on an empty vault', async () => {
    const freshVault = await makeVault(dir)
    expect(await freshVault.listMementos()).toEqual([])
  })
})
