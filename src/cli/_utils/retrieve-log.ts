import { appendFile, mkdir, stat, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const MAX_LOG_BYTES = 1024 * 1024

/**
 * Append one failure line to `~/.mementos/retrieve.log`, rotating to `retrieve.log.1` past
 * 1 MB. Best-effort: any I/O error is swallowed — a broken log path must never interrupt
 * the user's conversation, matching the runSessionStart catch that invokes this.
 */
export async function logRetrieveFailure(e: unknown): Promise<void> {
  try {
    const dir = join(homedir(), '.mementos')
    await mkdir(dir, { recursive: true })
    const logPath = join(dir, 'retrieve.log')
    const size = await stat(logPath).then(s => s.size).catch(() => 0)
    if (size > MAX_LOG_BYTES) await rename(logPath, logPath + '.1').catch(() => {})
    const msg = `[${new Date().toISOString()}] retrieve failed: ${(e as Error).stack ?? String(e)}\n`
    await appendFile(logPath, msg)
  } catch { /* best-effort */ }
}
