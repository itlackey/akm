# AKM CLI — Architecture Refactor Plan (Design-Level)

## Execution status (last updated 2026-06-26, D-series in progress)

**✅ R/X core MERGED to `main` via PR #667** (merge commit `b1f7960a`; full history). **Every non-deferred item (R1–R9, X1–X3) is DONE and shipped.**

**D-series progress (each its own branch + PR off `main`):**
- **D3** — ✅ MERGED, PR #669 (`consolidate.ts` 3,442 → 2,790).
- **D2** — ✅ MERGED, PR #670 (scoped: migration registry isolated + index-cache DDL relocated; per-table CRUD split deliberately skipped as cohesion-only — see row).
- **D1 + D1b + D1c** — 🟡 OPEN, PR #671 (`improve.ts` **5,395 → 1,443 LOC**). All gates green: lint 0 / tsc 0 / unit 5,274 / integration 1,558 / node-compat 22.
- **X4** — ⏸️ the only item not started. Now unblocked by D2/D3/D5 for the *state/index* offenders, but still gated on the *command-layer* raw-SQL offenders (`salience.ts`/`outcome-loop.ts`/`homeostatic.ts`). See row.

Each ✅/🟡 was individually verified by hand AND gated (tsc 0 / biome 0 warnings / unit + integration + node-compat green).

> **CI/Node-parity note (added during the PR):** the PR also fixed `tests/integration/node-compat.test.ts`, which had been `skipIf(!ENABLED)`-gated and **pre-existingly 10/22-failing on `main`** (verified by building+running main directly) — exposed only when the new `node-smoke` job (`f7d753bb`) first ran it. 8 were test bugs (commands invoked with wrong names/syntax, a same-process `spawnSync` deadlock in the URL-import test, a duplicate-import collision, the init test pointing `--dir` at a pre-created dir); **1 was a real production bug** — `setup --yes` leaked @clack's backup banner to **stdout**, corrupting `setup --yes | jq` on BOTH runtimes (fixed by routing it to stderr in JSON mode, `b1157544`); 1 (`history` crash) was resolved by indexing first so both runtimes succeed identically. **No parity assertions were weakened.**

> **Test-host note:** the integration suite (`bun run test:integration`, single-process `--parallel=1`) finishes in **~2 min** on an idle host but APPEARS to hang for 100+ min under CPU contention (concurrent workflow subagents, or a runaway `bun test` from a prior session pinning a core). It is NOT a code hang — kill stray `bun test` procs (`ps … | grep 'bun test'`) and re-run on idle cores to verify green. Bun buffers all test output until completion, so a contended run shows an empty log, not partial progress.

| Task | Status | Notes |
|---|---|---|
| **R4** delete dead provider interface | ✅ DONE `65f2006b` | −574 LOC; zero-call-site v1 surface removed |
| **X1** `withManagedDb`/`withStateDb` seam | ✅ DONE `f511e10c` `c3ec1aad` `1484b180` | Seam + async/path variants; **22 sites converted, 8 deliberately left** (long-lived run handles, guarded conditional opens, open-only try/catch — the seam can't express "soft-fail to undefined" or "catch open but not body") |
| **X2** `callStructured()` template | ✅ SUBSTANTIVELY DONE `86797077` `b55b51e5` +3 | Type-half (`86797077`) + seam (`b55b51e5`) + the 3 genuinely-scaffold-replicating callers migrated via TDD (`1b3ab4d2` memory-infer; `714703bd` metadata-enhance; `15f39a01` graph-extract leaf). **SCOPE FINDING (verified):** the plan's "20 `chatCompletion` importers" conflated true replicators with incidental importers. Only callers that replicate the `classify(context_limit/html/other)` ladder are candidates — `grep -c "isContextSizeError\|provider_html_error\|LlmCallError"` is **0 for every remaining caller** (distill/extract/consolidate/schema-repair/memory-contradiction/etc.). A batch-2 triage of 3 of them all correctly **SKIPPED as poor fits** (split parse outside the gate, ungated, non-LLM validate callbacks, try-bodies wrapping far more than the call) — migrating would be net-positive force-fitting. Only remaining true target: **consolidate's leaf, folded into D3**. No further standalone X2 migrations. |
| **R3** registry cache-fetch Template + layering fix | ✅ DONE `7d9cb8a3` | |
| **R1** typed PhaseResult (kill cast-injection) | ✅ DONE `cd9af204` | |
| **D4** split `git.ts` | ✅ DONE `a4a37c28` | → git-provider / git-install / git-stash |
| **D5** extract `WorkflowAssetLoader` | ✅ DONE `992157ba` | |
| **R7** `defineGroupCommand` seam | ✅ DONE `0061d1b8` | |
| **R9** dir-staleness pass extraction | ✅ DONE `05d4b1fa` | |
| **R5** source-kind dispatch (was: descriptor table) | ✅ DONE `5966a209` | Design team REJECTED the table (compiler-probe receipt: `KitSource = SourceSpec["type"]` over-widened install fields to the 6-member config union — why `Record<KitSource,_>` couldn't gate). Implemented the no-table shape via TDD (characterization-pinned `buildInstallRef` outputs): added `InstallKind` (real 4-set), re-pointed the 4 install-only `.source` fields, moved `buildInstallRef` static-index→resolve.ts as an **exhaustive switch** (github now an explicit case, was `default` — byte-identical), dropped the `SourceSpec` cast + `never`-exhaustiveness. Behavior byte-identical; production net-negative (+test). Design: `docs/technical/r5-design.md`. |
| **R6** collapse output/text+shapes wrappers | ⏭️ NOT VALID | Premise was wrong — those modules are registration entries delegating to output-layer helpers, **not** command-wrappers. Nothing to inline. Removed from scope. |
| **X3** `executeRunner()` kind-switch | ✅ DONE `bf84d441` | TDD; one dispatch in `integrations/agent/runner-dispatch.ts` + `RunnerSeams`; deleted both copied switches (reflect+drain) + `runProfileJudgment`. net −43 |
| **R2** route `ensureSourceCaches` through `sync()` | ✅ DONE `eaef79a4` | TDD; **fixed the verified npm-never-refreshed bug** — two hardcoded loops → one `provider.sync({force})` loop. net −10 prod |
| **R8** `runImproveSession` lifecycle lift | ✅ DONE `5e16311e` | TDD; SIGNAL_TABLE + handlers + persist-before-exit lifted to testable `improve/improve-session.ts` (fake-SIGTERM unit test, no child process). net −20 CLI |
| **D3** decompose `consolidate.ts` (3,442 LOC) | ✅ MERGED PR #669 | → orchestrator + `consolidate/{types,chunking,sanitize,eligibility,merge}.ts` (behavior-identical moves behind re-export shims; 3,442→2,790). SUBTRACT-FIRST shrank scope: journal cluster NOT extracted (relocate-without-decouple — all callers private/in-orchestrator), `clusterMemoriesBySimilarity` NOT extracted (embedder coupling), BOTH X2 `callStructured` migrations SKIPPED (fit-test grep = 0; chunk-plan call has a retry the seam can't model, merge leaf ungated). Design: `docs/technical/d3-design.md`. |
| **D2** `state-db` per-domain repositories | ✅ MERGED PR #670 (scoped) | Landed the 2 coupling-deleting moves only: `MIGRATIONS` registry → `core/state/migrations.ts` as ONE ordered literal (rejected per-repo fragments — migration `001` creates 3 tables in one un-splittable fragment), and relocated misplaced `REGISTRY_INDEX_CACHE_DDL` → indexer/db. `state-db.ts` 2,452→1,682. **Per-table CRUD split deliberately SKIPPED** — verified cohesion-only (the "transitive load" benefit is false in TS/Bun; X1 already removed lifecycle coupling) and unlocks nothing downstream. `Proposal` core→commands type-only cycle left as-is (deferred). Design: `docs/technical/d2-design.md`. |
| **D1** decompose `improve.ts` + **D1b** `withProcessLock` + **D1c** prep/stage extraction | 🟡 OPEN PR #671 | `improve.ts` **5,395→1,443**. D1b: lock primitives → `improve/locks.ts` + `withOptionalProcessLock` RAII (3 stage locks) + 3 invariant pins. D1c: prep pipeline → `improve/preparation.ts` (+ `runSessionExtractPass`, `runValidationAndRepairPass` extracted from it), loop/post-loop/maintenance → `improve/loop-stages.ts`, candidate-selection → `improve/eligibility.ts`. SKIPPED (verified): `runWithTelemetry` (really 1 clean site, not "8+"), recombine/procedural registry (incompatible signatures), `ImproveBaseContext` (per-stage bags genuinely distinct). NOT extractable as pure moves: the prep `salienceMap` cross-phase accumulator blocks (Outcome loop / selectors / replay) — need an accumulator-passing redesign, left in place. Design: `docs/technical/d1-design.md`. |
| **X4** repository-owns-SQL lint ratchet | ⏸️ NOT STARTED (only remaining item) | State/index offenders cleared by D2/D3/D5. STILL gated on the **command-layer** raw-SQL offenders that bypass repositories: `commands/improve/salience.ts`, `outcome-loop.ts`, `homeostatic.ts` (raw `asset_salience`/`asset_outcome` SQL), and any remaining registry-provider reaches. Either move those behind repos first OR ship the lint with a documented temporary allowlist that ratchets them down. |

> **Process note:** the executed work used a gated workflow (implement → gate → adversarial review → commit-or-revert). Lessons baked in: verify the resulting branch yourself (agents run `git reset`); a sync RAII loan can't wrap a handle held across an `await` (needs an async variant); `biome`/`bun run lint` exit 0 on *warnings* — count warning lines, don't trust the exit code.

---

## NEXT-SESSION PRIMING — D-series (D1/D2/D3 + X4)

Everything below the cross-subsystem/per-subsystem sections is still accurate as *design*. This section is the **operational handoff**: current state, what's been de-risked, the playbook that worked, and the traps to avoid. Read it first, then the per-item D sections.

### Current state (start here)
- All R/X work + **D3 (#669, merged)** + **D2 (#670, merged, scoped)** are on `main`. **D1/D1b/D1c (#671) is OPEN** (review/merge it). **X4 is the only item not started.**
- Each D item is its own branch + PR off `main` — design docs: `d1-design.md`, `d2-design.md`, `d3-design.md`, `r5-design.md` (the design-team-first worked examples).
- **The `node-smoke` CI job gates the Node runtime path.** Any change touching output shape / DB open path / stdout discipline must keep both runtimes identical — run `bun run build && AKM_NODE_COMPAT_TESTS=1 AKM_SMOKE_NODE=node bun test tests/integration/node-compat.test.ts` before pushing.
- **X4 next steps:** the lint enforces "raw SQL only inside `storage/repositories/**` + DB-owner modules". The remaining offenders are in the **command layer** (`commands/improve/salience.ts`, `outcome-loop.ts`, `homeostatic.ts` hit `asset_salience`/`asset_outcome` directly). Decide: (a) extract a `state/salience-repo.ts` + `state/outcome-repo.ts` first (the proper fix; mirrors D2's repo pattern), then ship the lint clean; or (b) ship the lint with an explicit allowlist of those files and a TODO to ratchet them. Mirror the existing custom-lint suite in `scripts/lint-*.ts` (`bun run lint`).
- **Verified-and-skipped (do NOT re-attempt as pure moves):** the D-series repeatedly found the plan over-scoped (R5 table, X2 "20 callers", D2 per-table CRUD, D1 `runWithTelemetry`/registry/`ImproveBaseContext`). Each was verified — don't redo them. The `improve.ts` prep-internal accumulator blocks (`salienceMap`) need a redesign, not a move.

### Prerequisites now satisfied (this is *why* the D-series is safer than it was)
- **D2 (`state-db.ts` → per-domain repos)** depends on the **X1 seam, which is DONE** (`withStateDb`/`withManagedDb`, sync+async+path). The repos can be cut behind `withStateDb` instead of re-rolling open/try/finally/close. The migration-ordering contract is the one real hazard — keep the registry an **explicit ordered array literal**, never renumber fragments.
- **D1 (`improve.ts`)** is meant to run *after* X1 + X2 so the loop operates on already-extracted services and the per-process LLM bodies are already collapsed. X1 is done; **X2 is substantively done** but note its scope finding (below) — `improve.ts`'s own LLM calls were among the callers that *don't* fit `callStructured`, so do NOT expect X2 to have shrunk `improve.ts`. D1's `runWithTelemetry` Template + service extraction (locks/eligibility/budget) is still the first move *within* D1.
- **D3 (`consolidate.ts`)** absorbs the one remaining X2 target (consolidate's leaf LLM call). Decompose first (move, don't rewrite — most functions already `export`ed), then adopt `callStructured` for the leaf *if it genuinely fits* — re-run the fit test (§ scope finding), don't assume.
- **X4 (lint ratchet)** stays BLOCKED until D2/D3/D5 clear the existing raw-SQL offenders. D5 is done; D2/D3 remain. Land X4 last.

### The playbook that worked (reuse it verbatim for each D increment)
1. **Smallest proven increment.** Never one-shot a god-module. Extract ONE service/repo, gate, commit, repeat. The whole point of the D-series being "deferred / human-supervised" is that each step is individually reviewed.
2. **Gated TDD workflow per increment:** RED characterization test (pin current behavior, green on current code) → GREEN (move/extract, keep it green) → **adversarial review** (behavior-identical? real subtraction not machinery? gate independently clean?) → **deterministic commit-or-revert**. On revert, agents `git stash -u` — never `rm`.
3. **Verify the branch yourself** after the workflow (agents run `git reset`/`git stash`); confirm HEAD, clean tree, and re-run the quick gate (lint+tsc) by hand.
4. **For any item whose shape is uncertain, run a DESIGN TEAM first** (3 independent lenses + adversarial synthesis → a written design doc with a TDD checklist), THEN execute. R5 proved this: the team rejected the planned abstraction outright and found the real (smaller) fix. D2's repo boundaries and D1's service split are exactly the kind of ambiguous shape that warrants this.

### Lessons learned (the expensive ones — don't relearn them)
- **SUBTRACT-FIRST is not a slogan here — it changed outcomes twice.** R5's "descriptor table" was the wrong tool (a design team killed it; the fix was a type-narrow + a move, net-negative). X2's "20 callers to migrate" was an overcount; only 4 genuinely fit and forcing the rest was rejected by triage. **Expect the D-series to contain similar over-scoping.** Before decomposing, verify the responsibilities are *actually* independent and the split *deletes* coupling — don't split for split's sake.
- **The integration-suite "hang" is the #664 race, still live in the single-process runner.** `bun run test:integration` (`--parallel=1`) is race-free *enough* to pass but can wedge: the child `bun` zombies (STAT Z) while the parent busy-spins at ~98% CPU `wchan=0`. It is NOT a code hang and NOT a regression. Mitigation: `ps … | grep 'bun test'`, `kill -9` the wedged runner + zombie (ephemeral, never user data), re-run on idle cores (~2 min, ~1,545 pass). Bun buffers output to completion, so a wedged run shows a 0-byte log. **Never trust a workflow agent's "integration hung/unknown" — re-verify by hand.** The sharded *unit* path (`scripts/test-unit.sh`) does not have this race.
- **`biome`/`bun run lint` exit 0 on warnings.** Unused imports, `useImportType`, type-only `noUnusedImports` are warnings the pre-commit hook rejects. COUNT warning lines in the output; don't trust the exit code. Type-only `noUnusedImports` is NOT auto-fixed by `--write`.
- **A sync RAII loan can't wrap a handle held across an `await`** — that's why X1 needed `withManagedDbAsync`/`withStateDbAsync`. D2's repos will have async methods; use the async loan.
- **Migration ordering is append-only.** Both state.db and index.db migration fragments must concatenate in an explicit ordered literal; renumbering an existing fragment corrupts the `schema_migrations` ledger. This is D2's single biggest hazard.
- **Verify the *effective* runtime config, not just the code default** (the #632 inert-feature footgun). For any "registry-as-source-of-truth" change (D1's process registry), confirm `config.json` doesn't pin the old value.
- **Before fixing a "regression", confirm it IS one — diff against `main` (cheapest decisive experiment).** PR #667's `node-smoke` failure looked like the PR broke Node; building+running `main` directly proved the suite was already 10/22-failing there (the new *gate* surfaced a pre-existing-broken, always-skipped suite). Attribution first saved fixing the wrong thing. Corollary: **adding a gating CI job for a `skipIf`-gated suite first requires confirming that suite actually passes** — a never-run test suite is presumed broken.
- **JSON-output commands must keep stdout pure — progress/banner output goes to stderr.** The real bug `node-compat` caught: `setup --yes` wrote @clack `p.log.info` banners to stdout, corrupting `cmd --yes | jq`. Any command emitting a structured envelope must gate human-progress notices on `getOutputMode().format !== "json"` (route to stderr otherwise). Relevant to D1/D3 (improve/consolidate emit JSON envelopes + lots of progress logging).
- **A test HTTP server in the same process that then calls `spawnSync` deadlocks.** `spawnSync` blocks the event loop, so an in-process `http.Server` can never accept the child's connection → timeout. If a D-series test needs a server feeding a spawned child, serve from a `file://` URL or a detached process, never the bun-test process itself.
- **`bun:sqlite` and `better-sqlite3` emit different error strings/codes** (e.g. "unable to open database file" vs "no such table: …"). Node↔Bun parity tests must compare on the SUCCESS path (valid stash/index), not on error-message text. When a D-series change alters a DB open/error path, make it succeed identically rather than asserting around the runtime difference.

## Executive summary

The akm `src/` tree is structurally sound at the *boundary* level — the team has already shipped exemplary seams (the `StorageProvider` driver boundary, `OutputShapeHandler`/`AssetRenderer` registries, `TaskBackend` Strategy+Factory, `WorkflowRunsRepository` + `withWorkflowRunsRepo`, `withIndexDb`, `withIndexWriterLease`, `feature-gate.tryLlmFeature`, the AsyncLocalStorage usage-telemetry inversion). The problem is **half-finished application of patterns the codebase already proved work**, concentrated in two failure modes:

1. **God-modules** that fuse 7-11 unrelated responsibilities behind one file: `improve.ts` (5,406 LOC, verified), `consolidate.ts` (3,447), `state-db.ts` (2,443), `indexer/db/db.ts` (2,458), `indexer.ts` (1,918), `output/text/helpers.ts` (1,177), `git.ts` (787), `workflows/runtime/runs.ts` (710).
2. **Shotgun-surgery idioms** where one decision is hand-re-implemented at N sites because the seam that should own it was never extracted: the `chatCompletion → classify → parse → validate → fallback` scaffold (20 modules import `chatCompletion`, verified), the borrow-or-own DB lifecycle (`withStateDb` does **not** exist while `withIndexDb`/`withWorkflowRunsRepo` do — 27 `owns*`/`sharedStateDb`/`localDb` hits in improve+consolidate alone, verified), the `RunnerSpec` kind-switch, the per-process improve dispatch blocks, and the four parallel source-kind switches.

This plan **decomposes the god-modules first**, then collapses the duplicated dispatch idioms behind seams that already have working siblings. It is sequenced **cheap-and-mechanical → decompose → reshape**, so the high-risk rewrites (improve registry, state-db repos) operate on already-extracted, already-tested services rather than going big-bang.

The three review lenses (fit / over-engineering / leverage) converged strongly. The disagreements were all about **scope and sequencing**, not correctness — and three genuinely new **cross-subsystem** findings emerged that no per-subsystem diagnosis could see. Those are promoted to first-class workstreams below.

---

## Structural diagnosis

### The two god-module clusters
- **improve cluster** (`improve.ts` + `consolidate.ts`): 9 fused responsibilities in `improve.ts` (lock lifecycle, eligibility, budget/watchdog, orchestration, event/metrics, consolidation gate, prep/loop/post stages) coupled through shared closures and a 12-18-field argument bag threaded by hand. `consolidate.ts` is a second god-module fusing eligibility predicates, chunk math, plan-merge, sanitization, and a 1,600-line inner orchestrator.
- **storage cluster** (`state-db.ts` + `indexer/db/db.ts`): `state-db.ts` fuses 11 independent table-domains + a 717-line migration array; each consumer verified to touch exactly one table. `db.ts` fuses connection lifecycle, sqlite-vec loading, full schema/migration DDL, entry CRUD, and the vector/FTS query layer.

### Coupling hotspots (verified)
- **No `withStateDb` seam.** `withIndexDb` (index-db.ts:38) and `withWorkflowRunsRepo` exist, but state.db never got the loan helper — so 11+ files hand-roll `open → try → finally → close` and the `eventsCtx?.db ?? openStateDatabase()` + `ownsDb` flag idiom recurs 27× across improve+consolidate.
- **LLM call idiom owned nowhere.** 20 modules import `chatCompletion` and each re-rolls the same classify/parse/validate/fallback scaffold; adding `provider_html_error` forced edits across 4 files. The error taxonomy (`isContextSizeError` vs `looksLikeContextOverflow`) is even duplicated with *divergent* rules — a real correctness divergence, not just dup.
- **Untyped inter-phase contract.** `indexer.ts:392-393/529` hand off phase results by casting `ctx` to an ad-hoc inline type — invisible to the compiler, fails silently on a typo.
- **Layering inversions.** Registry providers import `indexer/db/db.ts` directly (static-index.ts:8, skills-sh.ts:8); `runs.ts` reaches into index.db with raw SQL (484-558) despite the subsystem's own "repository owns ALL SQL" rule; `core/config` imports *up* into `integrations/` and `registry/`; `state-db.ts:56` imports `Proposal` from `commands/`.
- **Closed-set-enumerated-in-N-places.** The improve process set (4 places), the source-kind set (4 switches), and the harness capability set are each enumerated in multiple uncoordinated locations with no exhaustiveness link.

---

## CROSS-SUBSYSTEM WORKSTREAMS (highest leverage — promote above per-subsystem items)

All three reviewers independently flagged the same wounds seen from different subsystems. Designing these **once** prevents shipping 3-4 subtly-different local fixes.

### X1. One `withManagedDb` loan + `openManagedDatabase` factory — spans core + storage + indexer + workflows + tasks
**Present pain.** The recipe `mkdir(dir) → openDatabase(path) → applyStandardPragmas → migrate` is copy-pasted in `state-db.ts:111`, `logs-db.ts`, `db.ts` (×2), `workflows/db.ts`. The lifecycle `open → try → finally → close` plus the borrow-or-own `ctx?.db ?? open()` + `ownsDb` branch is hand-rolled in 11+ files (27 verified hits in improve+consolidate). `withIndexDb`/`withWorkflowRunsRepo` already prove the pattern but state/logs/graph never adopted it. `graph-db.ts`'s optional `db?` param is the same borrow-or-own at the graph layer.

**Pattern.** Factory (`openManagedDatabase(spec)`) + RAII loan (`withManagedDb<T>(opener, { borrowed? })`).

**Target design.**
```ts
// src/storage/managed-db.ts
function openManagedDatabase(spec: { path: string; pragmas?: PragmaOpts; init?: (db: Database) => void }): Database;
function withManagedDb<T>(open: () => Database, fn: (db) => T, opts?: { borrowed?: Database }): T;
```
Each owner module collapses to a path + initializer:
```ts
const openStateDatabase = () => openManagedDatabase({ path: getStateDbPath(), init: runMigrations });
const withStateDb  = (fn, opts?) => withManagedDb(openStateDatabase, fn, opts);  // borrowed=ctx?.db ⇒ no close
const withIndexDb  = (fn, opts?) => withManagedDb(openIndexDatabase, fn, opts);  // re-expressed as a specialization
```
**Before:** `const db = ctx?.db ?? openStateDatabase(); const owns = !ctx?.db; try {…} finally { if (owns) db.close(); }` ×27. **After:** `return withStateDb(db => {…}, { borrowed: ctx?.db });` — the `owns` flag and finally/close deleted.

**Coupling reduced.** Deletes ~27 ownership flags + every duplicated finally/close (kills a handle-leak class, the exit-78 "already running" family). One place to add busy-timeout, integrity checks, or test-isolation injection. **This is the prerequisite seam** that makes the state-db repository decomposition (D2) safe.

**Effort:** M. **Risk:** low (mechanical; mirrors shipping helpers).

### X2. `callStructured()` template — the most-replicated idiom in the repo (src/llm)
**Present pain.** 20 modules import `chatCompletion` (verified), each re-rolling `tryLlmFeature → chatCompletion → catch/classify (context/html/transient/other) → parseEmbeddedJsonResponse → validate shape → bump telemetry → typed fallback`. `graph-extract.ts:877-931`, `memory-infer.ts:110-161`, `metadata-enhance.ts:58-86`, `consolidate.ts:1917-1990` are structurally identical, differing only in prompt/schema/validate-fn. The `provider_html_error` addition was textbook shotgun surgery. The error taxonomy is **divergently** duplicated (`client.ts` treats a bare "context size" string as overflow; `graph-extract.ts:71` deliberately does not) — a live correctness split.

**Pattern.** Template Method + a discriminated `LlmCallOutcome`/`LlmErrorClass`.

> **Scope correction (2026-06-25, after building the seam + migrating 3 callers):** the "20 modules import `chatCompletion`" framing overcounted. The seam's value is centralizing the `classify(context_limit/html/other)` ladder + the gated `tryLlmFeature`→call→pure-parse→fallback scaffold. Empirically only `graph-extract`, `memory-infer`, `metadata-enhance` (all migrated) and `consolidate` (→ D3) replicate that shape. Every other importer uses `chatCompletion` differently — split parse outside the gate, ungated raw calls, non-LLM `validate` callbacks, dispatch arms (now in X3's `executeRunner`), or try-bodies that wrap much more than the LLM call. Forcing those onto `callStructured` is net-positive force-fitting and was correctly rejected by triage. **X2 is substantively complete; do not re-attempt the non-replicating importers.**

**Target design.**
```ts
// src/llm/structured-call.ts
function callStructured<T>(opts: {
  feature: LlmFeatureKey; config; akmConfig?; messages; schema?;
  parse: (raw: string) => T | undefined; fallback: T; telemetry?;
}): Promise<T>;
```
Owns the `tryLlmFeature` wrap, the single `chatCompletion`, the catch→classify, the parse, the telemetry bump. The error taxonomy (`context_limit | html | transient | other`) is defined **once** here next to `LlmCallError`; `looksLikeContextOverflow` is deleted in favor of the stricter `isContextOverflow`, re-exported so `isRetryable` and graph-extract share one definition. `graph-extract` keeps its bespoke batch/chunk/merge algorithm but its leaf call becomes `callStructured({ feature: 'graph_extraction', parse: parseGraphExtraction, fallback: empty() })`.

**Coupling reduced.** Callers stop depending on the `LlmCallError` code taxonomy and parse ordering. A new error class or telemetry field is one edit. Each caller's failure handling becomes unit-testable by stubbing one `chat` seam. Side effect: shrinks the improve and indexer god-module bodies as every per-process LLM block collapses.

**Effort:** L. **Risk:** medium — stage incrementally, one caller at a time (each migration independently testable).

### X3. `executeRunner()` — collapse the duplicated llm/agent/sdk kind-switch (integrations)
**Present pain.** The `RunnerSpec` tagged-union is dispatched by an identical 3-arm switch (`llm→chatCompletion`, `agent→runAgent`, `sdk→runOpencodeSdk`) copied across `drain.ts`, `reflect.ts` (twice), `agent-dispatch.ts:142`, `propose.ts:212`. The code self-documents the copy (drain.ts comment "mirroring reflect's dual..."). Each site re-declares its own `runAgentFn`/`runSdkFn`/`chat` test seams. Command modules reach directly into `integrations/harnesses/opencode-sdk` (feature envy).

**Pattern.** Strategy + Factory (single dispatch table keyed by `RunnerSpec.kind`).

**Target design.**
```ts
// src/integrations/agent/runner-dispatch.ts
function executeRunner(spec: RunnerSpec, prompt: string, opts, seams?: RunnerSeams): Promise<AgentRunResult>;
```
One switch (`llm`/`agent`/`sdk`/`assertNever`), one `RunnerSeams` object for the per-kind test seams. The 5 inline switches become one `executeRunner(...)` call; callers stop importing `runOpencodeSdk`/`runAgent` directly.

**Coupling reduced.** A 4th kind is one edit. Kills the feature-envy imports. **Subsumes the SDK-special-casing work** (see CUT): once the fork is internal to `executeRunner`, the scattered `profile.sdkMode`/`"opencode-sdk"` literals at setup/migration sites become a small incremental mop-up, not an XL rewrite. **Design X2 and X3 together** — `executeRunner` should return into `callStructured`'s outcome type so you don't build two overlapping seams at the same call sites.

**Effort:** L. **Risk:** medium.

### X4. Enforce "repository owns ALL SQL outside storage/repositories" with one lint guard
**Present pain.** The rule exists (workflow-runs-repository.ts:15) but is unenforced, so registry providers (static-index.ts:8, skills-sh.ts:8) and `runs.ts` (484-558) bypass repositories to hit index.db directly — the same layering inversion in three places.

**Pattern.** Architectural fitness function (a custom lint, mirroring the existing custom-lint suite in `bun run check`).

**Target design.** A lint rule: `openExistingDatabase`/`openIndexDatabase`/raw `Database` SQL outside `src/storage/repositories/**` and the DB-owner modules is an error. Lands **after** D2/D3/D5 fix the existing offenders, then ratchets to prevent regression.

**Coupling reduced.** Catches all current and future inversions cheaply instead of per-site review. **Effort:** S. **Risk:** low.

---

## Per-subsystem kept proposals (decompositions first, then reshapes)

### D1. Decompose `improve.ts` — telemetry wrapper + extracted services + scoped registry
**Present pain.** 9 responsibilities in one 5,406-LOC file. The recombine block (4806-4835) and procedural block (4842-4865) are verified near-byte-identical (same 5-condition guard, same `options.Xfn ?? akmX` seam, same `try/catch→allWarnings.push`, same `improveProfile.processes.X.*` marshalling); the maintenance passes (4989-5160) are a 3rd copy of the telemetry epilogue. Adding a process is shotgun surgery across `AkmImproveOptions` (XFn? field), the `Fn ?? akm` resolution, the dispatch block, the result-merge literal, and `emitImproveCompletedEvent`'s switch.

**Pattern (reconciled — Template Method core + *scoped* Strategy registry, NOT a full polymorphic hierarchy).** All three reviewers flagged that forcing reflect (loop-stage voting), consolidate (its own 300-line gate), and the heterogeneous maintenance passes into one `isEligible/run` interface is procrustean. So:

1. **`runWithTelemetry(name, ctx, fn)`** (Template Method): extract the copy-pasted start-time/`withLlmStage`/try-catch/duration/`allWarnings.push` epilogue (8+ sites). Captures ~80% of the de-dup at a fraction of the risk. **Do this first within D1.**
2. **A thin registry over ONLY the uniform opt-in passes** (recombine, procedural, extract — the verified-homogeneous trio): each becomes a small adapter `{ name, isEligible(ctx), run(ctx) }`; the post-loop stage collapses to `for (const p of postLoopPasses) if (p.isEligible(ctx)) outcomes.push(await runWithTelemetry(p.name, ctx, () => p.run(ctx)))`.
3. **Leave reflect / consolidate / the maintenance passes as named stage functions** (they have bespoke preambles — skip-message branches, hint-ref counting, profile-gating).
4. **Extract cross-cutting services** out of the orchestrator: `improve/locks.ts`, `improve/eligibility.ts`, `improve/budget.ts`, `improve/run-telemetry.ts`. Promote the 12-18-field argument bags into a single constructed `ImproveRunContext` object built once and passed by reference.

**Before:** ~600 LOC of inline dispatch + 12 `XFn?` test-seam fields. **After:** `improve.ts` drops toward ~1,200 LOC (precedent: the #490 cli.ts 4,589→620 split the team executed); test seams collapse to one override map.

**Coupling reduced.** Adding/reordering an opt-in pass becomes a one-file change. Each extracted service (locking, eligibility, budget, telemetry) becomes independently testable without standing up a full `akmImprove` run.

**Effort:** XL. **Risk:** high. **Sequence:** AFTER X1 (`withStateDb`) and X2 (`callStructured`) so the registry loop operates on already-extracted services and the per-process LLM bodies are already collapsed. Do `runWithTelemetry` + service extraction before the registry.

### D1b. `withProcessLock` RAII (within the improve cluster)
**Present pain.** Module-global `heldProcessLocks` Set + manual `process.on('exit')` backstop that the finally must remove EXACTLY (improve.ts:147-250, 1287-1294). A missed release leaks a lock → the exit-78 failures this code is littered with comments about.

**Pattern.** RAII (mirrors the existing `withIndexWriterLease`).

**Target.** `withProcessLock(lockName, opts, body)` acquires, runs body in try, releases in finally, and registers/deregisters its own exit backstop internally. Dispatch sites become `await withProcessLock('reflectDistill', …, () => runLoopStage(…))`. The global Set and explicit exit-handler variable disappear.

**Coupling reduced.** Lock correctness becomes local and unit-testable instead of an emergent property of correctly-paired calls in a 5,400-line file. Pairs with the `improve/locks.ts` extraction. **Effort:** M. **Risk:** low.

### D2. Decompose `state-db.ts` into per-domain repositories behind a migration registry
**Present pain.** 2,443 LOC / 11 unrelated tables + a 717-line migration array (141-848). Verified: each consumer touches exactly one table (`extract.ts`→extract_sessions only; `consolidate.ts`→body_embeddings+consolidation_judged; `recombine.ts`→recombine_hypotheses; `proposals.ts`→proposals), yet all import the file carrying all 11. `state-db.ts:56` imports `Proposal` from `commands/` (core→commands reach).

**Pattern.** Repository-per-aggregate + a shared migration-fragment registry.

**Target design.** `src/core/state/<domain>-repo.ts` per table (events, proposals, task-history, improve-runs, extract-sessions, consolidation-judged, recombine-hypotheses, body-embeddings, salience). Each exports its own `Migration[]` fragment, Row type, mappers, CRUD. `state/migrations-registry.ts` concatenates fragments **in an explicit ordered array literal** (append-only contract preserved — fragments never renumbered) and re-exports `openStateDatabase`. Consumers import only the repo they touch, via `withStateDb` (X1). Move `REGISTRY_INDEX_CACHE_DDL` to `indexer/db/db.ts` where its table lives. The `Proposal` reach is fixed by defining the row/domain type in core (see CUT note on the broader DIP).

**Coupling reduced.** Each table independently testable against a tmpdir DB; a new table is a new file + one registry append. Consumers stop transitively loading 10 irrelevant tables.

**Effort:** XL. **Risk:** medium — the migration-ordering contract is the one real hazard; keep the registry array literal explicit. **Sequence:** AFTER X1.

### D3. Decompose `consolidate.ts` along its already-exported seams
**Present pain.** 3,447 LOC fusing eligibility predicates, chunk math, plan-merge, sanitization, and a 1,600-line `akmConsolidateInner`. These are independent (string sanitization knows nothing about chunk math).

**Pattern.** Decompose-module (move, not rewrite — most functions already `export`ed/tested).

**Target.** `consolidate/eligibility.ts`, `consolidate/chunking.ts`, `consolidate/merge.ts`, `consolidate/sanitize.ts`; `consolidate.ts` stays the orchestrator. Its LLM calls adopt `callStructured` (X2).

**Coupling reduced.** Sanitize/chunk-math become reusable (recombine/distill also build prompts + sanitize output). Orchestrator shrinks to readable size. **Effort:** L. **Risk:** low.

### D4. Split `git.ts` into provider / install / save
**Present pain.** 787 LOC fusing three responsibilities with three different callers, co-located only because they shell out to `git`: (1) `GitSourceProvider` + mirror cache (read-side, called by the indexer); (2) `syncRegistryGitRef`/`doSyncGit` install pipeline (called by `add`/`update`); (3) `saveGitStash` + commit/push machinery (~270 LOC, called by improve + `akm sync`, importing `loadConfig`/`getSources`/`sanitizeCommitMessage` that the provider never touches).

**Pattern.** Single-responsibility decomposition + a shared `git-exec.ts`.

**Target.** `git-provider.ts`, `git-install.ts`, `git-save.ts`, with `runGit`/`classifyCloneFailure` hoisted into `git-exec.ts`. Factory self-registration stays with `git-provider.ts`.

**Coupling reduced.** `saveGitStash` becomes testable without constructing a provider; improve/sync stop transitively importing clone+mirror machinery. Each file is single-reason-to-change. **Effort:** L. **Risk:** medium.

### D5. Extract `WorkflowAssetLoader` out of `runs.ts`
**Present pain.** 710-LOC run-state engine fuses workflow-ref resolution (441-558) — including raw index.db SQL (484-558) that violates the subsystem's own repository rule and duplicates the `entry_key` string at 491 and 543 — plus a `require()`-to-dodge-an-LLM-cycle judge factory (656-674).

**Pattern.** Extract-collaborator + Repository (mirror `WorkflowRunsRepository`) + finish the existing `SummaryJudge` injection.

**Target.** `workflows/runtime/asset-loader.ts` (`loadWorkflowAsset`); move the index.db reads behind a `WorkflowDocumentsReader` in `storage/repositories` (owns the `workflow_documents`/`entries` SQL + the `entryKey` builder). Move `buildDefaultSummaryJudge` into `validate-summary-default.ts` with normal top-level imports; default it at the CLI boundary, not inside the engine.

**Coupling reduced.** The state machine becomes unit-testable with a fake loader + the existing repo, no index.db on disk. Removes the last raw-SQL break and the `require()` cycle dodge. **Effort:** L. **Risk:** medium.

### R1. Typed `PhaseResult` to kill the indexer cast-injection
**Present pain.** `runFinalizePhase` writes `(ctx as IndexRunContext & {_verification;_totalEntries})._verification = …` (392-393) and `akmIndex` reads it back with the identical cast (529) — verified verbatim. The producer→consumer contract is invisible; a typo fails silently. The dead `graphExtractionResult` field lies that graph is an in-pipeline phase.

**Pattern.** Extract-interface (each phase returns a typed result).

**Target.** Each `run*Phase` returns an explicit typed result (`FinalizeResult{verification, totalEntries}`, etc.); `akmIndex` threads results forward as locals. Drop inter-phase result fields (`_verification`, `_totalEntries`, `graphExtractionResult`) from `IndexRunContext`; keep ctx for genuinely cross-cutting inputs.

**Coupling reduced.** Pipeline data flow becomes compiler-checked from the `akmIndex` body alone. Removes both cast sites and the dead field. **Effort:** M. **Risk:** low.

### R2. Route `ensureSourceCaches` through `SourceProvider.sync()`
**Present pain.** `search-source.ts:298-328` hardcodes git refresh and website refresh in two type-gated loops, duplicating provider logic. Every provider implements `sync()` (git.ts:92, website.ts:21, npm.ts:67) but this path ignores it — **so npm sources are silently never refreshed** (a real bug). A new cache-backed kind = edit in both the provider AND `ensureSourceCaches`.

**Pattern.** Strategy via the existing provider registry.

**Target.** `resolveSourceProviders(config) → for each provider, if provider.sync await provider.sync()`. Collapses ~30 LOC of concrete plumbing to a ~6-line polymorphic loop. The git content/-subdir convention stays in `resolveEntryContentDir` (a layout concern, correctly separated).

**Coupling reduced.** `search-source` stops depending on git/website cache internals; npm gets refreshed; the `force` flag flows through one path. **Effort:** M. **Risk:** medium.

### R3. Extract `fetchCachedJson` (registry cache Template) + fix the layering inversion
**Present pain.** `withRegistryCacheDb` is verified byte-identical in static-index.ts:182 and skills-sh.ts:47, and the surrounding read→fetch→write→stale-fallback flow is the same state machine duplicated. Both reach into `indexer/db/db.ts` (layering inversion). This subsystem has a documented cache-correctness regression history — two copies WILL drift.

**Pattern.** Template Method + a `RegistryCache` seam.

**Target.** `registry/registry-cache.ts` exporting `fetchCachedJson<T>({ cacheKey, ttlMs, fetch, parse })`. It owns `withRegistryCacheDb`, the get/upsert cache calls, stale-fallback, and the isolation-guard rethrow. Providers stop importing `indexer/db` entirely — the cache module is the single chokepoint that knows the schema.

**Coupling reduced.** ~110 LOC of duplicated state machine → one tested impl; cache bugs fixed once; the inversion is gone. **Effort:** M. **Risk:** low.

### R4. Delete the dead provider v1 interface (do this FIRST — risk-free)
**Present pain.** `RegistryProvider.searchKits/searchAssets/getKit/canHandle` and `SourceProvider.init`/`ProviderContext`/`sync`-as-method are implemented in every provider but have **verified zero non-test callers** (grep confirmed — `search-source` uses only `.path()`, `registry-search` only `.search()`). ~120 LOC of phantom surface every new provider must implement; `skills-sh.getKit` even does an extra network search for a method nobody invokes.

**Pattern.** Interface segregation / dead-code removal.

**Target.** Narrow `RegistryProvider` to `{ type; search() }` and `SourceProvider` to `{ name; kind; path() }`. Delete `ProviderContext`, `init()`, and unused `KitResult`/`AssetPreview`/`KitManifest`/`RegistryQuery` if unreferenced. (`sync()` stays as the standalone function it always was; just off the interface.)

**Coupling reduced.** Removes ~120 LOC and the obligation on every future provider. **Effort:** M. **Risk:** near-zero. **Sequence:** FIRST — clarifies the real 2-method contract before D4.

### R5. Source-kind descriptor table (kill the 4 parallel switches)
**Present pain.** `{npm,github,git,local}` is switched independently in `parseRegistryRef` (resolve.ts:64), `resolveRegistryArtifact` (135), `buildInstallRef` (static-index.ts:521 — misplaced in a registry provider), `syncFromRef` (20), `config-sources.ts:39). None is exhaustiveness-checked against the others.

**Pattern.** Registry/table-driven dispatch with a `satisfies Record<KitSource, _>` constraint.

**Target.** One source-kinds table keyed by `KitSource`, each entry `{ buildInstallRef, resolveArtifact, syncMaterializer }`. `resolveRegistryArtifact`/`syncFromRef` look it up; `static-index` imports `buildInstallRef` from `resolve.ts` instead of re-deriving it. `parseRegistryRef` stays a string-prefix parser (different concern).

**Coupling reduced.** Adding a kind = one table entry, compiler-flagged if incomplete. Removes `buildInstallRef`'s misplacement. **Effort:** M. **Risk:** medium.

### R6. Collapse `output/text/*` and `shapes/*` wrappers into their command modules
**Present pain.** `text/helpers.ts` (1,177 LOC, ~60 functions) and `shapes/helpers.ts` (503, ~21) are god-modules; the 26 per-command `text/*.ts` / 15 `shapes/*.ts` files are pure re-export indirection. Editing wiki text means editing the shared 1,177-line file. Cohesion is faked by directory layout.

**Pattern.** Decompose-module (INVERT the indirection — this REMOVES a layer, adds no abstraction).

**Target.** Move each `format*Plain` BODY out of `helpers.ts` INTO the per-command module that already owns its `TextFormatterEntry`. `helpers.ts` shrinks to genuinely-shared primitives. The registries and assembly arrays stay as-is (already correct).

**Coupling reduced.** Each command's formatter becomes independently editable without risking 59 others. **Effort:** L. **Risk:** low.

### R7. `defineGroupCommand` factory for the 8 subcommand-group families
**Present pain.** `graph-cli.ts:156`, `wiki-cli.ts:325`, config/proposal/tasks/secret/env each repeat: build `XXX_SUBCOMMAND_SET` from `Object.keys`, then a near-identical default-action `run` (`if (hasSubcommand(args, SET)) return; output(default)`). The desync-prevention comment is repeated verbatim in each.

**Pattern.** Factory method (parameterized command builder).

**Target.** `defineGroupCommand({ meta, subCommands, defaultAction })` in `cli/shared.ts` derives the set internally and wires the default-action run. Each family shrinks to one call.

**Coupling reduced.** 8 copies → 1; the invariant lives in one place. **Effort:** M. **Risk:** low.

### R8. Lift improve-run lifecycle out of `improve-cli.ts` into `runImproveSession`
**Present pain.** `improve-cli.ts:92-296` (~200 LOC) fuses CLI arg-decode with a `SIGNAL_TABLE`, three signal handlers, terminated-run persistence, result-file persistence, and `process.exit` choreography — domain logic with no test seam (must spawn the process to exercise it). This is exactly the cron-timeout-persistence code that has repeatedly regressed (per MEMORY: improve sync-only-on-clean-finish).

**Pattern.** Facade / extract-service with an injected signal source.

**Target.** `improve/improve-session.ts` → `runImproveSession(opts, { onTerminate, signalSource })`. The CLI shrinks to decode → call → output/exit. A unit test drives a fake SIGTERM and asserts the terminated row is written — no child process.

**Coupling reduced.** The layer's biggest untestable knot becomes testable; flag-parsing and run-orchestration stop sharing one function. **Effort:** L. **Risk:** medium.

### R9. Extract the incremental dir-staleness engine (`passes/dir-staleness.ts`)
**Present pain.** `indexer.ts:571-1093` (~520 LOC) is a self-contained staleness engine (`computeDirFingerprint`, `getDirStaleReason`, `canUseIncrementalSkip`, `inferZeroRowReason`, the `DirScanReason` taxonomy) interleaved with the walk loop and Phase-2 insert transaction — only reachable via a full `akmIndex` run.

**Pattern.** Decompose-module + extract a pure evaluator `(db, dirPath, files, builtAtMs) → {stale, reason, persistedRowCount}`.

**Coupling reduced.** Staleness logic becomes directly unit-testable with a fixture DB; `indexEntries` drops ~380→220 LOC. **Effort:** L. **Risk:** medium.

---

## CUT / DOWNGRADED (over-engineered or misfit)

- **Full `ImproveProcess` Strategy hierarchy across all 9 processes (improve §P1 as written).** CUT the maximal form. All three lenses verified reflect/consolidate/maintenance are heterogeneous (bespoke preambles); forcing them into one `isEligible/run` interface is procrustean and adds indirection. **Kept the scoped form in D1** (Template-Method `runWithTelemetry` + a registry over ONLY the uniform recombine/procedural/extract trio).
- **opencode-sdk as a first-class `AgentRunner` replacing all `sdkMode`/literal checks (integrations §P3, XL/high).** CUT as a standalone. Highest-risk item in the review; **subsumed by X3** — once `executeRunner` internalizes the fork, the residual setup.ts/config-migration.ts literals are a small incremental follow-up, not an XL contract rewrite.
- **Harness "descriptor-as-provider-of-providers" lazy accessors (integrations §P2).** CUT/defer. Verified the registries are *already* derived (`SESSION_LOG_HARNESSES = HARNESS_REGISTRY.filter(h => h.capabilities.sessionLogs)`, harnesses/index.ts:80), and a load-time throw guards the rest. Hanging accessors off the pure data descriptor forces lazy-import dodges for a closed 2-element set. Do only if a 3rd harness lands; if pursued, a `satisfies` exhaustiveness check is the right shape, not behavior-on-descriptor.
- **`SalienceStore` facade (improve §P5).** CUT as standalone — the proposal itself concedes it's "closer to a code-organization win than a present pain." 14 loose imports of pure functions over a db handle is a nit, not coupling that bites. Fold in only if it falls out of D1.
- **`AiRunner` interface + relocate `call-ai.ts` (llm §P4).** DOWNGRADE. The back-edge is real but is ONE import in ONE small file. Just **move the file under `src/integrations`** to fix layering; skip the new interface — X3's `executeRunner` largely subsumes the agent-vs-http fork. Don't build two runner abstractions.
- **`selectEmbedder` factory (llm §P3).** DOWNGRADE to a bundled tidy. The embedder half is "textbook Facade+Strategy already in place"; 4 `hasRemoteEndpoint` branches in one 190-line file is local dup, not cross-module coupling. **Keep only the context-overflow classifier unification** (folded into X2) — that fixes a real correctness divergence.
- **`VecBackedStore` vs `JsFallbackStore` Strategy classes (storage §P4).** CUT the class formalization — two Strategy classes for a binary `if (isVecAvailable(db))` is heavier than the problem. **Keep** the `db.ts` decomposition into lifecycle/schema/embedding-store as a plain split (deferred; lower priority than D2).
- **`FormatRenderer` per-(command,format) registry for md/html (output §P2, cli §P4).** DOWNGRADE. Verified only TWO sites use the intercept and BOTH are health. Building a general extension framework for one consumer is the speculative-flexibility trap. **Instead:** relocate health's html/md renderers behind `output()` (a 2-entry lookup); add the registry only when a 2nd command needs md/html.
- **Data-driven metadata-contributor descriptor (output §P3).** DEFER (lowest priority). `renderers.ts` already uses a clean registry; the special cases (memory mtime, secret body-never-read) escape the table anyway, leaving two mechanisms.
- **Full core→features Dependency-Inversion via `core/contracts` (core §P5).** DOWNGRADE. The coupling is real but **acyclic and stable today** (harnesses is a graph leaf). High-churn for a purity argument. **Keep only the surgical fix:** the genuinely wrong-direction reach — `state-db.ts:56` importing `Proposal` from `commands/` — by defining that row/domain type in core (handled inside D2). Leave the integrations/registry type-imports until they actually cause a cycle.

---

## Sequenced roadmap

**Phase 0 — Risk-free, do immediately (parallel, no dependencies):**
1. **R4** delete dead provider interface (~120 LOC, grep-proven zero callers) — clarifies the real contract before D4.
2. **X2 (type half) / llm dedup:** replace the 6 inline `LlmConnectionConfig & { supportsJsonSchema }` with the existing `LlmProfileConfig`; unify the context-overflow classifier. tsc-verifiable, zero runtime change.
3. **R6** collapse the `text/*`/`shapes/*` wrapper indirection (removes a layer, adds nothing).

**Phase 1 — The prerequisite seams (low risk, high reach):**
4. **X1** `openManagedDatabase` + `withManagedDb`/`withStateDb` — deletes the 27 `owns*` sites; the prerequisite that makes D2 and D1 safe.
5. **X2** `callStructured()` template — staged one caller at a time; shrinks the improve/indexer bodies as a side effect.
6. **X3** `executeRunner()` — design jointly with X2 so it returns into the same outcome type.

**Phase 2 — Decompositions (medium risk, on the new seams):**
7. **D3** consolidate.ts split, **D4** git.ts split, **D5** WorkflowAssetLoader, **R1** typed PhaseResults, **R3** fetchCachedJson, **R2** provider.sync routing — all pure moves / contained reshapes that also fix verified encapsulation breaks.
8. **D2** state-db.ts → per-domain repos behind the explicit ordered migration registry (on X1). Keep the array literal explicit to preserve append-only ordering.

**Phase 3 — The big cohesion target (high risk, last):**
9. **D1** improve.ts: `runWithTelemetry` → extract locks/eligibility/budget/run-telemetry + `ImproveRunContext` → **D1b** `withProcessLock` → the scoped opt-in registry. Gated behind X1/X2 landing so the loop operates on extracted services.
10. **R8** `runImproveSession`, **R9** dir-staleness extraction, **R7** `defineGroupCommand`, **R5** source-kind table — independent reshapes, any time after Phase 1.

**Phase 4 — Ratchets:**
11. **X4** the "repository owns ALL SQL" lint guard — lands after D2/D3/D5 clear the existing offenders, then prevents regression. Add the same explicit-ordered-migration-fragment convention as a documented rule for both state.db and index.db.

**Guiding principles.** (a) Dead-code → loan-seams → dispatch-collapses → god-module decomposition → registry reshapes that depend on the decomposition. (b) Never start with the XL rewrites (D1, D2). (c) For any "registry-as-source-of-truth" item (D1, R5), verify the **effective** runtime-config path, not just the code default — per the #632 inert-feature footgun, a registry isn't authoritative if config.json can still pin the old value.