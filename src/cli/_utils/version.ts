/**
 * The installed package version, for `mementos --version`.
 *
 * Read from the manifest at runtime rather than compiled in: a build-time constant
 * would drift from the `package.json` npm actually published whenever a release bumps
 * the version without a rebuild.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

// In dist: dist/cli/_utils/version.js → three levels up to the package root.
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json')

export function packageVersion(): string {
  const { version } = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
  if (!version) throw new Error(`package.json is missing a "version" field (${pkgPath})`)
  return version
}
