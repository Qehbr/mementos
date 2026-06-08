/**
 * mementos CLI banner — Bloody-cropped wordmark with a per-letter truecolor purple
 * gradient on TTY output. Indigo at the edges, lighter orchid in the middle — a single
 * hue family with intensity variation that reads as "different newsprint sources" without
 * leaving the secrets/archive/mystery palette the product is positioned in.
 *
 * Gated on `process.stdout.isTTY` so the banner NEVER leaks into:
 *   - `mementos mcp` (stdout is MCP protocol; any decoration breaks the client)
 *   - `mementos retrieve` / `snapshot` (stdout is piped into the AI's context)
 *   - any piped/redirected output (`mementos --help | less`, `> help.txt`, etc.)
 * `NO_COLOR` is also honored: banner still prints on a TTY, just without ANSI styling.
 *
 * The art is the Bloody FIGlet font cropped to its top 5 rows (the natural letter
 * baselines) so the blood-drip rows are gone but the chunky cut-from-newsprint character
 * at the letter tops survives. Truecolor (24-bit) renders best on iTerm2 / Alacritty /
 * Kitty / WezTerm / Ghostty / modern VSCode; legacy 16-color terminals approximate.
 */

const BANNER = [
  ' ███▄ ▄███▓   ▓█████     ███▄ ▄███▓   ▓█████     ███▄    █    ▄▄▄█████▓    ▒█████       ██████ ',
  '▓██▒▀█▀ ██▒   ▓█   ▀    ▓██▒▀█▀ ██▒   ▓█   ▀     ██ ▀█   █    ▓  ██▒ ▓▒   ▒██▒  ██▒   ▒██    ▒ ',
  '▓██    ▓██░   ▒███      ▓██    ▓██░   ▒███      ▓██  ▀█ ██▒   ▒ ▓██░ ▒░   ▒██░  ██▒   ░ ▓██▄   ',
  '▒██    ▒██    ▒▓█  ▄    ▒██    ▒██    ▒▓█  ▄    ▓██▒  ▐▌██▒   ░ ▓██▓ ░    ▒██   ██░     ▒   ██▒',
  '▒██▒   ░██▒   ░▒████▒   ▒██▒   ░██▒   ░▒████▒   ▒██░   ▓██░     ▒██▒ ░    ░ ████▓▒░   ▒██████▒▒',
]

// 8 truecolor purples — symmetric gradient: indigo (dark) at the edges, orchid (light)
// in the middle. Order maps M E M E N T O S left-to-right; if the banner were ever
// changed, the gradient cycles modulo its length so the wordmark still gets distinct
// per-letter colors without crashing on a count mismatch.
const PURPLE_GRADIENT = [
  '\x1b[38;2;75;0;130m',     // M  — indigo
  '\x1b[38;2;128;0;128m',    // E  — purple
  '\x1b[38;2;148;0;211m',    // M  — dark violet
  '\x1b[38;2;138;43;226m',   // E  — blue violet
  '\x1b[38;2;186;85;211m',   // N  — medium orchid (lightest)
  '\x1b[38;2;148;0;211m',    // T  — dark violet
  '\x1b[38;2;128;0;128m',    // O  — purple
  '\x1b[38;2;75;0;130m',     // S  — indigo
]
const RESET = '\x1b[0m'

/**
 * Compute letter column ranges by detecting inter-letter gaps. A "gap column" is a
 * column where EVERY row of the banner is a space; a run of ≥2 consecutive gap columns
 * is an inter-letter gap. Letters are the regions between such gaps (or at the start /
 * end of the line). Each returned range extends through the gap that follows it, so the
 * coloured slices cover the line continuously with no uncoloured seams.
 *
 * Computed once at module load — the banner is constant, so this is effectively a
 * static table generated from data rather than hand-counted column numbers (which is
 * what the previous version got wrong: hand-counting misaligned half the letters).
 */
function computeLetterBounds(banner: readonly string[]): Array<readonly [number, number]> {
  const width = Math.max(...banner.map(r => r.length))
  const isAllSpace = (c: number): boolean => banner.every(row => (row[c] ?? ' ') === ' ')

  // Find inter-letter gap runs: [start, endExclusive) of ≥2 consecutive all-space columns.
  const gapEnds: number[] = []
  let runStart = -1
  for (let c = 0; c <= width; c++) {
    const space = c < width && isAllSpace(c)
    if (space) {
      if (runStart === -1) runStart = c
    } else {
      if (runStart !== -1 && c - runStart >= 2) gapEnds.push(c)
      runStart = -1
    }
  }

  // Each letter region runs from the previous gap-end (or 0) to the current gap-end.
  // The final region runs from the last gap-end to width.
  const bounds: Array<readonly [number, number]> = []
  let cursor = 0
  for (const end of gapEnds) {
    bounds.push([cursor, end])
    cursor = end
  }
  if (cursor < width) bounds.push([cursor, width])
  return bounds
}

const LETTER_BOUNDS = computeLetterBounds(BANNER)

/** Wrap each letter's column slice with its gradient color. */
function colorLine(line: string): string {
  let out = ''
  for (let i = 0; i < LETTER_BOUNDS.length; i++) {
    const [start, end] = LETTER_BOUNDS[i]
    const color = PURPLE_GRADIENT[i % PURPLE_GRADIENT.length]
    out += color + line.slice(start, end) + RESET
  }
  return out
}

/**
 * Print the banner to stdout. No-op when stdout isn't a terminal (so piped output, the
 * MCP server, and hook subprocesses stay clean). Per-letter truecolor purple gradient
 * on color-capable terminals; plain ASCII when `NO_COLOR` is set.
 */
export function printBanner(): void {
  if (!process.stdout.isTTY) return
  const color = !process.env.NO_COLOR
  const lines = color ? BANNER.map(colorLine) : BANNER
  process.stdout.write(lines.join('\n') + '\n')
}
