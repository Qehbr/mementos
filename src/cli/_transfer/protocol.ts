/**
 * LAN key-transfer protocol — ECDH key agreement + Short Authentication String (SAS)
 * verification + AES-256-GCM encrypted payload.
 *
 * Wire flow over an already-established TCP socket (one round trip + a payload):
 *
 *     1. Both peers send their X25519 public key (44-byte DER SPKI).
 *     2. Both peers derive the shared secret via ECDH and compute a 6-digit SAS code
 *        (truncated SHA-256 of the sorted concatenated public keys).
 *     3. Both peers display the SAS to the user, who visually confirms they match on
 *        BOTH screens. Each peer sends a 1-byte verdict: 0x01 = "user confirmed" / 0x00
 *        = "user rejected". Sides only proceed if both verdicts are 0x01.
 *     4. The sender encrypts the secret under the shared secret with AES-256-GCM and
 *        sends [4 BE bytes ciphertext length][12 nonce][N ciphertext][16 GCM tag].
 *     5. The receiver decrypts and returns the plaintext.
 *
 * Why SAS, not PAKE: the user's confirmation that the same code appears on both screens
 * is what defeats an active MITM. The shared key itself is agreed via ECDH, which is
 * uniformly safe against passive attackers regardless of password length. No PAKE
 * dependency, no shaky third-party crypto library — just Node's built-in primitives.
 *
 * Threat model assumed:
 *   - Active LAN attacker can sniff, inject, and replay TCP traffic.
 *   - Attacker CANNOT modify the screens of both legitimate machines simultaneously.
 *   - Attacker may run a peer of their own and try to MITM; the SAS check catches that
 *     because the attacker's ECDH key produces a different SAS than the legitimate one.
 *
 * Out of scope: malicious code already running on either machine (game over anyway);
 * compromise of the OS keychain on the sender (also game over).
 */
import {
  generateKeyPairSync, diffieHellman, createPublicKey,
  createCipheriv, createDecipheriv, createHash, randomBytes, hkdfSync,
  type KeyObject,
} from 'node:crypto'
import type { Socket } from 'node:net'

/** Byte length of an X25519 public key exported in DER (SubjectPublicKeyInfo) format. */
const PUBKEY_DER_LEN = 44
/** GCM nonce: 12 bytes is the standard size. */
const NONCE_LEN = 12
/** GCM authentication tag: 16 bytes. */
const TAG_LEN = 16
/** 1-byte SAS verdict on the wire: yes = 0x01, no = 0x00. */
const SAS_YES = 0x01
const SAS_NO = 0x00

/**
 * HKDF context for the LAN-pairing AES-256-GCM key. The X25519 shared secret is the
 * curve-point X-coordinate — not uniform in 256-bit space (scalar clamping + small
 * structural bias) — so per NIST SP 800-56C / standard ECDH+AEAD practice, run it through
 * HKDF before use as an AEAD key. The version tag (`v1`) is the forward-compat knob: a
 * future protocol revision bumps to `v2` and old senders/receivers reject cleanly via
 * GCM auth failure (they'd derive a different key).
 */
const PAIRING_KDF_SALT = 'mementos-share-key-v1'
const PAIRING_KDF_INFO = 'aes-256-gcm-key'

/** Derive the AEAD key from the raw X25519 shared secret. */
function derivePairingKey(rawShared: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', rawShared, PAIRING_KDF_SALT, PAIRING_KDF_INFO, 32))
}

/** Caller-supplied hook to display the SAS to the user and return their y/n answer. */
export type SasConfirm = (sas: string) => Promise<boolean>

/** Sender-side: agree on a key, verify SAS, encrypt and send the secret. */
export async function runSender(socket: Socket, secret: string, confirm: SasConfirm): Promise<void> {
  const reader = createReader(socket)
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const ourPubDer = exportRawPublic(publicKey)

  await writeBytes(socket, ourPubDer)
  const peerPubDer = await reader.read(PUBKEY_DER_LEN)
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

/** Receiver-side: agree on a key, verify SAS, receive and decrypt the secret. */
export async function runReceiver(socket: Socket, confirm: SasConfirm): Promise<string> {
  const reader = createReader(socket)
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const ourPubDer = exportRawPublic(publicKey)

  const peerPubDer = await reader.read(PUBKEY_DER_LEN)
  await writeBytes(socket, ourPubDer)
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
 * Compute the 6-digit SAS code from both public keys. Order-stable: sender and receiver
 * sort the two keys identically before hashing, so the digest matches on both sides.
 *
 * Exported for unit tests; in normal use it's called inside runSender/runReceiver.
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
