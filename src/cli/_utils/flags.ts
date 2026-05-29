/**
 * Parse a CLI flag from process.argv. Three return shapes:
 *   - `--name=value` present  → returns `"value"`
 *   - `--name` (bare) present → returns `""` (truthy presence, no value)
 *   - absent                  → returns `undefined`
 *
 * Callers that only care about presence use `parseFlag('foo') !== undefined`; callers
 * that pass a value read it directly.
 */
export function parseFlag(name: string): string | undefined {
  for (const arg of process.argv) {
    if (arg === `--${name}`) return ''
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3)
  }
  return undefined
}
