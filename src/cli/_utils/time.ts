/**
 * Elapsed-time formatting for the CLI's status surfaces.
 *
 * `secondsSince` was copied in both `daemon.ts` and `doctor.ts`; `status.ts` would
 * have been the third. Both render the same thing — how long ago the daemon recorded
 * `startedAt` — so the formatting lives in one place.
 */

/** Whole seconds since an ISO timestamp, or `?` if it doesn't parse. */
export function secondsSince(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return '?'
  return String(Math.max(0, Math.round((Date.now() - then) / 1000)))
}

/**
 * Coarse elapsed time for a long-lived process — `12s`, `5m`, `3h 20m`, `2d 4h`.
 * Deliberately one or two units: an uptime readout is scanned, not measured.
 */
export function formatUptime(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return '?'
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}
