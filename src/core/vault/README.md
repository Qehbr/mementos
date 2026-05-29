# Encryption & on-disk format

How your data stays private. Every byte stored on disk is encrypted with AES-256-GCM under a key derived from a 24-word BIP39 mnemonic in the OS keychain.

For the key derivation pipeline and provider implementations, see [src/keys/README.md](../../keys/README.md). For the chunking + chunk-keyed search model, see [src/vector/README.md](../../vector/README.md).

---

## Why encrypt vectors?

Most encrypted memory tools encrypt the text but leave the embedding vectors in plaintext. This is a real privacy leak. [Research](https://arxiv.org/abs/2310.06816) (ALGEN, ZSinvert, 2025) demonstrates that embedding-inversion attacks can reconstruct original text from vectors with high accuracy, and that existing defenses are largely ineffective. mementos encrypts the text **and** the vectors.

## The algorithm: AES-256-GCM

Every byte stored on disk is encrypted with AES-256-GCM:

- **AES-256** — a 256-bit key, considered unbreakable with current hardware.
- **GCM** — provides encryption AND authentication. Tampering with the ciphertext makes decryption throw (`AuthenticationError`), rather than silently returning garbage.
- **Random IV per write** — every `encrypt()` call generates a fresh 12-byte nonce, so two encryptions of the same text produce completely different ciphertexts.

The crypto primitive is one file ([crypto.ts](crypto.ts)) wrapping Node's built-in `node:crypto`. No third-party crypto library.

## The on-disk file

Each memento is **one `.mem` file**. Only its `id` is plaintext — it is the filename, and a random UUID, so it leaks nothing. Everything else lives in two encrypted payloads:

```json
{
  "id": "a3f9c2d4-12bc-4def-9876-0123456789ab",
  "chunks": { "enc": "<base64>", "iv": "<base64>", "tag": "<base64>" },
  "meta":   { "enc": "<base64>", "iv": "<base64>", "tag": "<base64>" }
}
```

- **`chunks`** decrypts to a JSON array `[{ text, vector }, …]` — the memory's text and its embedding(s). A short memory has one chunk; a long one has several. The full text is the chunk texts joined.
- **`meta`** decrypts to the memento's metadata: `created_at`, `updated_at`, the optional `chronicle_id` / `parent_memento_id`, and the `tags` array. Keeping this encrypted — rather than in cleartext — keeps the creation timeline and the conversation/fork structure off disk; tags like `["medical", "salary-negotiation"]` would otherwise leak topics even with the text itself encrypted.

## AAD-bound payloads

Each encrypted payload is bound to the memento `id` AND its field name via AES-GCM **Additional Authenticated Data**. The `memAad(id, field)` helper produces deterministic bytes that go into both encrypt and decrypt; modifying the AAD between the two fails authentication.

Three attacks this defeats:
- **Cross-file lift** — moving `chunks` from `A.mem` to `B.mem` fails (AAD has a different `id`).
- **Field swap** — swapping `chunks` and `meta` within a file fails (AAD has a different `field`).
- **Filename rename** — renaming `A.mem` to `B.mem` fails (the Vault checks the decrypted `mem.id` against the filename and refuses on mismatch).

Nothing else needs binding: every other field lives *inside* the encrypted `meta` payload, so the GCM tag authenticates it directly. The AAD scheme lives in [aad.ts](aad.ts).

## The encrypted index cache

`~/.config/mementos/cache/index.hnsw.enc` is an encrypted snapshot of the HNSW vector index, loaded at startup to skip re-decrypting and re-inserting every `.mem` file. The cache lives **outside** the vault directory so cloud-synced vault folders don't ship per-machine state and don't generate conflict copies.

Format: `{ entries: [{id, mtimeMs}, ...], data: Encrypted }` — entries are plaintext (the `.mem` filenames are already plaintext), `data` is the encrypted HNSW blob.

Validation on load: the cache is valid iff the on-disk `{id, mtime}` set EXACTLY equals the cached one. Catches adds, removes, AND in-place updates (changed mtime) — clock-independently, since each file is checked against its OWN recorded mtime. The encrypted blob is AAD-bound to the sorted id-set, so replaying an older valid cache (same key, different IVs, all auth tags valid) fails GCM authentication because the AAD differs.

See [cache.ts](cache.ts) for the load/save logic.

## What is never on persistent storage in plaintext

- Memory text and embedding vectors — only inside the encrypted `chunks` payload.
- Timestamps, tags, and conversation structure — only inside the encrypted `meta` payload.
- The mnemonic — only in the OS keychain (or `chmod 600` fallback file at `~/.local/share/mementos/key`).
- The derived AES key — never persisted; recomputed each startup via HKDF.

The in-memory HNSW index holds decrypted vectors in RAM for the process lifetime; they're gone on exit.

**Caveat — HNSW serialization uses a tmpfile briefly.** `hnswlib-node` only supports file-based index I/O, so saving/loading the encrypted HNSW cache writes the binary index (which contains plaintext vectors) to `os.tmpdir()`, encrypts or reads+decrypts the bytes, then unlinks in `finally`. The window is milliseconds; a crash in it could leave plaintext vectors in `/tmp` until reboot. The `.mem` files and the cache itself are always encrypted on stable storage — this is the one transient exception.

## Optimistic concurrency (`ifMatch`)

`Vault.updateMemento` reads a memento's file with its etag, runs the update, then writes with `{ ifMatch: etag }`. If a sync client / text editor / `git pull` modified the file in between, the put is rejected (translated into `StaleMementoError`) and the caller is told to re-read and re-apply — first writer wins. See [src/storage/_utils/check-if-match.ts](../../storage/_utils/check-if-match.ts).

## The chronicle + memento model

A **memento** is one logical memory stored as exactly ONE `<id>.mem` file. Long text is split into `chunks` — but those chunks live INSIDE the one file (an internal `[{text,vector}]` array). No cross-file numbering anywhere: git's per-file merge unit equals the memento.

A **chronicle** is a conversation — a set of mementos sharing a `chronicle_id`. It is not a stored object; it is derived by grouping mementos in RAM via `MetaStore`'s inverted index.

See [types.ts](types.ts) for the full type schema and the lifecycle shapes (`Memory`, `MemFile`, `MemMetadata`, `RecallResult`, `MementoSummary`, …).
