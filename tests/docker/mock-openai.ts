/// <reference types="node" />
/**
 * Minimal OpenAI-compatible API mock.
 *
 * Just enough for an OpenAI-API client to complete one turn without a real API key, so an
 * ingestor drift test can run keyless in CI. It returns a fixed assistant reply over the
 * two APIs an OpenAI client might use:
 *   - Chat Completions  (`/chat/completions`) — streamed or not.
 *   - Responses         (`/responses`)        — the API the Codex CLI uses; streamed SSE.
 * plus a stub `/models` list. The reply content doesn't matter; only that the client
 * completes the turn and writes its real transcript, whose format the ingestor is tested
 * against. Every request is logged to stderr so a drift test can see what the client hit.
 *
 *   MOCK_PORT=8090 tsx tests/docker/mock-openai.ts
 */
import { createServer, type ServerResponse } from 'node:http'
import process from 'node:process'

const PORT = Number(process.env['MOCK_PORT'] ?? 8090)
const REPLY = 'Understood — noted.'
const MODEL = 'gpt-4o-mini'

/** Write one `event:`/`data:` SSE frame. */
function sse(res: ServerResponse, event: string, data: object): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

// ─── Chat Completions ─────────────────────────────────────────────────────────

function chatCompletion(): object {
  return {
    id: 'chatcmpl-mock', object: 'chat.completion', created: 0, model: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
}

function streamChatCompletion(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model: MODEL }
  const send = (choice: object): void => { res.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`) }
  send({ index: 0, delta: { role: 'assistant' }, finish_reason: null })
  send({ index: 0, delta: { content: REPLY }, finish_reason: null })
  send({ index: 0, delta: {}, finish_reason: 'stop' })
  res.write('data: [DONE]\n\n')
  res.end()
}

// ─── Responses API (used by the Codex CLI) ────────────────────────────────────

/** The final `response` object — also the body of a non-streamed Responses request. */
function responseObject(status: 'in_progress' | 'completed'): object {
  return {
    id: 'resp_mock', object: 'response', created_at: 0, status, model: MODEL,
    output: status === 'completed'
      ? [{
          id: 'msg_mock', type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: REPLY, annotations: [] }],
        }]
      : [],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  }
}

/** Stream the Responses API event sequence the Codex CLI expects, terminated by `[DONE]`. */
function streamResponse(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  let seq = 0
  const emit = (type: string, extra: object): void => sse(res, type, { type, sequence_number: seq++, ...extra })
  const msgItem = (status: 'in_progress' | 'completed', withText: boolean): object => ({
    id: 'msg_mock', type: 'message', status, role: 'assistant',
    content: withText ? [{ type: 'output_text', text: REPLY, annotations: [] }] : [],
  })

  emit('response.created', { response: responseObject('in_progress') })
  emit('response.in_progress', { response: responseObject('in_progress') })
  emit('response.output_item.added', { output_index: 0, item: msgItem('in_progress', false) })
  emit('response.content_part.added', {
    item_id: 'msg_mock', output_index: 0, content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  })
  emit('response.output_text.delta', { item_id: 'msg_mock', output_index: 0, content_index: 0, delta: REPLY })
  emit('response.output_text.done', { item_id: 'msg_mock', output_index: 0, content_index: 0, text: REPLY })
  emit('response.content_part.done', {
    item_id: 'msg_mock', output_index: 0, content_index: 0,
    part: { type: 'output_text', text: REPLY, annotations: [] },
  })
  emit('response.output_item.done', { output_index: 0, item: msgItem('completed', true) })
  emit('response.completed', { response: responseObject('completed') })
  res.write('data: [DONE]\n\n')
  res.end()
}

// ─── Router ───────────────────────────────────────────────────────────────────

createServer((req, res) => {
  let body = ''
  req.on('data', (c: Buffer) => { body += c.toString() })
  req.on('end', () => {
    const url = req.url ?? ''
    console.error(`mock-openai: ${req.method} ${url}`)
    const wantsStream = (): boolean => {
      try { return (JSON.parse(body) as { stream?: boolean }).stream === true } catch { return false }
    }

    if (url.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'mock' }] }))
      return
    }

    if (url.includes('/chat/completions')) {
      if (wantsStream()) { streamChatCompletion(res); return }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(chatCompletion()))
      return
    }

    if (url.includes('/responses')) {
      if (wantsStream()) { streamResponse(res); return }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(responseObject('completed')))
      return
    }

    // Anything else (telemetry, …) — benign 200 so nothing blocks.
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
}).listen(PORT, () => console.error(`mock-openai listening on :${PORT}`))
