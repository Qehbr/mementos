import type { Ingestor } from '../interface.js'

/** Match a file against every registered ingestor's `detects` — first claim wins. */
export async function findIngestor(file: string, ingestors: Ingestor[]): Promise<Ingestor | null> {
  for (const ing of ingestors) {
    if (await ing.detects(file)) return ing
  }
  return null
}
