import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

/**
 * Shared serialize/load plumbing for the VectorIndex backends. The wire format —
 * `[4-byte LE meta length][meta JSON][native index bytes]` — and the temp-file lifecycle
 * (the native libs only read/write files) are identical across backends; only the meta
 * payload (counter type, key mapping) and the lib calls differ, and those stay per-impl.
 */

/** Frame a meta blob + native index bytes into the on-disk format. */
export function frameIndex(meta: Buffer, index: Buffer): Buffer {
  const metaLen = Buffer.allocUnsafe(4)
  metaLen.writeUInt32LE(meta.byteLength, 0)
  return Buffer.concat([metaLen, meta, index])
}

/** Inverse of `frameIndex`: split a framed buffer into its meta + index byte ranges. */
export function unframeIndex(data: Buffer): { meta: Buffer; index: Buffer } {
  const metaLen = data.readUInt32LE(0)
  return { meta: data.subarray(4, 4 + metaLen), index: data.subarray(4 + metaLen) }
}

/** Run `fn` with a unique temp-file path, unlinking it afterwards even on error. */
export async function withTempFile<T>(prefix: string, fn: (path: string) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `${prefix}-${randomBytes(8).toString('hex')}.bin`)
  try {
    return await fn(path)
  } finally {
    await unlink(path).catch(() => {})
  }
}
