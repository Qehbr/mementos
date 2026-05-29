/**
 * Unit tests for MetaStore — the id-keyed metadata map that also maintains a
 * most-recently-updated-first linked list over its entries.
 *
 * The load-bearing properties: `set` links a (new or existing) entry at the head,
 * `delete` unlinks cleanly at any position, `values()` walks the list in recency order,
 * and `reorderByUpdatedAt()` re-threads the whole list by the `updated_at` field.
 */
import { describe, it, expect } from 'vitest'
import { MetaStore } from '../core/vault/meta-store.js'
import type { MemMetadata } from '../core/vault/types.js'

/** Minimal MemMetadata — only id + updated_at matter to MetaStore. */
function meta(id: string, updatedAt = '2026-01-01T00:00:00Z'): MemMetadata {
  return { id, created_at: updatedAt, updated_at: updatedAt, tags: [], chunkCount: 1, mtimeMs: 0 }
}

/** Ids in recency order (head → tail). */
function order(store: MetaStore): string[] {
  return [...store.values()].map(m => m.id)
}

/** A store with `ids` inserted in the given order. */
function build(...ids: string[]): MetaStore {
  const s = new MetaStore()
  for (const id of ids) s.set(id, meta(id))
  return s
}

describe('MetaStore', () => {
  it('get / has / size', () => {
    const s = new MetaStore()
    expect(s.size).toBe(0)
    s.set('a', meta('a'))
    expect(s.size).toBe(1)
    expect(s.has('a')).toBe(true)
    expect(s.get('a')?.id).toBe('a')
    expect(s.has('missing')).toBe(false)
    expect(s.get('missing')).toBeUndefined()
  })

  it('set links each new entry at the head — most recent first', () => {
    expect(order(build('a', 'b', 'c'))).toEqual(['c', 'b', 'a'])
  })

  it('set on an existing id moves it to the head', () => {
    const s = build('a', 'b', 'c')          // c, b, a
    s.set('a', meta('a'))                   // re-set the tail
    expect(order(s)).toEqual(['a', 'c', 'b'])
    s.set('c', meta('c'))                   // re-set a middle
    expect(order(s)).toEqual(['c', 'a', 'b'])
  })

  it('delete unlinks at the head', () => {
    const s = build('a', 'b', 'c')          // c, b, a
    s.delete('c')
    expect(order(s)).toEqual(['b', 'a'])
  })

  it('delete unlinks at the tail', () => {
    const s = build('a', 'b', 'c')
    s.delete('a')
    expect(order(s)).toEqual(['c', 'b'])
  })

  it('delete unlinks in the middle', () => {
    const s = build('a', 'b', 'c')
    s.delete('b')
    expect(order(s)).toEqual(['c', 'a'])
  })

  it('delete of an absent id is a no-op', () => {
    const s = build('a', 'b')
    s.delete('nope')
    expect(order(s)).toEqual(['b', 'a'])
    expect(s.size).toBe(2)
  })

  it('empties cleanly and can be reused (head/tail reset)', () => {
    const s = build('a', 'b', 'c')
    s.delete('a'); s.delete('b'); s.delete('c')
    expect(s.size).toBe(0)
    expect(order(s)).toEqual([])
    s.set('d', meta('d'))
    s.set('e', meta('e'))
    expect(order(s)).toEqual(['e', 'd'])
  })

  it('reorderByUpdatedAt re-threads the whole list by updated_at descending', () => {
    const s = new MetaStore()
    s.set('a', meta('a', '2026-03-01T00:00:00Z'))
    s.set('b', meta('b', '2026-01-01T00:00:00Z'))
    s.set('c', meta('c', '2026-02-01T00:00:00Z'))
    expect(order(s)).toEqual(['c', 'b', 'a'])  // head-insertion order
    s.reorderByUpdatedAt()
    expect(order(s)).toEqual(['a', 'c', 'b'])  // updated_at order
  })

  it('reorderByUpdatedAt on an empty store is a no-op', () => {
    const s = new MetaStore()
    s.reorderByUpdatedAt()
    expect(order(s)).toEqual([])
  })

  it('entries() yields [id, meta] pairs in recency order', () => {
    const s = build('a', 'b')
    expect([...s.entries()]).toEqual([['b', s.get('b')], ['a', s.get('a')]])
  })

  it('values() on an empty store yields nothing', () => {
    expect(order(new MetaStore())).toEqual([])
  })
})

// Helper: build a meta with explicit tags / chronicle / timestamp for the index tests.
function metaFull(id: string, opts: { tags?: string[]; chronicleId?: string; updatedAt?: string } = {}): MemMetadata {
  const updatedAt = opts.updatedAt ?? '2026-01-01T00:00:00Z'
  return {
    id, created_at: updatedAt, updated_at: updatedAt,
    tags: opts.tags ?? [], chunkCount: 1, mtimeMs: 0,
    ...(opts.chronicleId ? { chronicle_id: opts.chronicleId } : {}),
  }
}

describe('MetaStore — tag inverted index', () => {
  it('set indexes tags so idsMatchingFilter finds the memento by each of its tags', () => {
    const s = new MetaStore()
    s.set('a', metaFull('a', { tags: ['work', 'urgent'] }))
    s.set('b', metaFull('b', { tags: ['work'] }))
    s.set('c', metaFull('c', { tags: ['personal'] }))
    expect(s.idsMatchingFilter({ tags: ['work'] })).toEqual(new Set(['a', 'b']))
    expect(s.idsMatchingFilter({ tags: ['urgent'] })).toEqual(new Set(['a']))
    expect(s.idsMatchingFilter({ tags: ['personal'] })).toEqual(new Set(['c']))
  })

  it('set on an existing id reflects tag changes (old tags unindexed, new tags indexed)', () => {
    const s = new MetaStore()
    s.set('a', metaFull('a', { tags: ['work', 'draft'] }))
    expect(s.idsMatchingFilter({ tags: ['work'] })).toEqual(new Set(['a']))
    expect(s.idsMatchingFilter({ tags: ['draft'] })).toEqual(new Set(['a']))

    // Update: drop 'draft', add 'urgent', keep 'work'.
    s.set('a', metaFull('a', { tags: ['work', 'urgent'] }))
    expect(s.idsMatchingFilter({ tags: ['work'] })).toEqual(new Set(['a']))
    expect(s.idsMatchingFilter({ tags: ['draft'] })).toEqual(new Set())
    expect(s.idsMatchingFilter({ tags: ['urgent'] })).toEqual(new Set(['a']))
  })

  it('delete unindexes the memento from every tag set it was in', () => {
    const s = new MetaStore()
    s.set('a', metaFull('a', { tags: ['work', 'urgent'] }))
    s.set('b', metaFull('b', { tags: ['work'] }))
    s.delete('a')
    expect(s.idsMatchingFilter({ tags: ['work'] })).toEqual(new Set(['b']))
    expect(s.idsMatchingFilter({ tags: ['urgent'] })).toEqual(new Set())
  })

  it('a memento with empty tags array appears in no tag set', () => {
    const s = new MetaStore()
    s.set('a', metaFull('a'))  // no tags
    expect(s.idsMatchingFilter({ tags: ['work'] })).toEqual(new Set())
  })
})

describe('MetaStore — chronicle inverted index', () => {
  it('set indexes chronicle so idsMatchingFilter finds the memento by its chronicle', () => {
    const s = new MetaStore()
    s.set('a', metaFull('a', { chronicleId: 'c1' }))
    s.set('b', metaFull('b', { chronicleId: 'c1' }))
    s.set('c', metaFull('c', { chronicleId: 'c2' }))
    expect(s.idsMatchingFilter({ chronicleId: 'c1' })).toEqual(new Set(['a', 'b']))
    expect(s.idsMatchingFilter({ chronicleId: 'c2' })).toEqual(new Set(['c']))
  })

  it('a memento without chronicle_id is not in any chronicle set', () => {
    const s = new MetaStore()
    s.set('a', metaFull('a'))  // no chronicle
    expect(s.idsMatchingFilter({ chronicleId: 'any' })).toEqual(new Set())
  })

  it('delete unindexes the memento from its chronicle set', () => {
    const s = new MetaStore()
    s.set('a', metaFull('a', { chronicleId: 'c1' }))
    s.set('b', metaFull('b', { chronicleId: 'c1' }))
    s.delete('a')
    expect(s.idsMatchingFilter({ chronicleId: 'c1' })).toEqual(new Set(['b']))
  })
})

describe('MetaStore — valuesInRange (date-bounded recency walk)', () => {
  it('yields only mementos with updated_at in [start, end], newest-first', () => {
    const s = new MetaStore()
    s.set('jan', metaFull('jan', { updatedAt: '2026-01-15T00:00:00Z' }))
    s.set('feb', metaFull('feb', { updatedAt: '2026-02-15T00:00:00Z' }))
    s.set('mar', metaFull('mar', { updatedAt: '2026-03-15T00:00:00Z' }))
    s.set('apr', metaFull('apr', { updatedAt: '2026-04-15T00:00:00Z' }))
    // recency: apr, mar, feb, jan (each set re-links at head)

    // Range covers feb + mar.
    const ids = [...s.valuesInRange('2026-02-01', '2026-03-31')].map(m => m.id)
    expect(ids).toEqual(['mar', 'feb'])  // newest-first within the range
  })

  it('with no bounds yields all entries (same as values())', () => {
    const s = build('a', 'b', 'c')
    expect([...s.valuesInRange()].map(m => m.id)).toEqual([...s.values()].map(m => m.id))
  })

  it('stops walking once it passes the start boundary (the early-bail property)', () => {
    const s = new MetaStore()
    // Insert in chronological order so the recency list is newest-first naturally.
    s.set('old1', metaFull('old1', { updatedAt: '2025-01-01T00:00:00Z' }))
    s.set('old2', metaFull('old2', { updatedAt: '2025-06-01T00:00:00Z' }))
    s.set('new', metaFull('new', { updatedAt: '2026-05-01T00:00:00Z' }))
    // Range entirely in 2026: should yield only 'new', stop before walking old2/old1.
    const ids = [...s.valuesInRange('2026-01-01', '2026-12-31')].map(m => m.id)
    expect(ids).toEqual(['new'])
  })
})

describe('MetaStore — idsMatchingFilter (combinator)', () => {
  function seed(): MetaStore {
    const s = new MetaStore()
    s.set('a', metaFull('a', { tags: ['work', 'urgent'], chronicleId: 'c1', updatedAt: '2026-01-15T00:00:00Z' }))
    s.set('b', metaFull('b', { tags: ['work'], updatedAt: '2026-02-15T00:00:00Z' }))
    s.set('c', metaFull('c', { tags: ['personal'], chronicleId: 'c1', updatedAt: '2026-03-15T00:00:00Z' }))
    s.set('d', metaFull('d', { tags: ['work', 'draft'], updatedAt: '2026-04-15T00:00:00Z' }))
    return s
  }

  it('empty filter returns every id', () => {
    const s = seed()
    expect(s.idsMatchingFilter({})).toEqual(new Set(['a', 'b', 'c', 'd']))
  })

  it('tags filter: union — "must match at least one"', () => {
    const s = seed()
    expect(s.idsMatchingFilter({ tags: ['work'] })).toEqual(new Set(['a', 'b', 'd']))
    expect(s.idsMatchingFilter({ tags: ['urgent', 'personal'] })).toEqual(new Set(['a', 'c']))
  })

  it('chronicle filter only', () => {
    const s = seed()
    expect(s.idsMatchingFilter({ chronicleId: 'c1' })).toEqual(new Set(['a', 'c']))
  })

  it('date range filter only', () => {
    const s = seed()
    expect(s.idsMatchingFilter({ start: '2026-02-01', end: '2026-03-31' })).toEqual(new Set(['b', 'c']))
  })

  it('excludeTags only — subtracts from the full set', () => {
    const s = seed()
    expect(s.idsMatchingFilter({ excludeTags: ['draft'] })).toEqual(new Set(['a', 'b', 'c']))
  })

  it('combined: tag + excludeTags + date range', () => {
    const s = seed()
    // work tag, not draft, in Q1
    const got = s.idsMatchingFilter({
      tags: ['work'],
      excludeTags: ['draft'],
      start: '2026-01-01',
      end: '2026-03-31',
    })
    expect(got).toEqual(new Set(['a', 'b']))  // d is excluded (draft), c is excluded (no work tag)
  })

  it('chronicle + tag + excludeTags', () => {
    const s = seed()
    expect(s.idsMatchingFilter({ chronicleId: 'c1', tags: ['urgent'] }))
      .toEqual(new Set(['a']))
  })

  it('returns a fresh Set the caller can safely mutate', () => {
    const s = seed()
    const got = s.idsMatchingFilter({ tags: ['work'] })
    got.delete('a')  // must not affect the internal tag index
    expect(s.idsMatchingFilter({ tags: ['work'] })).toEqual(new Set(['a', 'b', 'd']))
  })

  it('unknown predicates return empty set, not the full set', () => {
    const s = seed()
    expect(s.idsMatchingFilter({ chronicleId: 'nonexistent' })).toEqual(new Set())
    expect(s.idsMatchingFilter({ tags: ['nonexistent'] })).toEqual(new Set())
  })
})
