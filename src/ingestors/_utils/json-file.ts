import { readFile } from 'node:fs/promises'

/**
 * Parse a JSON string; `undefined` on malformed input. The single tolerance rule — "a bad
 * blob is silently dropped, not fatal" — shared by the file readers and the SQLite
 * ingestors that parse JSON out of DB columns. Callers keep their own skip/return control flow.
 */
export function tryParseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

/**
 * Read and JSON-parse a whole file; `undefined` on malformed JSON (the caller shapes its
 * own empty result). A read error propagates — the CLI logs the file as a skip rather than
 * the ingestor swallowing it. The JSON analogue of `readJsonlRecords`.
 */
export async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  return tryParseJson<T>(await readFile(filePath, 'utf8'))
}
