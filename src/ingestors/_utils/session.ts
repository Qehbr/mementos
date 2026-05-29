import type { IngestSession } from '../interface.js'

/**
 * Assemble one session from its collected mementos, or `undefined` if none survived
 * filtering. `createdAt` is the first memento's timestamp (mementos are pushed in order),
 * falling back to `fallbackCreatedAt` when no memento carries one (e.g. sources whose
 * messages have no per-turn timestamp).
 */
export function buildSession(
  chronicleId: string,
  mementos: IngestSession['mementos'],
  source: string,
  fallbackCreatedAt?: string,
): IngestSession | undefined {
  if (mementos.length === 0) return undefined
  return {
    chronicleId,
    mementos,
    tags: [`source:${source}`],
    createdAt: mementos.find(m => m.createdAt)?.createdAt ?? fallbackCreatedAt,
  }
}
