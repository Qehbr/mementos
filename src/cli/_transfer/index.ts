/**
 * High-level send/receive flows for LAN key transfer.
 *
 * Orchestrates the three layers:
 *   1. on-demand install of bonjour-service (peerDependency)
 *   2. mDNS publish/discovery (transport.ts)
 *   3. TCP socket setup + ECDH/SAS/AES-256-GCM handshake (protocol.ts)
 *
 * Caller provides a `confirm` callback that displays the SAS to the user and returns
 * their y/n. UI is the caller's responsibility — this module is headless.
 */
import { createServer, createConnection, type Socket } from 'node:net'
import { hostname } from 'node:os'
import { runSender, runReceiver, type SasConfirm } from './protocol.js'
import { publishService, discoverPeers, type DiscoveredPeer } from './transport.js'
import { ensurePackage } from '../../core/plugins.js'

export type { DiscoveredPeer } from './transport.js'

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000  // 5 min upper bound on either side waiting

/**
 * Sender side: start a TCP listener, advertise via mDNS, wait for one peer to connect,
 * run the secret-transfer handshake, then tear everything down.
 *
 * `print` and `confirm` come from the CLI caller (share-key.ts) — print emits status
 * lines to stdout, confirm shows the SAS and prompts y/N.
 */
export async function sendKey(
  secret: string,
  print: (msg: string) => void,
  confirm: SasConfirm,
): Promise<void> {
  await ensurePackage('bonjour-service', print)

  const server = createServer()
  const peerSocket = waitForOneConnection(server)
  await listenOnRandomPort(server)
  const port = (server.address() as { port: number }).port

  const peerName = `${hostname()}-mementos`
  print(`Listening on port ${port}, advertising as "${peerName}" on the local network…`)
  const stopMdns = publishService(port, peerName)

  try {
    const socket = await withTimeout(peerSocket, DEFAULT_TIMEOUT_MS, 'No peer connected within 5 minutes.')
    try {
      print(`Peer connected from ${socket.remoteAddress}.`)
      await runSender(socket, secret, confirm)
      print('Key transfer complete.')
    } finally {
      socket.destroy()
    }
  } finally {
    await stopMdns()
    server.close()
  }
}

/**
 * Receiver side: scan for advertised peers via mDNS, let `pickPeer` choose one (returning
 * `null` aborts), connect over TCP, run the handshake, return the decrypted secret.
 */
export async function receiveKey(
  print: (msg: string) => void,
  confirm: SasConfirm,
  pickPeer: (peers: DiscoveredPeer[]) => Promise<DiscoveredPeer | null>,
): Promise<string> {
  await ensurePackage('bonjour-service', print)

  print('Scanning the local network for a sender…')
  const peers = await discoverPeers()
  if (peers.length === 0) throw new Error('No mementos sender found on this network. Run `mementos share-key` on the other device first.')

  const chosen = await pickPeer(peers)
  if (!chosen) throw new Error('No peer selected — aborting.')

  print(`Connecting to ${chosen.name} (${chosen.host}:${chosen.port})…`)
  const socket = await connectTo(chosen.host, chosen.port)
  try {
    return await runReceiver(socket, confirm)
  } finally {
    socket.destroy()
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function listenOnRandomPort(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, () => { server.off('error', reject); resolve() })
  })
}

function waitForOneConnection(server: ReturnType<typeof createServer>): Promise<Socket> {
  return new Promise((resolve, reject) => {
    server.once('connection', resolve)
    server.once('error', reject)
  })
}

function connectTo(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
