/**
 * Shared visual style — the brand violet plus a pre-built `@inquirer/prompts`
 * theme so every prompt looks consistent without each call site re-declaring it.
 *
 * Truecolor (24-bit ANSI). Most modern terminals (iTerm2, Alacritty, kitty,
 * WezTerm, vscode terminal, modern xterm, Windows Terminal) speak it natively.
 * Legacy 16-color terminals fall back to the closest match (usually magenta);
 * the wrapper still works, just slightly off-hue.
 */
import { styleText } from 'node:util'

/** `#b69cf0` — the brand accent. */
const PURPLE_FG = '\x1b[38;2;182;156;240m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

/** Wrap text in the brand accent. */
export const accent = (s: string): string => `${PURPLE_FG}${s}${RESET}`
/** Bold accent — used for titles. */
export const accentBold = (s: string): string => `${PURPLE_FG}${BOLD}${s}${RESET}`
/** Dimmed text — used for hints, defaults, footer keybinds. */
export const dim = (s: string): string => `${DIM}${s}${RESET}`

/**
 * Inquirer theme. Pass `theme: promptTheme` to every `select`, `input`,
 * `confirm`, `checkbox` call so the highlight / answer / prefix all render in
 * the brand colour. Inquirer's defaults use blue/cyan; this overrides them.
 *
 * Each top-level field (`prefix`, `style`, `spinner`) is shared across all
 * prompt kinds via `@inquirer/core`'s `DefaultTheme`.
 */
export const promptTheme = {
  prefix: {
    idle: accent('?'),
    done: accent('✔'),
  },
  style: {
    answer: (text: string) => accent(text),
    // Bold ONLY the first line. Callers can embed an unbolded second line
    // (e.g. a dim hint) by passing `"Question\n  hint"` as the message —
    // without the line-split, the bold attribute leaks into the hint line.
    message: (text: string) => {
      const [first, ...rest] = text.split('\n')
      const head = `${BOLD}${first}${RESET}`
      return rest.length > 0 ? [head, ...rest].join('\n') : head
    },
    error: (text: string) => styleText('red', `> ${text}`),
    defaultAnswer: (text: string) => dim(`(${text})`),
    help: (text: string) => dim(text),
    highlight: (text: string) => accent(text),
    key: (text: string) => `${PURPLE_FG}${BOLD}<${text}>${RESET}`,
  },
} as const

/**
 * Checkbox-specific theme — extends `promptTheme` with brand-coloured circle
 * indicators (`◉ ◯`) and a purple cursor `❯`. Inquirer's default uses a green
 * tick which clashes with the rest of the wizard's palette.
 *
 * Pass `theme: checkboxTheme` instead of `promptTheme` to any `checkbox(...)`
 * call where you want the coloured circles.
 */
export const checkboxTheme = {
  ...promptTheme,
  icon: {
    checked: accent('◉'),
    unchecked: dim('◯'),
    cursor: accent('❯'),
  },
} as const
