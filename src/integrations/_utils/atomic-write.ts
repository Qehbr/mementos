/** Cross-platform atomic file write helper. Windows EBUSY/EPERM retries are in renameWithRetry. */
import { rename } from 'node:fs/promises'

/**
 * Atomic rename with retry. On Windows, rename-over-existing-file can fail with EBUSY
 * or EPERM if another process (e.g. an AI client) holds the destination open. We retry
 * with exponential backoff (50, 100, 200, 400ms) before giving up.
 */
export async function renameWithRetry(from: string, to: string, maxAttempts = 5): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
      if (!retryable || attempt === maxAttempts - 1) throw e
      await new Promise(r => setTimeout(r, 50 * Math.pow(2, attempt)))
    }
  }
}
