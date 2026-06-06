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

Mementos is an encrypted personal memory vault that persists across sessions, tools,
and devices. Use it to recall what the user has said or decided before, and to write
down durable facts (preferences, decisions, conventions, pitfalls) that future you
will want.

A **memento** is one logical memory. A **chronicle** is a past conversation — a set of
mementos imported together by \`mementos ingest\` or the snapshot hook.

## How to invoke mementos

Mementos exposes the same operations through two channels — pick whichever your
client supports:

- **MCP mode (preferred when available)**: call \`recall\`, \`write_memento\`,
  \`update_memento\`, \`get_tags\`, etc. as tools. The MCP server is registered
  when you see those tool names in your tool list.
- **CLI mode**: when there is no MCP server, run the same operations via shell:
  \`mementos recall "..."\`, \`mementos write "..." --tags=a,b\`,
  \`mementos update <id> "..." [--tags=a,b]\`, \`mementos tags\`, etc.
  The \`## Tools (MCP)\` and \`## CLI equivalents\` sections below show the
  one-to-one mapping.

Both channels hit the same vault. Examples in this skill use the MCP names for
brevity; the corresponding CLI form is at the bottom.

## Recalling memories

At the start of each new conversation, call recall with a short description of what
you're about to work on. This surfaces relevant context before you begin.

Example: recall("TypeScript project architecture and coding preferences")

Do this before asking clarifying questions. The vault may contain exactly what you need.

Also call recall mid-conversation whenever you're about to make a decision that past
context might inform (tech choices, naming conventions, known pitfalls, user preferences).

## Recall vs. search

Two ways to find memories, for two different needs:

- **recall** — semantic search. "What is known about X?" Finds memories by *meaning*,
  even when the wording differs. This is the default.
- **search** — exact-text search (present only when deep search is enabled). "Where does
  this *literal* string appear?" Use it for a specific error message, a code identifier,
  a file path, a UUID, an exact phrase — things semantic search misses. It returns short
  match snippets with surrounding context, not whole mementos; call get_memento for the
  full text of a hit that looks relevant.

If the exact string is known, use search; if the goal is to describe a topic, use recall.

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

## The memory index

The vault keeps ONE curated summary memento — the top-level view of what's in
this vault. The session-start hook loads it once per conversation under a
\`[MEMORY-INDEX]\` heading; re-read it any time with \`get_memory_index\` and
revise it with \`update_memory_index(text)\`. The id is resolved internally —
it never has to be tracked.

Format the body as a flat list — one durable fact per line, optionally with the
memento id when an entry points at a specific memento:

  - user: prefers tabs over spaces
  - project: mementos v1.0.1 published; next is the SessionStart hook work
  - decision: chose hybrid retriever over pure semantic — see <memento-id>
  - reference: bug board in Linear "INGEST"

When to update:
- After writing 2-3 related mementos, revise the index entry(s) that cover them.
- When a covered memento is deleted or its content shifts substantially.
- Keep it tight: never past ~30 lines. Compact entries that have stopped earning
  their slot — the index is signal, not history.

When NOT to update:
- For transient facts ("user is currently debugging X") — never go in the index.
- For one-off context you'd not write a memento for at all.

## Tags that mark a memento's origin

Mementos carry an auto-applied \`source:*\` tag when they came from somewhere other than a direct \`write_memento\` call during a live chat — the tag names the tool whose transcript was ingested or auto-snapshotted (for example \`source:claude-code\`, \`source:openclaw\`).

Mementos written directly with \`write_memento\` have NO \`source:*\` tag. To surface only direct writes (the user's curated knowledge, not bulk-imported chat history), exclude the ingested sources:

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

## Tools (MCP)

- \`get_tags()\` — list all tags in use with counts — call before tagging a new memento
- \`write_memento(text, tags?)\` — store a new memento
- \`recall(query, k?, tags?, exclude_tags?, chronicle_id?)\` — semantic search, optionally scoped by tags (include / exclude) or chronicle
- \`search(query, k?, regex?, ignore_case?, context_chars?, tags?, exclude_tags?, chronicle_id?)\` — exact-text / regex search returning match snippets; present only when deep search is enabled
- \`update_memento(memento_id, text, tags?)\` — replace a memento's text and optionally its tags (omit tags to keep them, pass [] to clear)
- \`get_memento(memento_id)\` — fetch the full text of one memento
- \`delete_memento(memento_id)\` — delete one memento
- \`get_chronicle(chronicle_id)\` — read a whole past conversation in order
- \`list_chronicles()\` — list all imported conversations
- \`list_mementos(start?, end?, query?, k?)\` — list mementos by recency, optionally bounded by a date window and/or ranked by a query (no args = most recent)
- \`get_memory_index()\` — re-read the curated index memento
- \`update_memory_index(text)\` — revise the curated index memento (id is internal)
- \`sync()\` — pull the latest memories from storage now; call only when the user insists a memento exists but recall came up empty (it may have been written on another device)

## CLI equivalents

Every MCP tool has a matching shell command, so when the MCP server isn't
registered on this client you can still drive the vault via shell:

- \`mementos recall <query> [--k=N] [--tags=a,b] [--exclude-tags=a,b] [--chronicle=id]\` — same as \`recall\`
- \`mementos write <text> [--tags=a,b]\` — same as \`write_memento\` (multi-line via piped stdin: \`echo "text" | mementos write\`)
- \`mementos update <id> <text> [--tags=a,b]\` — same as \`update_memento\` (multi-line via piped stdin)
- \`mementos tags\` — same as \`get_tags\`
- \`mementos get <id>\` — same as \`get_memento\`
- \`mementos chronicle <id>\` — same as \`get_chronicle\`
- \`mementos chronicles\` — same as \`list_chronicles\`
- \`mementos list [tag1 tag2 ...] [--tags=a,b] [--start=...] [--end=...] [--query=...] [--k=N]\` — same as \`list_mementos\` (positional tags = back-compat tag filter)
- \`mementos index [<text>]\` — same as \`get_memory_index\` (no text) or \`update_memory_index\` (text via positional or piped stdin)
- \`mementos delete <id>\` — same as \`delete_memento\`
- \`mementos search <query> [--regex] [--k=N] [--context=N] [--case-sensitive]\` — same as \`search\`
- \`mementos sync\` — same as \`sync\`

The CLI and MCP paths share the same vault; an id printed by \`mementos write\`
can be passed straight to the MCP \`update_memento\` tool (and vice versa).
`

/**
 * `SKILL.md` form — `SKILL_BODY` with the YAML frontmatter every Agent-Skills-compliant
 * client requires (`name` must be hyphen-case and match the folder; `description` is a
 * single line that tells Claude what the skill does AND when to use it).
 *
 * Claude Code, Codex, OpenClaw, Antigravity all follow the same `<dir>/<name>/SKILL.md`
 * layout in 2026 — see https://code.claude.com/docs/en/skills.
 */
export const SKILL_MD = `---
name: mementos
description: Encrypted personal memory vault — recall past context and store durable facts across conversations and devices. Use at the start of a conversation to surface relevant context, whenever the user mentions a preference, decision, project convention, or mistake worth remembering, and whenever an answer would benefit from past architectural decisions, naming conventions, or known pitfalls.
---

${SKILL_BODY}`

