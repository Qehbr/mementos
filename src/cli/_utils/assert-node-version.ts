/**
 * Refuse to run on a Node older than package.json's `engines.node`.
 *
 * Runs at import time and MUST be the first import of the CLI entry:
 * `npm install -g` only WARNS on an engines mismatch, so without this gate
 * an old Node crashes later with whatever missing-API error it hits first.
 * Only Node built-ins that exist on every remotely-modern Node are imported
 * here, so the gate itself always reaches its own error message.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

// In dist: dist/cli/_utils/assert-node-version.js → three levels up to the package root.
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json')
const { engines } = JSON.parse(readFileSync(pkgPath, 'utf8')) as { engines?: { node?: string } }
const match = /^>=(\d+)\.(\d+)/.exec(engines?.node ?? '')
if (!match) throw new Error(`package.json engines.node is missing or not ">=X.Y" (got "${engines?.node ?? ''}")`)

const reqMajor = Number(match[1])
const reqMinor = Number(match[2])
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
if (major < reqMajor || (major === reqMajor && minor < reqMinor)) {
  console.error(`mementos requires Node >= ${reqMajor}.${reqMinor} — you are running ${process.version}.`)
  console.error('Install a newer Node from https://nodejs.org (or via nvm / fnm), then re-run.')
  process.exit(1)
}
