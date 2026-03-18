> **Status: Completed.** This audit was performed on 2026-03-17 and the identified issues
> have been addressed. See ARCHITECTURE.md for current design decisions.

# Logic Audit: Fundamental Design Confusions

These are not code quality issues. These are places where the code fundamentally misunderstands what it's trying to do.

---

## 0. Context-hub is treated as something special when it's just a git repo

**The root confusion:** Context-hub has its own `StashProvider` class (`ContextHubStashProvider`), its own scoring function (`scoreEntry`), its own index format (`index.json`), its own cache management, its own entry type (`ContextHubEntry`), and its own search path. None of this is necessary. It's just a git repository.

The system already knows how to handle git repos as stash sources — `akm add github:owner/repo` clones a repo, extracts it to a cache directory, and registers that directory as a filesystem stash source. The indexer walks it, classifies files, generates metadata, and indexes everything into FTS5. Search finds it through the normal pipeline with all the scoring, boosting, and ranking.

Context-hub should work exactly the same way. Clone the repo, point a filesystem stash at the cached directory, let the normal pipeline handle the rest. Instead, ~450 lines of custom provider code duplicates what the existing git clone + filesystem stash + indexer pipeline already does, but worse — no FTS5 field weighting, no type boosts, no alias matching, no utility scoring, no `whyMatched`, and scores on an incompatible scale.

**Every git-based stash source should be: clone → cache → filesystem stash → index → search through the unified pipeline.** There is no reason for a separate code path.

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

## 9. FilesystemStashProvider is dead code

**The confusion:** `FilesystemStashProvider` is registered as a stash provider but `resolveStashProviders()` explicitly skips `type=filesystem` entries (line 38 of `stash-provider-factory.ts`). The class is never instantiated for search. Filesystem stashes go through `resolveStashSources` → indexer → FTS5 → `searchLocal`. The provider exists but is never used for search — only `canShow` matters, and even that falls through to `showLocal` as the default.

**Impact:** 52 lines of dead code that looks important.

---

## 10. Any git-based stash should go through the same path as installed kits

**The confusion:** Installed kits from `akm add github:owner/repo` are:
1. Cloned/downloaded to `~/.cache/akm/registry/...`
2. Added to `config.installed[]` with `stashRoot` pointing to the cache dir
3. Included in `resolveStashSources` (line 54 of `search-source.ts`)
4. Indexed into FTS5 by the indexer
5. Searched through the unified scoring pipeline

Context-hub repos should follow the EXACT same path. Instead they have a parallel universe of code. The only difference is that context-hub's cache management (tarball download, extraction) is slightly different from installed kits — but that's an implementation detail of the clone step, not a reason for a separate search/scoring path.

---

## 11. `source: "both"` merges stash and registry results into one array

**The confusion:** When `--source both` is used, `mergeSearchHits` combines stash hits (assets you USE) with registry hits (kits you can INSTALL) into a single `hits` array. These are fundamentally different things:
- A stash hit's action is `akm show skill:deploy → follow instructions`
- A registry hit's action is `akm add github:owner/repo → install first, then search again`

Mixing them in one array with merged scores confuses both humans and agents. An agent seeing a registry hit ranked at #3 might try to `akm show` it and fail.

**What it should be:** The `SearchResponse` should have separate `hits` and `registryHits` arrays when `source: "both"`. The CLI can display them in separate sections. Agents can ignore registry hits when looking for actionable tools.

---

## 12. The search orchestration layer duplicates what the index already does

**The confusion:** `akmSearch` in `stash-search.ts` does this:
1. Call `searchLocal` → searches the FTS5 index (which contains all filesystem stash dirs + installed kits)
2. Call each stash provider's `search()` → context-hub and OpenViking do their own thing
3. Merge results from step 1 and step 2

But step 1 already covers everything that's indexed. The only providers that need step 2 are those whose content is NOT indexed (OpenViking — truly remote). If context-hub content were indexed (fix #0), step 2 would only be needed for OpenViking.

The merge function `mergeStashHits` exists solely because of this two-path architecture. If all indexable content goes through one index, the merge simplifies dramatically.

---

## Summary: What actually needs to happen

1. **Replace context-hub provider with a standard git stash provider.** Any git repo URL in stash config should go through the same path as `akm add github:repo`: clone → cache → register cache dir as filesystem stash → index through normal pipeline. The context-hub provider keeps `show()` for `context-hub://` ref resolution but loses `search()`, `scoreEntry`, and `entryToHit`. Consolidate the clone/cache mechanism with the existing `akm add` git behavior — one code path for all git-sourced stashes.

2. **Treat OpenViking as a local stash.** Its content should be indexed into the local FTS5 index and searched through the unified pipeline. If that's not feasible (truly ephemeral remote content), normalize its scores to compete fairly with local results instead of suppressing them.

3. **Simplify `mergeStashHits`** — with both context-hub and OpenViking indexed, the merge function may not be needed at all. If any truly remote-only provider remains, a simple append + dedup is sufficient.

4. **Separate registry results from stash results** — don't merge installable kits into the same hits array as usable assets.

5. **Remove dead `FilesystemStashProvider`** — it's never used for search.

6. **Fix the interrupted index** — rebuild so all configured stash dirs are properly indexed.
