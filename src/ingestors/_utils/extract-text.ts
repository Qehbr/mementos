/** Pull text from a content union: a bare string, or an array of `{type:'text', text}` blocks (others dropped). */
export function joinTextBlocks(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const t = (block as { text?: unknown }).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  return parts.join('\n').trim()
}

function partText(part: unknown): string {
  if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
    return (part as { text: string }).text
  }
  return ''
}

/** Flatten a `string | Array<string | {text}>` union, concatenating runs with no separator. */
export function joinTextRuns(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return partText(content).trim()
  return content.map(p => typeof p === 'string' ? p : partText(p)).join('').trim()
}
