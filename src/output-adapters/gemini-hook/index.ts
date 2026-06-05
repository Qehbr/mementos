/**
 * Gemini-shape hook envelope — wraps stdout in
 * `{ hookSpecificOutput: { hookEventName, additionalContext } }`, the format
 * the Gemini CLI hook contract documents (inherited by Antigravity CLI).
 *
 * Used by the antigravity-cli integration; selected via the hook command's
 * `--output-adapter=gemini-hook --hook-event=<event>` flags.
 */
import type { OutputAdapter } from '../interface.js'
import type { OutputAdapterImplementationModule } from '../registry.js'

export const type = 'gemini-hook'

export function create(): OutputAdapter {
  return {
    wrap: (text, params) => JSON.stringify({
      hookSpecificOutput: {
        hookEventName: params['event'] ?? 'BeforeAgent',
        additionalContext: text,
      },
    }),
  }
}

const _shape: OutputAdapterImplementationModule = { type, create }
