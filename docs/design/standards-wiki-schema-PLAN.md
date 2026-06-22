# AKM Standards — Final Implementation Plan (two separate features)

Status: build-ready. Supersedes the prior drafts and `docs/design/standards-wiki-schema-DRAFT-INPUT.md`.

## The central correction: these are TWO features, not one

Earlier drafts muddied **wiki schemas** and **stash standards** into a single "standards context" with a blended precedence stack. They are distinct features that fire on **mutually exclusive targets** and share almost nothing:

| | **Feature A — Wiki schema** | **Feature B — Stash standards** |
|---|---|---|
| Governs | pages **inside one wiki** | authoring of **stash assets** (skill/command/agent/fact/…) |
| Source of truth | `wikis/<name>/schema.md` (local to that wiki) | `fact` assets, scoped by `category` frontmatter |
| Fires when | edit target is **under `wikis/<name>/`** | edit target is a **non-wiki asset** |
| Content | pageKind, voice, citation/xref/contradiction policy | naming, tag vocabulary, frontmatter, per-type conventions |
| Scope | one wiki | whole stash |

A wiki-page edit and a stash-asset edit are **never the same target**. Global stash standards do **not** cascade into wikis (a wiki owns its schema; asset-naming/tag rules are irrelevant to a wiki page). There is therefore **no cross-feature precedence stack** — selection is by target type, full stop.

**Neither fires (empty `standardsContext`):** a wiki `raw/` file, a wiki infra file (`schema.md`/`index.md`/`log.md`) edited as itself, or a non-wiki asset when no `convention`/`meta` facts exist. A and B do not partition all targets — there is a safe third "no injection" bucket, and readers degrade to empty without error.

They share exactly one thing: a thin seam at the prompt boundary — one optional `standardsContext?: string` field. Each feature is independently shippable and independently valuable. **Recommended order: Feature A first** (smaller, self-contained, leans on existing wiki infra).

The guiding thesis for both: *surface the relevant rulebook to the agent at write-time so it stops inventing conventions.* Neither feature parses rules in its MVP — the doc bodies travel to the agent as prose. (Rule *parsing* exists only to let a machine *enforce* rules — that is lint, deferred §4.)

---

## Shared seam (built once, by whichever feature ships first)

- `prompts.ts` — add optional `standardsContext?: string` to `ReflectPromptInput` (`prompts.ts:153`) and `ProposePromptInput`; push it as a section **before** the "Current asset content" block (ahead of the guard at `prompts.ts:255`). NOTE: both dispatch routes (agent-file-write and direct-LLM-JSON) flow through the single `buildReflectPrompt` call (`reflect.ts:1052`; the branch is just the last `sections.push` at `prompts.ts:393`), so one `sections.push` reaches both — no separate wiring. Same single-builder shape for `buildProposePrompt`.

That is the whole overlap: one optional string field. No cap, no helper, no shared resolver, no rule model. Each feature's resolver returns a plain `string` (empty = inject nothing).

---

## Feature A — Wiki schema delivery

**Goal:** when an agent edits a file under `wikis/<name>/`, inject *that* wiki's `schema.md` **body** into the write-time prompt.

**Why it's small:** wiki infra already exists — `SCHEMA_MD`/`WIKI_SPECIAL_FILES` constants (`wiki.ts:61-68`), `resolveWikiDir`, the disk-read pattern in `readSchemaDescription` (`wiki.ts:281-296`). The only gap is that `readSchemaDescription` reads the frontmatter `description` and **discards the body** — yet the body *is* the rulebook (in `schema-template.md` the description is one sentence, line 2; the page contract / operations / hard rules are all body, lines 14-61).

**Build**
- `src/wiki/wiki.ts` — `export function loadWikiSchema(stashRoot, name): { body: string; frontmatter: Record<string,unknown> }`, beside `readSchemaDescription`, reusing `SCHEMA_MD` and the swallow-and-degrade read. Missing/malformed → empty body, never throws. Leave `readSchemaDescription` untouched (it's correct for `listWikis` summaries).
- Resolution: given an edit target, extract the wiki name from the path/ref (`extractWikiNameFromRef`, `wiki.ts:141`); if it's a wiki page (not `raw/`, not the special files themselves), `standardsContext = loadWikiSchema(name).body` (empty string otherwise). No cap, no wrapping — the body goes straight to the agent.
- Wire the call at the reflect assembly seam (`reflect.ts:983-985`) and in `propose.ts`.

**DoD**
- Editing `wiki:research/foo` injects `wikis/research/schema.md` **body** (not just the description); editing `wiki:product/foo` injects product's schema, never research's.
- Missing/malformed schema → no injection, no crash. No index rebuild needed.
- Test asserts injected text contains body-derived rules (a hard-rule line / the pageKind list), not merely the description string.
- `bun run check` green.

---

## Feature B — Stash authoring standards

**Goal:** when an agent creates/edits a **non-wiki** asset, inject the relevant `category: convention`/`meta` `fact` bodies so naming/tag/frontmatter conventions are followed.

**Why it builds cleanly on existing primitives:** `fact` already exists with `category` frontmatter (`personal|team|project|convention|meta`, `src/commands/lint/fact-linter.ts:9`) and nested refs are free (`facts/conventions/x.md` → `fact:conventions/x`, `asset-spec.ts:34-38`). Standards are just facts; this feature is **content + a small resolver + the shared prompt seam**.

**Build**
- `src/core/standards/resolve-stash-standards.ts` — `resolveStashStandards(stashRoot): string`: enumerate facts, select those with `category: convention`/`meta` by **frontmatter** (no path globbing, no index dependency), concatenate their **bodies** in stable enumeration order (each preceded by a one-line `# <ref>` header so the agent knows provenance). Returns `""` if none. No cap, no parsing, no rule objects, no warnings.
- Skip entirely when the target is a wiki page (that's Feature A's domain) — the two never both fire.
- Wire at the same reflect/propose seams.
- Scaffold a starter `facts/conventions/` / `facts/meta/` set (plural spelling matches `fact-asset-type.md:58`) as templates, authored as ordinary facts.

**DoD**
- Editing `skill:x` injects convention/meta fact bodies; editing a wiki page injects **none** of them.
- Facts selected by `category` frontmatter regardless of subdirectory; flat and nested layouts resolve identically.
- `bun run check` green.

---

## Decisions (apply to both features)

1. **Format** — rules are authored as fenced ` ```akm-standards ` (facts) / ` ```akm-wiki-schema ` (schema) blocks **in the markdown body**, co-located with their prose. Fully supported by akm's read paths (the prior "fenced = invisible" claim was false: `prompts.ts:376` preserves fenced content as "load-bearing"; `markdown.ts:128` "leaves inner code blocks intact"; the only fence-blanking is one broken-ref lint check, `src/commands/lint/base-linter.ts:253`). The MVP does **not parse** these blocks — they reach the agent as body text.
2. **Deliver bodies, not descriptions** — Feature A injects the schema body; `readSchemaDescription` stays for summaries only.
3. **No cap** — bodies are injected whole. Standards docs are small human-authored files; capping/truncation machinery is not worth its complexity. (If a stash ever grows standards large enough to crowd the prompt, per-type scoping — deferred §4 — is the fix, not a runtime cap.)
4. **Precedence is prompt prose** — at most the relevant doc(s) per feature, in order. No `layer: number` engine, no cross-feature stack.
5. **Direct edits allowed** — schema.md and standards facts are directly editable; not proposal-queue-locked.

---

## Deferred follow-ups (NOT built now)

| Deferred item | Belongs to | Build it when |
|---|---|---|
| Fenced-block parser + structured rule model — *if built, A parses `akm-wiki-schema` and B parses `akm-standards` into **separate** rule models; never one unified parser/store* | both | you build deterministic lint |
| pageKind lint (`WikiLintKind` + `severity` on findings, gate on `mode: closed`) | A | authors want CI to catch invalid pageKinds — the *first* lint to add (local, low-noise) |
| Global standards lint (tag-vocabulary / naming across assets) | B | only after pageKind lint proves the model; expect tuning, false-positives |
| TYPE_HINTS migration to `facts/conventions/assets/<type>.md` (+ FactLinter basename/category checks) | B | drift between built-in hints and authored conventions actually bites |
| — cheap alternative: resolver *also* includes an authored `fact:conventions/assets/<type>` body when present, **without** removing built-in `TYPE_HINTS` | B | you want per-type conventions now, with ~no new machinery |
| info-string-aware `stripFencedBlocks` (~10 lines, keeps refs inside `akm-*` blocks xref-validated) | both | a real standards doc references an asset inside a fenced block |
| Automated standards maintenance (improve pass) | both | manual editing + lint warnings prove insufficient against real usage data |

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Re-muddying the two features | Selection is by target type; the only shared code is the `standardsContext` prompt field. Each feature has its own resolver and DoD. |
| Under-building (description-only) | Feature A DoD requires a test asserting body-derived rules reach the agent. |
| Standards bodies bloat the prompt | Small in practice (human-authored schema/convention docs). No cap by choice; per-type scoping (deferred §4) is the trigger if they ever grow large. The existing stdin transport (`spawn.ts`) already handles oversized prompts. |
| Malformed schema/fact body | Readers degrade to empty, never throw; a doc with no fenced block is valid prose. |
| Scope creep back to the heavy plan | Deferred items stay out until a concrete trigger fires. |

---

## Owner decisions (resolved)

1. Body cap → **removed**; bodies injected whole (standards docs are small; scoping is the deferred fix if ever needed).
2. Direct edits → allowed.
3. Automated maintenance → cut; future follow-up only.
4. Complexity → MVP per feature is "load body → inject"; cap, parser, rule model, precedence engine, TYPE_HINTS migration, and all lint deferred.
5. **Wiki schema and stash standards are separate features** — separate resolvers, separate triggers, no blended precedence. Ship **Feature A first**.
