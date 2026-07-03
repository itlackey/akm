# akm — End-to-End Code Quality Review

**Date:** 2026-07-03
**Reviewer:** Claude (Opus 4.8) + 6 parallel area-review agents
**Scope:** Full `src/` tree (107k LOC) + `tests/` (122k LOC)
**Method:** First-hand grounding (CLI dispatch, storage boundary, ambient-env, metrics) plus six focused review agents (improve, indexer, core/storage, setup/integrations/llm, cli/commands/output, tests). All findings are evidence-backed with `file:line`.

---

## Executive summary

This codebase is **healthier than its file sizes suggest**, and that framing matters for calibration: the *plumbing* is well-architected. Command dispatch (citty `subCommands`, not a switch), the LLM/agent integration layer (documented strategy/adapter boundaries with a single `callStructured` seam), output rendering (one centralized `output()` + error-envelope + exit-code table), and the test harness (in-process CLI capture, `_set…ForTests` seams, `mock.module` eliminated) are all genuinely good. `any` discipline is strong (22 occurrences in 107k LOC). **Do not rewrite these** — several agents independently flagged "resist adding machinery here."

The debt is **concentrated, not diffuse**, in two shapes:

1. **God files / god functions** — a dozen 950–2900 LOC modules and 380–1500 LOC functions that accreted unrelated responsibilities (schema + migrations + queries + a *domain algorithm* in one DB file; a 1500-line consolidate function inlining four op-handlers; a 2900-line setup script).
2. **Half-adopted boundaries / stalled migrations** — the *signature* debt. Repeatedly the right abstraction was built, adopted in 2–11 places, then abandoned while 20–69 call sites keep the old pattern. The Zod-vs-hand-written config drift, `managed-db` used by only one of three DBs, `defineJsonCommand` at 11/80 sites, and 69 test files re-implementing `makeTempDir` are all the same story.

**The corrective is overwhelmingly subtraction-by-relocation, not new abstraction** — deleting duplicated interfaces, carrying misplaced concerns back out of god-files, and finishing migrations already in flight. The single largest win (config single-source-of-truth) *deletes* ~250 lines and closes a class of real, previously-shipped bugs.

### Cross-cutting metrics
- Source: 107k LOC TS. `src/commands/` = 45% of source; `improve/` = ~25k LOC alone.
- Tests: 122k LOC (more than source — largely copy-paste scaffolding, not coverage).
- `any`: 22 total (good). TODO/FIXME: 8 (clean). `biome-ignore`/`eslint-disable`: 10.
- Ambient `process.env` reads: 102, concentrated in `paths.ts` (13), `setup/detect.ts` (7), `config.ts` (7).
- 5 god-files at 1900–2900 LOC; several 380–1500 LOC functions.

---

## Top architectural problems (ranked by impact)

### 1. Config defined twice → silently dropped keys — **CRITICAL**
`config-schema.ts` (Zod) and `config-types.ts` (hand-written interfaces) maintain the full config surface in parallel. `AkmConfigParsed = z.output<typeof AkmConfigSchema>` **already exists** (`config-schema.ts:964`) as the correct single source of truth, and the `z.infer` migration was *started* (`AgentProfileConfig`, `ImproveProcessConfig`, `ImproveProfileConfig` at `config-types.ts:138/150/158`) then stalled. Everything else still types against hand-written `AkmConfig`/`ImproveConfig` (`config-types.ts:299,438`, ~250 LOC). Every new key must be added in two places; forgetting one silently drops it at load — the documented root cause of the `extract`/`timeoutMs`/`fullScan` regressions. **Highest ROI in the review: purely subtractive, small, fixes a live bug class.**

### 2. `improve/` god-functions: concentration, not missing abstraction — **CRITICAL / HIGH**
- `akmConsolidateInner` (`consolidate.ts:966–2455`, **~1500 LOC**, 6-level nesting, a verbatim-copied LLM retry block at `:1518` vs `:1550`, four inlined op-handlers merge/delete/promote/contradict at `:1800/2087/2140/2343`).
- `akmDistill` (`distill.ts:895–1858`, ~963 LOC) inlines an *entire second command* — memory→knowledge promotion — at `:1067–1299`.
- Runner-ups: `akmImprove` (`improve.ts:405–1256`, ~851 LOC, a ~90-line result literal at `:1092–1181`), `runImproveLoopStage` (`loop-stages.ts:76–697`, ~621 LOC).

These can only be tested end-to-end against a real stash + real clock. The fix (pipeline stages over a shared `ImproveContext`) simultaneously deletes ~25–30 duplicated result-envelope literals and creates the test seam.

### 3. `indexer/db/db.ts` (2498 LOC) — persistence god-object holding domain policy — **HIGH**
Schema DDL (~362 LOC inline, `:226–588`), migrations (`:755/794/830`), all CRUD/FTS/vector queries — **and the MemRL reinforcement-learning feedback algorithm** (`:2250–2365`: `FEEDBACK_LR=0.1`, `MAX_NEG_DELTA_PER_CALL`, bounded-step EMA math in `applyFeedbackToUtilityScore` at `:2322`). A domain/policy decision living inside the SQLite module (`arXiv:2601.03192` per the comment). state-db.ts already pushed its migrations out to `state/migrations.ts`; db.ts never did.

### 4. Half-built storage boundary — **HIGH**
`storage/repositories/` exists with 2–3 repos, and `managed-db.ts` owns the canonical `mkdir → open → pragmas → init` recipe (`openManagedDatabase`, `:42`) + borrow/own loan (`withManagedDb`, `:65`) — but **only `state.db` uses it** (`state-db.ts:110/121/133`). `indexer/db/db.ts:69–129` and `logs-db.ts:83–94` re-hand-roll the open recipe; `repositories/index-db.ts:56–66` re-hand-rolls the loan. Meanwhile `state-db.ts` (1956 LOC) is a 13-table repository god (its header still claims "owns THREE tables" — stale by ~10), imported directly by 23 files.

### 5. Two misnamed / mixed god commands — **HIGH**
- `health.ts` (2740 LOC): `akmHealth()` is a single **382-line function** (`:2259–2640`) mixing two DB opens, metric computation, advisories — *and* inline MD table rendering (`padRight`/`renderTable`/`renderRunsDetailMd`/`renderWindowCompareMd` at `:2639–2740`). HTML rendering was already extracted to `health/html-report.ts` (1051 LOC); MD was left behind — **inconsistent extraction.**
- `proposal/validators/proposals.ts` (1577 LOC): **not a validators file** — it's the proposals repository + domain service + legacy-file migration (`:535–634`) + promote/revert/diff engine. Only `validateProposal` (`:1151`) and `repairProposalContent` (`:1180`) are validators. The path lies about the contents.

### 6. `setup.ts` (2905 LOC) — the one true monolith — **HIGH**
~10 responsibilities and 3 entry styles in one procedural script: 14 wizard steps (~1300 LOC, `:346–2068`), legacy-config adapters (`:150–250`), provider lookup `switch`es (`:2631–2666`), generic utils (`deepMergeConfig`/`isPlainObject` at `:2545–2571`), and subprocess spawning (`prepareSemanticSearchAssets` spawns `bun add @huggingface/transformers` at `:526`) all interleaved. No seam between "decide config" and "perform I/O" — the reason it is untestable end-to-end.

---

## File-by-file findings

### `src/core/config/config-types.ts` — **CRITICAL**
Delete hand-written `AkmConfig`/`ImproveConfig`/sub-shapes (`:299,438`); `export type AkmConfig = AkmConfigParsed` (already at `config-schema.ts:964`) and derive sub-types via `z.infer`. Finish the migration started at `:138/150/158`. *(−~250 LOC, subtractive; fixes dropped-key bug class.)*

### `src/indexer/db/db.ts` — **HIGH**
Extract, all as moves (db.ts shrinks ~800 LOC, zero behavior change):
- `db/schema.ts` — DDL + `ensureSchema` + `migrate*` + `ensureDerivedFromColumn` + `tableExists` (`:226–588`, `:755/794/830`). Isolates the one genuinely risky area (schema evolution).
- `feedback/utility-policy.ts` — pure `computeNextUtility(prev, pos, neg)` + MemRL constants (`:2250–2365`). Testable with zero DB.
- `search/fts-query.ts` — `sanitizeFtsQuery` (`:1436`), `buildPrefixQuery` (`:1340`) — pure string fns.
- `db/entry-mapper.ts` — one `ENTRY_COLUMNS` const + one `rowToIndexedEntry(row)`. The entry SELECT is repeated at `:1502/1505/1508/1615`; JSON-parse-guard reimplemented at `:1416/1469`.
- Fold the two near-identical FTS SELECT blocks (`:1357–1401`, differ by one WHERE clause) into one templated query.
- Route open through `openManagedDatabase` (see #4).
- Inconsistent error handling: 14 catch blocks, most swallowing to `return []`/`undefined` (`:915/928/1156/1418/1431/1605/1991`); pick one log-and-skip policy.

### `src/core/state-db.ts` — **HIGH**
Split into `repositories/{proposals,events,improve-runs,recombine,embeddings,canaries}-repository.ts` (pattern already exists with `workflow-runs-repository.ts` + `registry-cache.ts` extracted). Route open/loan through `managed-db`. Fix stale "owns THREE tables" header (`:8`). 16 unchecked `as {...}` row casts → centralize one typed `mapRow` per table in the split.

### `src/commands/improve/consolidate.ts` & `distill.ts` — **CRITICAL/HIGH**
Extract pipeline stages over a shared `ImproveContext { now, fs, db, config, events, llm }`. The four consolidate op-branches (`:1800/2087/2140/2343`) become four dispatched handlers; the distill promotion branch (`distill.ts:1067–1299`) becomes its own function/command. This is also the test seam (converts inline I/O to injectable deps without a DI framework).

### `src/commands/improve/` cross-file DRY — **HIGH/MEDIUM**
Extract shared helpers and delete per-file copies:

| New helper | Replaces |
|---|---|
| `makeImproveResult(base, partial)` | ~25 `{schemaVersion:1,…}` sites + `finish()` closures (proven at `recombine.ts:633`, `procedural.ts:340`) |
| `resolveImproveLlmFn(config, {processKey, systemPrompt, tag, signal})` | byte-identical `recombine.ts:600–617`, `procedural.ts:309` (+ reflect/distill variants) |
| use existing `assembleAsset`/`serializeFrontmatter` | reinvented frontmatter at `recombine.ts:1002`, `distill.ts:457–462`, `distill-promotion-policy.ts:238` |
| `emitImproveSkip(ref, reason)` | ~16 inline `appendEvent` sites (`loop-stages.ts:221/234/444/513/548/639`, `improve.ts:813/895`, distill ×8) |
| `errMessage(e)` | ~8 `instanceof Error ? … : String()` sites (`improve.ts:527/571/639/766/1216`, `loop-stages.ts:662/691`) |
| `filterByCooldown(refs, latestTsMap, windowMs)` | `loop-stages.ts:535–562`, `improve.ts:959–985` |
| `parseSince` (one time-window module) | `extract.ts:126/327`, `consolidate.ts:2541` |
| `refSlug(ref)` | `loop-stages.ts:604/620` |

Long positional-arg lists → option objects: `archiveMemory` 7 positional args (`consolidate.ts:1051/2057/2116`), `buildChunkPrompt` 7 args (`:1508`).

### `src/commands/improve/homeostatic.ts` (639 LOC) — **MEDIUM**
The namesake "homeostatic demotion" pass was deleted (`config-schema.ts:275`, `salience.ts:67`). The file is now a 7-concern grab-bag (schema-similarity penalty, embedding loading, generation guards, merge-info-floor, bigram diversity, CLS context, distill-fidelity) with a **misleading name**. Rename/split by concern.

### `src/setup/setup.ts` — **HIGH**
Decompose to:
- `setup/steps/*` (steps are already `(ctx) → ConfigPatch`-shaped; group as `steps/connection.ts` (ollama/llm/small-model/agent), `steps/sources.ts`, `steps/semantic.ts`, `steps/tasks.ts`) — ~1300 LOC out.
- `setup/legacy-config.ts` (`applyLegacy*`/`getCurrent*`, `:150–250`).
- `setup/providers.ts` — turn provider `switch`es (`:2631–2666`) into a `Record<string, {endpoint, model}>` table.
- `setup/semantic-assets.ts` — `prepareSemanticSearchAssets` (isolates the one subprocess).
- `setup/prompt.ts` — clack `prompt`/`promptOrBack`/`onCancel`/`bail` shims.
- Move `deepMergeConfig`/`isPlainObject` to `core/`.
- Target: `setup.ts` < 500 LOC of pure orchestration (`runSetupWizard`, `runSetupWithDefaults`, `runSetupFromConfig`).

### `src/integrations/agent/spawn.ts` (`:487–551`) — **HIGH**
**Delete** the hand-rolled `{…}`-only JSON scanner — a known-buggy copy (`core/parse.ts:20` documents it can't recover a top-level `[…]` array) — and call `parseEmbeddedJsonResponse(stdout)`. `agent/` may import `core/parse` (boundary only forbids `agent/ → llm/`). *(−55 LOC, closes latent bug.)*

### `src/commands/health.ts` — **HIGH**
Extract MD renderers (`:2639–2740`) to `health/md-report.ts` (mirror the existing HTML extraction); decompose `akmHealth` (`:2259–2640`) into a thin composition of its existing metric-builders (`buildWindowMetrics`, `summarizeImproveRuns`).

### `src/commands/proposal/validators/proposals.ts` — **HIGH**
Move repository/CRUD (`withProposalsDb`, `createProposal`, `listProposals`, `getProposal`, `archiveProposal`, `resolveProposalId`) to `proposal/repository.ts`; legacy import (`importLegacyProposalFiles`/`readLegacyProposalFile`, `:535–634`) to `proposal/legacy-import.ts`; keep only validate/repair in `validators/`. Seams already exist (`ProposalsContext` DI, `withProposalsDb`). *(~1000 LOC relocated.)*

### `src/cli.ts` — **MEDIUM**
- `resolveHelpMigrateVersionArg`/`wasHelpMigrateFlagValueConsumedAsVersion` (`:136–183`) — 45 lines of argv re-parsing fighting citty.
- `health` `run()` inlines HTML/MD/JSON presentation branching in the dispatch layer (`:357–424`).
- Declare hyphenated flags in `args` defs so `args.groupBy` works and the `(args as Record<string,unknown>)["group-by"]` casts (29 sites total) disappear.
- `setup` `run()` is a 5-way flag-combination if/else ladder (`:260–328`) with repeated `{dir, noInit, probe}` param clusters.

### `src/core/paths.ts` / `common.ts:161` / `sqlite-pragmas.ts:69` — **MEDIUM**
`getConfigDir`/`getDataDir` already take `env = process.env` (good seam). Extend the same default-param convention to `getCacheDir`/stash resolvers (`paths.ts:140/149/152/155/164/173/186/309/313/318/396`) which read the global ambiently. This is the documented "path resolver reads `process.env`" root cause — fix by *subtracting* global reads, not adding a context object. Same for `sqlite-pragmas.ts:69` (`AKM_SQLITE_JOURNAL_MODE` → thread through `ManagedDbSpec.pragmas`).

### Stalled migrations (consistency debt) — **MEDIUM**
- `defineJsonCommand` (`shared.ts:124`): **11 files adopted vs 69 remaining inline `runWithJsonErrors` sites.** Finish the migration; don't add a third pattern.
- `getStringArg`: 22 uses vs 10 lingering raw `typeof args.X === "string" && .trim()` idioms.

### Clock seam (deterministic tests) — **LOW/MEDIUM**
`Date.now()`/`new Date()` read directly ~80× in `improve/`, 27× in `indexer.ts`, 10× in `db.ts`, 10× in `staleness-detect.ts`. Thread `now()` through the shared context objects the splits introduce (one param, no wrapper class).

### `src/output/text/helpers.ts` (1190 LOC) — **LOW**
Dumping ground, not tangled logic: ~55 pure `formatXxxPlain` functions, no cross-coupling. Per-command modules (`text/search.ts`, etc.) already exist as thin wrappers while the functions sit here. Relocate each into its domain module. Cosmetic — lowest priority.

### `output()` singleton seam — **MEDIUM (test enablement)**
124 `output()` calls render through the `getOutputMode()` module singleton (`output/context.ts`). A command's rendered output can't be asserted without setting global state first. Have `output()` take an explicit `OutputMode` (or thread via citty `CommandContext`) — subtraction of hidden global state.

---

## Testing improvements

Source seams are **largely done and are a genuine strength** — in-process `runCliCapture` (65 files), `_set…ForTests` seams replacing all `mock.module`, injected clocks in `akmHealth`. Remaining work is mostly in the *tests*:

- **CRITICAL — massive fixture duplication.** `tests/_helpers/sandbox.ts` already exports the right primitives, yet local re-implementations proliferate:

  | Local helper | # files | Consolidate to |
  |---|---|---|
  | `makeTempDir`/`createTmpDir`/`makeTmpDir` | 69 + 18 + 6 | existing `makeSandboxDir()` |
  | `makeStashDir`/`makeStash`/`makeTempStash` | 32 + 13 + 4 | existing `makeStashDir()` (currently **shadowed**) |
  | `writeMemory`/`writeLesson`/`writeSkill`/`writeFact` | 26 + 3 + 4 + 4 | new `tests/_helpers/assets.ts` |
  | `renderFrontmatter` | 3 (+ inlined) | same asset-writer module |
  | `writeConfig` | 10 | existing `writeSandboxConfig()` |
  | `makeProposal`/`makeProfile`/`makeConfig` | 4 + 9 + 9 | `tests/_helpers/factories.ts` |

  Net-subtraction change — likely several thousand LOC removed. Main reason test LOC (122k) > source LOC (107k).

- **HIGH — stalled isolation ratchet.** `lint-tests-isolation.ts:283` baseline stuck at **64** (stated target ~5); 64 files still hand-roll `mkdtempSync` + manual XDG env save/restore (e.g. `index-clean.test.ts:35–81`, `semantic-search-e2e.test.ts:303–584`) instead of `withIsolatedAkmStorage()`. Migrate in batches, lowering the baseline each time.

- **MEDIUM — `_preload.ts` `healSandboxEnv` (`:255–292`)** is self-healing machinery compensating for cross-file env leaks; deletable once the ratchet completes. Debt tied to the ratchet, not permanent architecture.

- **LOW — in-process CLI harness** (`_helpers/cli.ts:181–210`) relies on empirically-fragile Bun stdout interception ("capture closures must be inline"); re-verify on Bun upgrades.

- **Assertion quality is good** — structured JSON assertions, only 1 `toMatchSnapshot`. No baseline fragility problem.

- **Shard-runner verdict: justified, not a smell.** `scripts/test-unit.sh` works around a real, empirically-confirmed Bun 1.3.x `EEXIST epoll_ctl` race no app-level fix can address, and is ~3× faster than the old single-process approach. Leave it. The one reducible piece (`healSandboxEnv`) is downstream of the un-migrated-test debt.

---

## Suggested design patterns (only where justified)

- **Pipeline stages over a shared context** (improve consolidate/distill) — replaces 1500-line functions; the context object *is* the DI seam. No framework.
- **Table-driven dispatch** — the four consolidate op-handlers; setup provider maps. `Record` lookup replaces `switch`/inline branches.
- **Repository split** (state-db, db.ts) — as *decomposition of an existing god-module*, not a new interface layer. **Explicitly do not** add a repository-*interface*/DI container; the remedy is carrying concerns out, not layering abstraction on.

**Patterns NOT to introduce:** no hand-rolled command registry (citty is fine), no output-format plugin layer (already centralized), no effects/DI framework for setup (file separation + passing the 2 existing effect callables suffices), no repository-interface/DI container.

---

## Technical debt to delete or simplify

| Delete / simplify | Where | Payoff |
|---|---|---|
| Hand-written config interfaces | `config-types.ts:299,438` | −250 LOC, fixes dropped-key bugs |
| Buggy JSON scanner | `spawn.ts:487–551` | −55 LOC, bug fix |
| ~25 result-envelope literals + `finish()` closures | `improve/*` | consolidation |
| Duplicated `resolveProductionLlmFn` | `recombine.ts:600`, `procedural.ts:309` | 1 helper |
| 3× reinvented frontmatter serialization | recombine/distill/distill-promotion-policy | use `assembleAsset` |
| Duplicated DB open/loan recipe | `db.ts`, `logs-db.ts`, `repositories/index-db.ts` | 3→1 via `managed-db` |
| ~69 local `makeTempDir` etc. | tests/ | −thousands LOC |
| Misleading `homeostatic.ts` name + stale headers | improve, state-db | clarity |

---

## Prioritized implementation roadmap

Every phase must be **net-subtractive or a pure move**. If a phase starts growing net lines or introducing an interface/DI layer, that is the signal a root cause is being worked around — stop and reassess. Each unit: **test-first**, then implement the smallest change, then gate (typecheck + lint + relevant tests), then adversarial review, then keep-or-revert. Commit at the end of each phase after review approval. Every commit clean: 0 errors, 0 warnings, 0 test failures (`bun run check`).

### Phase 1 — Subtractive quick wins (low risk, high ROI)
1. **Config single-source-of-truth** — delete `config-types.ts` interfaces → `AkmConfigParsed`. *(−250 LOC, fixes dropped-key bug class.)*
2. **Delete `spawn.ts` JSON scanner** → `parseEmbeddedJsonResponse`. *(−55 LOC, bug fix.)*
3. **Extract `improve/` shared helpers** (`makeImproveResult`, `resolveImproveLlmFn`, `errMessage`, `refSlug`, `filterByCooldown`, `parseSince`, use `assembleAsset`). *(net-negative.)*
4. **Route `indexer/db` + `logs-db` + `repositories/index-db` through `managed-db`.** *(3 copies → 1.)*

### Phase 2 — Carry concerns out of god-files (moves, near-zero behavior change)
5. `db.ts` → `schema.ts` + `utility-policy.ts` + `fts-query.ts` + `entry-mapper.ts`.
6. `health.ts` → extract MD renderers; `proposals.ts` → repository/legacy split.
7. `state-db.ts` → repository split.
8. `homeostatic.ts` rename/split; fix stale headers/comments.

### Phase 3 — Decompose the two hard monoliths (largest effort; smallest-increment-first)
9. `setup.ts` → `setup/steps/*` + extracted clusters.
10. `improve` consolidate/distill → pipeline stages over `ImproveContext` (also the test seam).

### Phase 4 — Finish stalled migrations (mechanical, per-file)
11. `defineJsonCommand` (69 inline sites); `getStringArg` (10 raw idioms); typed hyphenated args.
12. Test-fixture consolidation + isolation-ratchet migration; `output()` explicit-mode seam; `paths.ts` env seams.

### Priority buckets
- **Critical:** #1 config collapse; begin #2/#10 improve god-function split.
- **High:** db.ts + state-db.ts decomposition; managed-db routing; spawn.ts deletion; health.ts + proposals.ts splits; setup.ts decomposition.
- **Medium:** finish migrations; paths.ts env seams; `output()` singleton seam; test-fixture consolidation.
- **Low:** homeostatic.ts rename; stale comments; `output/text/helpers.ts` relocation (cosmetic).

---

## What is already good (do not touch)

- citty-based command dispatch (`cli.ts:543–582`) — a real registry, not a switch.
- `llm/` + `integrations/agent/` — `callStructured` single seam, `client.ts` single retry, `core/parse.ts` shared parse, `runner-dispatch.executeRunner` single `llm|agent|sdk` switch, `AgentCommandBuilder` strategy + `BUILTIN_BUILDERS`/`HARNESS_REGISTRY` adapter boundary. Sound.
- `output()` / `emitJsonError` / `EXIT_CODES` — centralized output + error envelope + exit-code table.
- Test harness: in-process `runCliCapture`, `_set…ForTests` seams, `mock.module` eliminated (Rule 6), JSON-targeted assertions, justified shard runner.
- `any` discipline (22 total); low TODO/ignore counts.
