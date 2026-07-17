# Chunk 0b — grounding census (anchors)

Censused at HEAD `3c178568` (chunk 9 closed — WI-9.11, "4 gates verified, full
check green"), 2026-07-17, by direct read-only inspection (every anchor below
opened at this HEAD; none trusted from the plan). Authority: manifest chunk id
"0b" (scope + 5 gates) and chunk id "8" (0b's consumer — re-key merge,
orphan quarantine, rc-train FROM-state); plan lines 44 (drift-detail bullet),
80 (adapter-capability table), 178 (§4.3 REPLACE row), 436 (§11 chunk-0b
sentence), 450 (§11 Chunk 0b paragraph), 466 (§11 Chunk 8 paragraph), 515–520
(§12.3 golden/re-key-merge contract tests), 532 (§12.4 line-drift risk); plan
§3.1–3.4 (identity/re-key/cutover/throwaway-migrator) for Section E.

**Wave state at this HEAD**: Wave 1 (Chunks 0a, 7, 6, 9) is closed per the
manifest's execution order; Wave 2 (0b, 1, 1.5, 2, 3, 4, 5, 6.5, 8, 10) has
not started. Confirmed by direct probes: no `src/migrate/` directory, no
`BundleAdapter` interface, no `legacy_state` table, `asset-ref.ts` closed-union
guards (`isAssetType`, `TYPE_ALIASES`) still intact — Wave 2 genuinely hasn't
touched anything yet. Several Wave-1 chunk-9 work items materially changed the
plan's own anchors (RunContext threading, config schema shape, cycle kills);
those are captured in Section A because they change what a Chunk-1/2/5 author
will find, even though they are chunk-9's work, not 0b's.

---

## A. Line-drift re-anchoring (§12.4 — the manifest's #1 flagged risk)

### A.1 Re-measured anchors

| Symbol | Plan-stated | ACTUAL @ HEAD | Drift |
|---|---|---|---|
| `classifyBySmartMd` | `matchers.ts:181-222` (plan's own re-anchor, line 44) | `src/indexer/walk/matchers.ts:181-223` | **0** (plan's re-anchor is correct; end-line off by 1, immaterial — dir is `indexer/walk/`, not bare `indexer/`) |
| `classifyByWiki` | `matchers.ts:251` | `src/indexer/walk/matchers.ts:251` | **0** |
| `wikiMatcher` | `matchers.ts:296` | `src/indexer/walk/matchers.ts:296` | **0** |
| `file-context.runMatchers` specificity contest | `file-context.ts:242-265` | `src/indexer/walk/file-context.ts:242-265` | **0** (same dir-move note) |
| `deriveCanonicalAssetNameFromStashRoot` — definition | not given by plan | `src/core/asset/asset-spec.ts:338-353` | n/a (plan never anchored the def, only call sites) |
| `deriveCanonicalAssetNameFromStashRoot` — call site 1 | `mv-cli.ts:769` | `src/commands/mv-cli.ts:739` | **−30** |
| `deriveCanonicalAssetNameFromStashRoot` — call site 2 | `mv-cli.ts:1266` | `src/commands/mv-cli.ts:1239` | **−27** |
| `processSession` | `extract.ts:550`, "19 positional args" | `src/commands/improve/extract.ts:738-741` | **+188 lines; ARG SHAPE CHANGED** — now 2 params `(runCtx: ExtractSessionRunCtx, session: ExtractSessionInput)`. Chunk 9's own §10.7 THREAD item ("`processSession` (19 positional args) → RunContext") is DONE — but threaded into a bespoke 16-field `ExtractSessionRunCtx` (extract.ts:639-665), not the minted `RunContext` directly (a narrower per-session carrier built from one `createRunContext()` call at extract.ts:1416). Not a defect, just: grepping for "19 positional args" or the old signature will find nothing. |
| `stepLlm` | `connection.ts:185` (chunk-9's own pre-work figure) | `src/setup/steps/connection.ts:194` | +9 |
| `stepSmallModelConnection` | `connection.ts:455` (plan line 532; chunk-9 pre-work figure) | `src/setup/steps/connection.ts:357` | **−98** |
| `stepAgentConnection` | `connection.ts:733` (chunk-9 pre-work figure) | `src/setup/steps/connection.ts:515` | **−218** |
| `connection.ts` file size | 940 LOC (chunk-9 pre-work) | 701 LOC | **−239**. Decomposed by LOC but NOT into the plan's named `collectInput`/`probe`/`deriveConfig` sub-passes — still 4 top-level exported functions (`stepOllama:42`, `stepLlm:194`, `stepSmallModelConnection:357`, `stepAgentConnection:515`); no functions by those three names exist anywhere in `src/setup/`. |
| `rekeyStateDbForMove` — definition | `mv-cli.ts:928` (plan §3.2) | `src/commands/mv-cli.ts:898` | −30 |
| `rekeyStateDbForMove` — call site | `mv-cli.ts:957` (plan §3.2) | `src/commands/mv-cli.ts:1034` | +77 (plan's two citations were def+nearby-line at old HEAD; now def and the one call site are further apart) |
| `asset-ref.ts` `isAssetType` guard | `:109` | `src/core/asset/asset-ref.ts:109` | **0** (Wave-2 untouched, as expected) |
| `asset-ref.ts` `TYPE_ALIASES` | `:25-27` | `src/core/asset/asset-ref.ts:25` (map literal starts here) | **0** |
| `db-search.ts` scored-path filter block | `:483-530` (§4.3) | `src/indexer/search/db-search.ts:505-534` (`sourceFiltered`→`selected`) | +22/+4 |
| `db-search.ts` enumerate-path filter block | `:607-637` (§4.3) | `src/indexer/search/db-search.ts:610-638` | +3/+1 |
| `buildWhyMatched` | `:837` (§14.2 A2, unmoved — Chunk 5 target) | `src/indexer/search/db-search.ts:837` | **0** |
| `metadataRankingContributor` | `:292` (§14.2 chunk-9 pre-work, unrelated chunk) | `src/indexer/search/ranking-contributors.ts:288` | −4 |
| `core/eval/rank-metrics.ts` | plan target: relocate to `scripts/akm-eval` (§13.1, Chunk 9) | **GONE from `src/`** — canonical now `scripts/akm-eval/src/rank-metrics.ts` (186 LOC); `scripts/akm-eval/src/curate-metrics.ts` is now an 8-line re-export shim (`export * from "./rank-metrics"`) | Chunk 9 fold-in landed; anyone writing a 0b golden that imports rank-metrics must import from `scripts/akm-eval/src/rank-metrics.ts`, not `src/core/eval/*` (path no longer exists). |

### A.2 config-schema re-measurement (manifest: "re-measure config-schema before sizing")

- `src/core/config/config-schema.ts` = **1410 LOC** at HEAD. Plan's original figure: 1415. Chunk-9's own pre-work census (chunk-9/anchors.md B.1, at HEAD `365f5b09`): 1267 LOC / 216 `.optional()` / 3 `.default()`.
- At THIS HEAD: **1410 LOC / 216 `.optional()` / 3 `.default()`** — LOC grew **+143** since chunk 9's pre-work measurement while the optional/default counts are UNCHANGED. Cause: chunk 9's WI-9.6 added 9 new named per-process schema consts (below) that reuse the same field-object spreads rather than adding new `.optional()` wrappers.
- **"Per-process discriminated schemas" (§10.2) landed, but not as `z.discriminatedUnion`.** Zero literal `discriminatedUnion` calls exist anywhere in the file. Instead: 9 separate named `z.object({...IMPROVE_PROCESS_BASE_FIELDS, ...<PROCESS>_FIELDS}).passthrough().superRefine(checkRetiredProcessKeys)` schemas — `ReflectProcessConfigSchema:604`, `DistillProcessConfigSchema:610`, `ConsolidateProcessConfigSchema:616`, `MemoryInferenceProcessConfigSchema:622`, `GraphExtractionProcessConfigSchema:628`, `ExtractProcessConfigSchema:634`, `ValidationProcessConfigSchema:640`, `TriageProcessConfigSchema:646`, `ProactiveMaintenanceProcessConfigSchema:652` — composed into an object map `ImproveProfileProcessesSchema:657-668` (keyed `reflect`/`distill`/`consolidate`/`memoryInference`/`graphExtraction`/`extract`/`validation`/`triage`/`proactiveMaintenance`, each `.optional()`). The WIDE `ImproveProcessConfigSchema:588-601` (the old monolith) **intentionally stays** — documented in a comment block at `:319-330` as backing the generic `ImproveProcessConfig` TS type two dynamic-process-name call sites need, plus two existing tests. **Grepping `discriminatedUnion` to verify this chunk-9 gate finds nothing; grep `ProcessConfigSchema` instead.**
- Reserved-knob dispositions re-verified at this HEAD: `pushOnCommit` still present as a no-op `.optional()` stub at `:746` (CLI warn-and-ignore path retained, matches chunk-9 anchors B.1 "0.10 removes"); `GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED` is **gone** — a comment at `:933` ("the prior GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED") confirms the adapter-metadata-sourced replacement landed.

---

## B. The 14 formats — output producers to snapshot

The "14 formats" are the `ASSET_SPECS_INTERNAL` keys (`src/core/asset/asset-spec.ts:129-259`) — identical set to the `TYPE_TO_RENDERER` keys (`src/core/asset/asset-registry.ts:21-36`): **skill, command, agent, knowledge, workflow, script, memory, env, secret, wiki, lesson, task, session, fact**. Both registries independently enumerate the same 14 — confirmed, no drift from the plan's count.

### B.1 Per-format producer table

| Type | stashDir | Recognize (file:line) | Placement (`toAssetPath`, same file) | Renderer name / file:line | Lint |
|---|---|---|---|---|---|
| skill | `skills` | `classifyByExtension`/`matchDirectoryHint` (SKILL.md filename check) — matchers.ts:133,152 | asset-spec.ts:138 (`<typeRoot>/<name>/SKILL.md`) | `skill-md` — output/renderers.ts:204 | `SkillLinter` — lint/skill-linter.ts:25 (`types:["skills"]`) |
| command | `commands` | dir-hint `.md` — matchers.ts:48-51 | markdownSpec (asset-spec.ts:89) | `command-md` — output/renderers.ts:225 | `CommandLinter` — lint/command-linter.ts:21 |
| agent | `agents` | dir-hint `.md` — matchers.ts:53-56 | markdownSpec | `agent-md` — output/renderers.ts:250 | `AgentLinter` — lint/agent-linter.ts:21 |
| knowledge | `knowledge` | dir-hint `.md` — matchers.ts:58-61; ALSO the `classifyBySmartMd` fallthrough target (:222) for any unmatched `.md` | markdownSpec | `knowledge-md` — output/renderers.ts:322 | `KnowledgeLinter` — lint/knowledge-linter.ts:15 |
| workflow | `workflows` | dir-hint `.md` (matchers.ts:63-66) + `looksLikeWorkflow` body probe inside `classifyBySmartMd` (:198-200) + `classifyByWorkflowProgram` for `.yaml`/`.yml` (:242-249) | workflowSpec (asset-spec.ts:63) | `workflow-md` — workflows/renderer.ts:64; **+ second renderer** `workflow-program-yaml` — workflows/renderer.ts:98 (name const `WORKFLOW_PROGRAM_RENDERER_NAME` at workflows/program/project.ts:26) | `WorkflowLinter` — lint/workflow-linter.ts:20 |
| script | `scripts` | `classifyByExtension` (`SCRIPT_EXTENSIONS`) — matchers.ts:156-158; dir-hint matchers.ts:43-46 | scriptSpec (asset-spec.ts:123) | `script-source` — output/renderers.ts:396 | none dedicated — falls to `DefaultLinter` |
| memory | `memories` | dir-hint `.md` — matchers.ts:68-71 | markdownSpec | `memory-md` — output/renderers.ts:376 | `MemoryLinter` — lint/memory-linter.ts:17 (`types:["memories"]`) |
| env | `env` | dir-hint (filename `.env`/`*.env`) — matchers.ts:78-81 | asset-spec.ts:172 (`.env`→`default`, `<name>.env`→`<name>`) | `env-file` — output/renderers.ts:450 | none dedicated |
| secret | `secrets` | dir-hint (any file except `.lock`/`.sensitive`) — matchers.ts:83-89 | asset-spec.ts:192 (identity path) | `secret-file` — output/renderers.ts:479 | none dedicated |
| wiki | `wikis` | `classifyByWiki` — matchers.ts:251 (`.md` under a `wikis` ancestor dir) | markdownSpec | `wiki-md` — output/renderers.ts:332 | none dedicated |
| lesson | `lessons` | dir-hint `.md` — matchers.ts:73-76 | markdownSpec | `lesson-md` — output/renderers.ts:352 | `DefaultLinter`, explicitly keyed `"lessons"` — lint/registry.ts:39 |
| task | `tasks` | dir-hint (`.yml`) — matchers.ts:90-97 (see note below the table) | asset-spec.ts:226 (`<name>.yml`) | `task-yaml` — output/renderers.ts:499 | `TaskLinter` — lint/task-linter.ts:23 |
| session | `sessions` | dir-hint `.md` — matchers.ts:100-103 | markdownSpec | `session-md` — output/renderers.ts:524 | none dedicated |
| fact | `facts` | dir-hint `.md` — matchers.ts:109-112 | markdownSpec | `fact-md` — output/renderers.ts:575 | `FactLinter` — lint/fact-linter.ts:21 |

`DIR_TYPE_MAP` (matchers.ts:41-113) covers 12/14 types by directory rule; `skill` is a filename special-case (`SKILL.md`, matchers.ts:133,152) and `wiki` is the dedicated `classifyByWiki` (matchers.ts:251) — both excluded from `DIR_TYPE_MAP` deliberately (skill needs the exact filename in any nested dir; wiki needs the `wikis` ancestor check, and its dir literal `wikis` is NOT in `DIR_TYPE_MAP` to avoid double-claiming with `classifyBySmartMd`).

**Note on the `task` row (post-WI-0b.1 correction):** this table's `task` row reads `.yml`, and at capture HEAD (`b8fbc3a9`) that was a **census transcription error** — the code at that HEAD actually tested `test: (ext) => ext === ".md"` (a stale rule left over from the pre-0.8.0 markdown task format; every other consumer — asset-spec, asset-registry, renderers, task-linter — was updated for the `.yml` migration but this matcher was missed). That meant `tasks/*.yml` never recognized: `runMatchers()` returned `null` for every task file, `akm show task:<name>` threw "unrecognized layout", the flat indexer silently dropped tasks, and the `task-yaml` metadata contributor was dead code. Per the maintainer's "fix now in 0b" decision, **WI-0b.1 fixed `matchers.ts`'s `tasks` `DIR_TYPE_MAP` rule to test `ext === ".yml"`** (matchers.ts:90-97), so the table's `.yml` claim is now true of the actual code, not just the doc. `tests/fixtures/stashes/all-types/MANIFEST.json`'s task note and `tests/integration/file-context.test.ts` were updated to match.

### B.2 Split-brain renderer/action confirmed (§2.3 gap-fill)

Cross-checked against HEAD: **8 types carry `rendererName`/`actionBuilder` directly in `asset-spec.ts`** (workflow:149-150, env:176-178, secret:193-195, wiki:200-201, lesson:212-213, task:230-231, session:241-243, fact:256-257) — matches the plan's "8" exactly. **The other 6 (script, skill, command, agent, knowledge, memory) get their renderer/action ONLY from the static `asset-registry.ts` `TYPE_TO_RENDERER`/`ACTION_BUILDERS` maps** (`:21-58`) — confirmed by reading `markdownSpec` (asset-spec.ts:89-122) and `scriptSpec` (asset-spec.ts:123-127), neither of which sets `rendererName`/`actionBuilder`, and `skill`'s literal object (asset-spec.ts:130-139) has neither field either. Matches plan §2.3 exactly — no drift.

### B.3 Existing golden coverage: NONE

No golden/snapshot fixtures exist today for recognition, placement, renderer output, or lint output, per-format or otherwise. Confirmed by absence:
- `tests/fixtures/goldens/` has only 4 subdirs: `cli/`, `consolidate/`, `improve/`, `journal/` (Section F) — no `recognition/`, `placement/`, `renderer/`, or `lint/` subdirectory.
- No test file matches `*matcher*`/`*classify*`/`*linter*` naming.
- `tests/integration/file-context.test.ts` (720 LOC) exercises `runMatchers`/`buildFileContext` but is a behavior test, not a golden/snapshot capture — no `expectGolden`/`loadGolden` calls, not in `DESIGNATIONS.json`.
- No stash fixture contains all 14 types: `tests/fixtures/stashes/minimal/` has only agents/commands/knowledge/scripts/skills (5 of 14); `ranking-baseline/` has scripts/skills only; `curate-golden/` is judgment data, not a stash tree.

**This is the actual capture surface Chunk 0b must build from scratch** — there is no existing golden to "re-baseline," only production code to snapshot for the first time. A brief author should budget for minting a 14-type fixture stash (or reusing/extending `minimal/`) as a prerequisite.

---

## C. The minting oracle — `deriveCanonicalAssetNameFromStashRoot`

Definition: `src/core/asset/asset-spec.ts:338-353`.

```
export function deriveCanonicalAssetNameFromStashRoot(
  assetType: string,
  stashRoot: string,
  filePath: string,
): string | undefined
```

Logic (asset-spec.ts:343-352): compute `relPath` = POSIX-relative(`stashRoot`, `filePath`); take its first path segment; if that segment equals `TYPE_DIRS[assetType]` (asset-spec.ts:326-328, e.g. `"agents"`), the effective `typeRoot` is `stashRoot/<firstSegment>`; otherwise `typeRoot` falls back to the bare `stashRoot` itself (preserves the full relative path — the comment notes this is deliberate for installed stashes with custom top-level dirs, e.g. `tools/agents/svelte-file-editor`). It then delegates to `deriveCanonicalAssetName(assetType, typeRoot, filePath)` (asset-spec.ts:334-336), which calls `ASSET_SPECS[assetType]?.toCanonicalName(typeRoot, filePath)` — i.e. it defers the actual name-shaping to each type's own `toCanonicalName` (the same per-type function in the B.1 table's "Placement" column, run in reverse).

Two call sites (re-anchored, Section A): `mv-cli.ts:739` (rejects a fallback hit unless the resolved path matches the canonical spelling) and `mv-cli.ts:1239` (derives the canonical `sourceName` before computing `fromRef` for the state.db/index re-key — comment there is explicit: "the entry_key re-key, the state.db asset_ref re-key, the report — must use the CANONICAL extensionless name ... or the real rows ... are silently missed"). Freeze both the function's output AND its two call-site usages (the second is the exact oracle Chunk 8's re-key will lean on).

---

## D. Filter-behavior + rank-metric surfaces

### D.1 proposed/belief/scope filters — TWO parallel implementations, same shape

`src/indexer/search/db-search.ts` has independently-duplicated filter chains (plan's own §4.3 "unify scored/enumerate filter path" row — unowned by any Wave-1 chunk, still Chunk-5's job, confirmed untouched):

- **Scored path** (`searchDatabase`, fn starts :282): `sourceFiltered` :513-515 → `scopeFiltered` :520-522 (`entryMatchesScope`, db-search.ts:927) → `qualityFiltered` :527-529 (`isProposedQuality`, `src/indexer/passes/metadata.ts:245`) → `beliefFiltered` :530 (`matchBeliefFilter`, db-search.ts:692) → `selected = beliefFiltered.slice(0, limit)` :534.
- **Enumerate path** (`enumerateEntries`, fn starts :574): `sourceFiltered` :619-621 → `scopeFiltered` :625-627 → `qualityFiltered` :628-632 → `inheritDerivedTwinBeliefStates` :636 (belief-inheritance for `.derived` twins — scored path lacks this call, a documented asymmetry per the :633-635 comment) → `beliefFiltered` :637 → `selected` :638.

A 0b filter-behavior golden should capture BOTH paths' output sets (proposed/belief/scope combinations) since they are not yet unified and could diverge subtly (the derived-twin belief-inheritance asymmetry above is exactly the kind of divergence a golden should pin before Chunk 5 unifies them).

### D.2 whyMatched

`buildWhyMatched` — `src/indexer/search/db-search.ts:837` (exported). Called once, from `buildDbHit` at `:784`. Per §14.2 finding A2 (still unaddressed, Chunk-5-owned): it re-scans matches and recomputes boost constants that duplicate `metadataRankingContributor` (`src/indexer/search/ranking-contributors.ts:288`) — a drift-prone parallel scorer. Capture `whyMatched` output alongside the ranked hit set in the same golden so a future consolidation (Chunk 5) has a byte-level oracle.

### D.3 Rank metrics + eval harness

- **Canonical location moved** (Section A): `scripts/akm-eval/src/rank-metrics.ts` (186 LOC) — `ndcgAtK:69`, `recallAtK:81`, `mrr:89`, `noBannedAboveRequired:102`, `scoreCurateCase:128`, `summarizeCurateMetrics:163`, plus `CurateJudgment`/`CurateCaseMetrics`/`DEFAULT_CURATE_WEIGHTS`/`CurateSuiteSummary` types. `scripts/akm-eval/src/curate-metrics.ts` is now purely `export * from "./rank-metrics"` (8 LOC, a compatibility shim — do not delete without repointing its 3 test consumers).
- Consumers at HEAD: `tests/curate-metrics.test.ts`, `tests/integration/curate-golden-eval.test.ts` (both import the shim), `tests/integration/commands/improve/collapse-detector.test.ts:29` (imports `scripts/akm-eval/src/curate-metrics` directly — the plan's own C.3 finding flagged this as needing repoint once the shim's stale doc comment claiming `collapse-detector.ts` is a consumer is fixed; unresolved at this HEAD).
- Eval harness root: `scripts/akm-eval/` — `src/run.ts`, `src/curate-bench.ts` (sets `AKM_EMBED_DETERMINISTIC` on real-binary subprocesses, :159 per chunk-9 census), `src/report.ts`, `src/compare.ts`, `src/collect.ts`, `src/replay.ts`, `src/trend.ts`, `src/graph-ablation.ts`, `src/proactive-verdict.ts`, `src/scoring.ts`, `src/types.ts`; CLI entry points under `bin/` (`akm-eval-run`, `akm-eval-curate-bench`, `akm-eval-collect`, `akm-eval-compare`, `akm-eval-replay`, `akm-eval-trend`, `akm-eval-graph-ablation`, `akm-eval-proactive-verdict`).
- Fixture data: `tests/fixtures/stashes/curate-golden/judgments.json` (curate-golden judgment set) + `tests/fixtures/stashes/ranking-baseline/` (a 2-skill fixture stash with `MANIFEST.json`) — both consumed by `tests/integration/curate-relevance-eval.test.ts`, `tests/integration/ranking-regression.test.ts`, `tests/integration/ranking-contributor-ablation.test.ts`. Neither is registered in `tests/fixtures/goldens/DESIGNATIONS.json` (Section F) — they live outside that policy's scope (`tests/fixtures/stashes/`, not `tests/fixtures/goldens/`).
- Salience-derived ranking contributor: `loadSalienceRankScores` — `src/indexer/search/ranking.ts:86` (the cross-DB reach flagged in plan §14.2 A3 — opens state.db per query); consumed at `ranking.ts:234`. The corresponding contributor is `"salience-ranking"` — `src/indexer/search/ranking-contributors.ts:491`.

---

## E. Migration fixture shapes (for Chunk 8's consumers)

### E.1 `asset_salience` / `asset_outcome` schema (`src/core/state/migrations.ts`)

- `asset_salience` — migration `009-asset-salience` (:507-523): `CREATE TABLE` at `:509-517`. Columns: `asset_ref TEXT PRIMARY KEY` (the `type:name` ref string — comment at `:533` confirms), `encoding_salience`, `outcome_salience`, `retrieval_salience`, `rank_score`, `consecutive_no_ops`, `updated_at`. Index `idx_asset_salience_rank` on `rank_score DESC` (:520-521). Two later ALTERs add columns: `homeostatic_demoted_at` (migration 011, `:594`) and `encoding_source` (migration 015, `:718`) — both still present, neither dropped.
- `asset_outcome` — migration `010-asset-outcome` (:555-577): `CREATE TABLE` at `:557-567`. Columns incl. `review_pressure` — **this column was DROPPED** by migration `018-drop-dead-lane-schema` (:804-813, `ALTER TABLE asset_outcome DROP COLUMN review_pressure`, landed by Chunk 7). Live columns today: `asset_ref`, `last_retrieved_at`, `retrieval_count`, `expected_retrieval_rate`, `negative_feedback_count`, `accepted_change_count`, `outcome_score`, `updated_at`.
- Migration ledger is **append-only** — historical `up` bodies (009/010/014) are never edited; a later migration (018) issues `DROP TABLE`/`DROP COLUMN` to retire what an earlier one created. 19 migrations total at HEAD (`001` through `019-proposal-fingerprints`, the last landed by Chunk 6's fingerprint work). A 0b fixture builder should apply the FULL migration chain (not hand-write DDL) so it reflects the real post-Chunk-7/9 schema.
- `recombine_hypotheses` (migration 014) — table DDL still exists in the ledger (immutable history) but is **dropped** by migration 018 (`:806-807`), consistent with Chunk 7 having actually deleted the `recombine`/`synthesis` subsystem (confirmed: no `recombine*` file exists anywhere under `src/`). Do not resurrect this table in a 0b fixture.
- No `legacy_state` table exists yet anywhere in `src/` — it is pure Chunk-8 scope (plan §3.3 item 4); 0b's orphan fixture only needs to produce ORPHANED ROWS in `asset_salience`/`asset_outcome` (rows whose `asset_ref` has no live asset), not the quarantine table itself.

### E.2 Ref-spelling conventions — the three-spelling merge target, already coded once

`src/commands/mv-cli.ts:898-967` (`rekeyStateDbForMove`, Section A re-anchor) is the EXISTING single-item instance of the exact algebra Chunk 8 must generalize to a full-table pass (plan §3.2). Reading its pair-construction logic (`:910-922`) precisely:

```
origins = {sourceName}  (+ "local" when sourceName === "stash" && includeLegacyBare)
pairs = [origin//fromRef → origin//toRef  for origin in origins]
      + [fromRef → toRef]                              (only if includeLegacyBare)
      + [origin//fromRef.derived → origin//toRef.derived  for origin in origins]   (only if includeTwin)
      + [fromRef.derived → toRef.derived]               (only if includeTwin && includeLegacyBare)
```

So the plan's phrase **"three ref spellings (bare / origin-qualified / `.derived` twins)"** is a 3-category label over what is concretely **up to 4 distinct key shapes** per logical asset: `fromRef` (bare), `origin//fromRef` (origin-qualified), `fromRef.derived` (bare + derived), `origin//fromRef.derived` (origin-qualified + derived) — `.derived` is an orthogonal suffix applied to either bare or qualified, not a fourth independent spelling. **A property-test generator sized to "3 categories" will under-cover if it treats `.derived` as mutually exclusive with bare/origin-qualified rather than a modifier bit.** Size the generator's state space as `{bare, origin-qualified} × {plain, .derived-twin}` (4 concrete shapes) landing on one canonical fully-qualified key, not 3 flat categories.

Per-table merge behavior already demonstrated by this function (matches plan §3.2's stated invariants exactly): for each `(oldRef, newRef)` pair, if `oldRef` exists in the table, `DELETE ... WHERE asset_ref = newRef` (clears any pre-existing row at the target key) then `UPDATE ... SET asset_ref = newRef WHERE asset_ref = oldRef` — i.e. **last-write-wins / target-clobbers**, not a field-level merge. Chunk 8's "scalar fields most-recently-updated wins" invariant is a STRONGER rule than this existing single-item function implements (this one just deletes-then-renames; it never compares `updated_at` between old and new rows) — the property-test harness should exercise the harder case (both a bare-spelled row AND an origin-qualified row present simultaneously with different `updated_at`), which `rekeyStateDbForMove` was never asked to handle (mv only ever touches one asset at a time, not a collision between two pre-existing spellings of the same conceptual asset).

Other bare/qualified ref-spelling logic worth cross-referencing: `parseAssetRef`/`makeAssetRef` (`src/core/asset/asset-ref.ts`, un-drifted per Section A) is the ref-string grammar itself; `resolveParentRef`/`parseMemoryRef`/`isDerivedMemory`/`DERIVED_SUFFIX` (`src/commands/improve/memory/derived-ref.ts:37-83`, all lines exact) is the single canonical `.derived`-suffix + `derivedFrom`/`source` frontmatter resolution logic (post-chunk-7 consolidation, per plan §4.4).

### E.3 "Orphan" — definition confirmed from plan text (no code yet)

Plan §3.3 item 4 (line 128): orphaned old-ref rows are "an acknowledged steady state (deleted-asset salience rows, append-only event history, retained judged keys)." **Expected orphans** (old ref → no live item) move to a quarantined `legacy_state` table; **integrity failures** (mapping collisions without a defined merge, row-count mismatches, unparseable refs) fail closed. No `legacy_state` table or quarantine code exists at this HEAD — confirmed via grep (zero hits). The 0b orphan-bearing fixture only needs to seed `asset_salience`/`asset_outcome` rows keyed to refs with no corresponding on-disk asset (in bare, origin-qualified, and `.derived`-twin spellings per E.2) — the quarantine mechanics are Chunk 8's to build.

### E.4 rc-train / FROM-state — definition (plan §3.4, line 137)

> **FROM-state:** the shipped rc-train layout (state ledger at its final pre-cutover migration, workflow.db present, vault removed) — not a pristine 0.8 tree. Fixtures cover it.

"rc-train" = the akm 0.9.0-rc.x release series' shipped-state layout — i.e. the DB/config shape of a real user who has been running an rc build, NOT a synthetic 0.8.0 tree. Concretely this means the fixture DB must: (a) be at migration `019-proposal-fingerprints` (the LAST migration in the ledger at this HEAD — the "final pre-cutover migration" the moment 0b captures it; Chunk 8's own cutover work will add a `018-<name>`-style migration `020`+ on top, so this fixture's ceiling should track "latest migration as of 0b's capture, re-verified"), (b) include a `workflow.db` (the plan confirms it's still present pre-cutover — `src/workflows/` still writes it; no `workflows/db.ts` deletion has happened, confirmed no `legacy_state`/cutover code exists), (c) have NO `vault` type artifacts (already true at HEAD — `vault` was removed pre-0.9.0, confirmed no `vault` asset-type entry in `ASSET_SPECS_INTERNAL`). No other rc-train-specific code or fixture references exist anywhere in `src/`, `scripts/`, or `tests/` at this HEAD (grep for `rc-train`/`rc.x`/`rcTrain`/`rc-era` returns only doc hits, none in code) — this fixture is genuinely greenfield for 0b to construct, seeded by running the real migration chain against a config with `workflow.db` present.

### E.5 Re-key merge algebra — target home (Chunk 8), generator target (Chunk 0b)

Plan §12.3 (line 520) states the property test's invariants precisely: **no key lost, event rows carried as-is with counts preserved, scalar fields most-recently-updated wins, output deterministic and idempotent**, exercised over ≥1000 generated cases. The generalization target is explicitly named in plan §3.2 (line 115): "re-key via the `rekeyStateDbForMove` SQL pattern (`mv-cli.ts:928,957`), generalized to a full-table pass" — i.e. **Chunk 8 will write a NEW full-table re-key function modeled on `rekeyStateDbForMove` (now at `mv-cli.ts:898-967`, Section A)**, most likely living beside the cutover code Chunk 8 introduces (no such file exists yet — `src/migrate/` doesn't exist). Chunk 0b's job is only the **generator + invariant harness** (a seeded RNG producing randomized state across the 4 concrete key shapes from E.2, plus an invariant-checking function), sized so Chunk 8 can import and run it against the real algebra once written — the generator itself should NOT hard-code assumptions about where Chunk 8's function will live (it doesn't exist yet), only about the row/key shapes it must accept and the invariants it must satisfy.

---

## F. §15.5 golden/characterization asset inventory

### F.1 `tests/fixtures/goldens/DESIGNATIONS.json` — the policed registry

Policy header (`DESIGNATIONS.json:2`) points at `docs/design/execution/chunk-0a/anchors.md §3.3` / `chunk-0a/brief.md §3.3` — Chunk 0a is this registry's owner, not 0b. Mechanically enforced by `scripts/lint-goldens-presence.ts` (wired into `bun run lint`; checks: registry exists/parses/non-empty, every asset file exists, every `frozen-migration-input` entry's sha256 matches its bytes, every consumer suite exists/calls `expectGolden`/`loadGolden`/isn't `.skip(`'d, every entry's path string appears in at least one consumer).

**Counted directly from the JSON at this HEAD: 50 entries total — 47 `frozen-migration-input`, 3 `re-baseline` (all `reBaselineChunk: "5"`).** Note: `lint-goldens-presence.ts:74`'s own error-message text says "Chunk 0a landed 51 designated assets" — **stale by 1** versus the actual 50 at this HEAD (harmless — it's only an error-path message string, not a check value, but worth fixing if anyone touches that script).

Re-baseline (non-frozen) entries — all three are ref-serializing CLI text-output goldens, correctly deferred to Chunk 5's ref-grammar codemod:
| Path | reBaselineChunk | Why |
|---|---|---|
| `cli/a-search-text.json` | 5 | embeds fixture-local ref `script:cli-a-deploy.sh` |
| `cli/a-show-per-type.json` | 5 | ref strings as JSON object KEYS |
| `cli/d-show-lines-view.json` | 5 | embeds fixture-local ref `knowledge:lines-fixture.md` |

Frozen entries by family (all sha256-pinned, none of 0b's business to touch): `journal/` (5: `proposal-txn`, `proposal-skip-shapes`, `proposal-recovery`, `move-txn`, `move-recovery` — Chunk 6 preservation oracles, journal-engine-shape ones already re-baselined+re-frozen at Chunk 6 per their notes), `consolidate/` (5: `consolidate-ops`, `merge-plans`, `journal-lifecycle`, `journal-recovery`, `journal-guard-verdicts` — Chunk 7 DoD 5 oracles), `improve/` (3: `signal-delta-gate`, `since-to-iso-identity-fallback`, `resolve-relative-dates`), `cli/` (34 CLI-output-baseline families A–F, WI-07/Chunk 9 oracle — "CLI output baselines from Chunk 0a stay green").

None of these 50 relate to recognition/placement/renderer/lint/filter-behavior/rank-metric/migration-fixture capture — **0b's entire deliverable set is new registry entries**, not modifications to existing ones. When 0b lands its new goldens (recognition/placement/renderer/lint parity fixtures, filter-behavior fixtures, orphan fixture, rc-train fixture, re-key merge generator fixtures) each new file under `tests/fixtures/goldens/**` MUST get a `DESIGNATIONS.json` entry or `lint-goldens-presence.ts` fails the gate mechanically (per its own doc comment, "Presence and integrity are a lint, not a promise").

### F.2 Golden/characterization-shaped assets OUTSIDE `DESIGNATIONS.json`'s policed scope

The registry's `$policy` only covers `tests/fixtures/goldens/**`. Other characterization-style assets exist and are NOT policed by the sha256/presence lint (they rely on ordinary `bun test` snapshot/assertion mechanics instead):

- **`.characterization.test.ts`-suffixed suites (7 files, not the plan's "6"):** `tests/storage/sqlite-migrations.characterization.test.ts` (has a companion Bun snapshot: `tests/storage/__snapshots__/sqlite-migrations.characterization.test.ts.snap`), `tests/integration/storage/index-db-loan.characterization.test.ts`, `tests/integration/storage/usage-events-queries.characterization.test.ts`, `tests/integration/storage/workflow-runs-repository.characterization.test.ts`, `tests/integration/health-checks-characterization.test.ts`, `tests/integration/install-ref-characterization.test.ts`, `tests/integration/graph-extract-single-characterization.test.ts`. (Plan/manifest text says "6 characterization suites" — actual count at this HEAD is 7; minor drift, flag for the brief rather than silently reconciling.)
- **Fixture stashes** (`tests/fixtures/stashes/`): `minimal/` (5-type stash + `MANIFEST.json`), `ranking-baseline/` (2-skill stash + `MANIFEST.json`, backs `ranking-regression.test.ts`/`ranking-contributor-ablation.test.ts`), `curate-golden/` (`judgments.json` only — backs `curate-relevance-eval.test.ts`/`curate-golden-eval.test.ts`).
- **Bun snapshot dirs**: `tests/storage/__snapshots__/` (1 file), `tests/commands/__snapshots__/` (`default-improve-strategies.test.ts.snap`).
- **Migration suites** (extended-not-rewritten per plan §15 rule 3): `tests/integration/migration-lifecycle-regression.test.ts` (1083 LOC — plan said 1,062, +21 drift), `tests/integration/migration-backup.test.ts` (420 LOC — plan said 405, +15 drift), `tests/integration/migration-apply-crash.test.ts` (227 LOC), `tests/contracts/migration-baseline.test.ts`, `tests/integration/migration-help.test.ts`, `tests/integration/workflows/migrations.test.ts`. **None reference "orphan" (grep-confirmed zero hits)** — corroborates E.3's finding that the orphan concept is greenfield.

None of these need a `DESIGNATIONS.json` entry (they're outside `tests/fixtures/goldens/`), but a brief author should decide whether 0b's NEW recognition/placement/renderer/lint/filter/rank-metric fixtures belong inside `tests/fixtures/goldens/` (policed, sha256-pinned) or alongside these looser characterization/snapshot assets (unpoliced) — the manifest's gate #4 ("§15.5 golden inventory committed with frozen-vs-re-baseline designation per asset") only makes sense if they go through the `DESIGNATIONS.json` registry, which argues for the former.

---

## G. Headline findings (bind the brief)

1. **The 14-format golden surface is 100% greenfield — there is nothing to "port," only production code to snapshot for the first time** (Section B.3): no matcher/linter/renderer test files, no `recognition/`/`placement/`/`renderer/`/`lint/` golden subdirectory, and no fixture stash containing all 14 types (the richest, `minimal/`, has 5). Budget fixture-stash construction as part of 0b's own work, not a reuse of existing assets.

2. **The plan's "three ref spellings" undercounts the real key-shape space by one axis.** `rekeyStateDbForMove` (mv-cli.ts:898-967, the function the plan itself names as the pattern to generalize) treats `.derived` as an orthogonal suffix bit applied to either bare or origin-qualified spellings, yielding **4 concrete key shapes**, not 3 flat categories (Section E.2). A property-test generator built literally to "3 spellings" will miss the bare+derived / qualified+derived cross-product. Also: the existing function implements simple delete-then-rename (target clobbers), never comparing `updated_at` between colliding rows — it does NOT already prove the "scalar fields most-recently-updated wins" invariant Chunk 8's gate requires; the property-test harness must exercise the harder simultaneous-collision case this single-item function was never asked to handle.

3. **Config "discriminated schemas" landed via 9 named per-process Zod object schemas, not `z.discriminatedUnion`** (Section A.2). Grepping the literal string will falsely read as "not done." The wide `ImproveProcessConfigSchema` monolith the plan wanted narrowed still exists BY DESIGN (typing constraint, documented in-file) — future re-measurement passes should grep `ProcessConfigSchema` or check `ImproveProfileProcessesSchema`, not `discriminatedUnion`.

4. **`processSession`'s RunContext-threading (a Chunk-9 item) landed into a bespoke 16-field `ExtractSessionRunCtx`, not the minted `RunContext` directly** (Section A.1) — confirmed NOT a violation (one `createRunContext()` call feeds it), but any future grep-based verification of "processSession takes a RunContext" needs to know the intermediate type name, or it will false-negative.

5. **`lint-goldens-presence.ts`'s own error message is stale by one** ("Chunk 0a landed 51 designated assets" vs the actual 50 — Section F.1) — a one-line, low-stakes drift, noted so a future chunk doesn't waste time reconciling a phantom missing asset.

6. **Plan/manifest's "6 characterization suites" figure is stale by one** — 7 `.characterization.test.ts` files exist at this HEAD (Section F.2); immaterial to 0b's gates but worth a one-line correction if the brief cites the count.

**Unresolved / needs a decision, not further grounding:** whether 0b's new format-parity, filter-behavior, and migration-fixture goldens go into the sha256-pinned `DESIGNATIONS.json`-policed `tests/fixtures/goldens/` tree (consistent with existing precedent and the manifest's own "frozen-vs-re-baseline designation per asset" gate wording) or a separate unpoliced location (Section F.2) — recommend the former given the manifest gate's own phrasing, but flagging as a call the brief author should make explicitly rather than one this census can resolve by reading code.
