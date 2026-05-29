# mementos — engineering standards & working agreement

Instructions for any AI session working in this repo. Follow them exactly.

## On-disk format changes need a migration
mementos is published — users have vaults on disk that must keep working across
upgrades. When an on-disk format must change, ship a migration step in `mementos
migrate` (alongside storage/key/embedder migrations) so existing vaults can move
to the new format on update. Breaking changes that affect user vaults need a
major version bump (semver). In-memory shapes and internal interfaces remain
free to change without ceremony.

## Fail loud — no silent fallbacks
If something fails, it must fail, with a clear actionable error. Forbidden: a
`try/catch` that returns a default/null/empty and hides the failure; a `??`
default that masks a missing or broken config; a `?.` chain that swallows a
structural error. A fallback is acceptable only when "missing" genuinely means
"use this default" — and a comment must say so. A rare deliberate fail-soft
(e.g. the `retrieve` hook must never break the user's conversation) must be
explicit and justified in a comment. Default: throw.

## Performance, scale & data structures
- **Design for scale.** Assume the vault grows large (100k+ mementos, bulk
  ingest). Do not size for "small and simple" by default.
- **No O(n²) or worse.** Eliminate quadratic-or-worse algorithms entirely. If
  one is genuinely unavoidable, **stop and get explicit approval** before
  implementing it — explain why no better option exists.
- **Pick the structure from the access pattern.** Before implementing any
  non-trivial data structure or hot-path algorithm, write down its operations ×
  frequency × required complexity, then choose the structure that meets them;
  name the standard pattern if there is one (LRU/LinkedHashMap, index, …). Never
  anchor on a representation (e.g. "an array") before doing this analysis.
  "Less code" never overrides "right structure" for load-bearing code.
- **No duplicate structures kept in sync.** Two structures mirroring each other
  is a bug surface — derive one from the other, or make the ordering/index
  intrinsic to the single structure.

## Modularity — abstract real variation, hardcode nothing
- **No magic numbers or strings.** Every threshold, limit, path, interval, or
  tunable is a named constant. An inline literal is drift waiting to happen and a
  grep that won't find it. A module's tunables live in a sibling `constants.ts`,
  never inline in the implementation — `<name>/index.ts` holds logic,
  `<name>/constants.ts` holds its knobs. This is uniform: if one implementation of
  an abstraction has a `constants.ts`, they all do.
- **Keep the project layout uniform.** The same shapes everywhere: an abstraction
  implementation is `<abstraction>/<name>/index.ts` (+ `<name>/constants.ts` for
  its tunables); code shared across an abstraction's implementations lives in
  `<abstraction>/_utils/` — the folder is always named `_utils` (never `_helpers`
  or anything else); CLI subcommand handlers live in `cli/commands/`. Don't invent
  a new place or name for something the project already has a home for.
- **A real axis of variation becomes an abstraction.** mementos is built on
  auto-discovered abstractions — `src/<abstraction>/<name>/index.ts` exporting
  `type` + `create`. When behaviour genuinely varies (a storage backend,
  embedder, vector index, retriever, searcher, ingestor, integration), add an
  implementation in that pattern. Never a hardcoded `if (type === 'x')` branch
  or a baked-in behaviour in `core`.
- **But an abstraction must earn its place.** It needs a real, plausible second
  implementation. One implementation with no realistic second is not
  modularity — it is indirection with a cost, and the audit hunts exactly that.
  Abstract genuine variation; don't abstract speculatively.

## Code style — short functions, comments that earn their lines
- **Keep functions short.** If a function is 30+ lines but the actual work is
  ~10, it's hiding behind scaffolding — defensive checks that can't fire,
  explained intermediate variables, mid-function commentary, verbose error
  messages, premature private-method splits. Inline the work, drop the
  explanation. A linear 50-line function doing 50 things is fine; a 25-line
  function where 18 lines are guards / narration is the smell. The goal is
  reader-time-to-understanding, not LOC for its own sake.
- **No mid-function commentary that restates the code.** Names cover that.
  Forbidden: "we used to do X but now do Y" notes, audit-N references, commit
  hashes, "added for the X flow" / "used by Y" pointers — they all rot. Only
  add a comment when WHY is non-obvious (a hidden constraint, a workaround for
  a specific bug, a surprising invariant). If removing the comment wouldn't
  confuse a future reader, don't write it.
- **JSDocs can be multi-line, but every line earns it.** Function and interface
  contracts often need >1 line. Going past ~6-8 lines usually means rehashing
  audit history or restating the body — trim to the contract.
- **DRY across siblings: same shape, different names.** When 3+ places share
  the same shape and differ only in identifiers (sibling integrations'
  `readX`/`writeX`, multiple `metaById.values()` filter+project walks, the
  one-shot CLI handlers' `try { … } finally { vault.close() }`), extract the
  shape into a shared helper. Two callers may be coincidence; three is a
  pattern. Don't extract for one caller.
  - **Exception: two-of-an-abstraction is a pattern, not coincidence.** When
    the duplication exists because each implementation of an auto-discovered
    abstraction (storage backend, embedder, searcher, retriever, integration,
    …) carries the same plumbing, treat it as ≥3 even at two siblings: every
    future implementation will pay the same duplication. The threshold is
    "this duplication is structural to the abstraction," not the current
    caller count. Place the helper under that abstraction's `_utils/`.

## Working style
- **Explain before implementing.** For any load-bearing or non-trivial change:
  describe the approach first — concrete example, the actual problem it solves —
  get approval, *then* write code. Do not batch many edits and commit without
  checkpoints.
- **Be concrete.** Name the real failure, give an example, say what changes —
  not just conclusions.
- **Report honestly.** Never present a bad result (regressed benchmark, failing
  test, skipped step) as fine. State it plainly.
- **Commit/push only when asked.** Commit messages: short (1–2 sentences), no
  `Co-Authored-By` trailer.
- Re-run and report the relevant benchmark before committing a change that
  affects retrieval or search quality.

## Environment
- **Do not install anything on this machine** — no global installs, no native
  builds on the host. If something must be installed to test, use Docker.
