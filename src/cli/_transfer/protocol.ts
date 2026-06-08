/**
 * LAN key-transfer protocol — commit-then-open ECDH + Short Authentication String
 * (SAS) verification + AES-256-GCM encrypted payload.
 *
 * Wire flow over an already-established TCP socket:
 *
 *     1. Sender sends a 32-byte SHA-256 commitment to its X25519 public key:
 *        `commit_S = SHA-256(pubS ‖ nonce_S)` where `nonce_S` is 32 random bytes.
 *     2. Receiver sends its X25519 public key (44-byte DER SPKI).
 *     3. Sender opens the commitment by sending `pubS ‖ nonce_S` (44 + 32 = 76 bytes).
 *     4. Receiver verifies `SHA-256(pubS ‖ nonce_S) == commit_S`, aborts on mismatch.
 *     5. Both peers derive the shared secret via ECDH and compute a 6-digit SAS
 *        (truncated SHA-256 of the sorted concatenated public keys).
 *     6. Both peers display the SAS to the user, who visually confirms they match on
 *        BOTH screens. Each peer sends a 1-byte verdict: 0x01 = "user confirmed" /
 *        0x00 = "user rejected". Sides only proceed if both verdicts are 0x01.
 *     7. Sender encrypts the secret under the shared secret with AES-256-GCM:
 *        `[4 BE bytes ciphertext length][12 nonce][N ciphertext][16 GCM tag]`.
 *     8. Receiver decrypts and returns the plaintext.
 *
 * **Why commit-then-open** (the critical change from v1): the previous protocol
 * exchanged raw public keys in steps 1+2 with NO commitment, then computed the
 * SAS over both. An active LAN attacker that sees pubS first can grind its own
 * ephemeral keypair pubM_S so that `trunc(SHA-256(sort(pubS, pubM_S)))` equals
 * a matching SAS it has already arranged on the receiver side. With a 20-bit
 * SAS that's ≈2²⁰ keygens — seconds of work — and both screens display the
 * same code → total vault-master-key compromise.
 *
 * The commitment closes the grind: the attacker must choose its public keys
 * BEFORE seeing pubS or pubR (the commitment hides pubS until after the
 * receiver has revealed pubR, and pubR is sent before the sender opens its
 * commitment, so the attacker cannot adaptively pick either side). With no
 * adaptive choice, the attacker's only knob is luck — 1 chance in 10⁶ to
 * collide the SAS. The 20-bit length now buys exactly what it advertises.
 *
 * Why SAS, not PAKE: the user's confirmation that the same code appears on
 * both screens is what defeats the active MITM. The shared key itself is
 * agreed via ECDH, which is uniformly safe against passive attackers.
 * No PAKE dependency, no shaky third-party crypto library — just Node's
 * built-in primitives + a 32-byte commitment nonce.
 *
 * Threat model assumed:
 *   - Active LAN attacker can sniff, inject, and replay TCP traffic.
 *   - Attacker CANNOT modify the screens of both legitimate machines simultaneously.
 *   - Attacker may run a peer of their own and try to MITM — defeated because:
 *       (a) the sender's commitment hides pubS until step 3, so the attacker
 *           must pick the key it forwards to the receiver BEFORE seeing pubS,
 *       (b) the receiver reveals pubR in step 2 (after seeing the sender's
 *           commitment), so the attacker has already committed to its
 *           receiver-facing key before learning pubR,
 *       (c) consequently the attacker can't adaptively pick either side to
 *           force a SAS collision — the 20-bit code regains its 2⁻²⁰ MitM bound.
 *
 * Out of scope: malicious code already running on either machine (game over
 * anyway); compromise of the OS keychain on the sender (also game over).
 */
import {
  generateKeyPairSync, diffieHellman, createPublicKey,
  createCipheriv, createDecipheriv, createHash, randomBytes, hkdfSync, timingSafeEqual,
  type KeyObject,
} from 'node:crypto'
import type { Socket } from 'node:net'

/** Byte length of an X25519 public key exported in DER (SubjectPublicKeyInfo) format. */
const PUBKEY_DER_LEN = 44
/** SHA-256 digest length — the commitment is one SHA-256 over `pubkey ‖ nonce`. */
const COMMIT_LEN = 32
/** Commitment nonce length — 256 bits of entropy. Sender generates fresh per session. */
const COMMIT_NONCE_LEN = 32
/** Opening message length: pubkey followed by the commitment nonce. */
const OPENING_LEN = PUBKEY_DER_LEN + COMMIT_NONCE_LEN
/** GCM nonce: 12 bytes is the standard size. */
const NONCE_LEN = 12
/** GCM authentication tag: 16 bytes. */
const TAG_LEN = 16
/** 1-byte SAS verdict on the wire: yes = 0x01, no = 0x00. */
const SAS_YES = 0x01
const SAS_NO = 0x00

/**
 * HKDF context for the LAN-pairing AES-256-GCM key. The X25519 shared secret is
 * the curve-point X-coordinate — not uniform in 256-bit space (scalar clamping +
 * small structural bias) — so per NIST SP 800-56C / standard ECDH+AEAD practice,
 * run it through HKDF before use as an AEAD key.
 */
const PAIRING_KDF_SALT = 'mementos-share-key-v1'
const PAIRING_KDF_INFO = 'aes-256-gcm-key'

/** Derive the AEAD key from the raw X25519 shared secret. */
function derivePairingKey(rawShared: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', rawShared, PAIRING_KDF_SALT, PAIRING_KDF_INFO, 32))
}

/** Caller-supplied hook to display the SAS to the user and return their y/n answer. */
export type SasConfirm = (sas: string) => Promise<boolean>

/** Sender-side: commit to pubkey, agree on a key, verify SAS, encrypt and send the secret. */
export async function runSender(socket: Socket, secret: string, confirm: SasConfirm): Promise<void> {
  const reader = createReader(socket)
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const ourPubDer = exportRawPublic(publicKey)
  const commitNonce = randomBytes(COMMIT_NONCE_LEN)
  const ourCommit = computeCommit(ourPubDer, commitNonce)

  // Step 1: send our commitment first — hides pubS until step 3.
  await writeBytes(socket, ourCommit)

  // Step 2: receive the peer's public key (no commitment from the peer — only
  // the sender needs to commit; the receiver reveals after seeing the
  // commitment, so a MitM that picks pubM_R has already committed to it on
  // its receiver-facing connection before learning pubR).
  const peerPubDer = await reader.read(PUBKEY_DER_LEN)

  // Step 3: open the commitment — send pubkey || nonce so the receiver can
  // verify against the commitment we sent in step 1.
  await writeBytes(socket, Buffer.concat([ourPubDer, commitNonce]))

  // Derive the shared secret and the SAS.
  const peerPub = createPublicKey({ key: peerPubDer, format: 'der', type: 'spki' })
  const sharedSecret = derivePairingKey(diffieHellman({ privateKey, publicKey: peerPub }))

  const sas = computeSas(ourPubDer, peerPubDer)
  const verdict = await runSasCheck(socket, reader, sas, confirm)
  if (!verdict) throw new Error('SAS verification failed or rejected — aborting key transfer.')

  // AES-256-GCM under the shared secret (32 bytes — exactly the AES-256 key size).
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv('aes-256-gcm', sharedSecret, nonce)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  const lenBuf = Buffer.allocUnsafe(4)
  lenBuf.writeUInt32BE(ciphertext.length, 0)
  await writeBytes(socket, Buffer.concat([lenBuf, nonce, ciphertext, tag]))
}

/** Receiver-side: verify commitment, agree on a key, verify SAS, decrypt the secret. */
export async function runReceiver(socket: Socket, confirm: SasConfirm): Promise<string> {
  const reader = createReader(socket)
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const ourPubDer = exportRawPublic(publicKey)

  // Step 1: receive the sender's commitment (32 bytes).
  const senderCommit = await reader.read(COMMIT_LEN)

  // Step 2: send our public key. The sender has already committed to pubS,
  // so even if a MitM forwarded its own commit_M to us, that commitment
  // locked in the MitM's receiver-facing pubkey BEFORE we revealed pubR —
  // the MitM cannot adaptively grind against pubR.
  await writeBytes(socket, ourPubDer)

  // Step 3: receive the sender's opening — pubkey followed by the nonce that
  // backed the commitment.
  const opening = await reader.read(OPENING_LEN)
  const peerPubDer = opening.subarray(0, PUBKEY_DER_LEN)
  const peerNonce = opening.subarray(PUBKEY_DER_LEN, OPENING_LEN)

  // Step 4: verify the commitment opens to the revealed pubkey. Constant-time
  // compare — there's no secret here (commits are public), but timingSafeEqual
  // also short-circuits on length, which is the right shape for a fixed-size
  // digest comparison.
  const expectedCommit = computeCommit(peerPubDer, peerNonce)
  if (!timingSafeEqual(senderCommit, expectedCommit)) {
    throw new Error(
      'Commitment verification failed — the sender\'s revealed public key does not match its earlier commitment. ' +
      'This indicates a man-in-the-middle attempt; aborting key transfer.',
    )
  }

  // Derive the shared secret and the SAS.
  const peerPub = createPublicKey({ key: peerPubDer, format: 'der', type: 'spki' })
  const sharedSecret = derivePairingKey(diffieHellman({ privateKey, publicKey: peerPub }))

  const sas = computeSas(peerPubDer, ourPubDer)
  const verdict = await runSasCheck(socket, reader, sas, confirm)
  if (!verdict) throw new Error('SAS verification failed or rejected — aborting key transfer.')

  const lenBuf = await reader.read(4)
  const ctLen = lenBuf.readUInt32BE(0)
  // Cap at 64 KiB to prevent a malicious peer from forcing huge allocations. A canonical
  // secret is at most a 24-word mnemonic (~200 bytes) — anything over a few KB is bogus.
  if (ctLen > 64 * 1024) throw new Error(`Refusing oversized payload (${ctLen} bytes).`)

  const nonce = await reader.read(NONCE_LEN)
  const ciphertext = await reader.read(ctLen)
  const tag = await reader.read(TAG_LEN)

  const decipher = createDecipheriv('aes-256-gcm', sharedSecret, nonce)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}

/**
 * Compute the SHA-256 commitment over a public key and a 32-byte nonce. SHA-256 is
 * collision-resistant under the standard assumption, so an attacker can't find a
 * second (pubkey', nonce') that hashes to the same commitment — binding holds.
 * The 32-byte nonce gives 256 bits of entropy, so the commitment is
 * computationally indistinguishable from random — hiding holds.
 *
 * Exported for unit tests.
 */
export function computeCommit(pubDer: Buffer, nonce: Buffer): Buffer {
  return createHash('sha256').update(pubDer).update(nonce).digest()
}

/**
 * Compute the 6-digit SAS code from both public keys. Order-stable: sender and receiver
 * sort the two keys identically before hashing, so the digest matches on both sides.
 *
 * Exported for unit tests; in normal use it's called inside runSender/runReceiver.
 *
 * The 20-bit SAS is only safe in combination with the commit-then-open exchange above:
 * without the commitment, an adaptive attacker can grind its own ephemeral key to
 * collide the SAS in ~2²⁰ keygens (seconds). With the commitment, the attacker
 * cannot adapt and the 20-bit SAS gives the intended 2⁻²⁰ MitM bound.
 */
export function computeSas(senderPub: Buffer, receiverPub: Buffer): string {
  const [a, b] = Buffer.compare(senderPub, receiverPub) <= 0
    ? [senderPub, receiverPub]
    : [receiverPub, senderPub]
  const digest = createHash('sha256').update(a).update(b).digest()
  // First 4 bytes → unsigned 32-bit int → modulo 10^6 → zero-padded to 6 digits.
  // Bias from non-uniform mod is negligible at 2^32 / 10^6 ≈ 4295 codes per digit class.
  const u32 = digest.readUInt32BE(0)
  return (u32 % 1_000_000).toString().padStart(6, '0')
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Export an X25519 KeyObject in raw DER SPKI bytes for wire transmission. */
function exportRawPublic(key: KeyObject): Buffer {
  return key.export({ format: 'der', type: 'spki' }) as Buffer
}

/**
 * Show SAS to user, collect their verdict, exchange verdicts with the peer. Returns
 * true only if BOTH sides confirmed. Any disconnect or malformed byte is treated as
 * rejection.
 */
async function runSasCheck(socket: Socket, reader: Reader, sas: string, confirm: SasConfirm): Promise<boolean> {
  const userOk = await confirm(sas)
  await writeBytes(socket, Buffer.from([userOk ? SAS_YES : SAS_NO]))
  const peerByte = await reader.read(1).catch(() => Buffer.from([SAS_NO]))
  return userOk && peerByte[0] === SAS_YES
}

/** Write exactly `buf.length` bytes to the socket, awaiting drain on backpressure. */
async function writeBytes(socket: Socket, buf: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(buf, err => err ? reject(err) : resolve())
  })
}

/** A persistent buffered reader: read exactly N bytes at a time off a socket. */
interface Reader {
  read(n: number): Promise<Buffer>
}

/**
 * Attach a single permanent 'data' listener that accumulates everything into a buffer.
 * `read(n)` resolves when the buffer reaches N bytes; the remainder stays for the next
 * call. The right pattern for length-prefixed wire protocols — a detach/reattach scheme
 * loses data when TCP chunks straddle a read boundary.
 */
function createReader(socket: Socket): Reader {
  let buffer = Buffer.alloc(0)
  let pending: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null
  let closed: Error | null = null

  const tryResolve = (): void => {
    if (!pending) return
    if (buffer.length >= pending.n) {
      const chunk = buffer.subarray(0, pending.n)
      buffer = buffer.subarray(pending.n)
      const { resolve } = pending
      pending = null
      resolve(chunk)
    } else if (closed) {
      const { reject } = pending
      const err = closed
      pending = null
      reject(err)
    }
  }

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    tryResolve()
  })
  socket.on('end', () => { closed = closed ?? new Error('Connection closed by peer'); tryResolve() })
  socket.on('error', (e: Error) => { closed = closed ?? e; tryResolve() })

  return {
    read(n: number): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        if (pending) {
          reject(new Error('createReader: concurrent reads are not supported'))
          return
        }
        pending = { n, resolve, reject }
        tryResolve()
      })
    },
  }
}
