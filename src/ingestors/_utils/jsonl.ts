import { readFile } from 'node:fs/promises'
import { tryParseJson } from './json-file.js'

/**
 * Read a JSONL file and parse each non-blank line; malformed lines are skipped (one bad
 * record shouldn't kill the transcript). A read error throws — the CLI logs the file as a
 * skip rather than the ingestor swallowing it.
 */
export async function readJsonlRecords<T>(filePath: string): Promise<T[]> {
  const raw = await readFile(filePath, 'utf8')
  const out: T[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const rec = tryParseJson<T>(line)
    if (rec !== undefined) out.push(rec)
  }
  return out
}
