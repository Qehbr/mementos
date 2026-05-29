/**
 * Shared epoch / ISO → ISO-8601 coercion for ingestors. Every helper rejects 0 and
 * negative values (every source we ingest treats those as missing).
 */

/** Epoch seconds (float) → ISO. Used where the source records POSIX seconds. */
export function fromEpochSeconds(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return new Date(value * 1000).toISOString()
}

/** Epoch milliseconds → ISO. Used where the source records JS-style ms. */
export function fromEpochMs(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return new Date(value).toISOString()
}

/** ISO-8601 string → canonical ISO. Tolerates any input `new Date(s)` understands. */
export function fromIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}
