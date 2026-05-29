/** Lowercase a raw role and keep only conversation turns; anything else ⇒ `undefined` (drop). */
export function acceptRole(raw: unknown): 'user' | 'assistant' | undefined {
  const r = typeof raw === 'string' ? raw.toLowerCase() : ''
  return r === 'user' || r === 'assistant' ? r : undefined
}
