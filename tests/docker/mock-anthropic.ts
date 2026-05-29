/// <reference types="node" />
/**
 * Minimal Anthropic Messages API mock.
 *
 * Just enough for `claude -p "<prompt>"` to complete one turn without a real API key, so
 * the claude-code ingestor drift test can run keyless in CI. It returns a fixed text reply
 * as a streaming SSE response in the Anthropic event shape. The reply content does not
 * matter — only that Claude Code completes the turn and writes its real session JSONL,
 * whose format the ingestor is then tested against.
 *
 *   MOCK_PORT=8080 tsx docker/mock-anthropic.ts
 */
import { createServer, type ServerResponse } from 'node:http'
import process from 'node:process'

const PORT = Number(process.env['MOCK_PORT'] ?? 8080)
const REPLY = 'Understood — noted.'

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

createServer((req, res) => {
  let body = ''
  req.on('data', (c: Buffer) => { body += c.toString() })
  req.on('end', () => {
    void body
    const url = req.url ?? ''

    // Token-count preflight some clients make before a request.
    if (url.includes('count_tokens')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: 10 }))
      return
    }

    // The Messages endpoint — stream a single fixed text block.
    if (url.includes('/v1/messages')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const message = {
        id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-mock',
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }
      sse(res, 'message_start', { type: 'message_start', message })
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
      sse(res, 'message_stop', { type: 'message_stop' })
      res.end()
      return
    }

    // Anything else (model lists, telemetry, …) — benign 200 so nothing blocks.
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
}).listen(PORT, () => console.error(`mock-anthropic listening on :${PORT}`))
