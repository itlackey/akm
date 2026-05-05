# Index Command Investigation (2026-05-05)

## Scope

This document captures the investigation into `akm index` instability during the
0.7.x pre-release cycle.

It records:

- issues found
- fixes already applied
- regression tests added
- remaining known issues
- next steps to fully stabilize `akm index`

It also records the product-direction decision that `.stash.json` is deprecated
in 0.7.x and will be removed in `v0.8.0`.

## Summary

Multiple independent issues were contributing to `akm index` instability.

The work completed in this session fixed several major classes of failure:

1. embedding-dimension drift caused by schema mutation on read-only DB opens
2. repeated incremental re-embedding caused by filename-less `.stash.json`
   handling
3. repeated incremental re-embedding for wiki-root sources that skipped no-op
   detection
4. git source resolution incorrectly assuming `<repo>/content`
5. stale detection comparing too many on-disk companion files against too few
   persisted indexed files
6. cross-source dedupe collapsing unrelated assets because the identity key was
   too weak

These fixes materially improved behavior and strengthened regression coverage,
 but `akm index` is still not fully stable in the live environment.

Since the investigation work captured here, follow-up commit `3709fe1` removed
the remaining `show` disk-fallback `.stash.json` dependency. That follow-up also
passed local `bun run check` and GitHub Actions CI run `25401342247` on `main`.

## Issues Found

### 1. Embedding-dimension DB drift (`1024` vs `384`)

Symptom:

- live config resolved to `1024`
- persisted `entries_vec` schema was still `FLOAT[384]`
- inserts failed with embedding dimension mismatch

Root cause:

- `openDatabase()` in `src/indexer/db.ts` always ran `ensureSchema()`
- callers that opened the DB without passing configured embedding dimension fell
  back to `EMBEDDING_DIM = 384`
- even read/telemetry code paths could therefore recreate `entries_vec` as
  `FLOAT[384]`

Examples of affected callers before the fix:

- `src/commands/info.ts`
- `src/indexer/indexer.ts` (`lookup`)
- `src/commands/search.ts`
- `src/commands/show.ts`
- `src/commands/history.ts`
- `src/cli.ts` (`feedback`)
- `src/workflows/runs.ts`
- `src/setup/setup.ts`

### 2. Filename-less `.stash.json` entries caused endless incremental churn

Symptoms:

- unchanged directories kept being rescanned
- entries were deleted and reinserted on every incremental run
- embeddings were regenerated repeatedly

Root causes:

- `isDirStale()` compared current file basenames against `entry.filename`
  only, so filename-less entries looked stale forever
- uncovered-file detection treated filename-less `.stash.json` entries as not
  covering any actual file, so metadata kept regenerating on every run

Affected code:

- `src/indexer/indexer.ts`

### 3. Wiki-root sources bypassed incremental skip logic

Symptom:

- unchanged wiki-root sources were always rescanned on incremental runs
- unchanged wiki-root entries were repeatedly re-embedded

Root cause:

- the `sourceAdded.wikiName` branch in `src/indexer/indexer.ts` grouped wiki
  pages by directory but never applied the same `isDirStale()` incremental skip
  path used by normal sources

### 4. `.stash.json` was still too central in runtime behavior

Problem:

- `.stash.json` was still a first-class metadata source in multiple runtime
  paths before the later cleanup moved more behavior to frontmatter and derived
  DB metadata

This increased complexity in:

- indexing
- substring search fallback
- manifest generation
- registry build

### 5. Git sources incorrectly required `<repo>/content`

Symptom:

- configured git source `itlackey/akm-stash` refreshed its mirror but was not
  actually indexed

Root cause:

- `src/indexer/search-source.ts` always resolved git sources to
  `path.join(repoRoot, "content")`
- `itlackey/akm-stash` is itself a stash root, not a repo with a `content/`
  subdirectory

### 6. Incremental stale detection used the wrong comparison set

Symptom:

- directories with companion files like `package.json`, `manifest.json`,
  `plugin.config.json`, `tsconfig.json`, `.gitkeep`, etc. were repeatedly
  marked stale even when the actually indexed entries had not changed

Root cause:

- stale detection compared broad current file sets against persisted indexed
  rows instead of comparing only the files that actually produced entries

### 7. Cross-source dedupe key was too weak

Symptom:

- unrelated assets with the same basename, especially `README.md`, collided
  across sources
- collision losers often persisted no rows, which meant their directories could
  never hit the incremental skip fast path
- live entry counts drifted across unchanged runs

Root cause:

- cross-source dedupe in `src/indexer/indexer.ts` used:

```text
type + basename + description
```

- this is not specific enough across multiple stashes and generated metadata

### 8. Workflow-classification noise remains in the git stash

Symptom:

- repeated warning for:
  - `~/.cache/akm/registry-index/git-.../repo/knowledge/akm-stash-structure.md`

Problem:

- this file is being treated as workflow-like and is rejected by workflow
  validation every run
- this may not be the main count-drift cause anymore, but it is still noisy and
  may still participate in rescans

## Fixes Applied

### A. Safe DB open split and schema drift fix

Changes:

- added non-mutating existing-DB open path in `src/indexer/db.ts`
- switched read/telemetry callers to that path
- changed setup sqlite-vec probing to use a temp DB instead of the live index DB

Primary files:

- `src/indexer/db.ts`
- `src/commands/info.ts`
- `src/indexer/indexer.ts`
- `src/indexer/db-search.ts`
- `src/indexer/manifest.ts`
- `src/commands/search.ts`
- `src/commands/show.ts`
- `src/commands/history.ts`
- `src/cli.ts`
- `src/workflows/runs.ts`
- `src/setup/setup.ts`

Operational repair performed:

- rotated stale live DB aside
- rebuilt the index with the configured `1024`-dim embedding model
- verified `entries_vec` schema and `index_meta.embeddingDim` matched `1024`

### B. Filename-less `.stash.json` stale detection fix

Changes:

- `isDirStale()` now compares against persisted `filePath` basenames rather
  than only `entry.filename`
- uncovered-file detection now resolves filename-less entries to actual files so
  they count as covered

Primary file:

- `src/indexer/indexer.ts`

### C. Wiki-root incremental skip fix

Changes:

- wiki-root directory groups now use the same incremental stale/skip path as
  normal sources

Primary file:

- `src/indexer/indexer.ts`

### D. Aggressive `.stash.json` phase-down in runtime behavior

Changes:

- `.stash.json` is now treated as a legacy compatibility layer, not the default
  metadata source
- filename-less legacy entries are ignored in the new runtime merge path
- explicit-file legacy overrides are still supported in 0.7.x
- follow-up commit `3709fe1` removed `show` fallback metadata reads from
  `.stash.json`, so command and skill summary metadata now comes from file-local
  parsing in the renderer path
- runtime behavior now prefers:
  - frontmatter
  - structured comment metadata
  - generated DB metadata

Primary files:

- `src/indexer/metadata.ts`
- `src/indexer/indexer.ts`
- `src/indexer/manifest.ts`
- `src/indexer/db-search.ts`
- `src/registry/build-index.ts`
- `src/commands/show.ts`
- `src/output/renderers.ts`

### E. Expanded file-local metadata support

Added support for curated metadata in:

- markdown frontmatter
- structured script/comment headers

Notable supported fields now include:

- `description`
- `tags`
- `aliases`
- `searchHints`
- `usage`
- `examples`
- `intent`
- `run`
- `setup`
- `cwd`
- `scope`

Primary files:

- `src/indexer/metadata.ts`
- `src/output/renderers.ts`

### F. Git source root fallback fix

Changes:

- git sources now resolve to `<repo>/content` only if it exists
- otherwise they resolve to the repo root

Primary file:

- `src/indexer/search-source.ts`

### G. Stale detection now compares resolved indexed files

Changes:

- incremental stale detection for normal directories now uses the set of files
  actually resolved from generated/kept entries
- this reduces false-positive churn from non-indexed companion files

Primary file:

- `src/indexer/indexer.ts`

### H. Cross-source dedupe identity strengthened

Changes:

- cross-source dedupe key changed from:
  - `type + basename + description`
- to:
  - `type + entry.name`

Primary file:

- `src/indexer/indexer.ts`

## Regression Tests Added / Updated

### DB / embedding-dimension safety

Files:

- `tests/db.test.ts`
- `tests/info-command.test.ts`
- `tests/commands/search.test.ts`
- `tests/commands/show-indexer-parity.test.ts`

Coverage added:

- read-only/info/search/show paths do not downgrade embedding dimension metadata
- reopening an existing DB does not recreate `entries_vec` with the wrong
  dimension

### Incremental indexing stability

File:

- `tests/indexer.test.ts`

Coverage added / updated:

- filename-less `.stash.json` entries stabilize across reruns
- filename-less `.stash.json` entries do not trigger re-embedding on unchanged
  incremental runs
- wiki-root sources skip unchanged directories incrementally
- wiki-root sources do not re-embed unchanged entries
- non-indexed companion files do not force repeated stale rescans
- unrelated same-basename assets across sources are not collapsed by dedupe

### Source resolution

File:

- `tests/source-source.test.ts`

Coverage added:

- git sources fall back to repo root when `content/` is absent

### Metadata / runtime phase-down

Files:

- `tests/metadata.test.ts`
- `tests/commands/search.test.ts`
- `tests/progressive-disclosure.test.ts`
- `tests/registry-build-index.test.ts`

Coverage added / updated:

- file-local metadata parsing parity
- filename-less legacy `.stash.json` metadata ignored in runtime fallback paths
- `show` summary/progressive-disclosure metadata no longer depends on
  `.stash.json`; command and skill tags are sourced from frontmatter
- registry build prefers generated/file-local metadata over filename-less legacy
  stash metadata

## Verification Performed

Targeted and combined regression suites were run repeatedly during the fixes.

Representative successful runs:

- `bun test tests/db.test.ts tests/info-command.test.ts tests/commands/search.test.ts tests/commands/show-indexer-parity.test.ts tests/indexer.test.ts`
- `bun test tests/indexer.test.ts tests/e2e.test.ts`
- `bun test tests/indexer.test.ts tests/source-source.test.ts tests/migration-help.test.ts`
- `bun test tests/indexer.test.ts tests/metadata.test.ts tests/commands/search.test.ts tests/commands/show-indexer-parity.test.ts tests/registry-build-index.test.ts tests/info-command.test.ts tests/db.test.ts tests/source-source.test.ts tests/migration-help.test.ts`
- `bun run check`
- GitHub Actions CI run `25401342247` passed on `main` for commit `3709fe1`
  (`check`, `semantic-search`, and `docker-install` all succeeded)

Latest combined suite status during this investigation:

- `180 pass`
- `0 fail`

## Remaining Known Issues

`akm index` is improved but not fully stable in the live environment.

Latest live consecutive runs still showed drift:

Run A:

- `5 stash sources`
- `Scanned 208 directories`
- `Generating embeddings for 222 entries`
- `Indexed 1216 assets`

Run B:

- `Scanned 208 directories`
- `Generating embeddings for 46 entries`
- `Indexed 1218 assets`

### Most likely remaining causes

1. directories that generate no persisted rows still never hit the incremental
   skip fast path because `prevEntries.length === 0`
2. workflow-like but non-workflow files in the git stash are still being
   revalidated and warning every run
3. there may still be one or more source-specific generated-name or
   classification instabilities in the newly indexed git stash

### Most visible current noisy file

- `~/.cache/akm/registry-index/git-.../repo/knowledge/akm-stash-structure.md`

This file repeatedly triggers workflow validation warnings but is not known to
be the sole remaining cause of count drift.

## Product / Migration Direction

`.stash.json` is now explicitly treated as:

- deprecated in `0.7.x`
- compatibility-only during the transition
- removed in `v0.8.0`

Preferred metadata carriers moving forward:

- markdown frontmatter
- structured code comments / header tags
- derived DB metadata

## Recommended Next Steps To Fully Fix `akm index`

### 1. Persist skip metadata for zero-row directories

Problem:

- directories whose generated entries all lose dedupe or validation paths may
  persist zero rows
- incremental skip currently depends on `prevEntries.length > 0`

Suggested fix:

- persist a lightweight per-directory fingerprint or last-seen file set in
  `index_meta` or a dedicated table so zero-row directories can still be
  recognized as unchanged

### 2. Narrow workflow classification / validation triggers

Problem:

- non-workflow knowledge files are still entering workflow validation noise
  paths

Suggested fix:

- tighten workflow detection so only clear workflow candidates are validated as
  workflows
- alternatively cache and suppress repeated known-invalid workflow diagnostics
  unless the file mtime changes

### 3. Capture per-source / per-dir churn diagnostics in the CLI

Problem:

- the live issue required repeated ad hoc diagnosis to isolate which source and
  which directories kept re-triggering work

Suggested fix:

- add `--verbose` or debug output that reports:
  - scanned dir reason (`mtime`, `file-set-changed`, `no-prev-rows`, etc.)
  - source root for each scanned dir
  - number of entries deleted/reinserted per dir

This would make future incidents much easier to localize.

### 4. Add one more end-to-end regression for zero-row dir stability

Suggested test:

- construct a source layout where a directory generates entries that are all
  deduped away or skipped, then assert consecutive incremental runs do not keep
  rescanning it forever once no content changed

### 5. Continue reducing `.stash.json` compatibility surface

The current runtime still retains some explicit-file compatibility behavior for
0.7.x. Before `v0.8.0`, the remaining compatibility write/read paths should be
audited and removed in a controlled migration pass, but `show` is no longer part
of that surface after `3709fe1`.

## Recommended Follow-Up Work Items

1. Add persistent incremental skip metadata for zero-row directories.
2. Tighten workflow detection to stop revalidating non-workflow knowledge docs.
3. Add verbose churn diagnostics to `akm index`.
4. Add a regression for zero-row directory stability.
5. Complete `.stash.json` compatibility removal ahead of `v0.8.0`.
