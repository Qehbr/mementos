/**
 * Shared mementos skill content. One source of truth; each integration wraps it in
 * whatever envelope its client expects (plain `.md`, or YAML-frontmatter `SKILL.md`).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** mkdir+write the skill at `<dir>/<filename>`. Idempotent. */
export async function writeSkillFile(dir: string, filename: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, filename), body, 'utf8')
}

export const SKILL_BODY = `# Mementos — Memory Vault

You have access to an encrypted personal memory vault via MCP tools. It persists across
sessions, tools, and devices.

A **memento** is one logical memory. A **chronicle** is a past conversation — a set of
mementos imported together by \`mementos ingest\` or the snapshot hook.

## Recalling memories

At the start of each new conversation, call recall with a short description of what
you're about to work on. This surfaces relevant context before you begin.

Example: recall("TypeScript project architecture and coding preferences")

Do this before asking clarifying questions. The vault may contain exactly what you need.

Also call recall mid-conversation whenever you're about to make a decision that past
context might inform (tech choices, naming conventions, known pitfalls, user preferences).

## Recall vs. search

Two ways to find memories, for two different needs:

- **recall** — semantic search. "What do I know about X?" Finds memories by *meaning*,
  even when the wording differs. This is your default.
- **search** — exact-text search (present only when deep search is enabled). "Where does
  this *literal* string appear?" Use it for a specific error message, a code identifier,
  a file path, a UUID, an exact phrase — things semantic search misses. It returns short
  match snippets with surrounding context, not whole mementos; call get_memento for the
  full text of a hit that looks relevant.

If you know the exact string, use search; if you're describing a topic, use recall.

## When to write a memento

Good candidates:
- User preferences (coding style, tools, formatting, communication style)
- Architectural decisions and the reasoning behind them
- Project conventions and patterns that would otherwise need re-explaining
- Mistakes made and their root cause — so the same error is not repeated

Do NOT write:
- Transient facts ("user is currently debugging X") — these are only true for this session
- Things already covered by an existing memento — use update_memento instead
- Summaries of the conversation — mementos are facts, not notes

## How to write good mementos

- One fact per memento — do not combine unrelated things
- Be specific: "prefers tabs over spaces in TypeScript" not "has indentation preferences"
- Include the why when it matters: "uses Zustand over Redux — too verbose for this 2-person team"
- Before tagging, call get_tags to see what tags already exist — reuse them over inventing near-duplicates

## Tags

Prefer these standard tags when they fit. Only invent new ones when none of these match:

- \`user\`         — facts about the human you're talking to (name, role, communication style)
- \`preference\`   — what they like or want done a certain way (tabs over spaces, terse responses)
- \`decision\`     — an architectural or design choice and the reasoning behind it
- \`pitfall\`      — a mistake that was made, why it happened, how to avoid repeating it
- \`convention\`   — a project rule or pattern (file structure, naming, testing approach)
- \`project:<name>\` — scope a memento to one project; use the actual project name

A memento may carry multiple tags. Combine them: \`["user", "preference"]\`, \`["decision", "project:foo"]\`.

## Tags that mark a memento's origin

Mementos carry an auto-applied \`source:*\` tag when they came from somewhere other than your own \`write_memento\` calls during a live chat — the tag names the tool whose transcript was ingested or auto-snapshotted (for example \`source:claude-code\`, \`source:openclaw\`).

Mementos you write directly with \`write_memento\` have NO \`source:*\` tag. To surface only your direct writes (the user's curated knowledge, not bulk-imported chat history), exclude the ingested sources:

  recall("...", exclude_tags=["source:claude-code", "source:openclaw"])

Or scope recall to one specific source:

  recall("...", tags=["source:claude-code"])

## Handling the "Similar memento exists" warning

If write_memento returns a "Similar memento exists" warning, do not write a duplicate
AND do not just resend your new text via update_memento — the existing memento may be
richer than what you just produced (more context, more details, more specifics). Read
it first: call get_memento(<id>), merge your new information into the existing text,
then call update_memento(<id>, merged_text). Confirm with the user before discarding
anything from the original.

## Long mementos and stale updates

A memento longer than ~1600 characters is split into chunks internally. recall shows the
best-matching chunk and notes "(matched chunk N/M)" — call get_memento(memento_id) for the
full text.

If update_memento reports the memento changed since you read it, another device or agent
edited it first. Call get_memento again, re-apply your change to the current text, and retry.

## Tools

- \`get_tags()\` — list all tags in use with counts — call before tagging a new memento
- \`write_memento(text, tags?)\` — store a new memento
- \`recall(query, k?, tags?, exclude_tags?, chronicle_id?)\` — semantic search, optionally scoped by tags (include / exclude) or chronicle
- \`search(query, k?, regex?, ignore_case?, context_chars?, tags?, exclude_tags?, chronicle_id?)\` — exact-text / regex search returning match snippets; present only when deep search is enabled
- \`update_memento(memento_id, text)\` — replace a memento's text
- \`get_memento(memento_id)\` — fetch the full text of one memento
- \`delete_memento(memento_id)\` — delete one memento
- \`get_chronicle(chronicle_id)\` — read a whole past conversation in order
- \`list_chronicles()\` — list all imported conversations
- \`get_recent_mementos(limit?)\` — most recently written mementos
- \`get_mementos_in_range(start?, end?, query?, k?)\` — mementos in a date window
- \`sync()\` — pull the latest memories from storage now; call only when the user insists a memento exists but recall came up empty (it may have been written on another device)
`

/**
 * `SKILL.md` form — `SKILL_BODY` with the YAML frontmatter that the OpenClaw and Codex
 * skill loaders require (`name` must be hyphen-case and match the folder; `description` is
 * a single line). Claude Code reads `SKILL_BODY` directly — its skill file takes no
 * frontmatter — so it imports `SKILL_BODY`, not this.
 */
export const SKILL_MD = `---
name: mementos
description: Encrypted personal memory vault — recall past context and store durable facts via MCP tools.
---

${SKILL_BODY}`

