/**
 * Scratch root for test artefacts — always `src/__tests__/tmp/`, never the OS `/tmp`.
 *
 * Kept in its own module, separate from `integration/_helpers.ts`, so the vitest
 * global setup can import the path without pulling in `vitest`'s test-context APIs
 * (`vi`), which are not available in a global-setup file.
 */
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Tests root (this file is at src/__tests__/_utils/tmp-root.ts). */
const TESTS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const TMP_ROOT = join(TESTS_ROOT, 'tmp')
