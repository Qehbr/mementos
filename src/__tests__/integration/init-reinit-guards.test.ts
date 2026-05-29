/**
 * `mementos init` re-run protections — refuse-on-data-loss paths.
 *
 * Three independent guards:
 *   1. Bare `mementos init` on an existing vault → refuse, point at dedicated commands.
 *   2. `mementos init --reinit --key=KEYTYPE` switching keyProvider → refuse (different
 *      providers derive different AES keys; switching would lock existing data).
 *   3. `mementos init --reinit --embedder=EMBEDDER` switching embedder → refuse
 *      (different embedders → incompatible vector spaces, retrieval becomes noise).
 *
 * All three exit with code 1 — caught here as ProcessExitError thanks to the
 * setupTestEnv mock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestEnv, runInitWithFlags, ProcessExitError, type IntegrationContext } from './_helpers.js'

describe('mementos init re-run guards', () => {
  let ctx: IntegrationContext

  beforeEach(async () => { ctx = await setupTestEnv() })
  afterEach(async () => { await ctx.cleanup() })

  // Helper: do a fresh init in this test's HOME so subsequent re-init scenarios have
  // an existing vault to refuse against.
  async function freshInit(extra: string[] = []): Promise<void> {
    await runInitWithFlags([
      '--backend=local',
      '--embedder=minilm',
      '--index=hnsw',
      '--key=env',
      '--integrations=none',
      ...extra,
    ])
  }

  it('refuses bare `init` on an existing vault (without --reinit)', async () => {
    await freshInit()

    // Without --reinit, init refuses to touch an already-initialised machine.
    await expect(freshInit()).rejects.toBeInstanceOf(ProcessExitError)
  }, 60_000)

  it('--reinit allows re-running with same configuration (idempotent)', async () => {
    await freshInit()

    // Same config + --reinit should succeed without exiting. KeychainKeyProvider /
    // EnvKeyProvider setupAtInit are key-idempotent so re-init never regenerates keys.
    await expect(freshInit(['--reinit'])).resolves.toBeUndefined()
  }, 60_000)

  it('refuses --reinit when keyProvider switches', async () => {
    // First init with env mode (the test default). Second tries to switch to keychain.
    await freshInit()

    await expect(
      runInitWithFlags([
        '--backend=local',
        '--embedder=minilm',
        '--index=hnsw',
        '--key=keychain',  // <-- different from existing machine's 'env'
        '--integrations=none',
        '--reinit',
      ]),
    ).rejects.toBeInstanceOf(ProcessExitError)
  }, 60_000)

  it('refuses --reinit when embedder switches', async () => {
    await freshInit()

    await expect(
      runInitWithFlags([
        '--backend=local',
        '--embedder=openai',  // <-- different from existing vault's 'minilm'
        '--index=hnsw',
        '--key=env',
        '--integrations=none',
        '--reinit',
      ]),
    ).rejects.toBeInstanceOf(ProcessExitError)
  }, 60_000)
})
