> **Status: Completed.** This audit was performed on 2026-03-17 and the identified issues
> have been addressed. See ARCHITECTURE.md for current design decisions.

# SLOP AUDIT -- agentikit Full Codebase Review

**Date:** 2026-03-17  
**Branch:** feat/searchImprovements  
**Scope:** Every file in src/ read completely; key test files reviewed  

**Total issues found: 34**
- Critical: 2
- Major: 8
- Minor: 24

---

## CRITICAL

### C-0. Utility scoring is completely dead in production

- **File:** `src/stash-search.ts` lines 169-188, `src/stash-show.ts` lines 60-74, `src/indexer.ts` lines 620-630
- **Category:** bug
- **Severity:** critical
- **What's wrong:** The entire M-2 utility scoring system is inert. `recomputeUtilityScores()` queries `usage_events WHERE entry_id IS NOT NULL GROUP BY entry_id`, but neither `logSearchEvent()` nor `logShowEvent()` ever sets `entry_id` on the events they insert. `logSearchEvent` stores entry refs in a JSON metadata blob. `logShowEvent` stores `entry_ref` (a string like `"script:deploy"`) but never `entry_id` (the integer FK). This means `recomputeUtilityScores()` always gets zero rows and returns immediately. The `utility_scores` table is always empty in production. The utility boost code in `searchDatabase()` never fires. The feature only "works" in tests because `recordUsageEvent()` (the test helper) explicitly sets `entry_id`, bypassing the production path entirely.
- **Fix:** Either make `logSearchEvent`/`logShowEvent` resolve entry refs to entry IDs, or rewrite `recomputeUtilityScores` to join on `entry_ref` instead of `entry_id`.

### C-1. SQL injection via string interpolation in purgeOldUsageEvents

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/usage-events.ts`, line 170
- **Category:** bug / security
- **Severity:** critical
- **What's wrong:** `retentionDays` is interpolated directly into a SQL string via template literal:
  ```ts
  db.prepare(`DELETE FROM usage_events WHERE created_at < datetime('now', '-${retentionDays} days')`).run();
  ```
  The function signature accepts any `number`. While the only caller passes a constant (`90`), the parameter type allows NaN, Infinity, or negative values that would produce malformed SQL. String interpolation into SQL is an anti-pattern that should never exist in production code, regardless of current call sites. SQLite's `datetime()` modifier syntax prevents traditional SQL injection, but the string interpolation pattern is inherently unsafe and will fail code reviews.
- **Fix:** Validate the input is a safe positive integer, or restructure to use a parameterized approach.

---

## MAJOR

### M-1. Duplicate DROP TABLE IF EXISTS usage_events in schema migration

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/db.ts`, lines 133 and 140
- **Category:** dead-code / inconsistency
- **Severity:** major
- **What's wrong:** `DROP TABLE IF EXISTS usage_events` appears twice in the version-migration block. Line 133 drops it, then line 140 drops it again (a no-op at that point). This is a copy-paste error in the most sensitive part of the codebase -- the schema migration path.

### M-2. Duplicate JSDoc block on mergeStashHits

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/stash-search.ts`, lines 196-218
- **Category:** stale-comment / dead-code
- **Severity:** major
- **What's wrong:** `mergeStashHits` has two consecutive JSDoc blocks. The first (lines 196-205) is a shorter, older version. The second (lines 206-218) is the current, more detailed version. The first block is entirely dead documentation. Anyone reading the code sees two conflicting descriptions.

### M-3. Stale RRF reference in scoring comment

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/local-search.ts`, lines 187-189
- **Category:** stale-comment
- **Severity:** major
- **What's wrong:** The comment says "rather than RRF, which was destroying score differentiation by compressing everything to the narrow 0.0164-0.0139 range." RRF was removed. The code now uses weighted addition. The comment documents the PREVIOUS system, not the current one. This will mislead anyone trying to understand the scoring pipeline.

### M-4. FilesystemStashProvider.canShow does not exclude context-hub:// refs

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/stash-providers/filesystem.ts`, lines 45-47
- **Category:** bug
- **Severity:** major
- **What's wrong:** `canShow` only excludes `viking://` refs. `context-hub://` refs will return `true`. Currently harmless because `akmShowUnified` queries non-filesystem providers first (and the context-hub provider claims `context-hub://` refs). But the `canShow` contract is wrong -- if routing logic changes, `context-hub://` refs would be routed to the filesystem provider and fail with a confusing error.

### M-5. FilesystemStashProvider constructor eagerly loads and caches config

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/stash-providers/filesystem.ts`, line 18
- **Category:** bug
- **Severity:** major
- **What's wrong:** The constructor calls `loadConfig()` and stores it in `this.config`. This config is never refreshed. If config changes between provider construction and search execution, the provider uses stale config. Additionally, `akmSearch` in `stash-search.ts` passes config through to `searchLocal` directly, but the filesystem provider ignores the externally-passed config and uses its own cached copy.

### M-6. logSearchEvent and logShowEvent open redundant DB connections

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/stash-search.ts`, lines 166-188; `/home/founder3/code/github/itlackey/agentikit/src/stash-show.ts`, lines 57-74
- **Category:** performance / unnecessary-complexity
- **Severity:** major
- **What's wrong:** Both functions open a new database connection, insert one row, then close it. The search/show code path already has an open database connection. The TODO comments acknowledge this ("Pass the existing DB connection... Not a correctness issue (WAL mode handles concurrent access) but wasteful"). This creates unnecessary filesystem I/O and lock contention on every search and show operation.

### M-7. RECENCY_HALF_LIFE_DAYS is misnamed (it is a time constant, not a half-life)

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/local-search.ts`, line 389
- **Category:** wrong-assumption
- **Severity:** major
- **What's wrong:** `RECENCY_HALF_LIFE_DAYS = 30` is used in `Math.exp(-daysSinceLastUse / RECENCY_HALF_LIFE_DAYS)`. This is exponential decay with a **time constant** of 30 days. At 30 days, the value is `e^(-1) = 0.368`, not `0.5`. A true half-life of 30 days would require `Math.exp(-daysSinceLastUse * Math.LN2 / 30)`. The name "half-life" will mislead anyone tuning this parameter into thinking the decay reaches 50% at 30 days when it actually reaches 36.8%.

### M-8. Empty-query search silently excludes all additional stash providers

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/stash-search.ts`, line 73
- **Category:** inconsistency
- **Severity:** major
- **What's wrong:** The guard `!query` on line 73 means that `akm search` with no query (browse-all mode) never queries additional stash providers (context-hub, OpenViking). A user who configured context-hub and runs `akm search` to browse all assets will only see local filesystem results. Context-hub and OpenViking assets are invisible in browse mode. This is undocumented.

---

## MINOR

### m-1. buildDbHit computes dead qualityBoost and confidenceBoost values

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/local-search.ts`, lines 566-568
- **Category:** dead-code
- **Severity:** minor
- **What's wrong:** `buildDbHit` computes `qualityBoost` and `confidenceBoost` but only passes them to `buildWhyMatched` for display. The actual scoring happened earlier in `searchDatabase`. The comment on lines 563-565 explains this is intentional, but the computation is still wasted cycles.

### m-2. sanitizeConfigForWrite silently strips apiKey fields

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/config.ts`, lines 184-196
- **Category:** wrong-assumption
- **Severity:** minor
- **What's wrong:** If a user manually adds `"apiKey": "sk-xxx"` to their config file's embedding or llm section, the next `saveConfig` call silently removes it. The function assumes API keys should always come from env vars. This is undocumented stripping behavior.

### m-3. Re-exports in stash-search.ts are dead indirection

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/stash-search.ts`, lines 190-194
- **Category:** unnecessary-complexity
- **Severity:** minor
- **What's wrong:** `searchLocal`, `buildLocalAction`, `rendererForType`, `registerTypeRenderer`, and `registerActionBuilder` are re-exported from stash-search.ts. The comment claims filesystem.ts needs them, but filesystem.ts imports directly from `local-search.ts`. These re-exports are orphaned from their original purpose.

### m-4. completions.ts hardcodes asset types

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/completions.ts`, line 14
- **Category:** inconsistency
- **Severity:** minor
- **What's wrong:** `FLAG_VALUES["--type"]` lists 7 types statically. The type system is extensible via `registerAssetType`, but bash completions will never suggest custom types.

### m-5. Module-level mutable singletons leak across test runs

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/config.ts`, line 121; `/home/founder3/code/github/itlackey/agentikit/src/embedder.ts`, lines 40-41; `/home/founder3/code/github/itlackey/agentikit/src/file-context.ts`, line 181
- **Category:** test-issue
- **Severity:** minor
- **What's wrong:** `cachedConfig`, `localEmbedderPromise`, and `builtinsPromise` are module-level state with no reset function. Tests must work around this with env var manipulation.

### m-6. Inconsistent query lowercasing between providers

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/stash-search.ts`, line 32 vs line 78; `/home/founder3/code/github/itlackey/agentikit/src/stash-providers/filesystem.ts`, line 27
- **Category:** inconsistency
- **Severity:** minor
- **What's wrong:** `akmSearch` lowercases the query before passing to `searchLocal` (line 32: `normalizedQuery`), but passes the ORIGINAL query to additional providers (line 78: `query`). Meanwhile, `FilesystemStashProvider.search` also lowercases `options.query` before calling `searchLocal`. This means local search always gets lowercased input, but context-hub and OpenViking get mixed-case input. Context-hub's `scoreEntry` does its own `toLowerCase()`, so it works, but the inconsistency is fragile.

### m-7. Duplicated sanitizeString function

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/stash-providers/context-hub.ts`, lines 444-448; `/home/founder3/code/github/itlackey/agentikit/src/stash-providers/openviking.ts`, lines 12-16
- **Category:** unnecessary-complexity
- **Severity:** minor
- **What's wrong:** Identical `sanitizeString` function defined in both files. Should be a shared utility.

### m-8. Duplicated isExpired function

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/stash-providers/context-hub.ts`, lines 450-452; `/home/founder3/code/github/itlackey/agentikit/src/stash-providers/openviking.ts`, lines 373-375
- **Category:** unnecessary-complexity
- **Severity:** minor
- **What's wrong:** Identical `isExpired(mtimeMs, ttlMs)` function defined in both files.

### m-9. Walker SKIP_DIRS duplicated in two code paths

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/walker.ts`, line 92 and line 150
- **Category:** inconsistency
- **Severity:** minor
- **What's wrong:** Both the git-walker and manual-walker define `SKIP_DIRS` locally with the same values. Should be a shared constant.

### m-10. Orphaned doc comment in indexer.ts

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/indexer.ts`, line 417
- **Category:** stale-comment
- **Severity:** minor
- **What's wrong:** Line 417 has `/** Set of all known type directory names */` which is a leftover from a deleted constant. The function `isDirStale` that follows has nothing to do with type directory names.

### m-11. Dead parameter _stashDir in indexEntries

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/indexer.ts`, line 171
- **Category:** dead-code
- **Severity:** minor
- **What's wrong:** `_stashDir: string` is accepted but never used.

### m-12. Dead parameter _query in assetToSearchHit

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/local-search.ts`, line 666
- **Category:** dead-code
- **Severity:** minor
- **What's wrong:** `_query: string` is accepted but never used.

### m-13. Dead parameter _dirPath in enhanceStashWithLlm

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/indexer.ts`, line 455
- **Category:** dead-code
- **Severity:** minor
- **What's wrong:** `_dirPath: string` is accepted but never used.

### m-14. Duplicate stash-providers/index import for side-effect registration

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/stash-show.ts`, line 17; `/home/founder3/code/github/itlackey/agentikit/src/stash-search.ts`, line 8
- **Category:** unnecessary-complexity
- **Severity:** minor
- **What's wrong:** Both files import `"./stash-providers/index"` for side-effect registration. If either import is removed, the other still registers all providers. The duplication is defensive but fragile -- a third consumer would need a third import.

### m-15. mergeStashHits: all provider scores collapse to 0 when minLocalScore is 0

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/stash-search.ts`, line 241
- **Category:** bug
- **Severity:** minor
- **What's wrong:** `const providerScore = Math.max(0, minLocalScore * 0.9 - i * 0.0001)`. When `minLocalScore` is 0 (no local hits or all local scores are 0), the formula produces `Math.max(0, -i * 0.0001)` which is 0 for all i. All provider-only hits get score 0, losing their relative ordering. The sort falls back to insertion order, which is non-deterministic.

### m-16. DB_VERSION is written redundantly in two places

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/db.ts`, line 163; `/home/founder3/code/github/itlackey/agentikit/src/indexer.ts`, line 132
- **Category:** inconsistency
- **Severity:** minor
- **What's wrong:** `setMeta(db, "version", String(DB_VERSION))` is called both in `ensureSchema` (db.ts:163) and in `akmIndex` (indexer.ts:132). The second write is always a no-op (same value) unless the version was somehow changed between schema init and index completion.

### m-17. expandEnvVars prevents legitimate ${VAR} in URLs

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/config.ts`, lines 297-304
- **Category:** over-engineering
- **Severity:** minor
- **What's wrong:** All fields named "url", "endpoint", or "artifactUrl" skip env var expansion. All values starting with "http://" or "https://" also skip expansion. This prevents legitimate use cases like `"endpoint": "${OLLAMA_HOST}/v1/embeddings"` where the user wants env-var substitution in their endpoint URL.

### m-18. ContextHubEntry.assetType is narrower than the type system

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/stash-providers/context-hub.ts`, line 27
- **Category:** inconsistency
- **Severity:** minor
- **What's wrong:** `assetType: "knowledge" | "skill"` -- if a context-hub repo contained command or agent .md files, they would all be classified as "knowledge" (the DOC.md fallback at line 260).

### m-19. Bun-specific API (Bun.CryptoHasher) in openviking.ts

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/stash-providers/openviking.ts`, lines 227-239
- **Category:** inconsistency
- **Severity:** minor
- **What's wrong:** Uses `new Bun.CryptoHasher("md5")` while every other file in the codebase uses `createHash` from `node:crypto`. Creates an unnecessary Bun-only dependency in this one file.

### m-20. stash-clone.ts self-clone guard is asymmetric for non-skill types

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/stash-clone.ts`, lines 132-138
- **Category:** bug (edge case)
- **Severity:** minor
- **What's wrong:** For non-skills, `path.join(destRoot, typeDir, destName)` may not include the file extension (user provides "deploy" as name, but source is "deploy.sh"). The self-clone comparison `resolvedSource === resolvedDest` would miss this case because the paths differ by the extension. The skill path correctly compares directories.

### m-21. stripJsonComments silently consumes unterminated block comments

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/config.ts`, lines 374-377
- **Category:** bug (edge case)
- **Severity:** minor
- **What's wrong:** An unterminated `/* ...` in the config file causes the rest of the file to be silently consumed as a comment. The result is valid JSON parsing of whatever came before the block comment, with everything after silently dropped. No warning or error is produced.

### m-22. Local embedding in embedBatch processes texts sequentially with no progress

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/embedder.ts`, lines 225-229
- **Category:** performance
- **Severity:** minor
- **What's wrong:** The local transformer pipeline processes one text at a time in a for-loop. For large stashes with hundreds of entries, initial indexing takes minutes with zero progress feedback. The caller (indexer) records total time but individual progress is invisible.

### m-23. config.ts loadConfig() does not clear cachedConfig on stat failure

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/config.ts`, line 134
- **Category:** inconsistency (minor)
- **Severity:** minor
- **What's wrong:** When `fs.statSync(configPath)` throws (file doesn't exist), line 134 sets `cachedConfig = undefined` and returns defaults. This is correct. But if the file DID exist before, was cached, and then is deleted, the next call will correctly detect the missing file and clear the cache. No actual bug, but the path through the cache invalidation logic is subtle and undocumented.

### m-24. asset-spec.ts ASSET_TYPES uses mutable `let` with a warning comment

- **File:** `/home/founder3/code/github/itlackey/agentikit/src/asset-spec.ts`, line 137
- **Category:** unnecessary-complexity
- **Severity:** minor
- **What's wrong:** `export let ASSET_TYPES: string[] = getAssetTypes()` is `let` because `registerAssetType` reassigns it. The comment warns callers not to capture it. This is a footgun -- a `const` array that gets mutated in place (via `push`) or a function call (`getAssetTypes()`) would be safer patterns. The `let` export makes it possible for a consumer to accidentally capture a stale snapshot.

---

## TEST ISSUES

### T-1. Utility scoring tests bypass the production code path

- **File:** `tests/utility-scoring.test.ts`
- **Category:** test-issue
- **Severity:** major
- **What's wrong:** All tests that verify utility boost behavior inject usage data via `upsertUtilityScore()` (direct DB helper) or `recordUsageEvent()` (test helper that explicitly sets `entry_id`). No test verifies that the production path (`logSearchEvent` → `recomputeUtilityScores` → utility boost) actually works. This is why C-0 (utility scoring dead in production) was not caught — tests bypass the broken path entirely.

### T-2. EMA utility decay is tied to index frequency, not time

- **File:** `src/indexer.ts` lines 650-662
- **Category:** wrong-assumption
- **Severity:** minor
- **What's wrong:** `recomputeUtilityScores` reads ALL events every time and applies EMA once per index run. If you index 5 times with no new events, the utility decays with each run. Indexing more often = faster decay, which is counterintuitive. The EMA should be time-based or only applied to new events.

### T-3. Tests use `source: "local"` which is not in the SearchSource type

- **Files:** Multiple test files
- **Category:** inconsistency
- **Severity:** minor
- **What's wrong:** Tests pass `source: "local"` to `akmSearch`. `SearchSource = "stash" | "registry" | "both"` does not include `"local"`. It works because `parseSearchSource` has an alias and the type includes `| string`, but this defeats type safety.

---

## OBSERVATIONS (not bugs)

1. **context-hub is correctly implemented as a cached git repo** -- downloads tarball, extracts locally, reads files from disk. No confusion with remote API.

2. **OpenViking is correctly implemented as a remote REST API** -- makes HTTP requests, caches query results.

3. **The scoring pipeline is mathematically sound** -- BM25 normalization, weighted FTS+Vec combination, boost system, and utility re-ranking are all implemented correctly (aside from the naming issue in M-7).

4. **The codebase is well-structured overall** -- clean separation between stash providers, the registry system, matcher/renderer pipeline, and scoring. Main debt is accumulated stale comments and minor duplication between the two provider files.
