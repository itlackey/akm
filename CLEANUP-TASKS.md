> **Status: Completed.** This audit was performed on 2026-03-17 and the identified issues
> have been addressed. See ARCHITECTURE.md for current design decisions.

# Cleanup Tasks

Consolidated from SLOP-AUDIT.md, LOGIC-AUDIT.md, and CLEANUP-PLAN.md.

---

## Phase 1: Critical Bugs

- [ ] **C-1** Utility scoring dead in production — `logSearchEvent`/`logShowEvent` never set `entry_id`, so `recomputeUtilityScores` always gets 0 rows. Fix: join on `entry_ref` instead of `entry_id`. Files: `src/indexer.ts`, `src/usage-events.ts`
- [ ] **C-2** SQL interpolation in `purgeOldUsageEvents` — `retentionDays` interpolated into SQL string. Fix: compute cutoff date in JS, pass as parameter. File: `src/usage-events.ts:170`

## Phase 2: Dead Code Removal

- [ ] **D-1** Duplicate `DROP TABLE IF EXISTS usage_events` in `ensureSchema`. File: `src/db.ts:133,140`
- [ ] **D-2** Duplicate JSDoc block on `mergeStashHits`. File: `src/stash-search.ts:196-205`
- [ ] **D-3** Dead functions `getUsageEventCounts` and `getLastUsedAt` — exported but never imported. File: `src/usage-events.ts:112-142`
- [ ] **D-4** Dead re-exports in `stash-search.ts` with wrong comment about `filesystem.ts`. File: `src/stash-search.ts:190-194`
- [ ] **D-5** Dead `entry` variable in `rebuildFts` — only used as intermediate. File: `src/db.ts:380`
- [ ] **D-6** Dead parameters: `_stashDir` in `indexEntries` (`src/indexer.ts:171`), `_query` in `assetToSearchHit` (`src/local-search.ts:666`), `_dirPath` in `enhanceStashWithLlm` (`src/indexer.ts:455`)
- [ ] **D-7** `recordUsageEvent` is a test-only helper in production code. Move to test utils. File: `src/usage-events.ts`
- [ ] **D-8** `FilesystemStashProvider` — registered but never instantiated (skipped by `resolveStashProviders`). File: `src/stash-providers/filesystem.ts`

## Phase 3: Stale Comments & Naming

- [ ] **S-1** Stale RRF comment in scoring pipeline. File: `src/local-search.ts:187-189`
- [ ] **S-2** `RECENCY_HALF_LIFE_DAYS` is not a half-life — rename to `RECENCY_DECAY_DAYS`. File: `src/local-search.ts:389`
- [ ] **S-3** Issue tag comment conventions — 5+ formats (Issue #1, CR-1, HI-14, M-2, S-3) that don't reference real GitHub issues. Clean up across: `src/local-search.ts`, `src/db.ts`, `src/indexer.ts`
- [ ] **S-4** Stale comment on re-exports claims `filesystem.ts` needs them — it doesn't. File: `src/stash-search.ts:190`
- [ ] **S-5** Orphaned doc comment `/** Set of all known type directory names */` before unrelated function. File: `src/indexer.ts:417`

## Phase 4: Inconsistencies

- [ ] **I-1** `console.warn` bypasses quiet mode in `db.ts` — replace with `warn()` from `./warn.ts`. File: `src/db.ts` (6 occurrences)
- [ ] **I-2** Duplicated `sanitizeString` function in both providers. Files: `src/stash-providers/context-hub.ts:444`, `src/stash-providers/openviking.ts:12`
- [ ] **I-3** Duplicated `isExpired` function in both providers. Files: `src/stash-providers/context-hub.ts:450`, `src/stash-providers/openviking.ts:373`
- [ ] **I-4** Tests use `source: "local"` not in `SearchSource` type — change to `"stash"` or add `"local"` to type. Multiple test files.
- [ ] **I-5** `SearchSource` type name collision — means string union in `stash-types.ts` and path object in `search-source.ts`. Rename one (suggest `SearchScope` for the string union). Files: `src/stash-types.ts`, `src/search-source.ts`, many consumers
- [ ] **I-6** Mixed `import("bun:sqlite").Database` inline vs top-level import. Files: `src/indexer.ts`, `src/local-search.ts`
- [ ] **I-7** Inconsistent query lowercasing — `akmSearch` lowercases for local but passes original case to providers. File: `src/stash-search.ts`
- [ ] **I-8** `Bun.CryptoHasher` in `openviking.ts` while rest of codebase uses `node:crypto`. File: `src/stash-providers/openviking.ts:227` (pre-existing on main)
- [ ] **I-9** Walker `SKIP_DIRS` duplicated in git-walker and manual-walker. File: `src/walker.ts:92,150`
- [ ] **I-10** `ASSET_TYPES` is mutable `let` export — footgun for consumers who capture it. File: `src/asset-spec.ts:137`

## Phase 5: Structural Fixes

- [ ] **X-1** `require()` in ESM to break circular dependency between `db.ts` and `indexer.ts`. Fix: extract `buildSearchFields` to `src/search-fields.ts`. Files: `src/db.ts:365`, `src/indexer.ts`
- [ ] **X-2** EMA utility decay tied to index frequency not time — each `akm index` applies one EMA round regardless of elapsed time. Fix: track last computation time, apply proportionally. File: `src/indexer.ts:650-662`
- [ ] **X-3** `boostSum` has no overall cap — can reach 4.79x with adversarial metadata. Consider adding a max multiplier. File: `src/local-search.ts:278-380`
- [ ] **X-4** Redundant DB connections for telemetry — `logSearchEvent`/`logShowEvent` open separate connections instead of reusing the search/show connection. Files: `src/stash-search.ts:169-188`, `src/stash-show.ts:60-74`
- [ ] **X-5** `FilesystemStashProvider.canShow` doesn't exclude `context-hub://` refs. File: `src/stash-providers/filesystem.ts:45-47`
- [ ] **X-6** `FilesystemStashProvider` constructor caches config eagerly, never refreshes. File: `src/stash-providers/filesystem.ts:18`
- [ ] **X-7** Empty-query search silently excludes all additional stash providers. File: `src/stash-search.ts:73`
- [ ] **X-8** Duplicate stash-providers/index import for side-effect registration. Files: `src/stash-show.ts:17`, `src/stash-search.ts:8`
- [ ] **X-9** `mergeStashHits` — all provider scores collapse to 0 when `minLocalScore` is 0. File: `src/stash-search.ts:241`

## Phase 6: Foundational — Git Provider Consolidation

- [ ] **F-1** Replace `context-hub` provider with standard git stash provider. Any git repo URL in stash config should follow the same path as `akm add github:repo`: clone → cache → register cache dir as filesystem stash → index through unified FTS5 pipeline. Keep provider `show()` for `context-hub://` ref resolution. Remove `search()`, `scoreEntry`, `entryToHit` from provider. Consolidate clone/cache with existing `akm add` mechanism. File: `src/stash-providers/context-hub.ts`
- [ ] **F-2** Treat OpenViking as a local stash — index its content into local FTS5 if possible. If content is truly ephemeral, normalize its scores to compete fairly with local results instead of suppressing below. File: `src/stash-providers/openviking.ts`, `src/stash-search.ts`
- [ ] **F-3** Separate registry results from stash results — `SearchResponse` should have separate `hits` (usable assets) and `registryHits` (installable kits) arrays instead of merging them. Files: `src/stash-types.ts`, `src/stash-search.ts`, `src/cli.ts`
- [ ] **F-4** Simplify `mergeStashHits` — with context-hub and OpenViking indexed, merge function reduces to simple dedup. If any truly remote-only provider remains, append + dedup is sufficient. File: `src/stash-search.ts`

## Phase 7: Test Fixes

- [ ] **T-1** Add integration test for utility scoring production path — index, search (triggers `logSearchEvent`), re-index (triggers `recomputeUtilityScores`), verify utility scores populated. Currently all utility tests bypass production path.
- [ ] **T-2** Scoring pipeline test "many matching searchHints has capped boost" — ratio threshold changed from 1.5 to 5.0, should be tightened once scoring stabilizes
- [ ] **T-3** `ranking-regression.test.ts` uses synchronous module-level setup outside `beforeAll` — fragile if import fails
- [ ] **T-4** Update benchmark suite to test against real-stash-representative fixtures including git-sourced stashes and OpenViking-sourced content
