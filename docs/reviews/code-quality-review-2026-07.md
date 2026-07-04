# AKM — End-to-End Code Quality Review

_Reviewer: staff-level code-quality audit • Date: 2026-07-04 • Scope: `src/` (~107K LOC, 410 TS files) + `tests/` (~125K LOC, 459 files)_

---

## Executive summary

AKM is a **mature, disciplined codebase with a serious structural-mass problem**. The engineering fundamentals are unusually good: a typed error hierarchy with stable exit codes, `assertNever` exhaustiveness, near-zero `as any` (16 in 107K LOC), near-zero `TODO/FIXME` (8), consistent license headers, a genuinely excellent test-isolation harness, and real dependency-injection seams in the newer code. This is not sloppy code.

The problems are almost entirely **architectural**, and they cluster into a small number of root causes that repeat across every subsystem:

1. **Pervasive god functions** — ~12 functions of 400–1,500 lines that fuse IO, business logic, LLM calls, formatting, and telemetry in one scope. This is the single largest driver of poor testability.
2. **Ambient dependency access** — production code resolves `config`, `paths`, and the `Database` from process-global state (`process.env` → filesystem → module-level singleton caches) instead of receiving them as arguments. The entire ~125K-LOC test suite and its isolation harness exist largely to compensate for this. *The harness is scar tissue; the wound is ambient dependency access.*
3. **Un-consolidated parallel pipelines (DRY failures)** — the same skeleton is copy-pasted rather than abstracted: frontmatter serialization (5+ copies), source fetch→cache pipelines (4×), session-log providers (2×), task-backend plumbing (3×), duration parsers (4+ copies, with a semantic conflict), inline LLM JSON schemas (6×), and search result-filtering (2×).
4. **God / junk-drawer modules** — `db.ts` (1,788 LOC, ~9 domains), `common.ts` (15 responsibilities), `wiki.ts` (26 exports), `output/text/helpers.ts` (57 functions + embedded agent policy).
5. **Config over-engineering** — a 1,012-line Zod schema with **219 `.optional()` and 3 `.default()`**, many knobs marked "reserved / advisory / observe-only / removed" (YAGNI), accessed everywhere via a fragile deep optional chain that hardcodes the `default` profile.
6. **Half-finished refactors** — a proper repository layer exists (`storage/repositories/`) but the core index SQL was never migrated into it, and two of those "repositories" are inverted facades that import the SQL back out of the `db.ts` god module.
7. **Speculative complexity / dead code** — a train/held-out grid search that runs **at module import** dragging a 300-line fixture corpus into the production bundle; a fully-built-but-unwired `review_pressure` feature; 14 files gated behind `DEFAULT OFF` flags.

None of the recommended fixes are rewrites. They are **consolidation and extraction** against patterns the codebase has already demonstrated it knows how to build.

**Overall grade: B–.** Excellent primitives and test discipline; held back by concentrated structural debt in `commands/improve/`, `indexer/`, and the config-access layer.

---

## Top architectural problems (ranked)

### A1. God functions everywhere — CRITICAL

A census of functions >300 lines (measured):

| Function | File:line | ~LOC |
|---|---|---|
| `runImprovePreparationStage` | `commands/improve/preparation.ts:772` | ~1,490 |
| `akmConsolidateInner` | `commands/improve/consolidate.ts:988` | ~908 |
| `akmImprove` | `commands/improve/improve.ts:406` | ~850 |
| `akmReflect` | `commands/improve/reflect.ts:955` | ~737 |
| `buildHealthHtmlReplacements` | `commands/health/html-report.ts:396` | ~655 |
| `runImproveLoopStage` | `commands/improve/loop-stages.ts:74` | ~616 |
| `akmDistill` | `commands/improve/distill.ts:654` | ~566 |
| `akmExtract` | `commands/improve/extract.ts:784` | ~474 |
| `runImproveMaintenancePasses` | `commands/improve/loop-stages.ts:889` | ~462 |
| `indexEntries` | `indexer/indexer.ts:631` | ~378 |
| `runGraphExtractionPass` | `indexer/graph/graph-extraction.ts:460` | ~450 |
| `runAgent` | `integrations/agent/spawn.ts:309` | ~200 |
| `akmHealth` | `commands/health.ts:120` | ~230 |
| `stepSmallModelConnection` | `setup/steps/connection.ts:436` | ~273 |

Each interleaves file IO, DB transactions, LLM calls, JSON parsing, gating, proposal writes, event emission, and result-envelope construction. They are the root cause of most other problems: they can't be unit-tested (hence the DI-seam sprawl), they force ambient config re-loading, and they are where the copy-paste divergence lives.

**Fix:** decompose each into named passes over a small explicit context object. The codebase already has the target shape — `curate.ts`, `drain.ts`, `computeSalience`, `evaluateCollapseAlerts` are small, pure, individually testable. Make the god functions look like those.

### A2. Ambient dependency access → the test harness is a symptom — CRITICAL

- `loadConfig()` called **94×** across `src/`, `resolveStashDir()` **42×**, `getDbPath()/getConfigPath()/getCacheDir()` **79×** — not just at the CLI boundary but deep inside `indexer/db/db.ts`, `indexer/indexer.ts`, `tasks/runner.ts`, `sources/providers/git-stash.ts`, `core/env-secret-ref.ts`.
- **51 sites** of the optional-DI anti-pattern `x ?? loadConfig()` / `?? resolveStashDir()` / `?? getDbPath()`. A caller can inject config at the top boundary, but a function three calls deep re-reads the global anyway.
- The config **singleton** `cachedConfig` (`core/config/config.ts:118`, keyed on mtime+size) is fragile enough that the code documents a write-race and requires `resetConfigCache()` to be threaded through the preload, the CLI test helper, and individual tests.
- Production ships **17 `_set…ForTests` module-level seams** and **16 `*Fn` injection fields on `AkmImproveOptions`** purely to make monoliths testable — DI grafted onto god functions instead of decomposition.

**Consequence:** 92 test files sandbox a real filesystem and 16 open a real SQLite DB to test logic that is pure once the ambient reads are removed. The isolation harness (`tests/_preload.ts`, `_helpers/sandbox.ts`, `lint-tests-isolation.ts`) is excellent engineering that mostly exists to contain this.

**Fix:** thread a `RunContext { config, stashDir, dbPath }` from the CLI boundary down; make `getDbPath(env = process.env)` a defaulted parameter like `getCacheDir` already is (`core/paths.ts:139`); retire the `?? loadConfig()` pattern in favor of required parameters; move caching onto the caller-owned context so there is no global to reset.

### A3. Config schema over-engineering + deep-chain access — HIGH

- `core/config/config-schema.ts` (1,012 LOC): **219 `.optional()` vs 3 `.default()`**. Nearly everything is optional-with-no-default, so every consumer re-implements its own inline fallback — default logic is scattered instead of centralized.
- Knobs openly marked non-functional: `emitAs` "Reserved; v1 always emits 'workflow'"; `mergeInformationFloor` "ADVISORY in v1 — counted, never refused"; `collapseDetector` "observe-only in v1"; `homeostaticDemotion` "was removed" but still tolerated.
- `config.profiles?.improve?.default?.processes?.X` deep chain repeated **20+ times** across improve stages — and it **hardcodes the `default` profile** even in paths that already resolved the active profile (a latent bug the code has already been bitten by: `reflect.ts:143`, `extract.ts:679`, `collapse-detector.ts:480`).
- `ImproveProcessConfigSchema` is a god-object flattening `consolidate`/`extract`/`recombine`/`procedural`/`distill`/`triage` knobs into one shape, with per-field comments policing which fields are "meaningful on process X" — the type permits nonsensical combinations.

**Fix:** split into per-process discriminated schemas; add `.default()` where a default exists so consumers stop re-deriving it; add a typed accessor `getProcessConfig(config, "distill", "cls")` that resolves the *active* profile and returns a validated shape; delete reserved/observe-only/removed fields until the feature ships.

### A4. Half-finished repository extraction / inverted layering — HIGH

`storage/repositories/` contains 12 domain repositories (proposals, events, workflow-runs, embeddings, …) — the exact decomposition `db.ts` needs. But the original index SQL (entries/vector/FTS/utility/registry-cache) was **never migrated**; it still lives in the 1,788-line `indexer/db/db.ts` god module. Worse, `storage/repositories/registry-cache.ts` and `embeddings-repository.ts` are **inverted facades**: they `import { upsertRegistryIndexCache, getRegistryIndexCache } from "../../indexer/db/db"` — the "storage" layer depends on the "indexer" god module rather than owning the SQL.

**Fix:** finish the extraction. Move entries/vector/FTS/utility/registry SQL into `storage/repositories/*`; have `indexer/db/db.ts` become a thin composition over them; make the dependency arrow point storage → (nothing), indexer → storage.

### A5. Un-consolidated parallel pipelines — HIGH

Same skeleton copy-pasted rather than abstracted:
- **Frontmatter serialization** reinvented 5+ times, divergently (`distill.ts:466`, `content-repair.ts:94/135/158`, `recombine.ts:985`, `distill-promotion-policy.ts:157`) — while `reflect.ts:808` correctly uses the canonical `serializeFrontmatter`. So distilled/recombined/reflected assets serialize inconsistently.
- **Source fetch→cache→detect-root→build-lock** duplicated across git/npm/website (`git-install.ts:62`, `npm.ts:97`, plus TTL-cache logic re-copied in `git-provider.ts:107` vs `website-ingest.ts:105` with their own `CACHE_TTL_MS`).
- **Session-log providers** `ClaudeCodeProvider` (321 LOC) and `OpenCodeProvider` (435 LOC) re-implement the same `isAvailable/watchRoots/listSessions/readSession/JSONL-loop` skeleton.
- **Task backends** cron/launchd/schtasks each redeclare near-identical `*Exec`/`*Fs`/`*Options` interfaces and repeat `throw new ConfigError(...stderr||stdout||"no output"...)` ~9×.
- **Search result filtering** in `db-search.ts` written twice (empty-query branch `:317` vs scored branch `:494`) — and already diverged in dedup/filter order.
- **Inline LLM JSON schemas** (6 near-identical `*_JSON_SCHEMA` literals) and **event-emission envelopes** (`distill_invoked` at 8 sites, `procedural_compiled` at 5).

**Fix:** one shared template per family — `serializeFrontmatter` everywhere, `syncArtifact({fetch,verify})` + `withFreshnessCache({ttlMs,staleMs})`, `AbstractSessionLogProvider`, `runOrThrow(exec,args,label)` + generic `BackendExec<Extra>`, `applyResultFilters(...)`, a schema-builder factory, per-stage `emit<X>()` closures.

---

## Confirmed concrete defects (not just style)

| # | Defect | Location | Severity |
|---|---|---|---|
| B1 | `--since 5m` means **5 months** in one parser and **5 minutes** in others (same `(\d+)([dhm])` grammar, opposite `m` semantics). 4+ copies of the parser. | `commands/health.ts:93` (m=30d) vs `commands/improve/consolidate.ts:2583` (m=60s); also `health/windows.ts`, `remember.ts` | HIGH |
| B2 | `config` command bypasses `defineGroupCommand` and hand-maintains `CONFIG_SUBCOMMAND_SET` that is already desynced — missing `validate`/`migrate`, so those subcommands fall through and emit a second `config list` envelope. | `commands/config-cli.ts:428` | HIGH |
| B3 | `getEmbeddableEntryCount` is a **byte-identical copy** of `getEntryCount` (both `SELECT COUNT(*) FROM entries`); the name promises a filtered count and `verifyIndexState` relies on the misleading semantics. | `indexer/db/db.ts:944/949` | MEDIUM |
| B4 | Full-rebuild wipe hand-writes `DELETE FROM …` inline and can drift from the `deleteRelatedRows` cascade (`utility_scores_scoped` cleaned in one, not the other). | `indexer/indexer.ts:894` | MEDIUM |
| B5 | A **raw NUL byte (U+0000)** is embedded as a literal separator in a template string, making the whole source file register as binary to grep/editors/git. Intent is valid (a separator that can't collide) but should be ` `. | `commands/improve/reflect-noise.ts:285` | LOW |
| B6 | `NpmSourceProvider.path()` **throws** unless pre-populated — one strategy implementer cannot honor a core interface method. | `sources/providers/npm.ts:55` | MEDIUM |
| B7 | `runFtsQuery` swallows **all** query errors and returns `[]` silently, while the sibling `searchBlobVec` warns — an FTS schema/corruption error is invisible. | `indexer/db/db.ts:842` | MEDIUM |
| B8 | `FEEDBACK_FAILURE_MODES` defined identically in two files; only one copy is consumed. | `core/config/config.ts:57` + `config-schema.ts:62` | LOW |
| B9 | Two `resolveParentRef` implementations with **different** parent-resolution semantics, so the contradiction-edge producer and consumer can disagree. | `memory/memory-improve.ts:816` vs `memory-contradiction-detect.ts:135` | MEDIUM |

---

## File-by-file findings (highest-impact, by subsystem)

### `commands/improve/` (~25K LOC) — the debt epicenter
- **God functions H1–H8** (see A1 table): `preparation.ts`, `consolidate.ts`, `improve.ts`, `reflect.ts`, `loop-stages.ts`, `distill.ts`, `extract.ts`, `improve-auto-accept.ts`.
- **`akmReflect` resolves the source asset twice** by two strategies (indexer `lookup` at `reflect.ts:1031` vs hand-built path at `:1458`, shadowing `assetContent`).
- **`processSession` takes 18 positional args** (`extract.ts:433`); empty-result envelope duplicated 4–6×.
- **Module-load grid search**: `DEFAULT_PROMOTION_POLICY_SELECTION = selectPromotionPolicy(DEFAULT_PROMOTION_POLICY_CORPUS)` runs a 3-model × ~10-threshold benchmark at import, pulling a ~300-line hardcoded corpus into the production bundle; two corpus entries defined twice (dead). `distill-promotion-policy.ts:972`. **Freeze the weights as a constant; move the benchmark to a `*.bench.test.ts`.**
- **Unwired `review_pressure`** (`outcome-loop.ts`): persisted column, constants, increment/decay branches, return field — nothing reads it. **Wire it or delete it.**
- **DRY (D1–D7)**: frontmatter serialize (5+), read-parse-mutate-write frontmatter (3× in `memory/`), derived-memory scan helpers (duplicated + divergent), LLM-call+JSON-parse (3 ways), event envelopes (copy-paste), `*_JSON_SCHEMA` (6×), rejected-proposal fetch, comparators, `MAX_REJECTED_PROPOSALS` declared twice.
- **Misleading names**: `writeImproveResultFile` writes a **DB row, not a file**; `relativeImproveResultPath` returns a fabricated `state.db/improve_runs/id` string (`improve-result-file.ts`).

### `indexer/` (~14K LOC)
- **`db.ts` god module** (1,788 LOC, ~9 domains) — split by table into `entries-repo`/`vector-repo`/`fts-repo`/`utility-repo`/`usage-repo`, and move registry/lessons/workflow helpers out entirely.
- **`indexEntries`** (378 LOC) — two near-duplicate scan branches (wiki-root vs normal) with copy-pasted `seenPaths`/incremental-skip logic; extract `scanSourceDirs()` (pure) + `persistDirRecords()`.
- **Raw SQL in the indexer hot path** breaks the "SQL lives in db.ts" invariant (`indexer.ts:418, 894`, `lookup` at `:1713`).
- **Duplicated filter pipeline** in `db-search.ts` (see B-table); **passes re-walk + re-read every memory file twice per invocation** (`staleness-detect.ts:276`, `graph-extraction.ts:1135`) — no `StashFileReader` cache, no repository seam.
- **`metadata.ts`** mixes a 108-line `StashEntry` interface + `validateStashEntry` + frontmatter apply + package.json IO + generation, with the same ~15 fields whitelisted in two parallel maps.
- Dead: `IndexRunContext.graphExtractionResult` never read; `void config`/`void sources` suppression hacks; 28-line CRDT ADR narrative at the top of `indexer.ts` (belongs in `docs/`).

### `core/` (~10K LOC)
- **Config singleton + schema** (A2, A3).
- **`common.ts` junk drawer** (15 responsibilities: asset types, URL validators, atomic writes, stash-dir resolution, fetch-with-retry, stdin, date/string coercers, `groupBy`, `isProcessAlive`). Self-admitted internal dup (`asNonEmptyString` ≡ `firstString`) and a dead `if/else` with identical arms in `writeFileAtomic`. **Split by concern.**
- **`loadUserConfig` mixes read + on-disk migration + backup + an 8-line banner to stdout/stderr** — a "load" that mutates disk and corrupts machine-readable pipelines. **Separate load from migrate-on-disk; route the banner through `warn.ts`.**
- **`parseSourceSpec` switch is non-exhaustive** — `SourceSpec` declares 6 variants, the parser handles 4; `github`/`local` silently coerce. Use `assertNever`.
- **Keep as-is (exemplary):** `errors.ts`, `assert.ts`, `best-effort.ts`, `events.ts` (`EventsContext` is the DI model config should copy).

### `commands/` (non-improve) + CLI
- **Duplicated bulk accept/reject** handlers (~90% identical) with the batch engine living **inside the CLI parse layer** (`proposal-cli.ts:107/205`) — extract `bulkAdjudicateProposals(...)` into `proposal.ts`.
- **`akmHealth` god function** (230 LOC) — split into `collectTaskMetrics`/`collectImproveMetrics`/`runChecks`/`computeWindows`.
- **Hand-rolled argv re-scanners** fighting citty (`parseAllFlagValues`, `findCittyTopLevelCommand`, `resolveHelpMigrateVersionArg` ~48 LOC of edge-case handling, `env unset`'s hardcoded global-flag list). Consolidate or accept citty's behavior.
- **`repository.ts`** (1,327 LOC) mixes the proposal store with a hand-rolled unified-diff renderer — move `formatUnifiedDiff`/`formatNewAssetDiff` to `proposal-diff.ts`.
- **Keep (exemplary):** `defineJsonCommand`/`defineGroupCommand`, `classifyExitCode`+`EXIT_CODES`+`assertNever`, `drain.ts`/`curate.ts` decomposition, `confirm.ts`/`clack.ts` seams.

### Supporting subsystems
- **`llm/`** — healthy layering (client → feature-gate → structured-call). But `graph-extract.ts` (929 LOC) has a **divergent second LLM path**: single-body uses the shared `callStructured` seam; the batch path hand-rolls `tryLlmFeature`+`chatCompletion`+try/catch+`isContextSizeError` inline — the exact scaffold `structured-call.ts` exists to remove. `isProcessEnabled` (`feature-gate.ts:175`) duplicates the authoritative `FEATURE_LOCATION` map with ad-hoc string matching.
- **`output/`** — `text/helpers.ts` is a 57-function dumping ground; **`formatShowPlain` (160 LOC) embeds agent-behavior policy** (workflow redirection, APPLY-directive branching) in a module whose header claims "pure plain-text formatting." Move directive generation to `agent-directives.ts` returning structured data.
- **`sources/`** — weakest abstraction (A5, B6): `SourceProvider.sync()` returns `void` while callers re-derive the lock data; refresh happens two ways (direct `syncMirroredRepo` vs `provider.sync()`). **`website-ingest.ts` (745 LOC)** fuses SSRF filtering + URL normalization + fetch/redirect + crawl queue + HTML→markdown + FS writes.
- **`setup/`** — `connection.ts` steps (256–273 LOC each) fuse prompting IO + network probing + config mutation, so the "which model given a probe result" logic can't be tested without driving the prompt stack. Split into `collectInput`/`probe`/`deriveConfig`.
- **`integrations/`** — anemic `AkmHarness` (metadata-only; real behavior in 4 side tables with an **import-time `throw`** as a drift check); claude vs opencode session-log providers are parallel copy-paste; `runAgent` (200 LOC) + `runOpencodeSdk` re-copy the timeout ladder and rebuild the result envelope ~6× each; `caps()`/`homeDir()` duplicated across 3 harness dirs.
- **`storage/`** — repository pattern with **no shared base**; each repo re-implements row→domain mapping + `JSON.parse(metadata_json)` glue. Add a `jsonColumn()` codec + `Repository<Row,Domain>` base.
- **`registry/`** — `resolve.ts` (757 LOC) embeds a full hand-written semver engine (`parseSemver`/`satisfiesRange`/`maxSatisfying`) — extract `registry/semver.ts`.
- **`wiki/`** — `wiki.ts` (1,181 LOC, 26 exports) spans validation, path resolution, FS scan, frontmatter parse, search, lint, index-gen. Split by concern.

---

## Recommended refactoring plan

**Phase 0 — Shared utilities first (removes the excuse for divergence).**
Establish/enforce the canonical primitives so subsequent decomposition has somewhere to land:
- `serializeFrontmatter`/`assembleAsset` used everywhere (kills D1/D6).
- `mutateFrontmatter(path, fn)` for read-parse-mutate-write (kills D2).
- `parseDuration(spec)` in `core/time.ts` with one documented unit table (kills B1 + 4 copies).
- Typed `getProcessConfig(config, section, process)` resolving the active profile (kills A3 deep-chains + the hardcoded-`default` bug).
- Enforce `bestEffort`/`errMessage` as the one error idiom (kills the 3-idiom split).
- `applyResultFilters(...)` for search (kills B-table dup).

**Phase 1 — Decompose the top god functions** (A1): the four biggest improve entry points, `indexEntries`, `runAgent`, `akmHealth`, the `connection.ts` steps. Extract named passes over small context objects. The DI-seam sprawl (17 `_setForTests` + 16 `*Fn`) collapses as a side effect.

**Phase 2 — Finish the repository extraction** (A4): move index SQL out of `db.ts` into `storage/repositories/*`; invert the two facade repositories; give the repos a shared base with a JSON-column codec.

**Phase 3 — Thread `RunContext`** (A2): replace ambient `loadConfig()`/`resolveStashDir()`/`getDbPath()` with an injected context from the CLI boundary; parameterize `getDbPath(env)`. Then most "unit" tests drop the filesystem sandbox and the harness shrinks to leaf-effect resets.

**Phase 4 — Delete speculative weight** (see Technical debt below).

---

## Suggested design patterns (only where justified)

- **Repository pattern (finish it)** — you already chose it; complete the migration so there is one DB-access idiom, not two. *Justified: eliminates the `db.ts` god module and the inverted facades.*
- **Template Method / Strategy for parallel pipelines** — `AbstractSessionLogProvider`, `syncArtifact({fetch,verify})`, `BackendExec<Extra>`. *Justified: collapses 4 copy-paste families into one seam each.*
- **Dependency injection via a `RunContext` object** — not per-function `*Fn` seams. *Justified: replaces 33 test-only seams with one honest boundary.*
- **Discriminated unions for config** — per-process schemas instead of one flattened god-object; `assertNever` on the source-spec switch. *Justified: makes illegal states unrepresentable, removes comment-policing.*
- **Result-object + separate renderer** — commands return typed data; pure renderers format it. *Justified: kills 22 brittle formatted-string tests and the agent-policy-in-formatter smell.*

_Do **not** add patterns for their own sake — the current abstractions that pay their way (typed errors, exit-code classifier, command-definition helpers, task-backend strategy, embedder strategy) should be left alone._

---

## Testing improvements (change production code, not tests)

The suite is disciplined (zero `mock.module`, only 2 snapshots, a leak tripwire, a shrink-only coverage ratchet) — but a large fraction of its bulk compensates for ambient dependency access. Highest-leverage production-side changes:
1. **Inject config/paths/db** (A2) so most "unit" tests drop the filesystem sandbox entirely.
2. **Parameterize `getDbPath(env=process.env)`** like `getCacheDir` already is, so DB tests pass an in-memory/temp path directly.
3. **Split structured results from string rendering** so tests assert on objects, not glyphs (`proposal-show-severity-render.test.ts`, `health-html-report.test.ts` are the brittle offenders).
4. **Extract pure scoring/ranking functions** (mirror `curate-logic.test.ts`) so ranking/graph-boost logic is unit-tested on in-memory inputs instead of through full index+search integration flows — this lets `tests/coverage-hardening/` (15 files of trivial-branch hitting) be retired.
5. **Prefer parameter injection over `_setXForTests`** for new code — the `akmExtract(harnesses)` model is the target; as call sites convert, seams and their reset scaffold shrink.

---

## Technical debt to delete or simplify

- **Module-load grid search + 300-line corpus** in the production bundle (`distill-promotion-policy.ts:972`) → freeze constant, move to bench test.
- **Unwired `review_pressure`** (`outcome-loop.ts`) → wire or delete.
- **14 `DEFAULT OFF` feature-flag paths** across improve stages → delete the dead branches until the feature is actually turned on (YAGNI).
- **Reserved/advisory/observe-only/removed config knobs** (`emitAs`, `mergeInformationFloor` advisory bits, `homeostaticDemotion`, `collapseDetector` observe-only) → delete until shipped.
- **`getEmbeddableEntryCount`** duplicate (B3), **duplicate `FEEDBACK_FAILURE_MODES`** (B8), **dead `writeFileAtomic` if/else**, **`IndexRunContext.graphExtractionResult`**, `void config`/`void sources` hacks, duplicate corpus fixtures.
- **The NUL-byte literal** (B5) → ` `.
- **Comment archaeology** — ~80 `#NNN`/`WS-`/`R4`/"the former X was removed" markers in `preparation.ts`, the CRDT ADR block in `indexer.ts`, stale line-number references (`env-cli.ts` cites a non-existent `cli.ts:1335`). Move ADRs to `docs/`; strip changelog comments to the invariant being protected.

---

## Prioritized implementation roadmap

### CRITICAL (do first — highest leverage, unblocks the rest)
1. **Phase 0 shared utilities** — `serializeFrontmatter` everywhere, `mutateFrontmatter`, `parseDuration` (fixes B1), `getProcessConfig` (fixes the hardcoded-`default` bug), one error idiom. Low risk, immediately kills the worst DRY divergence and one real bug.
2. **Decompose the 4 biggest improve god functions** (`preparation`, `consolidate`, `improve`, `reflect`) into named passes.

### HIGH
3. **Thread `RunContext`** for config/paths/db; parameterize `getDbPath`.
4. **Split `db.ts`** and **finish the repository extraction** (invert the facades).
5. **Fix B2** (config group → `defineGroupCommand`), **B6** (npm `path()`), **B7** (silent FTS swallow).
6. **Dedup `db-search` filter pipeline**; add `StashFileReader` cache so passes stop re-reading disk.
7. **Consolidate the parallel pipelines**: session-log providers, source fetch-cache, task backends, `runAgent`/`runOpencodeSdk` envelope.

### MEDIUM
8. Split god/junk-drawer modules: `common.ts`, `wiki.ts`, `output/text/helpers.ts` (+ extract agent-directives), `website-ingest.ts`, `registry/semver.ts`.
9. Per-process config schemas (discriminated union); add `.default()`s.
10. Split structured results from renderers; extract pure scorers; retire coverage-hardening tests.
11. Fix B3/B4/B8/B9; extract `bulkAdjudicateProposals`; split `akmHealth`.

### LOW
12. Delete speculative/dead code (grid search, `review_pressure`, `DEFAULT OFF` branches, reserved knobs).
13. Fix B5 (NUL byte); strip comment archaeology; hoist duplicated `caps()`/`homeDir()`; fix stale doc references.

---

## What to preserve (do not "refactor")

`core/errors.ts` (typed hierarchy + hint mapping), `assert.ts`, `best-effort.ts`, `events.ts` (`EventsContext` DI model), the CLI `defineJsonCommand`/`defineGroupCommand` + `classifyExitCode`/`EXIT_CODES`, `tasks/backends` (textbook strategy pattern), `llm/` transport→gate→structured-call layering, `drain.ts`/`curate.ts` decomposition, the pure scorers (`computeSalience`, `evaluateCollapseAlerts`), and the test-isolation harness itself. These are the model the rest of the codebase should converge toward.
