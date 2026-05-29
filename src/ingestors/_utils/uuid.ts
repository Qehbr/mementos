/**
 * Shared id helper for ingestors.
 *
 * The vault requires UUID-shaped ids for both chronicle ids and per-memento ids, but most
 * sources don't use UUIDs (OpenClaw's `msg_…`, a Slack `ts`, a WhatsApp line number, …).
 * `toUuid` maps any string to a stable, canonical UUID so an ingestor can derive ids from
 * whatever the source provides.
 */
import { createHash } from 'node:crypto'

/**
 * Map an arbitrary string to a deterministic, canonical UUID. SHA-256 the seed, take 16
 * bytes, and stamp in the version (5) + RFC 4122 variant nibbles so the result is a
 * well-formed UUID. Deterministic: the same seed always yields the same id — which keeps
 * re-ingestion idempotent and lets a child's `parentMementoId` match its parent's
 * `mementoId` (both sides hash through this same function).
 */
export function toUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex') // always 64 hex chars
  const variant = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16) // RFC 4122 variant
  // Stamp version 5 (name-based) at index 12 and the variant nibble at index 16.
  const s = hex.slice(0, 12) + '5' + hex.slice(13, 16) + variant + hex.slice(17, 32)
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}
