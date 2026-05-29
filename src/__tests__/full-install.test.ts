/**
 * `init --full` building blocks.
 *
 * Regular `init` installs only the chosen backends on demand; `--full` pre-fetches every
 * optional backend + the local embedding model so the vault then runs offline. These
 * tests pin the two pieces that decision rests on:
 *   1. the full-install set is exactly the declared optional peerDependencies, and
 *   2. the local embedder participates in setupAtInit (its model warm-up).
 */
import { describe, it, expect } from 'vitest'
import { optionalPluginNames } from '../core/plugins.js'
import * as localEmbedder from '../embeddings/local/index.js'

describe('init --full', () => {
  it('optionalPluginNames is exactly the declared optional peerDependencies', async () => {
    const names = await optionalPluginNames()
    // Sorted compare — order in package.json must not matter to the full-install set.
    expect([...names].sort()).toEqual(
      ['bonjour-service', 'hnswlib-node', 'openai', 're2', 'simple-git'].sort(),
    )
  })

  it('the local embedder exposes setupAtInit so the model is warmed at init time', () => {
    expect(typeof localEmbedder.setupAtInit).toBe('function')
  })
})
