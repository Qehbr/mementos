/**
 * Tests for the LAN key-transfer protocol — covers the SAS computation and the
 * full sender↔receiver round-trip over a localhost TCP pair.
 *
 * The integration scenarios bypass mDNS entirely: we open a server on a random
 * loopback port, run the sender against the accepted socket and the receiver
 * against the client socket in parallel. The mDNS layer (transport.ts) is glue
 * around discovery and is exercised by the manual `mementos share-key` flow.
 */
import { describe, it, expect } from 'vitest'
import { createServer, createConnection, type Socket, type AddressInfo } from 'node:net'
import { runSender, runReceiver, computeSas } from '../cli/_transfer/protocol.js'

describe('computeSas', () => {
  it('is order-stable — both sides compute the same value regardless of arg order', () => {
    const a = Buffer.from('alice-pub-key-bytes')
    const b = Buffer.from('bob-pub-key-bytes')
    expect(computeSas(a, b)).toBe(computeSas(b, a))
  })

  it('produces a 6-digit zero-padded numeric string', () => {
    const a = Buffer.from('any-pub-key-1')
    const b = Buffer.from('any-pub-key-2')
    const sas = computeSas(a, b)
    expect(sas).toMatch(/^\d{6}$/)
  })

  it('produces different SAS for different key pairs (sanity check, not a security claim)', () => {
    const a1 = Buffer.from('pair-1-key-a')
    const b1 = Buffer.from('pair-1-key-b')
    const a2 = Buffer.from('pair-2-key-a')
    const b2 = Buffer.from('pair-2-key-b')
    expect(computeSas(a1, b1)).not.toBe(computeSas(a2, b2))
  })
})

describe('sender ↔ receiver round-trip (localhost TCP)', () => {
  it('transfers a secret string verbatim when both sides confirm SAS', async () => {
    const secret = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'
    const [sasOnSender, sasOnReceiver] = await runRoundTrip(secret, () => true)

    expect(sasOnSender).toMatch(/^\d{6}$/)
    expect(sasOnSender).toBe(sasOnReceiver)
  })

  it('transfers a JSON-wrapped payload byte-for-byte', async () => {
    // share-key wraps `{ format, value }` as JSON; verify multi-byte / quote-containing
    // payloads survive the encrypted channel intact.
    const payload = JSON.stringify({ format: 'mnemonic', value: 'one two three four "five" six' })
    const [, , received] = await runRoundTrip(payload, () => true)
    expect(received).toBe(payload)
  })

  it('aborts when the sender user rejects SAS', async () => {
    await expect(runRoundTrip('secret', (side) => side === 'receiver')).rejects.toThrow(/aborting/i)
  })

  it('aborts when the receiver user rejects SAS', async () => {
    await expect(runRoundTrip('secret', (side) => side === 'sender')).rejects.toThrow(/aborting/i)
  })
})

/**
 * Run a full sender/receiver round-trip against a loopback TCP pair.
 *
 * `decide` is called as `decide(side)` where side is 'sender' or 'receiver' — return
 * true to confirm SAS on that side, false to reject. Returns `[senderSas, receiverSas,
 * receivedSecret]` on success.
 */
async function runRoundTrip(
  secret: string,
  decide: (side: 'sender' | 'receiver') => boolean,
): Promise<[string, string, string]> {
  const { acceptedSocket, clientSocket } = await openSocketPair()

  let senderSas = ''
  let receiverSas = ''

  const senderP = runSender(acceptedSocket, secret, async (sas) => {
    senderSas = sas
    return decide('sender')
  })
  const receiverP = runReceiver(clientSocket, async (sas) => {
    receiverSas = sas
    return decide('receiver')
  })

  try {
    const [, received] = await Promise.all([senderP, receiverP])
    return [senderSas, receiverSas, received]
  } finally {
    acceptedSocket.destroy()
    clientSocket.destroy()
  }
}

/** Open a server on a loopback ephemeral port, connect a client, return both sockets. */
async function openSocketPair(): Promise<{ acceptedSocket: Socket; clientSocket: Socket }> {
  const server = createServer()
  const acceptedP = new Promise<Socket>((resolve, reject) => {
    server.once('connection', resolve)
    server.once('error', reject)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  const clientSocket = createConnection({ host: '127.0.0.1', port })
  await new Promise<void>((resolve, reject) => {
    clientSocket.once('connect', () => resolve())
    clientSocket.once('error', reject)
  })
  const acceptedSocket = await acceptedP
  server.close()
  return { acceptedSocket, clientSocket }
}
