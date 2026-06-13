/**
 * MCP tool annotation contracts. These hints (readOnlyHint,
 * destructiveHint, idempotentHint, openWorldHint) are how MCP clients
 * decide whether a tool call needs permission gating — auto-approving
 * a "read-only" tool is a common client behaviour, so an annotation that
 * disagrees with the code semantics is a real authorisation gap, not a
 * doc typo.
 *
 * This file pins the load-bearing ones — the ones a careless refactor
 * could silently invert.
 */
import { describe, it, expect } from 'vitest'
import { CORE_TOOLS } from '../core/tools.js'

describe('MCP tool annotations', () => {
  // The bug this guards: since GitBackend.sync became bidirectional
  // (commits + pushes orphan files and unpushed commits), `sync` is no
  // longer read-only. The annotation was last touched before that
  // change; leaving `readOnlyHint: true` would let MCP clients
  // auto-approve a network write as if it were a network read.
  it('sync is NOT marked readOnly (it commits + pushes via GitBackend.sync)', () => {
    expect(CORE_TOOLS['sync']!.annotations?.readOnlyHint).toBeUndefined()
  })

  it('sync IS marked openWorld (it crosses the device→remote boundary)', () => {
    expect(CORE_TOOLS['sync']!.annotations?.openWorldHint).toBe(true)
  })

  it('delete_memento stays destructive (sanity — same risk class as the sync flip)', () => {
    // Pinned alongside sync because the failure mode is symmetric: a tool
    // whose annotation no longer matches its behaviour.
    expect(CORE_TOOLS['delete_memento']!.annotations?.destructiveHint).toBe(true)
    expect(CORE_TOOLS['delete_memento']!.annotations?.readOnlyHint).toBeUndefined()
  })

  it('the read-side tools stay readOnly (they do not mutate the vault)', () => {
    for (const name of ['recall', 'get_memento', 'get_chronicle', 'list_chronicles', 'get_tags', 'get_memory_index']) {
      expect(CORE_TOOLS[name]!.annotations?.readOnlyHint, `${name}.readOnlyHint`).toBe(true)
    }
  })
})
