/**
 * Match an installed hook command against the base command we'd recognise as ours.
 * Trim-tolerant; accepts the bare base or `base <any args>`. The "base + any args" rule
 * lives here only so siblings can't drift on the regex shape.
 */
export function matchesCommand(command: string | undefined, baseCommand: string): boolean {
  if (!command) return false
  const t = command.trim()
  return t === baseCommand || t.startsWith(baseCommand + ' ')
}
