/**
 * Output adapters — pluggable envelopes for hook-subprocess stdout.
 *
 * Different AI clients consume hook output in different shapes:
 *   - Plain text (Claude Code, Codex): inject stdout as-is. The DEFAULT — no
 *     adapter selected = no wrap. This case is handled in the runtime directly,
 *     so it does not need to ship as an adapter implementation here.
 *   - JSON envelope (Antigravity CLI, via the Gemini hook contract): a JSON
 *     object with the event name and a content field. Shipped as `gemini-hook`.
 *
 * Each adapter ships under `src/output-adapters/<name>/index.ts`. The integration
 * whose client expects that envelope selects it via its hook command's
 * `--output-adapter=<name>` flag; `--hook-event=<event>` and any other
 * `--hook-*` flag passes through as `params`.
 *
 * Auto-discovered — adding a new envelope is one folder, no edits to the runtime.
 */

export interface OutputAdapter {
  /**
   * Wrap raw hook text in the client-specific envelope. `params` are name=value
   * pairs the integration's hook command supplies via `--hook-<name>=<value>`
   * flags. An adapter reads whichever params it needs; unknown params are ignored.
   */
  wrap(text: string, params: Record<string, string>): string
}
