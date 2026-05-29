/**
 * Thin wrapper around bonjour-service for mDNS service publish + discovery.
 *
 * Loaded lazily via requireFromPlugins — bonjour-service is an optional peerDependency,
 * installed on demand into ~/.config/mementos/plugins/ the first time the user runs
 * `mementos share-key` (sender) or `mementos init --mode=join` with the LAN-pair option
 * (receiver).
 *
 * The actual handshake / SAS / encryption lives in protocol.ts and operates on a plain
 * net.Socket. This module is only responsible for getting two peers to that point:
 *   - publishService(port): advertise on the LAN; returns a stop() callback.
 *   - discoverPeers(timeoutMs): scan for advertised services; returns a list.
 *
 * The TCP server/client setup itself lives in index.ts so this stays a pure mDNS layer.
 */
import { requireFromPlugins } from '../../core/plugins.js'

/** mDNS service type used by mementos pair-up flow. The leading `_` and `._tcp.local` are added by bonjour-service. */
export const SERVICE_TYPE = 'mementos-pair'

/** Peer descriptor as returned by bonjour-service's `up` event. */
export interface DiscoveredPeer {
  /** Human-visible peer name (hostname-derived by bonjour-service). */
  name: string
  /** First reachable address. bonjour-service may return multiple; we use the IPv4 one. */
  host: string
  /** TCP port the peer is listening on. */
  port: number
}

/** Lazily load the bonjour-service module from the plugins dir. */
function loadBonjour(): BonjourCtor {
  // Cast through unknown — the runtime require returns the module namespace; we narrow
  // to the constructor shape we actually use below.
  const mod = requireFromPlugins('bonjour-service') as { Bonjour: BonjourCtor }
  return mod.Bonjour
}

/**
 * Advertise a mementos-pair service on the LAN. Returns a stop function that cleans
 * up both the published service and the underlying Bonjour instance.
 */
export function publishService(port: number, name: string): () => Promise<void> {
  const Bonjour = loadBonjour()
  const instance = new Bonjour()
  const service = instance.publish({ name, type: SERVICE_TYPE, port })
  return async () => {
    await new Promise<void>(resolve => service.stop(() => resolve()))
    instance.destroy()
  }
}

/**
 * Browse for mementos-pair peers on the LAN. Resolves with the list of peers seen within
 * the timeout window (1s default is plenty for mDNS announces on a healthy network).
 * Always cleans up the browser + instance before returning.
 */
export function discoverPeers(timeoutMs = 2000): Promise<DiscoveredPeer[]> {
  const Bonjour = loadBonjour()
  const instance = new Bonjour()
  const peers = new Map<string, DiscoveredPeer>()  // dedupe by name

  return new Promise(resolve => {
    const browser = instance.find({ type: SERVICE_TYPE })
    browser.on('up', (svc: RawService) => {
      // Prefer IPv4; bonjour-service often reports both link-local v6 and v4.
      const host = (svc.addresses ?? []).find(a => a.includes('.')) ?? svc.host
      peers.set(svc.name, { name: svc.name, host, port: svc.port })
    })
    setTimeout(() => {
      browser.stop()
      instance.destroy()
      resolve([...peers.values()])
    }, timeoutMs)
  })
}

// ─── Local typings for bonjour-service ────────────────────────────────────────

interface RawService {
  name: string
  host: string
  port: number
  addresses?: string[]
}

interface PublishedService {
  stop(cb: () => void): void
}

interface Browser {
  on(event: 'up', cb: (svc: RawService) => void): void
  stop(): void
}

interface BonjourInstance {
  publish(opts: { name: string; type: string; port: number }): PublishedService
  find(opts: { type: string }): Browser
  destroy(): void
}

interface BonjourCtor {
  new(): BonjourInstance
}
