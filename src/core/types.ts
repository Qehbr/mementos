/**
 * Cross-cutting type definitions — referenced by the storage / embedder / key / vector
 * registries, the CLI, and the Vault constructor. Vault-internal types (the on-disk schema
 * for `.mem` files) live in `core/vault/types.ts`.
 *
 * Implementation identifiers (`backend`, `embedder`, `keyProvider`, `vectorIndex.type`)
 * are plain `string`. They're open-ended on purpose: each abstraction auto-discovers
 * implementations at runtime from its subdirectory; the CLI validates the chosen string
 * against the loaded registry at startup and throws a clear "unknown X — available: …"
 * error. A typo in config won't be type-checked, but contributors don't have to edit
 * this file to add a new implementation.
 *
 * Built-in identifiers:
 *   - backend:      'local' (filesystem) | 'git'
 *   - embedder:     'minilm' (all-MiniLM-L6-v2 ONNX) | 'openai'
 *   - keyProvider:  'keychain' (OS keychain + file fallback, HKDF from mnemonic) |
 *                   'env' (raw 32-byte AES key from MEMENTOS_RAW_KEY)
 *   - vectorIndex:  'hnsw'
 *   - retriever:    'semantic' (pure vector search) | 'hybrid' (BM25 + RRF over vector search)
 *
 * keyProvider note: 'keychain' and 'env' produce *different AES keys for the same
 * vault*. A vault initialized in one mode cannot be decrypted in the other. Init refuses
 * to switch modes on an existing vault.
 */

/**
 * Machine-local configuration. Lives at `~/.mementos/config.json`. NOT synced across
 * devices — paths, remote URLs, and vector-index tuning are inherently per-machine
 * (your Dropbox folder is at a different path on a different OS).
 *
 * Each device has its own copy. Recreated by `mementos init` on every new device.
 */
export interface MachineConfig {
  /** Filesystem path where the vault lives on this machine. */
  vaultPath: string
  /** Storage backend identifier. See module doc for built-in values. */
  backend: string
  /**
   * Per-backend configuration blob. Each backend owns its own shape and validates it
   * inside `create(machine)`. Opaque to core so adding a new backend never requires
   * editing this file. Examples:
   *   - git: { remote: 'git@...' }
   *   - drive: { vaultFolderId: '<folder-id>' }
   *   - local: undefined (nothing to configure)
   *
   * When switching backends (rare; via `mementos migrate`), the old config is replaced
   * outright — there's no merging across backend types.
   */
  backendConfig?: Record<string, unknown>
  /**
   * Vector index identifier. See module doc for built-in values. Required field — if
   * missing, `buildVault` throws so a malformed config surfaces as a clear error rather
   * than silently picking a default that may not match what was originally written.
   */
  vectorIndex: string
  /**
   * Retriever identifier. Selects the retrieval strategy applied on top of the vector
   * index — `'semantic'` (pure vector search) or `'hybrid'` (vector + BM25). Written by
   * `mementos init`; `buildVault` throws if it is missing.
   */
  retriever: string
  /**
   * Searcher identifier. Selects the lexical-search strategy backing the `search` tool —
   * `'scan'`, `'trigram'`, or `'none'` (disabled). Independent of `retriever`. Written by
   * `mementos init`; `buildVault` throws if it is missing.
   */
  searcher: string
  /** AES-key provider identifier. See module doc for built-in values. */
  keyProvider: string
}

/**
 * Vault-portable configuration. Lives inside the vault directory as `vault.json`, written
 * once at `mementos init` and synced to every device that shares the vault (committed by
 * GitBackend, copied by Dropbox/iCloud/etc. for LocalBackend).
 *
 * The embedder identifier must match across devices: each embedder produces vectors of a
 * specific dimensionality, and the HNSW index is built for that exact dimension. Switching
 * embedders on an existing vault corrupts retrieval — every existing memory's vector becomes
 * incomparable to new ones. Init refuses to switch embedders on an existing vault.
 *
 * NOTE: dimensions is NOT stored here — it's a property of the embedder. Each EmbeddingProvider
 * exposes `readonly dimensions: number` as the single source of truth, and buildVault threads
 * that value into the vector index. Storing it separately would create the possibility of an
 * inconsistent recorded value vs. live embedder value.
 */
export interface VaultConfig {
  /** Embedding provider identifier. See module doc for built-in values. */
  embedder: string
}
