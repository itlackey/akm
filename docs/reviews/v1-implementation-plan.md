# akm v1 — Implementation Plan

**Status:** Draft, paired with `docs/technical/v1-architecture-spec.md` and `docs/reviews/v1-gap-analysis.md`.
**Audience:** akm core contributors executing the v1 refactor.

---

## 1. Executive Summary

The v1 migration collapses the LiveStash/SyncableStash split into a single minimal `SourceProvider` interface, removes OpenViking, renames `stash → source` throughout, and centralises the two write behaviours (plain-fs vs. git-commit) into one `write-source.ts` helper.

**Delivery model (revised 2026-04-25):** **per-phase merges into `release/0.6.0`.** Each phase runs on its own branch (`refactor/v1-phase-N` or, for parallel phases, a worktree branch), is verified + reviewed + green-tested, then `--no-ff`-merged into `release/0.6.0`. The next phase cuts from the updated `release/0.6.0`. The original "single long-lived branch + one mega-PR" model was abandoned after Phase 1 to reduce review burden and let downstream work see each phase's improvements immediately. Per-phase merge commits preserve clear phase boundaries in `release/0.6.0`'s history.

**Parallelism:** later phases that don't depend on each other are developed in **local git worktrees** branched off the integration branch, then fast-forward-merged back when their phase passes verification. The two early phases (drop OpenViking, rename) are sequential and land on the integration branch directly because they touch the whole tree.

**Biggest risks:** (a) the integration branch drifting too far from `release/0.6.0` while parallel worktrees are open, (b) silent index-shape regressions when reading consolidates into `indexer.lookup`, and (c) user-config breakage for anyone running with `openviking` sources today. Mitigations: keep `release/0.6.0` quiet for the duration (or rebase the integration branch nightly), pin a parity test fixture before Phase 4, and ship a clean `ConfigError` migration message in Phase 1.

---

## 2. Branch and Worktree Strategy

### 2.1 Per-phase branches into release/0.6.0

```
release/0.6.0  ◄── --no-ff merge ── refactor/v1-phase-N (per phase)
                                       └─ optional worktree for fan-out
```

- Each phase cuts a branch from current `release/0.6.0` tip.
- Sequential phases: branch named `refactor/v1-phase-N` (e.g. `refactor/v1-phase-2`).
- Parallel phases (3+4, 5, 6, 7): branched as worktrees from `release/0.6.0` after Phase 2 lands; named `phase/N-<descriptor>` (e.g. `phase/5-write-source`).
- Each phase merges back with `--no-ff` so the merge commit makes the phase boundary explicit in history.
- Build must be green on the phase branch before merge. Build must remain green on `release/0.6.0` after merge.
- No single integration PR at the end. Each phase is its own deliverable.

**Phase 1 already landed** as commits `392f40d` + `34ade9d` on the (now retired) `refactor/v1-architecture` branch and is being merged into `release/0.6.0` with `--no-ff` retroactively under this revised model.

### 2.2 Worktrees for parallel phases

Use `git worktree add` to develop independent phases in parallel without juggling branch checkouts in one directory.

```
~/code/github/itlackey/agentikit                    # main checkout, integration branch tip
~/code/github/itlackey/agentikit-wt/phase-5         # Phase 5 worktree (write-source)
~/code/github/itlackey/agentikit-wt/phase-6         # Phase 6 worktree (registry providers)
~/code/github/itlackey/agentikit-wt/phase-7         # Phase 7 worktree (error hints)
```

Setup pattern:
```sh
# from the main checkout, on refactor/v1-architecture
git worktree add ../agentikit-wt/phase-5 -b phase/5-write-source refactor/v1-architecture
cd ../agentikit-wt/phase-5
# work, commit, run bun test + tsc + biome
```

Merge back when the phase is green:
```sh
# from the main checkout
git switch refactor/v1-architecture
git merge --ff-only phase/5-write-source     # ff-only forces phase to be rebased first
git worktree remove ../agentikit-wt/phase-5
git branch -d phase/5-write-source
```

`--ff-only` is intentional: it forces the phase author to rebase onto the latest integration tip before merge, so the integration branch stays linear and every commit on it is green.

### 2.3 Phase dependency graph

```
Phase 1 (OpenViking removal)              ── direct on integration branch
   │
   ▼
Phase 2 (stash → source rename)           ── direct on integration branch
   │
   ├──────────────┬──────────────┬──────────────┐
   ▼              ▼              ▼              ▼
Phase 3        Phase 5        Phase 6        Phase 7
(simplify      (write-source) (registry      (error hints)
 SourceProv.)                  providers)
   │              │              │              │
   ▼              │              │              │
Phase 4           │              │              │
(indexer reads)   │              │              │
   │              │              │              │
   └──────────────┴──────────────┴──────────────┘
                      │
                      ▼
              Phase 8 (output shapes)
                      │
                      ▼
              Phase 9 (file splits)
                      │
                      ▼
              Phase 10 (docs + freeze)
                      │
                      ▼
              Open PR to release/0.6.0
```

**Sequential on integration branch (no worktree):** Phases 1, 2, 8, 9, 10. They touch the whole tree or depend on the full upstream set; parallel work would just produce conflicts.

**Worktree-eligible (parallel after Phase 2):** Phases 3+4 (single worktree, sequential inside it), 5, 6, 7. Run as a fan-out: four worktrees open simultaneously, each isolated, each independently green before merge.

### 2.4 Conflict containment

- Phase 5 (write-source) only touches `core/`, `remember.ts`, `import.ts`, the new helper, and tests.
- Phase 6 (registry providers) only touches `src/registry-providers/` and `commands/registry-search.ts`.
- Phase 7 (error hints) only touches `src/errors.ts`, `src/cli.ts` (the buildHint section), and error tests.
- Phase 3+4 worktree touches `src/source-providers/`, `src/indexer.ts`, `src/commands/search.ts`, `src/commands/show.ts`.

These four worktrees have near-zero file overlap, so merge order is flexible. If two worktrees do collide on a file, the second-to-merge rebases onto the first.

### 2.5 What stays green

- **Integration branch tip:** `bunx tsc --noEmit`, `bunx biome check src/ tests/`, `bun test` all pass after every merge.
- **Worktree tip:** must pass the same three before `--ff-only` merge is allowed.
- A pre-merge script (one-liner: `bun test && bunx tsc --noEmit && bunx biome check src/ tests/`) gates every worktree integration.

---

## 3. Phase Breakdown

Each phase below specifies whether it runs **directly on the integration branch** or **in a worktree**. Order is the dependency graph in §2.3. The "Verification" block is the gate before the phase can land.

---

### Phase 1 — Drop OpenViking (spec §10 step 1)

**Track.** Direct on `refactor/v1-architecture`. No worktree — must land before any parallel work starts.

**Goal.** Eliminate the only remote/query-style provider so the simplified `SourceProvider` interface is achievable in Phase 3. Users with `openviking` configs get a clear `ConfigError` with a hint pointing at the post-v1 `QuerySource` deferral.

**Files touched.**
- DELETE: `src/stash-providers/openviking.ts`
- DELETE: `tests/stash-providers/openviking.test.ts`
- DELETE: `tests/fixtures/openviking/`
- MODIFY: `src/stash-providers/index.ts` — remove `import "./openviking";`
- MODIFY: `src/config.ts` — remove `openviking` from the `StashSource` union (line 82) and from `parseStashEntrySource` (lines 936–937). Add a load-time guard that throws `ConfigError("openviking source is no longer supported in v1; see docs/migration/v1.md", "INVALID_CONFIG_FILE")` with a hint.
- MODIFY: `src/stash-search.ts` — drop the `additionalStashProviders` resolution entirely (lines 55–93). Sources are unified now; no extra search path.
- MODIFY: `src/stash-show.ts` — remove the "remote provider fallback" branch (lines 140 area).
- MODIFY: `src/search-source.ts` — remove the "remote-only providers" comment and undefined-return path (lines 95–129).
- MODIFY: `src/cli.ts` line 242 — drop `openviking` from `--provider` description.
- MODIFY: `tests/stash-show.test.ts` — delete the OpenViking remote-fallback `describe` block (line 402+).
- MODIFY: `tests/setup-run.integration.ts` — remove all `detectOpenViking` mocks (lines 152, 263, 379, 481).
- CREATE: `docs/migration/v1.md` — short doc explaining `openviking` removal and the post-v1 `QuerySource` plan.
- MODIFY: `CLAUDE.md` — remove `openviking` from the "three stash provider types" rule.

**Order of edits.** (1) Add the migration doc + `ConfigError` so a user running the binary sees the right message immediately. (2) Delete provider source + tests. (3) Remove call sites in search/show/search-source. (4) Update `CLAUDE.md`.

**Migration message text.**
```
openviking is not supported in akm v1. API-backed sources will return as a
separate QuerySource tier post-v1. Remove the source from your config (akm
config sources remove <name>) or downgrade to 0.6.x. See docs/migration/v1.md.
```
Hint on the `ConfigError`: `Run \`akm config sources remove <name>\` then re-run.`

**Tests to add or update.** Add `tests/config.test.ts` case: loading a config containing `{type: "openviking"}` produces `ConfigError` with the deferral message. Update `tests/stash-search.test.ts` and `tests/stash-show.test.ts` to drop OpenViking expectations.

**Verification commands.**
```
bunx tsc --noEmit
bunx biome check --write src/ tests/
bun test
grep -rn "openviking\|OpenViking" src/ tests/   # must return zero hits
```

**Recovery.** If the integration commits introduce a regression, `git revert` the Phase 1 commits on the integration branch. Provider re-registers via `stash-providers/index.ts`.

**Dependencies.** None. First.

---

### Phase 2 — Rename `stash` → `source` throughout (spec §10 step 2)

**Track.** Direct on `refactor/v1-architecture`. No worktree — touches every file; parallel work would conflict on every edit.

**Goal.** Mechanical, single-phase rename. After this, the codebase speaks the spec's vocabulary.

**Files touched.** (representative, not exhaustive — full set derived by `grep -ril "stash" src/ tests/`)
- RENAME: `src/stash-providers/` → `src/source-providers/`
- RENAME: `src/stash-provider.ts` → `src/source-provider.ts`
- RENAME: `src/stash-provider-factory.ts` → `src/source-provider-factory.ts`
- RENAME: `src/stash-search.ts` → `src/source-search.ts` (deleted in Phase 4 — kept named for diff clarity)
- RENAME: `src/stash-show.ts` → `src/source-show.ts` (also deleted in Phase 4)
- RENAME: `src/stash-ref.ts` → `src/asset-ref.ts`
- RENAME: `src/stash-types.ts` → `src/source-types.ts`
- RENAME: `src/search-source.ts` — unchanged name; rewrite types to `SourceEntry`.
- MODIFY: every importer.
- MODIFY: `src/config.ts` — `StashConfigEntry` → `SourceConfigEntry`, `StashSource` → `SourceSpec`, `StashEntry` → `SourceEntry`, `stashes[]` → `sources[]` in the persisted JSON. Add a one-pass loader migration: if the loaded JSON contains `stashes` and not `sources`, rewrite in-memory and emit a deprecation warning via `warn.ts`. Persist the migration on next `akm config` write.
- RENAME equivalent test files. `tests/stash-*.test.ts` → `tests/source-*.test.ts`.
- MODIFY: docs `docs/concepts.md`, `docs/technical/architecture.md`, `CLAUDE.md`, README, command help.

**Order of edits.** (1) Rename files (git mv). (2) Run a project-wide find/replace of identifiers using ts-morph or `bunx biome check --write` after a `sed`-driven rename of identifiers. (3) Update on-disk config loader to accept both `stashes` and `sources` keys. (4) Rebuild help strings in `cli-hints.ts`.

**Tests.** All renamed test files must still pass. Add `tests/config.test.ts` cases: legacy config with `stashes[]` loads, warns once, emits `sources[]` on next write.

**Verification.**
```
bunx tsc --noEmit
bunx biome check --write src/ tests/
bun test
grep -rln "[Ss]tash" src/ tests/    # only intentional occurrences (changelog, migration doc) remain
```

**Recovery.** Reset the integration branch to the pre-Phase-2 commit and re-attempt. Keep the legacy-key loader for a release.

**Dependencies.** Phase 1 (so we don't rename `openviking.ts` we're about to delete).

---

### Phase 3 — Simplify `SourceProvider` to `{ name, kind, init, path, sync? }` (spec §10 step 3)

**Track.** Worktree `phase/3-source-provider` (sequential with Phase 4 inside the same worktree). Branched from `refactor/v1-architecture` after Phase 2 lands. Runs in parallel with Phases 5, 6, 7.

**Goal.** Replace `LiveStashProvider` / `SyncableStashProvider` with the single minimal interface from spec §2.1. Provider classes lose `search`/`show`/`canShow` stubs.

**Files touched.**
- MODIFY: `src/source-provider.ts` (renamed in Phase 2). Replace contents with the spec's `SourceProvider` interface and `ProviderContext`.
- DELETE: `LiveStashProvider`, `SyncableStashProvider`, `isSyncable`, `SyncOptions`, `StashLockData` types from that file.
- MODIFY: `src/source-providers/filesystem.ts` — strip `search`/`show`. Add `path()` returning the resolved directory. No `sync`.
- MODIFY: `src/source-providers/git.ts` — strip `search`/`show`. `path()` returns the cache directory; `sync()` clones or pulls.
- MODIFY: `src/source-providers/website.ts` — strip `search`/`show`. `sync()` runs the recrawl.
- MODIFY: `src/source-providers/npm.ts` — strip `search`/`show`. `sync()` runs `npm install`.
- MODIFY: `src/source-provider-factory.ts` — `(name) => new FilesystemSource(name)` shape per spec Appendix B.
- MODIFY: `src/create-provider-registry.ts` — verify generic signature is `<P extends { name: string; kind: string }>` and registration works for both source and registry providers.
- DELETE: `LockData`-related fields from `SourceConfigEntry` that the new interface doesn't need (keep the on-disk lockfile, but it's owned by `lockfile.ts`, not the provider).

**Order of edits.** (1) Add the new interface alongside the old (parallel types) so providers compile. (2) Update each provider class to implement only the new interface. (3) Update factory + registry. (4) Delete the old interface and its imports. (5) Adjust `search-source.ts` to call `provider.path()` instead of the URL/path-ladder switch.

**Tests.** Update `tests/provider-registry.test.ts`, `tests/source-providers/git.test.ts`, `tests/source-providers/website.test.ts`. Add `tests/source-providers/filesystem.test.ts` covering `init` + `path`. Add a parity test verifying `path()` returns the same value across calls (spec's lifetime guarantee).

**Verification.**
```
bunx tsc --noEmit
bunx biome check --write src/ tests/
bun test
grep -rn "LiveStashProvider\|SyncableStashProvider\|isSyncable" src/ tests/   # zero hits
```

**Recovery.** Reset the worktree (or revert the merge commit on the integration branch) to restore the prior interfaces. Phase 4 depends on this — block its worktree until Phase 3 lands cleanly.

**Dependencies.** Phases 1, 2.

---

### Phase 4 — Move reading into the indexer (spec §10 step 4)

**Track.** Same worktree as Phase 3 (`phase/3-source-provider`, retitle to `phase/3-4-indexer-reads` after Phase 3 commits land). Sequential after Phase 3 because the provider interface change is a precondition.

**Goal.** Search and show stop fanning out across providers. They consult the unified FTS5 index and read files from disk.

**Files touched.**
- DELETE: `src/stash-search.ts` (now `src/source-search.ts`). Logic collapses into:
- CREATE: `src/commands/search.ts` — calls `indexer.search(query)` from `src/indexer.ts` directly.
- DELETE: `src/stash-show.ts` (now `src/source-show.ts`).
- CREATE: `src/commands/show.ts` — calls `indexer.lookup(ref)` then `readFile(entry.filePath)`.
- MODIFY: `src/indexer.ts` — add `lookup(ref: AssetRef): Promise<IndexEntry | null>`. Walks all sources by calling `provider.path()`. The old "resolveEntryContentDir" ladder in `src/search-source.ts` (lines 100–130) is deleted; `provider.path()` is the source of truth.
- MODIFY: `src/search-source.ts` — replace `resolveEntryContentDir` with calls into the provider registry to instantiate providers and call `path()`. The function now only enumerates sources for the indexer.
- MODIFY: `src/cli.ts` — `searchCommand` and `showCommand` import from `commands/search.ts` and `commands/show.ts`.

**Order of edits.** (1) Add `indexer.lookup`. (2) Add `commands/search.ts` calling the indexer; route `cli.ts` through it. (3) Add `commands/show.ts`. (4) Delete `source-search.ts` / `source-show.ts`. (5) Remove the ladder from `search-source.ts`.

**Tests.** Update `tests/stash-search.test.ts` → `tests/commands/search.test.ts`. Same for show. Add a regression test: `indexer.lookup(ref)` returns the path of an indexed file, and reading it produces the same content as the old `show` path.

**Verification.**
```
bunx tsc --noEmit
bunx biome check --write src/ tests/
bun test tests/commands/ tests/indexer.test.ts
```

**Recovery.** Reset the worktree (or revert the merge commit). The indexer.lookup addition is additive; main risk is missing index entries — caught by the parity test before the merge gate.

**Dependencies.** Phase 3.

---

### Phase 5 — Move writing into `write-source.ts` (spec §10 step 5)

**Track.** Worktree `phase/5-write-source`. Branched from `refactor/v1-architecture` after Phase 2. Runs in parallel with Phases 3+4, 6, 7. File overlap with other worktrees: near zero.

**Goal.** Single entry point for write/delete. The only `kind`-branching dispatch in the codebase, by design.

**Files touched.**
- CREATE: `src/core/write-source.ts` — exports `writeAssetToSource(source, config, ref, content)` and `deleteAssetFromSource(source, config, ref)` per spec §2.6 and §2.7.
- MODIFY: `src/remember.ts` — replace direct `writeFile` + commit logic with `writeAssetToSource`.
- MODIFY: `src/stash-add.ts` (renamed to `src/source-add.ts` in Phase 2) — same.
- MODIFY: `src/stash-source-manage.ts` — same for the import path.
- MODIFY: `src/config.ts` `SourceConfigEntry` — add `writable?: boolean`. Default-resolution helper: `true` for `filesystem`, `false` otherwise. Add `defaultWriteTarget?: string` to root config.
- MODIFY: `schemas/` JSON Schema for config — reflect the new field.

**Order of edits.** (1) Add `core/write-source.ts` plus tests. (2) Add `writable` to types + loader defaulting. (3) Migrate `remember.ts` first (smallest call site). (4) Migrate the rest. (5) Delete inlined commit-and-push code from each call site.

**Tests.** New `tests/core/write-source.test.ts` covering: not-writable refusal, plain filesystem write, git commit, git commit with `pushOnCommit`, git delete. Update `tests/remember*.test.ts` to assert via the helper.

**Verification.**
```
bunx tsc --noEmit
bunx biome check --write src/ tests/
bun test tests/core/ tests/remember-*.test.ts
```

**Recovery.** Reset the worktree (or revert the merge commit). Call sites restore their inline logic.

**Dependencies.** Phase 3.

---

### Phase 6 — Extract registry providers (spec §10 step 6)

**Track.** Worktree `phase/6-registry-providers`. Branched from `refactor/v1-architecture` after Phase 2. Runs in parallel with Phases 3+4, 5, 7.

**Goal.** Confirm `static-index` and `skills-sh` are first-class providers under `src/registry-providers/`. Remove any Context Hub special-casing.

**Files touched.**
- RENAME: `src/providers/` → `src/registry-providers/` (already houses `static-index.ts`, `skills-sh.ts`, `index.ts`).
- MODIFY: `src/registry-providers/types.ts` (new) — `RegistryProvider` interface from spec §3.1.
- MODIFY: `src/registry-search.ts` → `src/commands/registry-search.ts` — loop over registered registry providers.
- MODIFY: `src/registry-factory.ts` — provider registration via `createProviderRegistry`.
- DELETE: any Context Hub-specific code paths in `src/registry-resolve.ts`, `src/origin-resolve.ts`. Context Hub becomes a recommended kit in the official registry.
- MODIFY: `src/registry-build-index.ts` and the v2 schema doc — relocate the v2 schema notes under the `static-index` provider's owned contract.

**Order.** (1) Add new `RegistryProvider` interface. (2) Update `static-index.ts`, `skills-sh.ts` to implement it. (3) Re-route `commands/registry-search.ts`. (4) Strip Context Hub.

**Tests.** Update `tests/providers/skills-sh.test.ts`. Add `tests/registry-providers/static-index.test.ts` covering `searchKits`, `searchAssets`, `getKit`. Add a registry parity test exercising both providers through the same loop.

**Verification.**
```
bunx tsc --noEmit
bunx biome check --write src/ tests/
bun test tests/registry-providers/ tests/commands/registry-search.test.ts
```

**Recovery.** Reset the worktree (or revert the merge commit). Affects only the registry surface.

**Dependencies.** Phases 2, 3.

---

### Phase 7 — Error hints on classes (spec §10 step 7)

**Track.** Worktree `phase/7-error-hints`. Branched from `refactor/v1-architecture` after Phase 2 (Phase 1 also a hard prereq because OpenViking-specific hints are gone by then). Runs in parallel with Phases 3+4, 5, 6.

**Goal.** Delete the regex-on-message hint chain in `src/cli.ts` (the `buildHint` chain). Each error class owns a `hint()` method.

**Files touched.**
- MODIFY: `src/errors.ts` — add `hint(): string | undefined` per class. `UsageError`, `ConfigError`, `NotFoundError` carry their own hint string at construction (or derive from `code`).
- MODIFY: every throw site to pass an explicit `code` (most already do).
- MODIFY: `src/cli.ts` — replace `buildHint(message)` with `error instanceof Error && "hint" in error ? error.hint() : undefined`.
- DELETE: `buildHint` function and the regex chain.

**Order.** (1) Add `hint()` methods. (2) Audit throw sites to attach a code/hint where the regex chain previously injected one. (3) Replace dispatch in `cli.ts`. (4) Delete `buildHint`.

**Tests.** Update `tests/cli-errors.test.ts` to verify hints come from error instances, not message regex. Add coverage that each `UsageErrorCode` produces the expected hint.

**Verification.**
```
bunx tsc --noEmit
bunx biome check --write src/ tests/
bun test tests/cli-errors.test.ts
grep -n "buildHint" src/   # zero hits
```

**Recovery.** Reset the worktree (or revert the merge commit); the regex chain restores.

**Dependencies.** Phase 1 (so the OpenViking-specific hints are already gone).

---

### Phase 8 — Exhaustive output shapes (spec §10 step 8)

**Track.** Direct on `refactor/v1-architecture` after the four parallel worktrees (3+4, 5, 6, 7) have all merged. Touches every command file; serialising prevents collisions.

**Goal.** `shapeForCommand` becomes exhaustive. Every command registers `{ shape, textRenderer }` at module load. No silent `JSON.stringify` fallback.

**Files touched.**
- MODIFY: `src/output-shapes.ts` — replace the `default: return result;` fallback with a thrown `ConfigError("no output shape registered for command \"${command}\"")`.
- CREATE: `src/output-shape-registry.ts` — small registry. Each command file calls `registerOutputShape("search", shapeSearchOutput, renderSearchText)` at module load.
- MODIFY: every `src/commands/*.ts` (created in Phases 4, 5, 6, plus migrations from `cli.ts` in Phase 9) — register their shape on load.
- MODIFY: `src/output-text.ts` — drive text rendering through the same registry.

**Order.** (1) Build the registry. (2) Migrate the three currently shaped commands (search, registry-search, show). (3) Add shapes for every other command surface (`add`, `remove`, `list`, `update`, `clone`, `index`, `setup`, `remember`, `import`, `feedback`, `registry *`). (4) Switch `shapeForCommand` to throw on miss.

**Tests.** New `tests/output-shapes-exhaustiveness.test.ts` — iterate over the locked CLI command list (spec §9) and assert each has a registered shape. Keep `tests/output-shapes-unit.test.ts` and `tests/output-baseline.test.ts` green.

**Verification.**
```
bunx tsc --noEmit
bunx biome check --write src/ tests/
bun test tests/output-shapes-exhaustiveness.test.ts tests/output-baseline.test.ts
```

**Recovery.** Reset the integration commits. Output goes back to silently passing through unknown commands until re-attempted.

**Dependencies.** Phases 4, 5, 6.

---

### Phase 9 — File splits (spec §10 step 9)

**Track.** Direct on `refactor/v1-architecture`. No worktree — moves files everywhere; parallel work would conflict on every importer.

**Goal.** Apply the spec §7 module layout. `cli.ts` shrinks to a thin dispatcher.

**Files touched.**
- SPLIT: `src/cli.ts` (~2,235 lines) → `src/commands/<verb>.ts` per CLI subcommand. `cli.ts` keeps argv parsing and dispatch only.
- SPLIT: `src/wiki.ts` (~1,114 lines) → `src/wiki/wiki-crud.ts`, `src/wiki/wiki-index.ts`, `src/wiki/wiki-lint.ts`, `src/wiki/wiki-ingest.ts`.
- SPLIT: `src/setup.ts` (~1,106 lines) → `src/setup/<step>.ts` (one file per step).
- SPLIT: `src/config.ts` (~1,176 lines) → `src/core/types.ts` (canonical AssetRef, SourceConfigEntry, etc.) + `src/core/config.ts` (loading/merging) + `src/core/refs.ts` (parseAssetRef, parseInstallRef — split from `asset-ref.ts`).
- SPLIT: `src/renderers.ts` (~724 lines) → `src/renderers/<asset-type>.ts`.

**Order.** (1) Move the cleanest verbs first (`feedback`, `clone`, `list`). (2) Migrate the wiki module. (3) Migrate setup. (4) Last: split `config.ts` (touches every importer — coordinate with team).

**Tests.** Existing tests should keep passing unchanged. Add `tests/cli.test.ts` smoke coverage that every subcommand still dispatches.

**Verification.**
```
bunx tsc --noEmit
bunx biome check --write src/ tests/
bun test
wc -l src/cli.ts          # < 300 lines after split
```

**Recovery.** Mechanical revert per split commit on the integration branch.

**Dependencies.** Phases 4–8 (so the right verbs already have their own modules).

---

### Phase 10 — Document and freeze (spec §10 step 10)

**Track.** Direct on `refactor/v1-architecture`. Final commit set before opening the integration PR.

**Goal.** Tag v1.0. Documentation matches the locked contracts.

**Files touched.**
- MODIFY: `docs/technical/architecture.md` — replace with content derived from the spec.
- MODIFY: `docs/concepts.md` — `stash` → `source`, drop OpenViking, add `writable` flag explanation.
- MODIFY: `CLAUDE.md` — replace the "three stash provider types" rule and the "Refs" rule with the v1 versions. Add the locked-contracts list from spec §9.
- MODIFY: `docs/migration/v1.md` (created in Phase 1) — finalise with the full migration script.
- ADD: `docs/technical/v1-architecture-spec.md` is already in place; cross-link from architecture.md.
- ADD: `docs/plugin-authors.md` — extension points (spec §8).
- TAG: `v1.0.0`.

**Order.** Docs PR. No source changes.

**Tests.** None beyond doc-link checks.

**Verification.**
```
markdown-link-check docs/**/*.md   # if available
git tag v1.0.0
```

**Recovery.** Untag, revert docs commits.

**Dependencies.** Phases 1–9.

---

## 4. Cross-cutting Concerns

### 3.1 Migration handling

Existing user configs may contain `openviking` sources. Per spec §10 step 1, the loader must throw `ConfigError` with a hint at load time — not silently ignore. The full migration message is specified in Phase 1 above. `docs/migration/v1.md` documents the manual remediation: `akm config sources remove <name>` followed by waiting for the post-v1 `QuerySource` tier.

The `stashes[]` → `sources[]` JSON key change (Phase 2) is auto-migrated in-memory with a one-time `warn()` and persisted on the next write. This avoids forcing every user to edit their config.

### 3.2 Public API surface

Per `CLAUDE.md`: this is a CLI-only package, no public API, no barrel exports. **Safe to break:** any TypeScript type currently exported from `src/`. **Must not break:** the CLI command surface listed in spec §9 — `add | remove | list | update | search | show | clone | index | setup | remember | import | feedback | registry *`. Renames or removals require a major bump after v1.0. The output JSON shapes registered in Phase 8 are also locked; any field removal is breaking.

### 3.3 Test coverage

New tests required:
- `tests/core/write-source.test.ts` — full matrix of writable/non-writable × filesystem/git × push/no-push (Phase 5).
- `tests/registry-providers/parity.test.ts` — both built-in registry providers exercised through the same `RegistryProvider` interface methods (Phase 6).
- `tests/core/refs.test.ts` — `parseAssetRef` and `parseInstallRef` reject each other's inputs (spec Appendix A) (Phase 9).
- `tests/output-shapes-exhaustiveness.test.ts` — every locked command in spec §9 has a registered shape (Phase 8).
- `tests/source-providers/path-stability.test.ts` — `provider.path()` returns the same value across calls (Phase 3).
- `tests/config.test.ts` additions — OpenViking config is rejected with the documented hint; legacy `stashes[]` JSON loads with a deprecation warning (Phases 1, 2).

### 3.4 Documentation updates

- `docs/technical/architecture.md` — full rewrite to mirror the spec (Phase 10).
- `docs/concepts.md` — terminology pass: stash → source, drop OpenViking, document `writable` flag and `defaultWriteTarget` (Phase 10).
- `CLAUDE.md` — replace the "Provider types" and "Refs" rule blocks; add a "Locked contracts" reference pointing at spec §9 (Phase 10).
- `docs/migration/v1.md` — created in Phase 1, finalised in Phase 10.
- `docs/plugin-authors.md` — new doc covering the §8 extension points and the registration pattern from Appendix B (Phase 10).
- `docs/technical/registry-index.schema.json` — re-home as the input contract of the `static-index` provider (Phase 6).

---

## 5. Patterns to Leverage

The spec implicitly relies on a small set of patterns. Calling them out so contributors don't reinvent them:

- **Provider registry / factory.** `createProviderRegistry<P>()` is the only extension mechanism for sources and registries. Plugin packages register into the same registries after load. Keep the registry generic over `{ name, kind }` so the same primitive serves both tiers.
- **Strategy pattern for asset renderers.** One file per asset type under `src/renderers/`, each with three verbosity levels. Adding an asset type is one new file plus one registration line.
- **Single dispatch point for `kind` branching.** `writeAssetToSource` is **the only** place in the codebase that branches on `source.kind`. This is intentional — "git has a commit step" is domain knowledge, not polymorphism. Reviewers should reject any new `switch (source.kind)` outside this helper unless explicitly justified.
- **Exhaustive output shape registry.** No silent `JSON.stringify` fallback. Adding a new command requires registering its shape; the test suite enforces this.
- **Discriminated unions over inheritance.** `SourceProvider.kind` is a string discriminator, not a class hierarchy. Avoid `instanceof` checks.

**Recommended additions** (only what justifies itself under YAGNI):
- A tiny **content-addressed cache directory helper** (`src/core/cache-dir.ts`) shared by `git`, `website`, `npm` providers. They all do `path.join(ctx.cacheDir, hash(identifier))`. Centralising the hash keeps cache-dir layout consistent and gives one place to bump the hashing scheme. Single-purpose, ~20 lines.

I am **not** recommending a write-time hooks API. The spec is right that two cases (filesystem write vs. git commit) don't justify it. If a third behaviour appears post-v1 and the helper grows past three branches, revisit.

---

## 6. Decisions (locked)

The four open questions in spec §11 have been resolved. Build to these defaults:

1. **Default for `writable` on `filesystem`: `true`.** Matches user mental model (they own the directory). The escape hatch is one config line.
2. **Registry results in default `akm search`: behind `--include-registry`.** Default output stays scannable. Flip the existing `--source stash|registry|both` flag's default to `stash` and require opt-in for registry merge.
3. **`defaultWriteTarget`: explicit config key, falls back to the user's working stash.** The working stash (the one initialized by `akm init` and persisted as `stashDir` in config) is the implicit fallback target — `defaultWriteTarget` overrides; absent override, write-path commands target the working stash. This sidesteps "first-writable-in-source-array-order" ambiguity entirely: there's always one obvious destination.
4. **Refuse `writable: true` on `website` and `npm` kinds at config load.** `sync()` would clobber writes on the next refresh — that's a footgun, not a feature. Loader throws `ConfigError` naming the source and kind, with hint: *"writable: true is only supported on filesystem and git sources."* Users who need to author into a checked-out npm package can re-add the same path as a `filesystem` source.

**Implementation impact on the phase sequence:**

- **Phase 1** — Migration doc must mention decision 4: any v0.x configs with `writable: true` on `website`/`npm` will fail to load with a clear remediation message.
- **Phase 5 (write-source.ts)** — The only kinds that legitimately reach the write helper are `filesystem` and `git`; the loader rejection in decision 4 enforces this. Drop any "plain file write for non-git, non-filesystem kinds" branch before it appears.
- **Phase 5** — Write-target resolution order: explicit `--target` flag → `defaultWriteTarget` config key → `stashDir` (the working stash) → `ConfigError("no writable source configured; run \`akm init\`")`.
- **Spec update needed** — §5.4 gains a sentence: *"`writable: true` on `website` and `npm` kinds is rejected at config load."* §11 "open questions" becomes "decisions". Tracked in Phase 10's docs pass; the spec already lives at `docs/technical/v1-architecture-spec.md`.

---

## 7. Estimated Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | The integration branch drifts from `release/0.6.0` while parallel worktrees are open, accumulating hard-to-resolve rebase conflicts. | Medium | High | Keep `release/0.6.0` quiet for the duration where possible. If activity is unavoidable, rebase the integration branch onto `release/0.6.0` nightly; force-rebase any open worktree onto the new tip the next morning. The `--ff-only` merge gate enforces fresh rebases. |
| 2 | A worktree is merged with stale tests passing locally because the worktree wasn't rebased onto recent integration commits. | Medium | Medium | The `--ff-only` policy in §2.2 makes this impossible — non-FF merges fail outright, forcing rebase first. Document this in `CONTRIBUTING.md` (or a temp `docs/v1-refactor-howto.md`). |
| 3 | `indexer.lookup` regression in Phase 4 silently returns wrong file paths for assets with origin prefixes. | Medium | High | Parity test compares old `show` output against new for every fixture asset before deleting `source-show.ts`. Keep the parity test in the suite post-Phase-4 as a regression guard. |
| 4 | Users with `openviking` configs upgrade and hit `ConfigError` at every command, perceiving a regression. | Medium | Medium | Migration message explicitly references `docs/migration/v1.md`. Ship the doc in Phase 1. Add a banner to the next-pre-release CHANGELOG entry. |
| 5 | Output shape exhaustiveness check (Phase 8) catches missing shapes in command surfaces nobody ships text rendering for, blocking integration. | Medium | Low | Pre-flight: run a grep for `defineCommand` and cross-reference against the registered shape list before starting Phase 8. Add stub shapes that delegate to a generic JSON renderer if no text rendering is wanted. |
| 6 | The `writable` default flag lands as `true` and a user accidentally overwrites a curated read-only filesystem source. | Low | Medium | Document explicitly in `docs/concepts.md`. Add a one-time stdout banner the first time `writeAssetToSource` runs against a `writable: true` filesystem source per stash. |
| 7 | The single integration PR becomes too large to review usefully. | Medium | Medium | Squash-on-merge is **not** acceptable here; keep the per-phase commit history so reviewers can navigate phase-by-phase. Annotate the PR description with a phase-by-phase diff index linking to the relevant commits. |

---

## 8. Definition of Done

A checklist mapping to spec §9 locked contracts. All boxes must be true before tagging `v1.0.0`.

- [ ] `SourceProvider` interface in `src/source-providers/types.ts` matches spec §2.1 exactly. Three required methods, one optional. No extras.
- [ ] `RegistryProvider` interface in `src/registry-providers/types.ts` matches spec §3.1.
- [ ] Core types in `src/core/types.ts`: `AssetRef`, `AssetContent`, `SearchHit`, `KitResult`, `AssetPreview`, `KitManifest`, `SourceConfigEntry` all match spec §4.
- [ ] `parseAssetRef` accepts only `[origin//]type:name`; rejects URI schemes and traversal. `parseInstallRef` is a separate function and rejects asset-ref inputs. Test coverage in `tests/core/refs.test.ts`.
- [ ] `SearchHit.score` is in `[0, 1]`, higher = better. Verified by ranking-regression test.
- [ ] Configuration JSON Schema matches spec §5.1. `writable` flag defaults per §5.4. `{ env: "VAR" }` value form supported. Missing required env produces `ConfigError` naming the variable.
- [ ] Error classes own `.code` and `.hint()`. `buildHint` regex chain in `cli.ts` is deleted. Exit codes: USAGE=2, CONFIG=78, GENERAL=1.
- [ ] CLI command surface is exactly: `add | remove | list | update | search | show | clone | index | setup | remember | import | feedback | registry *`. Smoke test in `tests/cli.test.ts`.
- [ ] `shapeForCommand` is exhaustive; throws on unknown command. Test enforces.
- [ ] v2 JSON index schema lives under `src/registry-providers/static-index.ts`, not in core.
- [ ] Index DB schema-version bump path is documented and tested (wipe + rebuild).
- [ ] OpenViking removed; `grep -rn "openviking" src/ tests/` returns zero.
- [ ] `stash` token removed from source files; only present in changelog and migration docs.
- [ ] All builds green: `bunx tsc --noEmit`, `bunx biome check --write src/ tests/`, `bun test`.
- [ ] `docs/technical/architecture.md` rewritten to match spec. `docs/migration/v1.md` published. `CLAUDE.md` rules block updated.
- [ ] All worktrees merged and removed (`git worktree list` shows only the main checkout).
- [ ] No stale `phase/*` branches remain (`git branch | grep ^phase/` is empty).
- [ ] Integration branch tip builds green; every commit on the branch builds green (`git rebase --exec "bun test && bunx tsc --noEmit" release/0.6.0..refactor/v1-architecture` passes).
- [ ] Single PR `refactor/v1-architecture → release/0.6.0` opened, reviewed, and merged. Per-phase commits preserved (no squash).

---

## 9. Spec Concerns

Two minor items where I'd push back on the current spec wording:

**1. Spec §2.6 — `writeAssetToSource` is the "only" place that branches on `source.kind`.** This is aspirational. In practice, `sync()` orchestration in `commands/add.ts` and `commands/update.ts` will need to know whether a source has `sync` defined (trivially: `if (source.sync) await source.sync()`) — that's not a `kind` branch, but it's adjacent. Suggested rewording: *"`writeAssetToSource` is the only place that branches on `source.kind` to add behaviour. Optional-method probes (`if (source.sync)`) are allowed."*

**2. Spec §6.3 — `add` command relies on registry `canHandle` matching a ref.** The `RegistryProvider` interface in §3.1 doesn't include `canHandle`. Either add it to the interface or specify the matching as an external function (e.g. `parseInstallRef` returns a hint about which registry kind owns the ref). Suggested addition to §3.1:
```ts
canHandle(ref: InstallRef): boolean;
```
Otherwise `commands/add.ts` would need to introspect `kind`, which violates the §2 design rule.

Both are low-impact wording fixes. Raise in the v1 spec review thread, don't block implementation.

---

## Critical Files for Implementation

- `src/stash-provider.ts` (becomes `source-provider.ts` then collapses to spec §2.1 interface)
- `src/config.ts` (~1,176 lines — splits, gains `writable`, drops openviking)
- `src/cli.ts` (~2,235 lines — splits into `src/commands/*.ts`, hint chain deleted)
- `src/search-source.ts` (the `resolveEntryContentDir` ladder lines 100–130 deletes when `provider.path()` lands)
- `src/output-shapes.ts` (becomes exhaustive registry; `default: return result;` fallback removed)
