# Logic Audit: Fundamental Design Confusions

These are not code quality issues. These are places where the code fundamentally misunderstands what it's trying to do.

---

## 1. Context-hub is searched outside the scoring pipeline

**The confusion:** Context-hub is a git repository that gets cloned and cached locally. Its content lives on disk as real files. But it's registered as a `StashProvider` (`type=context-hub`) which means it has its own `search()` method with its own scoring function (`scoreEntry`). This scoring function is completely separate from the FTS5 + boost pipeline that all local/filesystem stash entries go through.

**What this means:**
- Context-hub assets are NOT in the FTS5 index (confirmed: 0 entries with context-hub stash_dir)
- They don't get multi-column field weighting (name 10x, desc 5x, etc.)
- They don't get type boosts, exact name match boosts, alias boosts, or any of the ranking signals
- They don't get `whyMatched` explanations
- They have their own ad-hoc scoring that produces scores on a different scale
- Then `mergeStashHits` tries to combine these incompatible scores
- The "fix" I applied (placing provider results below local) just hides them instead of ranking them properly

**What it should be:** Context-hub content should be indexed into the local FTS5 index during `akm index`, just like filesystem stashes. The `ContextHubStashProvider` should handle `show` (fetching content for display) but search should go through the unified index. The indexer's `resolveAllStashDirs` should include the context-hub cache directory so its files get walked, classified, and indexed like everything else.

**Impact:** ~800+ context-hub assets (the entire andrewyng/context-hub repo) are invisible to the scoring pipeline. They show up with degraded scores and no ranking signals.

---

## 2. `mergeStashHits` treats stash providers as second-class results

**The confusion:** The merge function assumes local = good, provider = noise. It places all provider results below all local results regardless of relevance. But stash providers (context-hub, OpenViking) ARE stash sources — their results should compete on equal footing with local results when they're relevant.

**What this means:**
- A context-hub result that perfectly matches a query (e.g., searching "docker" and context-hub has a Docker SDK doc) is artificially ranked below every local result, even irrelevant ones
- OpenViking results from a team's shared knowledge base are treated as noise

**What it should be:** For providers whose content IS indexed (context-hub after fix #1), no merge is needed — they're in the same index. For truly remote providers (OpenViking), the merge should use the provider's own relevance scoring rather than suppressing it.

---

## 3. The indexer doesn't index all configured stash sources

**The confusion:** `resolveStashSources` (used by the indexer) only picks up `type=filesystem` stash entries. But the user's config has `type=context-hub` and `type=openviking` entries too. The context-hub entry has cached local files that COULD be indexed but aren't because the resolver skips non-filesystem types.

**What's missing from the index (from user's config):**
- `type=context-hub` (andrewyng/context-hub) — has local cached files, should be indexed
- `type=openviking` — remote API, correctly NOT indexed
- `.hyphn/skills` — IS filesystem but got 0 entries (interrupted index build)
- `.codex` — IS filesystem but got 0 entries (interrupted index build)

**What it should be:** The indexer should resolve the context-hub cache path and include it in `allStashDirs`. The cache path is already computed in `context-hub.ts`'s `getCachePaths()` — just need to expose it.

---

## 4. Two completely separate scoring systems exist

**The confusion:** There are two independent scoring systems:

1. **`searchDatabase` in `local-search.ts`** — normalized BM25 + field weighting + 7 boost signals. Produces scores in the 0.3-4.0 range. This is the pipeline we spent all this time improving.

2. **`scoreEntry` in `context-hub.ts`** — ad-hoc token matching with manual weights (name=4, desc=2, tags=2, language=1). Produces scores in the 0-10 range. Completely unaware of FTS5, boosts, or any of the ranking improvements.

Plus **OpenViking** which returns its own scores from the remote API.

These scores are on different scales and measure different things. The merge functions try to paper over this but the fundamental problem is that the same search query produces results from completely different scoring systems.

**What it should be:** One scoring pipeline for all indexed content. Remote-only providers (OpenViking) are the only legitimate case for a separate scoring path.

---

## 5. `estimatedTokens` confusion

**The confusion:** I added `fileSize` computation to `entryToHit` in context-hub.ts, computing `Buffer.byteLength(raw, "utf8")` from the content read during `buildEntry`. But `buildEntry` runs during INDEX BUILDING (when the cache is refreshed), not during SEARCH. The `loadEntries()` method reads from a cached JSON index file (`index.json`), not from the raw files. So `fileSize` is only computed when the cache is rebuilt, and it's serialized into the JSON index. But the `isContextHubEntry` validator doesn't check for `fileSize`, so cached entries from before this change won't have it.

More fundamentally, if context-hub content were properly indexed into the FTS5 index (fix #1), `estimatedTokens` would come from the normal `buildDbHit` path like all other indexed entries.

---

## 6. Overcomplicated scoring merge when the real fix is unified indexing

**The confusion:** I spent hours:
- Replacing RRF with normalized BM25 in `searchDatabase`
- Rewriting `mergeStashHits` to preserve local scores
- Rewriting `mergeSearchHits` to preserve local scores
- Adding score-preserving merge tests
- Debugging why scores were flat at 0.0164

All of this was treating symptoms. The root cause is that context-hub results bypass the FTS5 index entirely. If they were indexed, there would be no merge problem — all results would come from the same pipeline with the same scoring.

The RRF removal and normalized BM25 ARE improvements to the local pipeline. But the merge function complexity is solving a problem that shouldn't exist.

---

## 7. Registry vs Stash confusion in merge functions

**The confusion:** `mergeSearchHits` (stash + registry) now uses the same score-preserving approach as `mergeStashHits`. But registries ARE fundamentally different from stashes:
- Registry results are kits you can INSTALL, not assets you can USE
- They should probably be presented separately, not interleaved with stash results
- The score comparison is meaningless — a local skill's score of 3.14 vs a registry kit's score of 0.5 are measuring completely different things

**What it should be:** Registry results should be in a separate section of the search response, not merged into the same `hits` array with local results.

---

## 8. The `--for-agent` output still includes registry and provider noise

**The confusion:** An agent searching for "docker" to find a tool to USE gets back results from npm registries and context-hub docs about Docker SDKs. These are not actionable — the agent can't use a context-hub doc as a tool. The `--for-agent` mode should focus on actionable assets (skills, commands, scripts, agents) from the local stash.

---

## Summary: What actually needs to happen

1. **Index context-hub content** — add the context-hub cache directory to `resolveAllStashDirs` so its files go through the normal walk → classify → metadata → FTS5 pipeline
2. **Simplify the merge** — with context-hub indexed, `mergeStashHits` only needs to handle OpenViking (the only truly remote provider). The current score-preservation logic is correct for that case.
3. **Separate registry results** — don't merge registry hits into the same array as stash hits
4. **Remove the duplicate scoring in context-hub.ts** — `scoreEntry` and `entryToHit` become unnecessary for search (still needed for `show`)
5. **Fix the interrupted index** — rebuild so `.hyphn/skills`, `.codex`, and context-hub are all properly indexed
