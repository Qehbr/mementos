import { extname, basename, sep } from 'node:path'

/** True if the path (separators normalised to `/`) contains `segment`, e.g. `'/chats/'`. */
export function pathContains(filePath: string, segment: string): boolean {
  return filePath.split(sep).join('/').includes(segment)
}

/** True if `filePath` has extension `ext` and basename `name` (both compared case-insensitively). */
export function isNamedFile(filePath: string, ext: string, name: string): boolean {
  return extname(filePath).toLowerCase() === ext.toLowerCase()
    && basename(filePath).toLowerCase() === name.toLowerCase()
}
