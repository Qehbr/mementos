/**
 * ChatGptExportIngestor — parses a ChatGPT data export's `conversations.json`.
 *
 * A ChatGPT account export (Settings → Data controls → Export) is a ZIP whose
 * `conversations.json` is a JSON array of conversation objects. Each conversation holds a
 * `mapping`: a tree of message nodes keyed by node id, where every node is
 * `{ id, message, parent, children }`. A node's `message` is `null` for the synthetic
 * root, otherwise `{ id, author:{role}, create_time, content:{content_type, parts} }`.
 *
 * We keep `user` / `assistant` turns and drop everything else (system primers, tool
 * calls, visually-hidden context injections). Identity maps to mementos like this:
 *
 *   - **`chronicleId`** = the conversation's `conversation_id` / `id`, hashed to a stable
 *     UUID via `toUuid()`.
 *   - **`mementoId`** = each node's id, hashed the same way.
 *   - **`parentMementoId`** = each node's `parent`, hashed the same way — so a child's
 *     `parentMementoId` equals its parent's `mementoId` and the branch structure
 *     (regenerated answers, edited prompts) is preserved.
 *   - **`createdAt`** = each message's `create_time` (epoch seconds → ISO).
 *
 * Nodes are emitted in `create_time` order. Branches are all kept — a regenerated answer
 * is real content the user saw — and the parent links let the vault annotate the forks.
 *
 * The export is a manual download (no ChatGPT CLI). Unit-tested against a captured
 * `conversations.json` fixture.
 */
import type { Ingestor, IngestSession, IngestorFactory } from '../interface.js'
import type { IngestorImplementationModule } from '../registry.js'
import { toUuid } from '../_utils/uuid.js'
import { roleLine } from '../_utils/turn-line.js'
import { fromEpochSeconds } from '../_utils/timestamp.js'
import { buildSession } from '../_utils/session.js'
import { acceptRole } from '../_utils/role.js'
import { isNamedFile } from '../_utils/detect.js'
import { readJsonFile } from '../_utils/json-file.js'

// ─── Discovery contract ───────────────────────────────────────────────────────
export const type = 'chatgpt-export'
export const create: IngestorFactory = () => new ChatGptExportIngestor()
const _shape: IngestorImplementationModule = { type, create }

class ChatGptExportIngestor implements Ingestor {
  readonly name = 'ChatGPT export'

  detects(filePath: string): boolean {
    // `conversations.json` is the fixed filename inside every ChatGPT export ZIP.
    return isNamedFile(filePath, '.json', 'conversations.json')
  }

  async parse(filePath: string): Promise<IngestSession[]> {
    const parsed = await readJsonFile<unknown>(filePath)
    if (parsed === undefined) return []
    // A ChatGPT export is an array; tolerate a single-conversation object too.
    const conversations = Array.isArray(parsed) ? parsed as ChatGptConversation[] : [parsed as ChatGptConversation]

    const sessions: IngestSession[] = []
    for (const conv of conversations) {
      const session = this.parseConversation(conv)
      if (session) sessions.push(session)
    }
    return sessions
  }

  private parseConversation(conv: ChatGptConversation): IngestSession | undefined {
    const mapping = conv?.mapping
    if (!mapping || typeof mapping !== 'object') return undefined

    // Collect message-bearing nodes, ordered by create_time (stable: ties keep map order).
    const nodes = Object.values(mapping)
      .filter((n): n is ChatGptNode => !!n && typeof n === 'object' && !!n.message)
      .sort((a, b) => (a.message?.create_time ?? 0) - (b.message?.create_time ?? 0))

    const mementos: IngestSession['mementos'] = []

    for (const node of nodes) {
      const message = node.message
      if (!message) continue
      const role = acceptRole(message.author?.role)
      if (!role) continue
      // System context that ChatGPT injects but never shows the user.
      if (message.metadata?.is_visually_hidden_from_conversation === true) continue

      const text = extractText(message.content)
      if (!text) continue

      mementos.push({
        mementoId: toUuid(node.id),
        parentMementoId: typeof node.parent === 'string' && node.parent ? toUuid(node.parent) : undefined,
        text: roleLine(role, text),
        createdAt: fromEpochSeconds(message.create_time),
      })
    }

    const convId = conv.conversation_id ?? conv.id
    const chronicleId = toUuid(typeof convId === 'string' && convId ? convId : JSON.stringify(conv.mapping))
    return buildSession(chronicleId, mementos, 'chatgpt', fromEpochSeconds(conv.create_time))
  }
}

/**
 * Pull plain text out of a ChatGPT message's `content`. The common case is
 * `content_type: "text"` with `parts: ["the text"]`; multimodal messages mix strings with
 * image/audio objects. We keep the string parts and join them — non-string parts (images,
 * tool payloads) carry nothing useful for memory retrieval. Some content types (e.g.
 * `code`) carry the body on `content.text` instead of `parts`; fall back to that.
 */
function extractText(content: ChatGptContent | undefined): string {
  const parts = content?.parts
  if (typeof parts === 'string') return parts.trim()
  if (Array.isArray(parts)) {
    const text = parts.filter((p): p is string => typeof p === 'string').join('\n').trim()
    if (text) return text
  }
  return typeof content?.text === 'string' ? content.text.trim() : ''
}

interface ChatGptContent {
  content_type?: string
  parts?: unknown
  text?: string
}
interface ChatGptMessage {
  id?: string
  author?: { role?: unknown }
  create_time?: number | null
  content?: ChatGptContent
  metadata?: { is_visually_hidden_from_conversation?: boolean }
}
interface ChatGptNode {
  id: string
  message?: ChatGptMessage | null
  parent?: string | null
  children?: string[]
}
interface ChatGptConversation {
  id?: string
  conversation_id?: string
  create_time?: number | null
  mapping?: Record<string, ChatGptNode | null>
}
