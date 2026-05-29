# `KeyProvider` — how the encryption key is obtained

The Vault holds a 32-byte AES-256 key in memory for the process lifetime. Implementations decide where the underlying secret lives (OS keychain, file, env var, mnemonic phrase) and how it's converted to the key (raw bytes, HKDF derivation).

```typescript
interface KeyProvider {
  getKey(): Promise<Buffer>                              // 32-byte AES-256 key
  storeEntropy(entropy: Buffer, ctx: InitContext): Promise<void>
  isAlreadyConfigured(): Promise<boolean>
  describeStoredKey(): string
  clearStoredKey(print: (msg: string) => void): Promise<void>
  checkReachable?(): Promise<void>                       // optional: pre-flight for hook subprocess
  getCanonicalSecret?(): Promise<CanonicalSecret>        // optional: backs share-key / migrate
}
```

Adding a new provider is one folder under `src/keys/<name>/` — see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Implementations

| | Description |
|---|---|
| **`KeychainKeyProvider`** | OS keychain (macOS Keychain / Linux libsecret / Windows Credential Manager) via `@napi-rs/keyring`, `chmod 600` file fallback at `~/.local/share/mementos/key` on headless Linux. Stores a **24-word BIP39 mnemonic**, HKDF-SHA256 derivation. **Default.** |
| **`EnvKeyProvider`** | Base64-encoded 32 bytes of entropy from `MEMENTOS_RAW_KEY`. Same HKDF pipeline. For CI / headless / containerised deployments. |
| **`MnemonicKeyProvider`** | Takes a mnemonic directly. **Test-only** — exports no `type`/`create`, so auto-discovery skips it. |

## The key: BIP39 mnemonic + HKDF + OS keychain

The vault key is 256 bits of entropy encoded as a **24-word BIP39 mnemonic** — the same standard hardware crypto wallets use:

```
indoor pair category reform absorb correct machine
violin quantum robust obtain achieve exhibit catalog
zebra unusual frost network lunar develop segment arrow
```

Chosen because it is portable (works on any OS / new device), human-readable (write it on paper, read it back years later), and a well-audited open standard.

Those 256 bits run through **HKDF-SHA256** (salt `mementos-v1`, info `aes-256-gcm-key`) to derive the actual AES key. This domain-separates the key from any other tool using the same mnemonic, and version-tags the derivation for future rotation.

The mnemonic is stored in the **OS keychain** — never in an AI client's config file. On systems without a keychain backend, mementos falls back to `~/.local/share/mementos/key` with `chmod 600` — deliberately outside `~/.config/mementos/`, so `mementos destroy` removing the regenerable machine state never touches the key.

## Cross-provider transfer is trivial

All KeyProviders converge on the same pipeline: 32 bytes of entropy → HKDF-SHA256 → 32-byte AES-256 key. Differences are only about HOW they store the entropy. So a vault initialised with `KeychainKeyProvider` (mnemonic) can be migrated to `EnvKeyProvider` (base64) without re-encrypting any `.mem` file — the same entropy derives the same AES key.

`getCanonicalSecret` returns the canonical stored secret in either format (`{ format: 'mnemonic', value }` or `{ format: 'raw', value }`); `share-key` converts between formats on the fly when the receiving device wants the other form.

## Defense against re-running `init`

Each provider's `setupAtInit` is idempotent: if a key already exists, KEEP it — don't overwrite. The keychain provider distinguishes "no key found" (`KeyNotFoundError` — fall through to generate) from "backend broken" (generic `Error` — abort, never overwrite). A new mnemonic would derive a different AES key, making every existing `.mem` file undecryptable; this is the primary defense against an accidental re-init bricking the vault.

Same posture in the join flow: `init --mode=join` decrypt-probes the active key against one cloned `.mem` before writing config. A leftover keychain key from a prior install now surfaces *during* init with an actionable message instead of as a misleading "file may be corrupt" hint hours later from `doctor`.

## What is never on persistent storage in plaintext

- Your derived AES key — never persisted; recomputed each startup via HKDF.
- Your mnemonic — only in the OS keychain (or the `chmod 600` fallback file).

No buffer-zeroing: V8's GC, the bip39 library's internal copy of the entropy, and the mnemonic string itself all hold the same secret in heap. Zeroing one local copy is cosmetic — a heap dump captures the others. Kept honest by not pretending otherwise.
