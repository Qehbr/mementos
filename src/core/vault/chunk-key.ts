/**
 * Chunk-key format used by Vault to address one chunk inside the lower layers
 * (VectorIndex, Retriever). One memento has N chunks, each addressed by
 * `"<mementoId>#<i>"` — memento ids are UUIDs (no `#`), so the format parses
 * unambiguously.
 *
 * The lower layers consult `mementoIdOf` to support filtered queries that take memento ids:
 * each one maps chunk-keys back to their memento for the filter check. Shared here so the
 * `lastIndexOf('#')` convention has one definition, not a hand-copied mirror per file.
 */

/** Build the chunk key for chunk `i` of memento `id`. */
export function chunkKey(id: string, i: number): string {
  return `${id}#${i}`
}

/** Memento id from a `"<mementoId>#<i>"` chunk key; the whole key when there's no `#`. */
export function mementoIdOf(key: string): string {
  const hash = key.lastIndexOf('#')
  return hash === -1 ? key : key.slice(0, hash)
}

/** Chunk index from a `"<mementoId>#<i>"` chunk key; 0 when there's no `#`. */
export function chunkIndexOf(key: string): number {
  const hash = key.lastIndexOf('#')
  return hash === -1 ? 0 : Number(key.slice(hash + 1))
}
