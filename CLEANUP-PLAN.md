> **Status: Completed.** This audit was performed on 2026-03-17 and the identified issues
> have been addressed. See ARCHITECTURE.md for current design decisions.

# Cleanup Plan: feat/searchImprovements

Comprehensive list of everything that needs to be cleaned up, with regression risks identified.

## Branch stats
- 79 files changed, +10,726 / -421 lines
- 20 source files modified/added
- 1188 tests (vs ~1020 on main)
- DB_VERSION: 6 (main) → 8 (feat)

---

## WHAT TO KEEP (genuine improvements over main)

### Scoring pipeline improvements
| Change | Files | Risk |
|--------|-------|------|
| Normalized BM25 (0.3-1.0) replacing RRF (0.0164 flat) | `local-search.ts` | Low — strictly better differentiation |
| Multi-column FTS5 (name 10x, desc 5x, tags 3x, hints 2x, content 1x) | `db.ts`, `indexer.ts` | Low — requires DB_VERSION bump, drop+recreate |
| Exact name match boost (+2.0) | `local-search.ts` | Low — new signal, doesn't remove old ones |
| Type relevance boost (skill +0.4, command +0.35, agent +0.3, script +0.2) | `local-search.ts` | Low — new signal |
| Alias exact match boost (+1.5) | `local-search.ts` | Low — new signal |
| Description relevance boost (+0.25 all tokens) | `local-search.ts` | Low — new signal |
| Fuzzy/prefix fallback in FTS5 | `db.ts` | Low — only triggers when exact returns 0 |
| Score-preserving merge (local scores not destroyed) | `stash-search.ts` | **Medium** — changes merge behavior, see risks below |

### New features
| Feature | Files | Risk |
|---------|-------|------|
| `akm show --detail summary` | `stash-show.ts`, `cli.ts`, `stash-types.ts` | Low |
| `akm manifest` | `manifest.ts`, `cli.ts`, `stash-types.ts` | Low — new command, no existing behavior changed |
| `akm info` | `info.ts`, `cli.ts`, `stash-types.ts`, `version.ts` | Low — new command |
| `akm feedback` | `cli.ts`, `usage-events.ts` | Low — new command |
| `--for-agent` output mode | `cli.ts` | Low — new flag, standard output unchanged |
| `--format jsonl` | `cli.ts` | Low — new format option |
| `estimatedTokens` on search hits | `local-search.ts`, `stash-types.ts` | Low — additive field |
| Configurable embedding model | `embedder.ts`, `config.ts` | Low — backward compatible |
| LRU embedding cache | `embedder.ts` | Low — transparent optimization |
| Parameter extraction ($ARGUMENTS, @param) | `metadata.ts` | **Medium** — adds new metadata to entries, see risks |
| Asset registry refactor | `asset-registry.ts`, `asset-spec.ts`, `local-search.ts` | **Medium** — moves code between modules |

### Infrastructure
| Change | Files | Risk |
|--------|-------|------|
| Usage events table | `db.ts`, `usage-events.ts` | Low — new table, no existing tables changed |
| Utility scores table | `db.ts` | Low — new table |
| Benchmark suite | `tests/benchmark-suite.ts` | None — test-only |
| Ranking regression tests | `tests/ranking-regression.test.ts`, `tests/ranking-fixtures/` | None — test-only |
| Benchmark docs | `tests/BENCHMARKS.md` | None — docs only |

---

## WHAT TO FIX

### Critical bugs

#### F-1. Utility scoring is dead in production
- **What:** `logSearchEvent`/`logShowEvent` never set `entry_id`, so `recomputeUtilityScores` always gets 0 rows
- **Fix:** `recomputeUtilityScores` should join on `entry_ref` (string) not `entry_id` (integer), OR the log functions should resolve refs to IDs
- **Risk:** Low — feature is currently inert, fixing it only adds behavior
- **Files:** `src/indexer.ts` (recomputeUtilityScores), `src/usage-events.ts`

#### F-2. SQL interpolation in purgeOldUsageEvents
- **What:** `retentionDays` interpolated into SQL string
- **Fix:** Compute cutoff date in JS, pass as parameter
- **Risk:** None — same behavior, safer implementation
- **Files:** `src/usage-events.ts`

### Major bugs

#### F-3. Duplicate DROP TABLE usage_events in ensureSchema
- **What:** Same DROP appears twice in version-migration block
- **Fix:** Delete the duplicate line
- **Risk:** None
- **Files:** `src/db.ts`

#### F-4. RECENCY_HALF_LIFE_DAYS is not a half-life
- **What:** Named "half life" but the math is `e^(-t/τ)` (time constant), not `e^(-t*ln2/t½)` (half-life)
- **Fix:** Rename to `RECENCY_DECAY_DAYS` or fix the math
- **Risk:** None — only affects naming, not behavior (utility scoring is dead anyway per F-1)
- **Files:** `src/local-search.ts`

#### F-5. EMA decay tied to index frequency not time
- **What:** Each `akm index` applies one round of EMA regardless of time elapsed
- **Fix:** Track last computation time, only apply EMA proportional to elapsed time
- **Risk:** Low — utility scoring is dead per F-1, fix this when fixing F-1
- **Files:** `src/indexer.ts`

### Stale/wrong code to remove

#### F-6. Duplicate JSDoc on mergeStashHits
- **What:** Two consecutive JSDoc blocks before the function
- **Fix:** Delete the first (shorter) one
- **Risk:** None
- **Files:** `src/stash-search.ts`

#### F-7. Dead functions: getUsageEventCounts, getLastUsedAt
- **What:** Exported but never imported anywhere
- **Fix:** Delete both functions
- **Risk:** None — grep confirms no callers
- **Files:** `src/usage-events.ts`

#### F-8. Stale re-exports in stash-search.ts
- **What:** 5 symbols re-exported with a wrong comment about filesystem.ts needing them
- **Fix:** Delete the re-exports and stale comment
- **Risk:** **Medium** — external consumers importing from `stash-search` would break. Check if any installed kits or plugins import these.
- **Files:** `src/stash-search.ts`

#### F-9. Stale RRF comment in local-search.ts
- **What:** Comment describes old RRF approach that no longer exists
- **Fix:** Update comment to describe current normalized BM25 approach
- **Risk:** None
- **Files:** `src/local-search.ts`

#### F-10. Dead `entry` variable in rebuildFts
- **What:** Declared and assigned but only used as intermediate for buildSearchFields
- **Fix:** Inline the parse into the buildSearchFields call
- **Risk:** None
- **Files:** `src/db.ts`

#### F-11. Dead parameters (_stashDir, _query, _dirPath)
- **What:** Three functions accept unused parameters
- **Fix:** Remove the parameters and update call sites
- **Risk:** Low — internal functions only
- **Files:** `src/indexer.ts`, `src/local-search.ts`

#### F-12. `require()` in ESM for circular dependency
- **What:** `db.ts` uses `require("./indexer")` to break circular dep
- **Fix:** Extract `buildSearchFields` to a shared module like `src/search-fields.ts`
- **Risk:** **Medium** — changes module graph, all imports need updating
- **Files:** `src/db.ts`, `src/indexer.ts`, new `src/search-fields.ts`

---

## WHAT TO REMOVE ENTIRELY

### Context-hub scoring/search duplicate (LOGIC-AUDIT #0)
- **What:** `context-hub.ts` has its own `scoreEntry`, `entryToHit`, scoring weights — duplicating the entire FTS5 pipeline
- **Fix:** Index context-hub content through the normal pipeline; keep provider for `show` only
- **Risk:** **HIGH** — changes how ~800+ context-hub assets are discovered. Requires:
  1. Adding context-hub cache dir to `resolveStashSources` or `resolveAllStashDirs`
  2. Ensuring the indexer walks it correctly
  3. Ensuring `context-hub://` refs still work for `show`
  4. Testing that search quality is maintained or improved
  5. The context-hub index cache (`index.json`) would become redundant for search
- **Migration:** Keep `context-hub.ts` provider for `show` and cache management. Remove `search()` method or make it delegate to the FTS index. Add the cache dir as a filesystem source.

### FilesystemStashProvider (LOGIC-AUDIT #9)
- **What:** Registered but never instantiated for search (skipped by resolveStashProviders)
- **Fix:** Delete the class, keep the file for the `registerStashProvider("filesystem", ...)` call if needed, or remove entirely
- **Risk:** **Medium** — the provider IS used for `canShow` routing in `stash-show.ts`... wait, no — `resolveStashProviders` skips filesystem, so it's never in the provider list for show either. It's fully dead.
- **Verify:** `grep -r "FilesystemStashProvider\|filesystem.*provider" src/ tests/` to confirm no references

### Dead code from incomplete features
- **What:** `recordUsageEvent` in `usage-events.ts` — test-only helper that should be in test utils, not production code
- **Fix:** Move to test helper file or inline in test
- **Risk:** Low
- **Files:** `src/usage-events.ts`

---

## INCONSISTENCIES TO RESOLVE

### I-1. SearchSource type name collision
- **What:** `SearchSource` means two different things in `stash-types.ts` (scope string) vs `search-source.ts` (path object)
- **Fix:** Rename one — suggest `SearchScope` for the string union
- **Risk:** **Medium** — wide rename across many files
- **Files:** `src/stash-types.ts`, `src/stash-search.ts`, `src/cli.ts`, many test files

### I-2. console.warn vs warn() in db.ts
- **What:** `db.ts` uses raw `console.warn` bypassing the quiet mode system
- **Fix:** Import and use `warn()` from `./warn.ts`
- **Risk:** None — just adds quiet mode support
- **Files:** `src/db.ts`

### I-3. Inconsistent query lowercasing
- **What:** `akmSearch` lowercases for local search but passes original case to providers
- **Fix:** Lowercase consistently or document the difference
- **Risk:** Low
- **Files:** `src/stash-search.ts`

### I-4. Duplicated sanitizeString and isExpired
- **What:** Identical functions in both `context-hub.ts` and `openviking.ts`
- **Fix:** Extract to shared utility
- **Risk:** None
- **Files:** `src/stash-providers/context-hub.ts`, `src/stash-providers/openviking.ts`

### I-5. Tests using `source: "local"` not in SearchSource type
- **What:** Works via alias but bypasses type safety
- **Fix:** Add `"local"` to type or change tests to `"stash"`
- **Risk:** None
- **Files:** Multiple test files

### I-6. Issue tag comment conventions (Issue #1, CR-1, HI-14, M-2, S-3, etc.)
- **What:** 5+ different prefixing conventions in comments, none reference real GitHub issues
- **Fix:** Remove or standardize. Describe behavior, not task IDs
- **Risk:** None — comments only

### I-7. Mixed import styles for bun:sqlite Database
- **What:** Top-level import in `db.ts`, inline `import("bun:sqlite").Database` elsewhere
- **Fix:** Top-level import everywhere
- **Risk:** None
- **Files:** `src/indexer.ts`, `src/local-search.ts`

### I-8. Bun-specific API in openviking.ts
- **What:** Uses `Bun.CryptoHasher` while rest of codebase uses `node:crypto`
- **Fix:** Use `createHash` from `node:crypto`
- **Risk:** None
- **Pre-existing:** This is on main too, not introduced by this branch

---

## REGRESSION RISKS

### R-1. DB_VERSION bump (6 → 8) forces full reindex
- **Impact:** Every user who switches to this branch must rebuild their entire index. With Ollama LLM configured, this takes 10+ minutes for 1200 entries.
- **Mitigation:** Document in release notes. Consider if version 7 (multi-column FTS5) is enough — utility_scores could be added without a version bump since it's `CREATE TABLE IF NOT EXISTS`.

### ~~R-2. Score scale change breaks external consumers~~
- **Not a concern** — no current external consumers of the score values.

### R-3. `mergeStashHits` behavior change — OpenViking must be treated as local
- **Impact:** On feat, provider results are suppressed below all local hits. OpenViking is a stash — its results should compete on equal footing with local results, not be treated as second-class.
- **Fix:** OpenViking results should go through the same scoring pipeline as local stash results. OpenViking content should be indexed into the local FTS5 index, just like context-hub content should be. If that's not feasible (truly remote, no local cache), then OpenViking's own relevance scores should be normalized and merged fairly — not suppressed.

### R-4. Name boost removal + type boost addition changes ranking
- **Impact:** On main, name match adds +0.10 flat. On feat, it adds up to +2.0 (exact match). Scripts that expected a specific asset at rank N may see different rankings.
- **Mitigation:** The new ranking is objectively better (skills for their own names rank #1). But any automation hardcoded to specific rank positions will break.

### R-5. Parameter extraction adds data to entries
- **Impact:** Commands with `$ARGUMENTS` and scripts with `@param` now have `parameters` in their entry JSON. This increases entry_json size slightly and adds terms to FTS content. Could change ranking for queries that match parameter names.
- **Mitigation:** Low risk — parameters are additive metadata. The change only improves discoverability.

### R-6. Asset registry refactor changes module structure
- **Impact:** `TYPE_TO_RENDERER` and `ACTION_BUILDERS` moved from `local-search.ts` to `asset-registry.ts`. Any external code importing from `local-search.ts` expecting these exports will break. The re-exports in `stash-search.ts` (F-8) were meant to handle this but they re-export from the wrong module.
- **Mitigation:** Check if any installed kits or external tools import from these modules. The `stash-search.ts` re-exports should import from `asset-registry.ts` if they're kept.

### R-7. context-hub fileSize addition changes cached index format
- **Impact:** `buildEntry` now adds `fileSize` to `ContextHubEntry`. The cached `index.json` format changes. Old caches won't have this field. `isContextHubEntry` validator doesn't check for it, so old caches still load — but `estimatedTokens` will be `undefined` for old cached entries until the cache refreshes (12hr TTL).
- **Mitigation:** None needed — graceful degradation. Field is optional.

### R-8. Replacing context-hub provider with standard git stash provider
- **Impact:** The `context-hub` stash type must be replaced with a standard git-based stash provider that works like `akm add` for git repos: clone → cache → register as filesystem stash → index through normal pipeline.
- **Approach:**
  1. Create a generic `git` stash provider type that handles any git repo URL (not just context-hub)
  2. `type=git` (or `type=context-hub` as alias) in config triggers: clone/pull the repo to cache dir, register the cache dir as a filesystem stash source
  3. `resolveStashSources` includes the cache dir so the indexer walks and indexes it
  4. Search goes through the unified FTS5 pipeline — no separate `scoreEntry`, no separate `search()` method
  5. The provider retains `show()` for `context-hub://` ref resolution and `canShow()` for routing
  6. Consolidate with the existing `akm add github:owner/repo` behavior — both should use the same clone/cache mechanism
  7. The existing `ContextHubStashProvider.search()` method and `scoreEntry`/`entryToHit` functions become dead code and are removed
- **Migration:** On first `akm index` after the change, context-hub content appears in the FTS5 index. No user action needed beyond re-indexing (which the DB_VERSION bump already forces).
- **Risk:** Low if done correctly — the indexer already handles walking arbitrary directories. The main risk is that context-hub's cache structure (tarball extraction, nested `content/` dir) may not match what the walker expects. Test with the real repo.

---

## PRIORITY ORDER FOR CLEANUP

### Phase 1: Fix critical bugs (no behavior change)
1. F-1: Fix utility scoring (entry_ref join)
2. F-2: Fix SQL interpolation
3. F-3: Remove duplicate DROP TABLE

### Phase 2: Remove dead code (no behavior change)
4. F-6: Remove duplicate JSDoc
5. F-7: Remove dead functions
6. F-9: Fix stale comments
7. F-10: Remove dead variable
8. F-11: Remove dead parameters
9. I-6: Clean up issue tag comments

### Phase 3: Fix inconsistencies (minimal risk)
10. I-2: console.warn → warn()
11. I-4: Extract shared utilities
12. I-5: Fix test source type
13. F-4: Rename RECENCY_HALF_LIFE_DAYS

### Phase 4: Structural changes (need testing)
14. F-12: Extract buildSearchFields to break circular dep
15. I-1: Rename SearchSource → SearchScope
16. F-8: Evaluate stash-search.ts re-exports

### Phase 5: Foundational fixes (highest risk, highest value)
17. Replace context-hub provider with standard git stash provider — clone → cache → filesystem stash → index. Consolidate with existing `akm add github:repo` clone/cache mechanism. Keep provider for `show` (context-hub:// ref resolution) only. Remove `scoreEntry`, `entryToHit`, and `search()` from provider.
18. Treat OpenViking as a local stash — index its content if possible, or normalize its scores to compete fairly with local results instead of suppressing below.
19. Remove FilesystemStashProvider dead code.
20. Separate registry results from stash results — different `hits` vs `registryHits` arrays in SearchResponse.
