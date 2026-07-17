# Chunk 2 — execution ledger (append-only)

Per-format adapters (10 adapters, 14 formats). Central Wave-2 chunk; purely
additive (globals stay until Chunk 3). Branch:
`claude/akm-architecture-refactor-fubvd7`.

## Opened — grounding census + brief

- `anchors.md`: the 10-adapter split (§A, a proposal for sign-off — parity-
  preserving, NOT the spec §4 aspirational okf registry), per-adapter porting
  anchors (§B recognize/placeNew/directoryList/validate/presentation), the
  special cases (§C skill Agent Skills, env/secret redaction, workflow two-form,
  the 9 metadata contributors), conformance mechanics (§D), parity vs the Chunk
  0b goldens (§E), registration + cycle (§F), 8 findings + proposed WI split.
- `brief.md`: WI-2.1..2.6, decisions D2-1..7, cycle-safety watch, 7-item traps.

### Decisions recorded (MAINTAINER REVIEW — made autonomously overnight)
- D2-1 the 10-adapter split (transitional parity-preserving: skill/wiki/script/
  workflow/task/dotenv[env+secret]/knowledge/agent-tooling[command+agent]/
  memory/note[lesson+session+fact]) — NOT the spec §4 okf registry (would break
  parity). Flagged for sign-off.
- D2-2 new core/adapter/registry.ts (asset-registry-modeled; additive).
- D2-3 validate() required but behavior-preserving (no new validation where none
  exists today; the reachability gap is preserved).
- D2-4 redaction port = renderer field-omission only, NOT core/redaction.ts.
- D2-5 skill Agent Skills contract (§4.5) = new feature, isolated WI-2.5, flag
  behavior changes.
- D2-6 per-adapter looksLikeRoot + new single-adapter golden-root fixtures.
- D2-7 the 9 index-time metadata contributors move into recognize.

## WI-2.1 — registry + skill/wiki/script adapters (Sonnet impl; Opus review, all 6 gates re-verified independently)

Landed the registry pattern + the 3 most self-contained adapters. Additive only
(no live global touched). Files: `src/core/adapter/registry.ts`,
`src/core/adapter/adapters/{index,shared,skill-adapter,wiki-adapter,script-adapter}.ts`,
`src/core/type-presentation.ts` (additive `rendererName?` field),
`tests/core/adapter/{registry,looks-like-root,skill,wiki,script}-adapter*.test.ts`
+ `_helpers/validate-context.ts`, `tests/fixtures/stashes/{skill,wiki,script}-only-root/`.

### Gates (Opus re-ran each un-piped, exit codes verified — not trusting the worker's report)
- `bunx tsc --noEmit` → exit 0.
- `bun scripts/lint-import-cycles.ts` → 18 (baseline, unchanged). No new participant:
  `shared.ts` COPIES base-linter check logic to a leaf and builds its ref-type
  alternation from `KNOWN_TYPES` (import-free sink) rather than importing
  `getAssetTypes()`/`base-linter.ts` (which would pull `output/renderers.ts` /
  `commands/lint` edges into `core/adapter/` — a 19th participant).
- `bun run lint` → exit 0 (biome + all custom lints; goldens-presence 58 intact).
- `bun test tests/core/adapter` → 45 pass / 0 fail.
- Live goldens (`goldens-recognition-placement` + `goldens-lint-output` +
  `goldens-renderer-output`) → 19 pass / 0 fail (live path unchanged — confirms additive).

### NEW binding decision — D2-8 (root convention) — MAINTAINER REVIEW, load-bearing
The worker resolved an ambiguity the brief left open, and it now governs every
remaining WI + Chunk 3's wiring, so it is pinned here explicitly:

- **A component's `c.root` (what `scanComponent` walks, what `recognize`/`placeNew`
  see relative paths against) = the type's own stash SUBDIRECTORY** (e.g. the skill
  component roots at `<stash>/skills`, not `<stash>`). This aligns with the spec's
  "one adapter per root, no per-file competition": each adapter only ever sees its
  own subtree, never competes over foreign files.
- **`directoryList()` / `looksLikeRoot(root)` operate at the STASH-root granularity**
  (install-time probe + git-stash pathspecs, which are repo-root-relative): they
  return/probe the stash-relative subdir NAMES (`["skills"]`, `exists(root/skills)`).
  The bridge is: *directoryList names the stash subdirs that BECOME component roots
  when mounted.* So `directoryList()` is deliberately NOT "dirs relative to `c.root`"
  — the two methods legitimately use two different roots (component-mount root vs.
  install/stash root). Documented so WI-2.2..2.6 don't "fix" the apparent mismatch.
- **Consequence flagged for sign-off:** under this model `wikiAdapter.recognize`
  becomes purely POSITIONAL (`.md` + `ancestorDirs.length >= 1`, "nested ≥1 level
  under my mount root") — it drops the legacy `classifyByWiki` "ancestor named
  `wikis`" identity marker, because once mounted AT `wikis/` that segment is no
  longer visible in the relative path. This is a faithful translation of the legacy
  "`wikis/<space>/<page>.md`, not `wikis/<page>.md`" rule GIVEN the subdir mount, and
  type/conceptId parity holds against the recognition golden. But it means the wiki
  adapter cannot self-distinguish a wiki page from any other type's one-level-nested
  file if it were ever handed a foreign file — isolation is enforced by MOUNTING, not
  `recognize()`. The `looks-like-root` conformance gate verifies the mounting-level
  isolation instead. If the maintainer prefers identity-based recognition (robust to
  a whole-stash single-component mount), Chunk 3 would need to root components at the
  stash and re-add the `wikis`/`skills`/`scripts` ancestor checks; that is a
  reversible Chunk-3 decision, not blocked by this WI.

### Other flagged sub-decisions (all documented in the file headers too)
- **Registry `types` extension:** `registerAdapter(a, types = [a.id])` — a second arg
  the brief's literal signature omitted, needed because `BundleAdapter` carries no
  owned-types field yet multi-type adapters (dotenv/agent-tooling/note) need a
  `type -> adapter` reverse lookup. No-op for WI-2.1's three 1:1 adapters.
- **`rendererName?` on `Presentation`** (`type-presentation.ts`): presentation NAMING
  only (matches `TYPE_TO_RENDERER` + the recognition golden byte-for-byte for
  skill/wiki/script); no `buildShowResponse` fn ported (no interface hook; renderer-
  output parity is not in WI-2.1's gate). The other 11 types stay `undefined` for
  later WIs. That file's own header invited this extension.
- **Deferred metadata contributors (D2-7 tension):** `toc-metadata` (wiki) and
  `script-comment-metadata` (script) were NOT folded into `recognize()` — `IndexDocument`
  has no field to carry TOC/heading data, and the comment-description helper lives in
  a cycle-adjacent module (`indexer/passes/metadata.ts`). The recognition golden pins
  only `{type, specificity, renderer, meta?}`, none of which is contributor output, so
  D2-7's "fold contributors in" is an OVERREACH relative to what the golden actually
  gates for these two. WI-2.4 (memory/note, which DO have carriable frontmatter
  contributors) is where folding genuinely bites; re-scope D2-7 there.
- **`missing-skill-md` port** (skill validate): the legacy directory-level
  `SkillLinter.lintDirectory` is ported as a per-change-dir, deduped check via
  `ctx.readFile` (read-only, per the `validate` MUST-NOT-touch-FS contract). Latent
  edge (NOT fixture-exercised, flagged): a change at a NESTED path inside a skill
  bundle (`<skill>/sub/doc.md`) checks `<skill>/sub/SKILL.md` and could FALSE-flag
  missing-skill-md even when `<skill>/SKILL.md` exists. Legacy checks only the
  immediate skill dir. WI-2.5 (skill's §4.5 pass) should tighten to the skill-bundle
  root dir. Behavior-preserving for flat skill bundles (the only shape the fixture +
  goldens exercise).
- **`fixed` always `false`** in ported base checks: `validate()` is read-only (no
  `--fix` apply path at this layer). Doesn't affect parity (golden fixtures are
  lint-clean, no `fixed:true` entries).
- **Base-check simplifications** (`shared.ts`): fence-strip is same-intent (not
  byte-identical to `markdown-insertion.ts`'s table/HTML-aware version); the
  `refs:`-frontmatter authoritative-list carve-out (memory/session-specific) is NOT
  ported — WI-2.4 extends it. Neither is exercised by skill/wiki/script fixtures.

## WI-2.2 — workflow + task adapters (Sonnet impl; Opus review + one correction, all gates re-verified)

Landed the two YAML-adjacent adapters. Additive only. Files: new
`src/core/adapter/adapters/{workflow-adapter,task-adapter}.ts`,
`tests/core/adapter/{workflow,task}-adapter.test.ts`,
`tests/fixtures/stashes/{workflow-only-root,task-only-root,workflow-non-workflow-md}/`;
additive edits `src/core/adapter/types.ts` (new `IndexDocument.rendererName?`),
`src/core/adapter/adapters/index.ts`, `src/core/type-presentation.ts`
(`workflow.rendererName = "workflow-md"`), `tests/core/adapter/{looks-like-root,registry}.test.ts`.

### Gates (Opus re-ran each un-piped AFTER the correction below)
- `bunx tsc --noEmit` → 0. `bun scripts/lint-import-cycles.ts` → 18 (unchanged; the
  new `core/adapter → workflows/parser` + `→ workflows/program/project` value imports
  add no participant). `bun run lint` → 0. `bun test tests/core/adapter` → 67/0.
  Live goldens (recognition-placement + lint + renderer) → 19/0.

### The renderer wrinkle — resolved (additive `IndexDocument.rendererName?: string`)
workflow is ONE type with TWO renderers (`workflow-md` + `workflow-program-yaml`), but
WI-2.1's `TYPE_PRESENTATION.rendererName` is per-TYPE. Resolved by a new optional
per-DOCUMENT `IndexDocument.rendererName` set in `recognize()` per form — the exact
`BundleAdapter`-shaped analog of how legacy `workflowProgramMatcher` names its renderer
directly on the per-file `MatchResult` rather than via the type-keyed lookup. Additive,
no existing consumer reads it, cross-asserted against the recognition golden's `renderer`
field for BOTH forms. `TYPE_PRESENTATION.workflow.rendererName = "workflow-md"` (the
type-level default/primary form). This is the smallest mechanism preserving both names.

### OPUS CORRECTION — workflow Form A recognition made POSITIONAL (parity regression fix)
The worker's Form A (`.md`) recognition gated on `looksLikeWorkflow(content)` — a
self-flagged "deliberate divergence" from the D2-8 positional precedent. **Opus review
caught this as a parity regression against the legacy matcher and corrected it in the
review pass** (standing defect-fix directive; firm understanding from reading
`matchers.ts:62-66` at HEAD):
- The legacy `workflows` dir-hint rule is `test: (ext) => ext === ".md"` — PURE
  positional. It already classifies EVERY non-README `.md` under `workflows/` as type
  `workflow`. `looksLikeWorkflow` (specificity 19) is a SEPARATE, higher-specificity
  matcher whose role in the legacy WHOLE-STASH walk was to claim workflow-shaped `.md`
  OUTSIDE `workflows/` and win cross-type ties — a role that D2-8's mount-based routing
  (component root scopes the adapter to `workflows/`, no per-file competition) REPLACES.
- Gating recognize() on `looksLikeWorkflow` therefore UNDER-recognized (silently dropped
  plain `.md` under `workflows/` that legacy calls `workflow`) and made workflow the lone
  content-gated exception among the positional dir-scoped adapters (wiki/task/script).
- Fix: `isWorkflowMdFile` = `ext === ".md" && !isTypedDirDocFile` (positional, matching
  the dir-hint + D2-8). Removed the now-unused `looksLikeWorkflow` import (kept
  `parseWorkflow`, still used by validate's `invalid-workflow-structure`). Rewrote the
  file header's Form-A section + flipped the `workflow-non-workflow-md` negative test to
  assert the correct positional behavior (a plain-prose `.md` under `workflows/` IS
  claimed as `workflow`; validity is validate()'s job, not recognize()'s). Root cause
  partly mine: the WI-2.2 dispatch said "port looksLikeWorkflow's body probe" — imprecise;
  the faithful port under D2-8 is the dir-hint floor.
- Note: this only changes the untested-edge region; the fixture parity was unaffected
  either way (the golden's workflow.md is a real workflow), and the adapter carries no
  `specificity` field, so the golden's captured specificity (19) is irrelevant to parity.

### Form B (`.yaml`/`.yml`) validate — no diagnostics, deliberately (reachability gap preserved)
The lint golden's `perType.workflowProgramYaml` is `{correctnessCheck: "parseWorkflowProgram",
result}`, NOT `{issues}` — there is no `Diagnostic[]` shape to reproduce, and legacy
`WorkflowLinter` never sees `.yaml` in production (`collectMarkdownFiles` filters `.md`).
Adapter produces zero diagnostics for `.yaml`/`.yml`, preserving the gap per anchors §E.2
(don't "fix" reachability this chunk). The parity test reproduces `parseWorkflowProgram`'s
result directly (the golden's own capture mechanism), not through validate(). Flagged.

### Metadata contributors — workflow DEFERRED, task FOLDED (refined-D2-7 in action)
- workflow's 2 contributors NOT folded (three independent reasons): recognition golden
  pins no contributor output; `workflow-document-metadata` calls `cacheWorkflowDocument`
  (a DB-cache side effect illegal in a pure read-only recognize); `entry.parameters` has
  no carrying `IndexDocument` field.
- task's `applyTaskMetadata` FOLDED (verified byte-faithful to output/renderers.ts:764-780):
  `tags` unconditionally gains `task`/`scheduled`; `searchHints` gains
  `schedule:`/`workflow:`/`prompt:` for present fields. Worker correctly followed the ACTUAL
  contributor (tags+searchHints, NO description) over the WI-2.2 brief's imprecise
  "name/description" paraphrase.
