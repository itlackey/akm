# AKM CLI — Final Refactoring Task List

> Lead-reconciled deliverable. Synthesizes the raw per-slice survey with the three-way Opus debate (correctness/dup, over-engineering skeptic, architecture/value). Only findings that survived **both** verification *and* the over-engineering skeptic are kept. Duplicate cross-slice reports are merged. Rejected/over-engineered items are in the explicit **CUT** section with reasons. Every claim below was spot-checked against the actual source by the lead before inclusion.

---

## Executive summary

The codebase is in good shape. The high-value refactors here are overwhelmingly **subtractive**: collapsing verbatim copy-paste helpers into one home, and lifting a handful of repeated mechanical idioms (chunked-SQL loops, `Math.max(0,Math.min(1,…))`, `JSON.parse(row)+warn`, empty-string validators) into tiny named helpers. None require new abstraction layers.

Two findings are **not cosmetic — they are latent bugs** that a consolidation fixes as a side effect, and they lead the roadmap:

1. **`improve.ts` leaks a process lock on throw.** Three of the four lock sites release the lock *after* an `await` with **no `try/finally`** (verified: consolidate-prep 1601-1624, reflect-distill 1642-1699, consolidate-post 1712-1734), while the triage site (1304-1339) correctly uses `try/finally`. A `withProcessLock` wrapper both dedups and guarantees release-on-throw.
2. **`mergeLegacyEntry` has silently diverged.** `indexer.ts:1695` preserves `source/quality/confidence` via `?? entry.x`; `manifest.ts:167` is a naive `{...entry, ...legacy, filename}` that **drops** that precedence. The survey called them "identical" — they are not. Consolidating to one definition fixes a real metadata-loss path in the manifest.

The single biggest cross-cutting observation the per-slice survey could not see: there is **one DB-lifecycle RAII idiom** (`open → try → finally close → rethrowIfTestIsolationError`) hand-rolled across registry, graph, workflows, and tasks — even though the repo *already* established `withIndexDb` / `withWorkflowRunsRepo` as the canonical shape. The win is to adopt the existing convention at the hand-rolled sites, not to invent new wrappers.

**Do-not-do (over-engineering, explicit):** `result-envelope` base type, generic `resolveProcessConfig`, `runPhaseAutoAcceptGate` orchestrator, agent-builder factory, `builders/` mirror directory, `LogBuilder` class, unified `tryResolveTarget` strategy, inlining `createProviderRegistry`. Details in CUT.

---

## Priority tiers (subtraction-first × maintainability gain × low risk)

| Tier | Theme | Risk |
|---|---|---|
| **P0** | Correctness fixes that are *also* dedups | Low–med (touches concurrency / merge semantics — needs a test) |
| **P1** | Pure mechanical subtraction in hot files | Very low (no behavior change) |
| **P2** | Byte-identical helper consolidations | Near-zero |
| **P3** | Repo-wide tiny helpers (`asArray`, `clamp01`, `buildWhereClause`) | Low |
| **P4** | Localized cleanups (lint, setup, output shapes) | Low |

---

## P0 — Correctness + dedup (do first, with tests)

### P0.1 — `withProcessLock` in improve.ts (fixes lock-leak-on-throw)
- **Files:** `src/commands/improve/improve.ts` (triage 1304-1339; consolidate-prep 1601-1624; reflect-distill 1642-1699; consolidate-post 1712-1734)
- **Pattern:** RAII resource-guard (`withXxx`, matching the repo's existing `withIndexDb` convention)
- **What it fixes/deletes:** Three of four sites release the lock *outside* any `try/finally`, after an `await` — they leak the process lock if the awaited stage throws. Wrap acquire→run→release in `withProcessLock<T>(lockPath, staleMs, skipIfLocked, name, fn)` returning `T | "skipped"`. Collapses 4 acquire/release blocks (~8 lines each) into 4 call sites **and** makes release-on-throw uniform.
- **Effort:** M
- **Confidence:** High (lead-verified the asymmetry directly: triage uses `finally`, the other three do not)
- **Note:** This is a real bug, not cosmetics. Add a test that throws inside the stage fn and asserts the lock file is released. Highest-priority item in the whole survey.

### P0.2 — Consolidate diverged `mergeLegacyEntry` (fixes metadata loss)
- **Files:** `src/indexer/indexer.ts:1695-1707`, `src/indexer/manifest.ts:167-170` → one home in `src/indexer/passes/metadata.ts`
- **Pattern:** extract-helper / single-source-of-truth
- **What it fixes/deletes:** The two are **not** identical (lead-verified). `indexer.ts` preserves `source/quality/confidence` via `?? entry.x`; `manifest.ts` does a plain spread that clobbers them. Pick the `indexer.ts` semantics (it preserves user-curated overrides) as canonical, export once, import in both. Deletes one copy and removes the manifest metadata-loss path.
- **Effort:** S
- **Confidence:** High (bodies read and compared). **Verify** the manifest path actually wants the precedence-preserving semantics before merging — if manifest intentionally wants legacy-wins, this is still a divergence to make explicit, not leave implicit.

---

## P1 — Mechanical subtraction in `src/indexer/db/db.ts` (one PR, hot file)

### P1.1 — `chunkArray<T>` generator for the 10 SQLITE_CHUNK_SIZE loops
- **File:** `src/indexer/db/db.ts` — verified 10 sites: lines 916, 964, 978, 1017, 1058, 1100, 1497, 1727, 1864, 1998
- **Pattern:** extract-helper (generator) — **not** a query-runner
- **What it deletes:** Each site repeats `for (let i=0;i<arr.length;i+=SQLITE_CHUNK_SIZE){ const chunk=arr.slice(i,i+SIZE); … }`. Replace with `for (const chunk of chunkArray(arr)) { … }`. Keep each site's own `placeholders`/`.prepare`/`.all` (the SQL and post-processing genuinely differ per site — a full "withChunkedQuery" would be a misfit). Removes ~2 lines of index/slice math × 10 sites and the off-by-one / placeholder-count risk.
- **Effort:** S
- **Confidence:** High (10 sites grep-confirmed)

### P1.2 — `parseEntryJson(json, context): StashEntry | null`
- **File:** `src/indexer/db/db.ts` — 6 sites: 880-883, 1120-1125, 1383-1387, 1440-1442, 1570-1572, 2446-2450
- **Pattern:** extract-helper
- **What it deletes:** `try { JSON.parse(row.entry_json) } catch { warn(…); return null/skip }` repeated 6×. One helper centralizes the corrupt-row warning + skip policy.
- **Effort:** S · **Confidence:** High

### P1.3 — `clamp01(v)` (merge with P3.2)
- **File:** `src/indexer/db/db.ts:2086, 2091, 2312` (+ see P3.2 for graph + search-display sites)
- **Pattern:** extract-helper (named numeric util)
- **What it deletes:** `Math.max(0, Math.min(1, …))` × 3 here. Put `clamp01` in a core numeric util and reuse repo-wide (graph `normalizeConfidence`, score-display rounding).
- **Effort:** S · **Confidence:** High

### P1.4 — `BM25_FIELD_WEIGHTS` named constant
- **File:** `src/indexer/db/db.ts:1344, 1357`
- **Pattern:** extract-constant
- **What it deletes:** The magic tuple `0, 10.0, 5.0, 3.0, 2.0, 1.0` is hardcoded in both FTS branches and must stay in sync. One named constant guards desync.
- **Effort:** S · **Confidence:** High

---

## P2 — Byte-identical helper consolidations (batch, near-zero risk)

All lead-verified as verbatim duplicates. Each is a delete-one-copy move.

### P2.1 — `caps()` → `harnesses/types.ts`
- **Files:** `src/integrations/harnesses/{claude,opencode,opencode-sdk}/index.ts` (claude:35, opencode:28, opencode-sdk:25)
- **Pattern:** extract-helper · **Deletes:** ~30 lines (3 identical copies); kills the "add a `HarnessCapabilities` field, update 3 files" trap. Move to where `HarnessCapabilities` is defined.
- **Effort:** S · **Confidence:** High

### P2.2 — `homeDir()` → reuse existing core logic
- **Files:** `src/integrations/harnesses/{claude,opencode}/config-import.ts:22-24`
- **Pattern:** dedup. **Note (reviewer 2 catch):** `src/core/paths.ts` already computes `process.env.HOME ?? process.env.USERPROFILE`. Reuse/export that rather than creating a new file. Delete both local copies.
- **Effort:** S · **Confidence:** High

### P2.3 — `ensureParentDir()` → core util (security-relevant)
- **Files:** `src/commands/env/env.ts:431-434`, `src/commands/env/secret.ts:74-77`
- **Pattern:** dedup. **Deletes:** one copy; the `0o700` mode is security-relevant, so a single source matters. Move to `src/core/common.ts` (or a file-io util).
- **Effort:** S · **Confidence:** High

### P2.4 — `normalizeConfidence()` → shared graph util (3 copies, not 2)
- **Files:** `src/indexer/graph/graph-dedup.ts:26`, `graph-boost.ts:154`, `graph-extraction.ts:294` (lead-verified THREE byte-identical copies — survey said two)
- **Pattern:** dedup. One shared `normalizeConfidence` that internally calls `clamp01` (P1.3/P3.2). Collapses 3 function copies.
- **Effort:** S · **Confidence:** High

### P2.5 — `withRegistryCacheDb` → one shared helper
- **Files:** `src/registry/providers/static-index.ts:182-204`, `skills-sh.ts:47-69`
- **Pattern:** RAII / extract-helper. **Deletes:** ~23 lines (the 23-line helper is byte-identical incl. the test-isolation guard comment). Lead-confirmed both definitions + both call sites. Fold into the broader "use withXDb" theme (see P3.4).
- **Effort:** S · **Confidence:** High

### P2.6 — `buildOpenAiHeaders(apiKey)`
- **Files:** `src/llm/client.ts:299-303`, `src/llm/embedders/remote.ts:128-135`
- **Pattern:** extract-helper. **Deletes:** identical Content-Type + conditional Bearer-via-`resolveSecret` block in both. One header builder.
- **Effort:** S · **Confidence:** High

---

## P3 — Repo-wide tiny helpers (low risk, broad reach)

### P3.1 — `asArray<T>(value): T[]` + `asRecord(value)` in `core/common.ts`
- **Files:** output/shapes/helpers.ts, output/text/helpers.ts, output/renderers.ts (cross-slice; ~60+ `Array.isArray(x) ? (x as T[]) : []` sites and the `(x as Record<string,unknown>) ?? {}` sites)
- **Pattern:** extract-helper (type-guard). **Note:** `src/integrations/github.ts:64-70` already defines `asRecord`/`asString` — **promote those to core** and reuse across output + integrations rather than creating new ones. Standardizes the inconsistent env-list/secret-list non-cast variants too.
- **Effort:** M (many call sites, mechanical) · **Confidence:** Med-high (count is large; verify exact total during the PR)
- **Caveat:** This *adds* a helper for a borderline-idiomatic pattern. Justified only because it (a) reuses an existing helper and (b) retires 60+ sites with one import. Keep it to `asArray`/`asRecord` — do **not** spawn per-slice variants.

### P3.2 — `clamp01` repo-wide (merge target for P1.3 + P2.4)
- **Files:** `src/indexer/db/db.ts` (3), graph `normalizeConfidence` (3 files), `src/indexer/search/db-search.ts:454,502` (clamp+round display score)
- **Pattern:** extract numeric util. One `clamp01(v)` (+ optional `roundTo(n)` for the 4dp display rounding). `normalizeConfidence` becomes `Number.isFinite(raw) ? clamp01(raw) : undefined`.
- **Effort:** S · **Confidence:** High

### P3.3 — `buildWhereClause(conditions, params)` returning `{where, params}`
- **Files:** `src/core/state-db.ts:1079-1095, 1173-1184, 1427-1446`, `src/core/logs-db.ts:257-276` (4 sites)
- **Pattern:** extract-helper. **Deletes:** the repeated `conditions.length>0 ? "WHERE "+conditions.join(" AND ") : ""` plus the parallel `conditions[]`/`params[]` bookkeeping that's easy to desync.
- **Effort:** M · **Confidence:** High

### P3.4 — Adopt existing `withXDb` RAII at hand-rolled sites (convention, not new abstraction)
- **Files:** `src/commands/graph/graph.ts` (2 verified-identical `db=open; buildRefByPath; finally close` sites — 414-417, 464-467; the claimed third at 350-357 is a *different* IIFE shape, **do not** count it), `src/workflows/runtime/runs.ts` (484-510, 536-558), `src/tasks/runner.ts` (556-571, 577-601)
- **Pattern:** RAII — **reuse the established `withIndexDb`/`withWorkflowRunsRepo` convention**, do not invent 4 differently-named wrappers
- **What it deletes:** Hand-rolled `open → try → finally close (+ rethrowIfTestIsolationError)` boilerplate; also makes close-on-throw uniform. Optionally back all domain wrappers with one generic `withDatabase(open, fn)` in `storage/repositories/` so the isolation-guard lives in one place.
- **Effort:** M · **Confidence:** Med-high (graph downgraded to 2 sites per reviewer 1's correction; verify each site's open/close fn before wrapping)

### P3.5 — `logUsageEventSafely(eventCreator)` for fire-and-forget usage logging
- **Files:** `src/commands/read/show.ts:336-349`, `search.ts:306-354`, `curate.ts:152-179`
- **Pattern:** extract-helper. **Deletes:** 3 copies of `try { withIndexDb; insertUsageEvent } catch { rethrowIfTestIsolationError(err) /* swallow */ }`. Centralizes the swallow-except-test-isolation policy.
- **Effort:** S · **Confidence:** High

---

## P4 — Localized cleanups (low risk, isolated blast radius)

### P4.1 — Lint command trio
- **`collectFilesByExtension(dir, ext, throwOnError?)`** — `src/commands/lint/index.ts:51-91` collapses `collectYamlFiles`/`collectMarkdownFiles`/`collectEnvFiles` (differ only by extension + env's try/catch). Deletes ~40 lines.
- **`BaseLinter.validateNameAndType(ctx, allowedTypes)`** — `src/commands/lint/agent-linter.ts:23-49` and `command-linter.ts:23-49` are **byte-identical except the `VALID_*_TYPES` constant** (lead-verified). Each subclass collapses to ~3 lines.
- **`BaseLinter.deleteFileIfFixing(ctx, issueType, successDetail)`** — `memory-linter.ts:27-46` / `workflow-linter.ts:27-45` share an identical unlink try/catch tristate block.
- **Pattern:** extract-helper / template-method · **Effort:** S · **Confidence:** High (agent/command verified; memory/workflow consistent with the pattern — confirm bodies when touching)

### P4.2 — `setup.ts` validators
- **`requireNonEmpty(fieldName)`** factory — ~18-20 sites of `!v?.trim() ? "X cannot be empty" : undefined` (grep-confirmed ~20 "cannot be empty" occurrences)
- **`validateHttpUrl(v)`** — 5 identical sites (927, 983, 1433, 1490, 1702)
- **`filterEmbeddingModels(models)`** — 2 sites (691, 1357) of the same `!m.includes("embed"|"nomic"|"minilm"|"bge")` filter
- **Pattern:** extract-helper · **File:** `src/setup/setup.ts` · **Effort:** S · **Confidence:** High · Best effort/reward ratio in the survey.

### P4.3 — Output-shape helpers
- **`addSchemaVersionIfFull(base, detail, sourceSchemaVersion?)`** — `src/output/shapes/helpers.ts`, 11 sites of `if (detail==="full") return { schemaVersion: result.schemaVersion ?? 1, ...base }`. **Also fixes a latent inconsistency:** line ~287 omits the `?? 1`. The helper normalizes it.
- **`makePathStrippingHandler(command, arrayField)`** — `env-list.ts` and `secret-list.ts` differ **only** in field name (`envs`/`secrets`) + discriminator. One factory collapses both.
- **Pattern:** extract-helper · **Effort:** S · **Confidence:** High

### P4.4 — `filterProposalsForBatch(proposals, filters)`
- **File:** `src/commands/proposal/proposal-cli.ts` — accept (133-144) and reject (237-248) filter bodies are byte-identical (generator / maxDiffLines / olderThanMs). One helper = single source of truth; removes drift when a filter dimension is added.
- **Pattern:** extract-helper · **Effort:** S · **Confidence:** High

### P4.5 — Smaller verified dedups (batch opportunistically)
- **`copyDirectoryContents`** — `src/sources/include.ts:108-113` is a private near-duplicate of the exported `src/sources/providers/provider-utils.ts:111-123`. Unify on the exported one. **Caveat:** include's `copyPath` has slightly different inner logic — verify symlink handling before merging.
- **`bestEffortRemoveSync(path)`** — identical cleanup-on-failure `try { fs.rmSync(...) } catch {}` in `git.ts:298-306` and `npm.ts:166-174`. Move to `provider-utils.ts`.
- **`isJunkValue(value)`** — `recombine.ts:217-226` (`isJunkTag`) and 280-291 (`isJunkEntity`) share identical stopword/numeric/version/hash regexes. One helper both call.
- **`onceWarn(key)` backed by a `Set`** — `src/storage/sqlite-pragmas.ts` has two parallel module-global `let warned* = false` + guard fns (41-42/73-75/179-181). Collapse into one `Set<string>`-backed `onceWarn`. (The one production module-global worth collapsing.)
- **`classifySpawnError(err, commandName, hint)`** — identical ENOENT/EACCES errno→typed-error mapping in `env-cli.ts:348-373` and `secret-cli.ts:207-229`. Lives next to `rethrowIfTestIsolationError` in `core/errors.ts` or a spawn util.
- **Pattern:** extract-helper / dedup · **Effort:** S each · **Confidence:** Med-high (each needs its bodies confirmed at PR time)

---

## CUT — rejected, downgraded, or over-engineering (do NOT action)

| Item | Reason |
|---|---|
| **`runPhaseAutoAcceptGate` orchestrator** (improve.ts) | The `makeGateConfig`/`runAutoAcceptGate`/`maybeAutoTuneThreshold` helpers **already exist and are reused**. The four call sequences are spread across ~2400 lines, interleaved with heterogeneous per-phase control flow (extract has a separate backlog gate; reflect+distill are distinct gates). A uniform orchestrator would force a leaky shape over genuinely different bodies. (All 3 reviewers reject.) |
| **`result-envelope.ts` / `ImprovePassResult` base type** | Speculative type-inheritance layer + new file for 4 trivial copy-stamped fields. Adds a contract, deletes nothing. Owner is burned by speculative abstraction. |
| **`resolveProcessConfig<T>` generic config resolver** | Trades explicit, greppable `x ?? DEFAULT` (idiomatic, type-safe) for an indirection that erases per-field types and hides which default applies. Keep explicit. |
| **`getProfileConfigOrDefault` / `readProcessConfig` chain readers** | Survey itself flagged "2 instances, monitor for a 3rd." YAGNI. |
| **`createPhasedGateConfigs` (reflect/distill)** | Only 2 instances; survey self-deferred. |
| **`buildEventAggregateMap<T>` generic** | The 3 aggregation shapes genuinely differ (ts-map vs `{hasSignal,positive,negative}`). A higher-order callback for 3 divergent outputs adds indirection. **Salvage instead:** extract only the concrete inline `buildFeedbackSummaryMap` (improve.ts:2973-3007) as a plain named function. |
| **`extractRefSet(...arrays)` Set-dedup helper** | `new Set([...a,...b].map(r=>r.ref))` is idiomatic; survey tags it "adds." |
| **Inline / delete `createProviderRegistry`** | Lead-verified 2 real callers (`registry/factory.ts:27`, `sources/provider-factory.ts:24`). Inlining re-duplicates register/resolve into two files — a net **addition** of duplication. Keep the 14-line named seam. (Only trivially-justifiable trim: drop the unused `list()` — not worth a PR on its own.) |
| **`tryResolveTarget` unified resolver** (installed-stashes) | Three matchers have genuinely different inputs (installed refs vs stash url/path/name vs git-repo-url parsing). A discriminated-union dispatcher is speculative strategy-pattern. Leave the three local matchers. |
| **Agent-builder factory parametrization** | Claude/opencode builders share ~70%, but the deltas (`normalizeTools`, `--print`) are the load-bearing differences; a config-object factory interleaves them and *reduces* readability of "what's different per platform." Defer until a 3rd harness lands. |
| **`builders/` mirror directory** | Whole new directory + index collector for 2 statically-registered builders. Speculative restructure. |
| **`LogBuilder` class** (tasks/runner) | A stateful builder for 3 log paths is a pattern import; the shared piece (`streamLines`) already exists. At most a plain `buildRunLog(header, sections)` fn — but borderline at 3 sites. Lower priority / skip. |
| **`parseJsonMetadata<T>(json, schema[])` declarative extractor** | Only 2 sites; the field-schema array is more machinery than the inline guards. If anything, a plain `parseJsonSafe(json)` (parse+catch only) — skip the schema layer. |
| **`SessionSummary` `buildSessionRefFields<T>` spread-builder** | `...(x!==undefined?{f:x}:{})` is idiomatic TS; a generic field-stripper erodes type inference for 3-4 line blocks. |
| **Optional-field conditional-spread helper (repo-wide)** | Flagged across sources/integrations/output slices — it is ONE idiomatic TS idiom. Do **not** create N helpers. Collectively reject, not collectively abstract. |
| **`config-walker` `walkPath` generic** | Zod-introspection vs object-indexing bodies differ enough that it adds a layer without savings. |
| **`getObj`→`getNestedObj(path[])` in config-migration** | Survey "adds"; the specialized `getImproveProcess` is greppable and the path-array form is not clearly better. Low value; skip. |
| **`normalizeVersion`/`compareConfigVersion` export, `events.ts` resolveDbPath/resolveNow seam, `parse-args` validators, `wiki-templates` replaceAll, config-path-walk** | All self-rejected as fine/single-use/YAGNI. No action. |
| **content/asset hashing "duplicate"** | False positive: session-events hash vs file-content hash are semantically different data. |
| **graph.ts "3 identical db blocks"** | Lead-verified only **2** are identical (414-417, 464-467); the 350-357 IIFE is a different shape. Downgraded into P3.4 as 2 sites. |
| **`asNonEmptyString` vs `firstString` "dead code"** | They are functionally equivalent now; collapsing `firstString`→`asNonEmptyString` is a trivial 1-fn delete, not a finding. Do opportunistically, not as a tracked task. |

---

## Sequenced roadmap (subtraction-first)

1. **P0.1 `withProcessLock`** — real lock-leak bug; ship first, with a throw-in-stage test.
2. **P0.2 `mergeLegacyEntry`** consolidation — fixes manifest metadata loss; small, verify intended semantics.
3. **P1 db.ts trio in one PR** — `chunkArray` (10) + `parseEntryJson` (6) + `clamp01` (3) + `BM25_FIELD_WEIGHTS`. All pure subtraction in one hot file, ~40 lines removed, zero behavior change.
4. **P2 byte-identical batch** — `caps`, `homeDir` (reuse core/paths), `ensureParentDir`, `normalizeConfidence` (3 copies, route through clamp01), `withRegistryCacheDb`, `buildOpenAiHeaders`. Near-zero review cost.
5. **P3.2 `clamp01` repo-wide** finalize (merges P1.3 + P2.4 + search-display).
6. **P3.3 `buildWhereClause`** + **P3.5 `logUsageEventSafely`** — small, real.
7. **P3.1 `asArray`/`asRecord`** — promote the existing `github.ts` helpers to core, retire the output/integrations sites. Larger mechanical PR; do once stable.
8. **P3.4 `withXDb` adoption** at graph/workflows/tasks (reuse existing convention; verify each open/close).
9. **P4 localized cleanups** — lint trio, setup validators, output-shape helpers, `filterProposalsForBatch`, and the P4.5 batch — pick up opportunistically; each is isolated and low-risk.

**Guiding rule throughout:** if a step starts *adding* an interface/class/factory rather than deleting copies, stop — it belongs in CUT.
