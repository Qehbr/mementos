import type { DatabaseSync } from 'node:sqlite'

/**
 * Open `filePath` as a read-only SQLite DB, run `fn`, and always close it. `node:sqlite` is
 * built in but recent, so it's lazy-imported here — an older Node without it fails only the
 * calling ingestor, not discovery of every ingestor.
 */
export async function withReadonlyDb<T>(filePath: string, fn: (db: DatabaseSync) => T): Promise<T> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(filePath, { readOnly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}
