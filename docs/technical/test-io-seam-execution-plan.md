# #664 Seam Refactor — Execution Plan (step-by-step, one green commit per item)

Working checklist for implementing `test-io-seam-design.md` + its §8 addendum.
**Invariant for every commit:** `bun run check` (lint + custom lints + tsc +
test:unit + test:integration) shows 0 errors / 0 warnings / 0 failures before
commit. Every production seam is a trailing optional defaulting to the real impl
(backward compatible). Test-migration commits also lower the unit-purity ratchet.

Legend: `[x]` done · `[ ]` pending · each line ≈ one commit (some batch 2-3).

---

## Phase 0 — gate scaffold (Step 0)
- [ ] **C0.1** Parameterize the CI knob: `run-test-shard.sh` → `--parallel="${SHARD_PARALLEL:-1}"`. No prod code. (Reviewer R3-1 blocker: the gate was inert.)
- [ ] **C0.2** Add `scripts/lint-tests-unit-purity.ts` (rules: `real-spawn`, `real-serve`, `akmIndex({full:true})` in a `test()` body), seeded with today's offenders as a shrink-only `UNIT_PURITY_BASELINE` + `baseline === live` meta-test; operate on the unit glob with a per-file allowlist (not a dir match — R3-5). Wire into `bun run lint`.

## Phase 1 — Seam 1 (HTTP `HttpClient`) · the ~26 `Bun.serve` collapse
- [x] **C1.1** Prod seam: `common.ts` HttpClient + `fetchWithTimeout`/`fetchWithRetry`; `client.ts` `fetch?`; `RemoteEmbedder` deps + `embed()` facade; export `l2Normalize`. (`346487f6`)
- [ ] **C1.2** Registry prod seam (1d): extract the two duplicated `withRegistryCacheDb` into one `src/registry/providers/cache-db.ts` (preserve each `rethrowIfTestIsolationError`); add `RegistryCache` + `RegistryProviderDeps` to `types.ts`; thread `fetch`+`cache` into `loadIndex` (static-index + skills-sh) and widen the factory. (R2-6 / R3-2)
- [ ] **C1.3** Migrate `llm-client.test.ts` + `llm.test.ts` off `Bun.serve`/`globalThis.fetch`-patch → injected `{ fetch }`; keep one injected-`AbortError` fetch test for the timeout→`LlmCallError` map.
- [ ] **C1.4** Migrate `embedder.test.ts` + `embedding-model-config.test.ts` → injected `deps.fetch`; test `l2Normalize`/`normalizeEmbeddingEndpoint`/`resolveEmbeddingModelId` directly. Add `clearEmbeddingCache`+`resetLocalEmbedder` to `resetAllProcessState`.
- [ ] **C1.5** Migrate graph-extract suites (`graph-extraction`, `graph-extract-batch`, `graph-extraction-batch`, `graph-lazy-show-curate`) → injected fetch via `chatCompletion`.
- [ ] **C1.6** Migrate registry suites (`registry-search`, `registry-providers/{static-index,skills-sh,parity}`, `registry-index-v2`, `registry-cli`) → injected fetch + in-memory `RegistryCache`; test `scoreKits`/`parseRegistryIndex`/`parseSkillsResponse` directly.
- [ ] **C1.7** De-socket `registry-build-index` (keep ONE integration test for real pagination) + the embedder paths in `commands/search` / `commands/show-indexer-parity`.

## Phase 2 — Seam 2 (`:memory:` entries) + guard + do-now sweep items
- [ ] **C2.1** `src/indexer/db/entry-reader.ts`: `GetAllEntries` type + `sqliteGetAllEntries()` (default, uses the SAME `openExistingDatabase` path) + `inMemoryGetAllEntries(db)` (real `:memory:` + real `getAllEntries`). `tests/_helpers/seed-entries.ts` (`openDatabase(":memory:", { embeddingDimension: EMBEDDING_DIM })`, seed via real `upsertEntry`). Wire `AkmImproveOptions.getAllEntries?` replacing the inline open at `improve.ts:662-664`.
- [ ] **C2.2** Runtime purity guard `tests/_helpers/purity-guard.ts`: throw on real `openDatabase`/`openStateDatabase`/`openExistingDatabase`/`globalThis.fetch`; exempt **exactly** `p === ":memory:"` at the storage boundary (`storage/database.ts:119`). Harness sets `AKM_NO_AUTO_MIGRATE=1` + `PRAGMA temp_store=MEMORY`. (§8.3 corrections 1+2.) **Also fix the §3 doc pseudocode is already done.**
- [ ] **C2.3** Issue C (ships with guard): `graph-db.ts` inner `catch { return null }` → `rethrowIfTestIsolationError(err)` first; typed `GraphSnapshotCorruptError` for corrupt-vs-absent.
- [ ] **C2.4** Do-now resets into `resetAllProcessState`: A (`clearLlmUsageSink`, stack-discipline), H (sqlite-pragma/`pushOnCommitWarned`/config/graph-boost/SDK-server/matcher warn-once + lazy singletons), I (idempotent registry-provider + matcher registration fns). Split into 2 commits if large.
- [ ] **C2.5** B (graph-extraction `readFile?` param) + G (`.sort()` at unsorted-readdir → capped-selection boundaries: `consolidate.ts`, `memory-contradiction-detect.ts`, `tasks.ts`). Small.
- [ ] **C2.6** Migrate the ~20 improve tests off `akmIndex({full:true})` → `seedEntries`/`collectEligibleRefsFn`. Batch ~5-7 files per commit.

## Phase 3 — Seam 3 (search `:memory:`) + E (gate precondition)
- [ ] **C3.1** Issue E (HARD gate precondition): thread `disableProjectContext`/`disableScopedUtility`/`cwd`/`scopeKey` into the `searchLocal`/`searchOnDb` options bag, resolved once at the search-cli edge; **delete** the `process.env.AKM_DISABLE_PROJECT_CONTEXT` write (`search-cli.ts:100`) and read (`db-search.ts:392`).
- [ ] **C3.2** Export `searchOnDb(db, input)`; add `db?: Database` to `searchLocal` (skip ensureIndex/open, gate the `finally` close). Migrate search/scoring/curate cluster to `:memory:` (FTS5+vec) or `beforeAll` shared fixture.
- [ ] **C3.3** L (if cheap): `ensureIndexFn?`+`eventSink?` on `akmShow`/`curate`; spawn decision passed as `ensureIndex(stashDir,{allowBackgroundSpawn})` at the edge. Else → deferred.

## Phase 4 — Seam 4 (stdin)
- [ ] **C4.1** `src/core/io-port.ts` `StdinPort` (leaf module); guarded `setStdinPort` (`AKM_TEST_HARNESS`); `readStdin`/`tryReadStdinText` delegate; `runCliCapture({ stdin })`; `resetStdinPort()` in `resetAllProcessState`.
- [ ] **C4.2** Migrate stdin spawns (`secret`, `remember-frontmatter`, `capture-cli`, `env create`) to `runCliCapture`.
- [ ] **C4.3** Relocate `env run` / `secret run` (inherited-fd grandchild) into `tests/integration/`.

## Phase 5 — Seam 5 (time) + F-min (gate precondition)
- [ ] **C5.1** F-min (HARD gate precondition): thread `env: NodeJS.ProcessEnv = process.env` through `getDbPath`/`getCacheDir`/`getDefaultStashDir` (sibling pattern); retire the `improve.ts:1131` env-snapshot race.
- [ ] **C5.2** Seam 5 prod: `AkmImproveOptions.now?` (telemetry bookends only); `tailEvents` via `resolveNow(ctx)`; thread `ctx.db` into `readEvents`; `TailOptions.setIntervalFn?`/`clearIntervalFn?`.
- [ ] **C5.3** Migrate real-sleep tests (`events.test.ts`, `improve-budget-watchdog`, `improve-reflect-unsupported-type-skip`) to injected fakes; `setTimeout(r,0)` → `await Promise.resolve()`.

## Phase 6 — close out + the `--parallel>1` flip
- [ ] **C6.1** Drive `UNIT_PURITY_BASELINE` → 0 (final stragglers) + drive `lint-tests-isolation` ratchet 64 → ~5 (`withIsolatedAkmStorage`/`makeStashDir`). Batch.
- [ ] **C6.2** Install the runtime purity guard globally in the unit tier; add lint rules (no `fs.readFileSync(0)`/`process.stdin` outside `io-port`/`runtime`/`common`; no real-sleep in unit tier).
- [ ] **C6.3** The gate: opt-in CI job `SHARD_PARALLEL=4` × 20 runs, 0 `RACE_SIGNATURE` retries, with E + F-min landed. If green, flip the `run-test-shard.sh` default; keep the epoll retry wrapper as defence-in-depth.

## Phase 7 — DEFERRED, owner-gated (separate proposal, off critical path)
God-function / reader decomposition — **requires explicit owner go-ahead per PR**, touches cron-critical files (`improve.ts`, `consolidate.ts`), zero bearing on the flip: D (`runImprovePreparationStage`), D2 (`indexEntries`), J (`akmConsolidateInner`/`akmReflect`/`akmDistill`), K (openDatabase CQS), M (session readers), N (selection-window clock), L (if not done in C3.3), O (leaf default-to-pure fixes).

---

### Commit cadence
- One item = one commit unless noted; `bun run check` green before each.
- Production-seam commits land first within a phase (backward compatible), then the test migrations that consume them (which also lower the ratchet).
- Gate preconditions **E** (C3.1) and **F-min** (C5.1) MUST be merged before C6.3.
