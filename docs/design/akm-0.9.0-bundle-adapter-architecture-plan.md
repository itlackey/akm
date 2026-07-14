# AKM 0.9.0 — Comprehensive Clean-Up Implementation Plan

**Bundle Adapters, Drop-Ref + Full Re-Key, improve Decomposition, and a Whole-Repo Debt Sweep**

Status: APPROVED architecture. This is an implementation plan, not a proposal. Baseline HEAD: `b7877d9` / `cf44e11` (post engine-strategy cutover). Single track, in-branch, no intermediate release.

**Companion spec:** the concrete bundle/adapter *how* is in [`akm-0.9.0-bundle-adapter-spec.md`](./akm-0.9.0-bundle-adapter-spec.md), reconciled with the normative `akm-format-neutral-bundle-workspace-spec.md` **v0.2** (amended in place). Read it alongside §2/§7.

**Reconciliation status (2026-07-13, final):** the four maintainer decisions (recorded in `akm-plan-vs-spec-deviation-analysis.md` §4) — OKF hybrid with open `type`; ref = `[bundle//]conceptId`; bindings/activation + the full bounded memory lifecycle + the third `consolidate` verb IN SCOPE; LLM Wiki adapter restored — are now **applied in place throughout this document**. The chunk sequence (§11), ledger (§12.1), DoD (§12.2), and contract tests (§12.3) encode the reconciled scope, and the review-pass findings (`akm-0.9.0-plan-review-2026-07.md`, `akm-target-design-review-2026-07.md`) are folded in: migration rewrite (§3/§8), corrected claims (§1.4/§4), behavior-change ledger (§5), memory-lifecycle 0.9.0 scope (§6), additional cross-cutting workstreams (§10.7), test strategy (§15), repo-surface sweep (§16). No passage below is superseded by a banner; this text is current. Doc gate: the pre-reconciliation phrasings (the bindings-deferral imperative, the two-verb count, the wiki-into-knowledge fold) grep to zero outside this sentence.

---

## 1. Executive Summary

### 1.1 What 0.9.0 is

0.9.0 is a **single-track, no-release, net-simplification** refactor that replaces AKM's asset-type taxonomy with **bundle adapters**, drops the `[origin//]type:name` ref for an **opaque adapter-owned id** with a **one-time full state re-key**, decomposes the **improve god-modules** into named passes, and **sweeps every remaining structural debt** the subsystem review surfaced so the churn stops. There is no `0.8.x → 0.9.0` compatibility window, no dual-write, no feature flags kept past cutover. One atomic migration, one throwaway migrator (`@removeIn 0.10.0`), one green branch that merges when the whole thing is done.

### 1.2 Four objectives (no debate, no re-scope)

1. **Asset-types → bundle adapters.** Delete `AssetSpec` / `AkmAssetType` closed union / `TYPE_DIRS` / global matchers / renderer+action registries / `StashEntry`-as-model / type-derived paths / `[origin//]type:name` refs. Bundle adapters own native formats, on-disk conventions, authoring rules, recognition, placement, renderer, and L1 validation. Core owns install / index / search / change-transaction / state / bindings / improve.
2. **Drop-ref + full re-key.** `type:name` refs become opaque bundle-scoped adapter-owned ids. One atomic `0.8 → 0.9` migration re-keys **all** state, fail-closed, backup-verified, throwaway migrator.
3. **Decompose improve.** Four god functions (`runImprovePreparationStage` ~1544, `akmImprove` ~943, `akmReflect` ~707, `akmDistill` ~635) become thin orchestrators over named passes on an explicit `RunContext`, mirroring the already-decomposed `consolidate.ts`. **Three verbs:** `revise` (reflect), `learn` (extract/distill/inference/recombine/synthesis), and `consolidate` (bound the memory tier — the only op that retires source content; see the memory lifecycle, §6 + normative §25).
4. **Sweep all remaining debt.** Ambient-config threading, config over-engineering, DRY consolidations, concrete defects, dead/unwired code, misleading names — comprehensively, so this is one-and-done.

### 1.3 Hard rules

- **NET LOC REMOVED must exceed added.** Honest target ≈ **−5,000 to −9,000 net** across src (§12.1 ledger: deletions −13,000 to −15,000, minus the budgeted +5,500–8,500 restored-subsystem adds). Test LOC is ledgered separately (§15) and does not count toward the src target.
- **No new machinery/frameworks EXCEPT the two spec-mandated restored subsystems** — bindings/activation (normative §18) and the memory-lifecycle state model (normative §25) — which are budgeted as a signed adds line in §12.1. Adapters, `RunContext`, and the `jsonColumn()` helper remain *refactors of existing coupled functionality into proper boundaries*. Anything else new is out of scope.
- **Keep valuable features + proven infra** (audit S26): `writeFileAtomic`, symlink containment, SQLite hardening, git exact-path staging, credential redaction, engine freezing, workflow frozen-plan, scheduler safety, deterministic search benchmarks, typed errors, **and the retrieval-canary probe + store** (the memory-lifecycle verification harness, §13.2 carve-out). Every §-level preserve list is binding.

### 1.4 Corrections folded from the sweep and the review pass

- Ref/migration decision **superseded**: DROP-REF + FULL-RE-KEY, no compat, no dual-write (was: ref-preserving migration).
- `config-schema.ts` is **1415 LOC / 252 `.optional()` / 3 `.default()`** (verified), not the stale §4 figure of 1012/219.
- `akmConsolidateInner` is **already decomposed** — do not re-plan it; current large consolidate targets are `planConsolidation` (~426), `handleMergeOp` (~298), `handlePromoteOp` (~215).
- `IndexDocument` **does not exist yet** (grep-verified zero hits). The normalized model is **minted from the existing `StashEntry`** plus provenance + the pinned query-time signal fields (adapter spec §3) — a rename + field move + signal promotion, with the schema-column migration owned by Chunk 5.
- Already-fixed, **do not re-churn**: `runFtsQuery` swallow (B7), `improve?.default` deep-chain (A3), `m=months vs minutes` conflict (B1 headline), `CONFIG_SUBCOMMAND_SET` desync (B2), grid-search-at-import (distill policy), `FEEDBACK_FAILURE_MODES` dup, `asNonEmptyString`/`firstString` dup, `writeFileAtomic` dead branch, `setup/legacy-config.ts` (already deleted), `AGENT_PLATFORMS` trap, **`summarizeImproveCompleted`** (already refactored to a 5-line delegate — the §4.7 decompose row is dropped). Residual debt around each is separately named below.
- **Corrected by verification (review pass):** `mergeInformationFloor` **is genuinely advisory** — `checkMergeInformationFloor` counts + warns and "merge proceeds (v1 observe-only)" (consolidate.ts caller); the schema comment was right and the earlier "live gate" correction was wrong. The field joins the §13.2 measurement pass (prove the floor should gate, or delete it with the collapse cluster). — Proposal **dedup/cooldown is live machinery** for 8 of 11 `createProposal` call sites (only the two human CLI paths and recombine's promote force-bypass it); its deletion is re-scoped in §4.5 to land **with** the fingerprint replacement, retaining rejection backoff. — The Node/`better-sqlite3` DoD gap is **stale**: CI's `node-smoke` job gates the driver on Node 20/22 every commit; the real items are deleting the stale `database.ts:14` comment and adding Node 24 to the matrices (§14.4). — Detail drift fixed in place: `SCRIPT_EXTENSIONS` = 16; `classifyBySmartMd` lives in `matchers.ts:181`; `caps()` is byte-identical across **10** files; P2 harness dir is `codex`, builders/extractors sum 946/1014 LOC; `AkmHarness.resume` is declared on 6/10 harnesses with 2 flag constants; `_set*ForTests` = 18 seams; the runtime graph-include SUPPORTED set silently drops schema-allowed `fact` (desync to fix in §4.2); `workflow.db` has two direct openers besides the repo gateway (§8.2).
- **Residual-complexity audit folded in** (companion `akm-0.9.0-residual-complexity-audit.md`, integrated in §13): ~4,300 LOC of **confident gold-plating deletions** fold into the chunks below (net-LOC ledger updated); a further ~6,000–12,000 LOC of **default-on-but-unproven** subsystems (graph extraction, the collapse-alert loop, the outcome-loop/encoding-salience/scoped-utility apparatus) go to a **single 0.9.1 measurement pass** rather than being litigated here. The audit's scope-down of bindings/memory/facets was **overruled by the maintainer reconciliation** (DEV-3/4/5): those ship in 0.9.0, budgeted honestly; the retained simplifications are renderer/action as a data table over a named-function module, optional methods instead of an interface hierarchy, and no `Repository<Row,Domain>` base class (§13.3).

---

## 2. Target Proper-Core Architecture

### 2.1 The boundary

```
CLI boundary ── builds ──▶ RunContext { config, stashDir, dbs, adapters, clock, logger }
                                   │
        ┌──────────────────────────┼───────────────────────────────┐
   BUNDLE ADAPTERS (per format)   CORE (format-agnostic)        STORAGE (DB repos)
   own: recognize / placeNew /    owns: install, index, search,  own: table SQL over a
        renderer / action /             change-transaction,           shared Repository<Row,
        L1 validate / native            state, bindings, improve,      Domain> base
        conventions                     memory lifecycle
```

**Refactor-not-addition note:** every element below already exists in coupled form; 0.9.0 relocates it behind a boundary and deletes the coupling. No element is a green-field addition.

### 2.2 Minimal durable types

- **`IndexDocument`** — *minted by renaming `StashEntry`* (`indexer/passes/metadata.ts:60`, ~40 fields), **adding typed provenance** (`ref`/`bundle`/`component`/`conceptId`/`adapterId`/`contentHash`) that today is carried out-of-band on `DbIndexedEntry.{filePath,stashDir}` and resolved at query time (`db-search.ts:100,210`), and **keeping the query-time signal fields first-class** (aliases, searchHints, quality, confidence, beliefState/currentBeliefRefs/supersededBy, scope, captureMode, lessonStrength, pinned, fileSize, derivedFrom — the exact set the ranking contributors and result filters read; adapter spec §3). Wiki-only fields `wikiRole`/`pageKind` (`metadata.ts:106,112`) move into the `llm-wiki` adapter's document extras. This is a **rename + field move + signal promotion**, not a new type — folding the signal fields into an opaque blob would fail the §12.3 parity gate.
- **`AssetRef`** — opaque bundle-scoped id string. `asset-ref.ts` (140 LOC) survives as a **pure parser**: grammar + `makeAssetRef`/`refToString` + `validateName` traversal/null-byte/drive-letter guards (`:121-136`). Delete the closed-union `isAssetType` gate (`:109`), `TYPE_ALIASES` (`:25-27`), and the vault `UsageError` (`:98-103`).
- **`Proposal`** — one object `{ changes: FileChange[]; beforeHash; status; evidence }`. Today it carries a single `payload{content,frontmatter?}` blob (`proposal/repository.ts:287`, `proposals-repository.ts:66-69`) that cannot express multi-file consolidate. This is a **shape change**, +40 LOC, the only net-add in the changes area.
- **`FileChange`** — `{ path; before?; after?; op }`, applied by one core transaction.

### 2.3 Adapter base + facets

One `BundleAdapter` interface, one adapter per component root — **recognize-required / index-optional over a core-owned walk** (adapter spec §2: the core walk keeps the git-aware traversal, symlink refusal, and skip-dirs in ONE place; adapters never reimplement it). Capabilities (each replacing a deleted global slice):

| Capability | Replaces (deleted global) |
|---|---|
| `recognize(c, FileContext) → IndexDocument?` (REQUIRED) | `matchers.ts` global competition + `file-context.runMatchers` specificity contest (`:242-265`) + `classifyBySmartMd` (`matchers.ts:181-222`) |
| `index?()` override (OPTIONAL; non-per-file layouts only, conformance-checked against recognize) | the wiki/website special-case walks |
| `placeNew?(c, conceptId) → path` | `TYPE_DIRS[type]` + `resolveAssetPathFromName` (`path-resolver.ts:28-33`, `write-source.ts:488-493`, `sources/resolve.ts:21-110`) |
| `directoryList?() → string[]` | `Object.values(TYPE_DIRS)` (git-stash pathspecs, provider-utils root detection, graph-extraction) |
| `TYPE_PRESENTATION` data table → named-function renderer module, trust-clamped actions | `asset-registry.ts` static `TYPE_TO_RENDERER`/`ACTION_BUILDERS` (`:21-58`) + `asset-spec` `rendererName`/`actionBuilder` split-brain |
| `validate(c, changes, ctx: ValidateContext)` — ctx = snapshot+overlay reads + `resolveRef` (adapter spec §2) | `LINTER_MAP`/`getLinterForType` + 9 per-type linter classes |
| `affectedItems?()` item-scoped incrementality | dir-staleness whole-dir regenerate (behavior-preserving for multi-file items: skill = the dir, wiki `schema.md` coupling) |

**Split-brain resolution (gap filled):** `asset-registry` statically maps renderers/actions for **all 14** types; `asset-spec` *also* carries `rendererName`/`actionBuilder` for only **8** (workflow/env/secret/wiki/lesson/task/session/fact). The remaining **6** (script/skill/command/agent/knowledge/memory) get their renderer **only** from the static registry map. Each per-format adapter must **locally stamp its own renderer+action**; the 6 static-only mappings must not be lost in the port.

**Shape discipline (§13.3):** capabilities are **optional methods on the one `BundleAdapter` interface** (DEV-6, normative §12) — no `MemoryLifecycleAdapter`/`AuthoringAdapter`/`ExportAdapter` `extends` hierarchy. `renderer`/`action` mappings stay a **data table** keyed on the open `type`, pointing at a small named-function core module (env/secret redaction is renderer *behavior* and survives as code, keyed on the adapter — normative §15.3/§15.4). Write real per-format code only where `recognize`/`validate` genuinely differ (skill SKILL.md, workflow codec, llm-wiki, env/secret safety).

---

## 3. Identity & Full Re-Key Migration

### 3.1 The new identity

`[origin//]type:name` → **`[bundle//]conceptId`** (path identity; normative §7.8/§11). `type` is no longer part of identity; it becomes an **open descriptive string** on `IndexDocument`, guarded only by the §7.3 known-type spelling pin (a lint/test), never by a closed union.

### 3.2 Complete state re-key list

Every table/column keyed on the old ref is re-keyed in the cutover, under the §3.3 mechanics:

- `asset_salience` (ref), `asset_outcome` (ref) — re-key via the `rekeyStateDbForMove` SQL pattern (`mv-cli.ts:928,957`), generalized to a full-table pass with the three-spelling merge (bare / `origin//` / `.derived` twins → one fully-qualified key; deterministic per-table merge: event rows carried as-is, scalar fields most-recently-updated wins).
- `proposals` (`entry_ref`), `improve_runs`, `extract_sessions`, `task_history`, `consolidation_judged` (`entry_key`), **`bindings` (new table, minted in this same cutover DDL)**.
- **`usage_events` lives in index.db today** (`usage-events.ts:66`, wired via `schema.ts:415`) — it is durable 90-day feedback history that current full rebuilds deliberately preserve. The cutover **migrates it into state.db** (ATTACH index.db read-only; `INSERT…SELECT` with `entry_ref` re-keyed in the same pass) **before** index.db is touched, which also satisfies normative §14.4's rule that durable feedback keys by item ref so index rebuilds never erase learning.
- `workflow_runs` / `workflow_run_steps` / `workflow_run_units` — merged in from workflow.db (§8).
- index.db is **regenerable after the usage_events rescue** — it is quarantine-renamed and rebuilt post-cutover (§3.3 boundary), not re-keyed.

### 3.3 One-time, journaled, fail-closed — the cutover is CODE, not a sealed SQL string

The shared migration engine seals static SQL bodies by SHA-256 and runs each inside its own transaction; the cutover cannot be that (the ATTACH path is runtime-resolved, and the old-ref→new-id mapping is filesystem-derived code). The cutover is therefore a **dedicated journaled step of the migrate-apply flow** — the plan owns this flow; the existing coordinator machinery (phase journals, generation fingerprints, active-writer barriers, WAL/SHM-safe publication) is retained exactly insofar as it serves these requirements and reworked where it does not:

1. **Backup first, verify-restorable** — the backup set includes config, state.db, workflow.db, and the pre-rescue index.db (home of usage_events). Pre-cutover backups MUST remain verifiable and restorable by the post-cutover binary: a **frozen copy of the `WORKFLOW_MIGRATIONS` ids+checksums** lives in `src/migrate/legacy/` (`@removeIn`) for exactly this.
2. **Old-ref→new-id map computed and persisted BEFORE any re-layout** — the migrator walks the old on-disk layout per source with the frozen legacy resolver (§3.4) and builds the complete map; the cutover consumes only the persisted map. Ordering rule: adapters land in earlier chunks, but old-ref resolution never runs through new-layout code.
3. **State cutover transaction** — exact sequence (empirically verified on bun:sqlite / SQLite 3.51): assert workflow.db exists (skip merge on fresh installs — ATTACH silently *creates* missing files); check `PRAGMA database_list`, then ATTACH workflow.db + old index.db **outside** any transaction; `BEGIN IMMEDIATE`; `INSERT…SELECT` the three workflow tables + the usage_events rescue + the full re-key; `COMMIT`; DETACH (in-transaction DETACH fails — the txn holds a read lock). The state.db handle goes through `applyStandardPragmas` (busy_timeout). Writes touch only state.db, so WAL cross-file atomicity is not relied on.
4. **Orphan taxonomy, not zero-orphan** — orphaned old-ref rows are an acknowledged steady state (deleted-asset salience rows, append-only event history, retained judged keys). **Expected orphans** (old ref → no live item) move to a quarantined `legacy_state` table, counts reported, migration completes. **Integrity failures** (mapping collisions without a defined merge, row-count mismatches, unparseable refs) fail closed to restore. The DoD fixture set includes an orphan-bearing DB that must complete-with-quarantine.
5. **index.db boundary** — touched only after the state cutover commits; "drop" = journaled rename-to-quarantine, never an early unlink; the rebuild (needs the new adapters, may need LLM/embedding) runs **outside** the fail-closed gate — a rebuild failure does not roll back a committed state cutover (the indexer self-heals on next run).
6. Then journaled, idempotent deletion of workflow.db + `-wal`/`-shm` sidecars, keyed on the committed ledger row.
7. Ledger entry named `018-<name>` (matching the `NNN-name` convention); the engine's idempotency/no-DROP contract gets an explicit carve-out note for the cutover vehicle.
8. No dual-write, no old-grammar read path retained after commit.

### 3.4 Throwaway migrator

- `src/migrate/legacy/` holds the migrator, **all** tagged `@removeIn` (next minor after release).
- **FROM-state:** the shipped rc-train layout (state ledger at its final pre-cutover migration, workflow.db present, vault removed) — not a pristine 0.8 tree. Fixtures cover it.
- `src/migrate/legacy/legacy-layout.ts` seeds from a **frozen COPY** (not `git-mv`) of the **whole old resolver surface**: per-type `ASSET_SPECS` (stashDir / `toAssetPath` incl. the SKILL.md directory-entry form and wiki layout / `toCanonicalName` / `isRelevantFile`), `SCRIPT_EXTENSIONS`/`WORKFLOW_EXTENSIONS`/`canonicalizeWorkflowName`, the ref grammar incl. bare and `.derived` key shapes, and origin→source resolution — so the live util home can evolve without touching the migrator. (Simpler in practice: the migrator enumerates the old layout by walking `TYPE_DIRS` per source and builds the map from disk, rather than resolving each DB ref individually.)
- A frozen copy of `WORKFLOW_MIGRATIONS` ids+checksums (§3.3 item 1) for pre-cutover backup verification.
- The pre-0.9 filesystem-proposal import (`proposal/legacy-import.ts` 131 LOC + `proposal_fs_imports` table + `proposals-repository.ts:258-302` ledger) folds into this single migrator and is deleted from the live path.

---

## 4. Comprehensive DELETE / MOVE / REPLACE / DECOMPOSE Inventory

Net-LOC is signed. "Repoint" = consumer edited to read adapter metadata; counted where the deleted source lives.

### 4.1 Asset-type core

| Action | Target (file:line) | LOC | Net |
|---|---|---|---|
| DELETE | `core/asset/asset-registry.ts` (whole; `:21-100` renderer/action maps) | 100 | −100 |
| DELETE | `asset-spec.ts:326-328` TYPE_DIRS + `:297-320` register/deregister/getAssetTypes + registry/renderer/action body | ~230 of 359 | −230 |
| MOVE | `asset-spec.ts` `SCRIPT_EXTENSIONS` (`:104`, 16 exts), `WORKFLOW_EXTENSIONS` (`:42`), `canonicalizeWorkflowName` (`:55`) → live util home (`core/recognition-util.ts`) | ~30 | 0 |
| DELETE | `asset-spec.ts` `buildTaskAction`/`toPosix` private helpers + 8 actionBuilder closures | — | (in −230) |
| DELETE | `common.ts:29-88` `ASSET_TYPES`/`AkmAssetType`/`ASSET_TYPE_SET`/`isAssetType` block | ~60 | −60 |
| REPLACE | `asset-ref.ts` closed-union `isAssetType` (`:109`), `TYPE_ALIASES` (`:25-27`), vault `UsageError` (`:98-103`) → drop | ~20 | −20 |
| KEEP | `asset-ref.ts` grammar + `makeAssetRef`/`refToString`/`validateName` guards | 120 | 0 |

### 4.2 Config schema

| Action | Target | LOC | Net |
|---|---|---|---|
| DECOMPOSE | `config-schema.ts:311-593` `ImproveProcessConfigSchema` (262-line god-object, ~40 "only meaningful on X" comments) → per-process discriminated schemas | — | −120 |
| DELETE | `:817-835` `ImproveCalibrationSchema` + `:837-852` `ImproveExplorationSchema` (whole default-off subtrees) | 36 | −36 |
| DELETE | `:437-439` homeostaticDemotion archaeology, `:546` `emitAs` reserved-dead, `:686-690` `pushOnCommit` deprecated | 15 | −15 |
| DELETE/OPEN | `:915-926` `GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED` (10 hardcoded, incl stale `wiki`) → source from adapter metadata | 12 | −12 |
| DELETE | `:704,750` + `config-types.ts:115` + `config-sources.ts:93,111` `wikiName` (5 sites) | 8 | −8 |
| RENAME | `:857-860` `outcomeWeightEnabled` comment (falsely says "Default false (parity)"; runtime is default-ON `w_o=0.15`) | 0 | 0 |
| KEEP+MEASURE | `:473-474,484` `mergeInformationFloor` — verified **genuinely advisory** (caller counts + warns, "merge proceeds (v1 observe-only)"); the schema comment is accurate. Joins the §13.2 measurement pass: prove the floor should gate, or delete it with the collapse cluster | 0 | 0 |
| DELETE | `config.ts:250-256` `getImproveProcessConfig` vestigial `_config` param | 1 | −1 |

### 4.3 Index / search / read

| Action | Target | LOC | Net |
|---|---|---|---|
| MINT | `StashEntry` (`metadata.ts:60`) → `IndexDocument` + provenance + pinned query-time signal fields (adapter spec §3); wiki fields `wikiRole`/`pageKind` move to the `llm-wiki` adapter | — | −40 |
| REPLACE | `matchers.ts` global competition + `classifyBySmartMd` (`:181-222`) + `classifyByWiki`/`wikiMatcher` (`:251,296`) → adapter `recognize` | — | −? (adapters) |
| DELETE | `file-context.ts:242-265` `runMatchers` specificity machinery (KEEP renderer registry `:202-229`, `buildFileContext`, lazy caching `:94-116`) | ~25 | −25 |
| REPLACE | `path-resolver.ts:8,28-33` disk-probe `resolveViaDisk`/`buildDiskCandidates` → adapter `placeNew` (KEEP `resolveViaIndex` `:56-63`, symlink containment `:79-81`) | ~30 | −30 |
| REPOINT | `ensure-index.ts:58,88-89` staleness loop (`ASSET_SPECS×TYPE_DIRS×spec.isRelevantFile/stashDir`) → adapter root enumeration | — | 0 |
| REPOINT | `walk/walker.ts:15` `isRelevantAssetFile` → adapter per-file recognition | — | 0 |
| DELETE | `walk/walker.ts:32` `walkStash` + `:21` `DirectoryGroup` (dead in src/, only in `tests/integration/walker.test.ts`) | 45 | −45 |
| REPOINT | `graph-extraction.ts:42,944,1159` bidirectional TYPE_DIRS (`:944` dir-seg→type, `:1159` type→dir) → adapter `directoryList` + includeable-format flag | — | 0 |
| CONSOLIDATE | `indexer.ts:956-977` `persistDirRecords` full-rebuild wipe → shared repo truncation incl `utility_scores_scoped` (fixes B4) | — | −15 |
| CONSOLIDATE | 3 divergent `mergeLegacyEntry` copies (`manifest.ts:167`, `indexer.ts:1727`, `registry/build-index.ts:371`) | — | −30 |
| INLINE | `db.ts:1173` `getEmbeddableEntryCount` (byte-identical to `getEntryCount`; misleading) | 6 | −6 |
| CONSOLIDATE | `db-search.ts:483-530` scored path vs `:607-637` enumerate path → one `applyResultFilters` | — | −40 |
| CONSOLIDATE | `.stash.json` `legacyOverrides` (`metadata.ts:253,279`; applied `indexer.ts:1552`, `manifest.ts:147`, `build-index.ts:360`) → fold to migrator | — | −60 |
| DELETE | `indexer.ts:243` `void config;` + `:414` `void sources;` suppression hacks | 2 | −2 |
| THREAD | `db-search.ts:88/291/767` `rendererRegistry` param + `search-hit-enrichers.ts:10` `getRenderer` → RunContext | — | −15 |

### 4.4 improve / memory / salience

| Action | Target | LOC | Net |
|---|---|---|---|
| DECOMPOSE | `preparation.ts:825` `runImprovePreparationStage` (~1544) → passes | — | −600 |
| DECOMPOSE | `improve.ts:413` `akmImprove` (~943, inline multi-cycle loop) → orchestrator | — | −400 |
| DECOMPOSE | `reflect.ts:939` `akmReflect` (~707) → passes; collapse double disk-read (`:1017-1023` + `:1400-1409`) | — | −400/−30 |
| DECOMPOSE | `distill.ts:678` `akmDistill` (~635) → passes | — | −? |
| DECOMPOSE | `consolidate.ts:1387` `planConsolidation` (~433) + `handleMergeOp:2117` (~298) + `handlePromoteOp:2477` (~215) | — | −300 |
| DECOMPOSE/TRIM | `distill-promotion-policy.ts:650-1491` `DEFAULT_PROMOTION_POLICY_SELECTION` (~840 LOC payload; production reads only `.selectedModel.{name,threshold}`) → keep frozen `{selectedModel}` only; bench recomputes | 840 | −820 |
| DELETE | `loop-stages.ts:117-160,307-331` self-consistency Jaccard majority-vote (D7: self-confidence ≠ authorization) | 120 | −120 |
| DELETE | `improve-auto-accept.ts:77-215` exploration promotion + self-confidence auto-apply gate | 150 | −150 |
| DELETE | `calibration.ts` + `preparation.ts:102-164` `maybeAutoTuneThreshold` (default-off, no field grounding) | 250 | −250 |
| DELETE | `procedural.ts` (procedural-in-core, default-off `#634`, single-project overfit) | 500 | −500 |
| DELETE | `outcome-loop.ts:127-305` `review_pressure` + `migrations.ts:564,570` column+index (wired-but-dead F7) | 60 | −60 |
| DELETE | `feedback-valence.ts` `ValenceScore.lane` (computed, never read) | 25 | −25 |
| DELETE | improve default-off branches: `autoTune` (`improve.ts:497`), dedup (`#617`), judged-state cache (`#581`), hotProbation, schemaSimilarity, proceduralAwareFloor | — | −300 |
| THREAD | `extract.ts:550` `processSession` (19 positional args) → RunContext | — | −10 |
| CONSOLIDATE | 5 copies JSON.stringify-per-value frontmatter serializer (`distill.ts:490`, `recombine.ts:1000`, `content-repair.ts:95/136/159`) → one `serializeFrontmatterQuoted` | — | −40 |
| CONSOLIDATE | `resolveParentRef` (`memory-improve.ts:820` vs `memory-contradiction-detect.ts:135`) + `isDerivedMemory` (name-keyed vs path-keyed, divergent) | — | −40 |
| CONSOLIDATE | `MAX_REJECTED_PROPOSALS` declared twice (`reflect.ts:228`, `distill.ts:905`) | 3 | −3 |
| CONSOLIDATE | `memory-improve.ts:315-328,730-735` raw fs read/parse/write → imported `mutateFrontmatter` (`:9`) | — | −20 |
| RENAME | `improve-result-file.ts:64,86` `relativeImproveResultPath`/`writeImproveResultFile` (writes DB row, name says file) | 0 | 0 |

### 4.5 changes / proposals / wiki / lint / mv

| Action | Target | LOC | Net |
|---|---|---|---|
| CONSOLIDATE | 3 FS journal engines → one FileChange transaction: `repository.ts:1036-1416` proposal-txn + `:1417-1530` reject-txn + `mv-cli.ts:309-541,1020-1120` move-txn (preserve fsync + before-hash) | — | −590/−350 |
| DELETE | `wiki/wiki.ts` (1182 LOC, 40 exports) — command subsystem; keep only broken-xref as base-linter missing-ref fold | 1182 | −1000 |
| DELETE | `wiki/wiki-templates.ts` + `assets/wiki/ingest-workflow-template.md` | 60 | −60 |
| CONSOLIDATE | 9 per-type linters + lint `registry.ts` `LINTER_MAP`/`getLinterForType` + `types.ts AssetLinter` → `runBaseChecks` + adapter `validate(c, changes, ctx)` | — | −250 |
| INLINE | `lint/index.ts:37` `STASH_SUBDIRS` + subdir→linter routing (`:117-189`) | 40 | −40 |
| ADD | Skill adapter `validate`: Agent Skills contract — hard: name 1–64 (`^[a-z0-9]+(-[a-z0-9]+)*$`, == dir name), desc 1–1024, compatibility ≤500, metadata string-map; warnings: body <500 lines, lowercase `skill.md`; per-adapter unknown-field strictness (adapter spec §6) — genuinely new, small | — | +? |
| DECOMPOSE | `repository.ts:2069` `formatUnifiedDiff` / `:2093` `formatNewAssetDiff` | 30 | −30 |
| CONSOLIDATE | `proposal-cli.ts:109-163,213-275` bulk accept/reject loops → `bulkAdjudicateProposals` in `proposal.ts` | 70 | −70 |
| DELETE | `proposal/legacy-import.ts` + `proposals-repository.ts:258-302` + `proposal_fs_imports` table → migrator | 160 | −160 |
| REPLACE | `repository.ts:439,482,487,659` dedup/cooldown machinery — **live guard for 8 of 11 `createProposal` sites** (only the human CLI paths + recombine-promote force-bypass); lands **with** the §23.6 fingerprint scheme in the same chunk, and the per-ref **rejection backoff windows are RETAINED** alongside fingerprints (fingerprints alone re-propose near-identical rewrites the day after a human rejection whenever new evidence lands); fingerprints gain an engine/model-id term so a model upgrade naturally reopens attempts | 120 | −80 |
| DELETE | `repository.ts:874` `recordGateDecision` + `Proposal.gateDecision` + the confidence gate (`runAutoAcceptGate` in `improve-auto-accept.ts` — the drain engine itself is deterministic/non-confidence-gated, `drain.ts:6`, and is KEPT) | 80 | −80 |
| DECOMPOSE | `repository.ts:198` `ProposalPayload` single-content → `FileChange[]` | — | +40 |
| RENAME | `lint/types.ts:15` `dangerous-vault-key` LintIssueType (vault removed 0.9.0) | 0 | 0 |
| THREAD | `write-source.ts:487-501` `resolveAssetFilePath` TYPE_DIRS → adapter `placeNew` (KEEP git exact-path boundary, `sanitizeCommitMessage`, `isWithin`) | — | −15 |
| THREAD | `drain.ts:42`, `propose.ts:19`, `repository.ts:50` TYPE_DIRS importers | — | −20 |
| MOVE | base-linter ref grammar `REF_BOUNDARY_PREFIX_CLASS_SRC`/`REF_SLUG_CHAR_CLASS_SRC` (`:173-174`, consumed by `mv-cli.ts:64-65`) → live util home; REF_RE type-alternation sourced from adapters | — | −20 |

### 4.6 sources / registry / integrations / setup

| Action | Target | LOC | Net |
|---|---|---|---|
| CONSOLIDATE | `caps()` byte-identical across **10** files (9 harness `index.ts` + `opencode-sdk/harness.ts`) + `homeDir()` (`claude/config-import.ts:22`, `opencode/config-import.ts:22`) → BaseHarness/shared | 90/8 | −90 |
| CONSOLIDATE | `git-provider.ensureGitMirror` + `website-ingest.ensureWebsiteMirror` freshness/stale-fallback → `withFreshnessCache({ttlMs,staleMs})` | — | −40 |
| CONSOLIDATE | `claude/session-log.ts` (321) + `opencode/session-log.ts` (435) shared skeleton → `AbstractSessionLogProvider` (format-specific readers kept) | — | −80 |
| CONSOLIDATE | `spawn.ts:107,315-356` SIGTERM→SIGKILL ladder + envelope vs `opencode-sdk/sdk-runner.ts:430-452` | — | −60 |
| DECOMPOSE | `registry/resolve.ts:650-757` inline semver engine → `registry/semver.ts` (unit-testable) | — | 0 |
| DECOMPOSE | `setup/steps/connection.ts` (940; `stepLlm:185`, `stepSmallModelConnection:455`, `stepAgentConnection:733`) → collectInput/probe/deriveConfig | — | −40 |
| DECOMPOSE | `sources/website-ingest.ts` (746; SSRF+normalize+fetch+crawl+HTML→md+FS) → passes | — | −20 |
| FIX | `sources/providers/npm.ts:55` `path()` throws → resolve cache dir lazily like `git-provider.path()` | 0 | 0 |
| FIX | `config-sources.ts:35` `parseSourceSpec` non-exhaustive switch (6 variants) | 0 | 0 |
| THREAD | `sources/resolve.ts:21-110` `resolveAssetPath`/`resolveByCanonicalName` (walkStashFlat+runMatchers fallback) → adapter | 25 | −25 |
| THREAD | `provider-utils.ts:14` `REGISTRY_STASH_DIR_NAMES`, `git-stash.ts:241` pathspecs, `git-provider.ts:198` `hasExtractedRepo` → adapter `directoryList` | — | 0 |
| RENAME | `sources/wiki-fetchers/` (registry.ts, youtube.ts) → `snapshot-fetchers/` (feeds knowledge/website path; NOT wiki) | 0 | 0 |
| THREAD | `commands/env/env-binding.ts:21`, `env-cli.ts`, `secret-cli.ts` `resolveAssetPathFromName` → env/secret adapter `placeNew` | — | 0 |
| REPOINT | `registry/build-index.ts` (StashEntry/generateMetadataFlat/detectStashRoot) — unlisted taxonomy consumer | — | 0 |

### 4.7 storage / DBs / output / health / tasks / cli

| Action | Target | LOC | Net |
|---|---|---|---|
| CONSOLIDATE | `workflows/db.ts` (426) merge into state.db (§8) | 426 | −426 |
| CONSOLIDATE | `storage/locations.ts:32` `workflowDb` + `core/paths.ts` `getWorkflowDbPath` + `migration-backup.ts:113,224,374,472,1140` workflow branches | — | −60 |
| DECOMPOSE | `indexer/db/db.ts` (2063, ~12 domains) → entries/vector/fts/utility/usage repos under storage; invert arrow (`index-db.ts:5`, `registry-cache.ts:6` stop importing openers from indexer) | — | net-neutral (−150 dup) |
| CONSOLIDATE | `storage/repositories/*` (13 repos, no base) → `Repository<Row,Domain>` + `jsonColumn()` codec | — | −120 |
| DECOMPOSE | `output/text/helpers.ts` (1418, 59 fns); extract `formatShowPlain:528` APPLY/workflow agent-directives to structured module | — | −200 |
| DECOMPOSE | `output/renderers.ts` (871) + `workflows/renderer.ts:23-25` (183) type-renderer registry → per-adapter (D12) | — | −250 |
| CONSOLIDATE | `output/shapes.ts` + `shapes/registry.ts` + `text/registry.ts` (3 parallel registries) | — | −150 |
| DECOMPOSE | `commands/health.ts:132` `akmHealth` (~272) | — | net-neutral |
| DECOMPOSE | `health/html-report.ts:401` `buildHealthHtmlReplacements` (file 1058) | — | −200 |
| (DROPPED) | ~~`summarizeImproveCompleted` decompose~~ — already refactored at HEAD (5-line delegate over `summarizeImproveRuns`/`projectRunMetrics`); do not re-churn | — | 0 |
| DECOMPOSE | `health/types.ts` (685 type dump) → per-domain | — | −100 |
| DECOMPOSE | `tasks/runner.ts` (698) | — | −150 |
| CONSOLIDATE | `tasks/backends/{cron,launchd,schtasks}.ts` `*Exec`/`*Fs`/`*Options` boilerplate → `BackendExec<Extra>` + `runOrThrow` (KEEP strategy pattern) | — | −80 |
| CONSOLIDATE | `cli.ts:137,602,652` `resolveHelpMigrateVersionArg`/`findCittyTopLevelCommand`/`parseAllFlagValues` argv re-scanners | — | −60 |
| CONSOLIDATE | duration residue: `consolidate.ts:2825` `parseSinceToIso` shadow + `extract.ts:414` `[mhd]/i` regex + `memory-improve.ts:377` "N days ago" → `core/time.ts` | — | −40 |
| THREAD | ambient reads: `loadConfig` ×90, `resolveStashDir` ×56, `?? loadConfig` 56 sites, 22 `_set*ForTests` → RunContext | — | −250 |
| DECOMPOSE | `standards/resolve-standards-context.ts:20,25,50,73-92` wiki Feature-A branch (KEEP Feature-B, `resolve-stash-standards`, repoint `resolve-type-conventions`) | 45 | −45 |

### 4.8 standards (wiki-death blast radius)

- DELETE `resolve-standards-context.ts` Feature-A: `:20` wiki imports, `:25` `WIKI_INFRA_BASENAMES`, `:50` `extractWikiNameFromRef`, `:73-92` `loadWikiSchema` → collapse to Feature-B path (−45).
- KEEP `resolve-stash-standards.ts`.
- REPOINT `resolve-type-conventions.ts:29,51` `getAssetTypes` + basename validation → adapter type-set / §7.3 provenance pin; wiki drops from any valid-type set.

---

## 5. improve Decomposition Map

Target shape mirrors the already-decomposed `consolidate.ts` (narrow/plan/apply) and the small pure scorers (`computeSalience`, `evaluateCollapseAlerts`).

**Three verbs, one envelope** (revise / learn / **consolidate**; consolidate is the only op that retires source content and carries the bounded memory lifecycle, §6):
- `revise` = reflect. `learn` = extract / distill / inference / recombine / synthesis.
- Each verb emits a single `Proposal { FileChange[] + beforeHash + status }` through one envelope facade.
- All passes read files **only from the run's hash-manifest snapshot** (D6), fixing the reflect double disk-read (`reflect.ts:1017-1023` + `:1400-1409`).

**Decomposition:**

| God fn | Becomes | Passes (named, over `RunContext`) |
|---|---|---|
| `runImprovePreparationStage` (~1544) | orchestrator | snapshot-manifest, candidate-gather, salience-score, valence-score, standards-context, eligibility-filter |
| `akmImprove` (~943) | orchestrator | per-cycle → pass sequence; **same-run multi-cycle deleted** (D7) |
| `akmReflect` (~707) | orchestrator | source-snapshot-read (single), revise-propose, size-gate |
| `akmDistill` (~635) | orchestrator | extract-candidates, promote-policy-apply (frozen `{selectedModel}`), distill-propose |
| `processSession` (19 args) | `RunContext` + `SessionInput` | one context object replaces the positional list |

**Deleted from loop AND config-schema (D7/D9):** self-confidence authorization, exploration promotion (`improve-auto-accept.ts:77-215`), Jaccard self-consistency voting (`loop-stages.ts:117-160,307-331`), confidence/calibration auto-tuning (`calibration.ts`, `improve.ts:497`), procedural-in-core (`procedural.ts`), the P0-A high-retrieval lane (`preparation.ts:1033-1040` — retrieval alone never authorizes rewrite, normative §24.4), same-run multi-cycle (`improve.ts:939` cycle loop; default 1, so default behavior is preserved).

**BEHAVIOR-CHANGE LEDGER (not dead code — reviewed as live changes in the 0.9.0 diff):**
- *Self-consistency voting* is **default-ON** today for refs with utility ≥ 0.7 (no config gate): deletion means 3×→1× reflect LLM calls on the hottest refs. Intended (cheaper, and self-agreement is not verification), but it is a behavior change.
- *The P0-A lane* is today the **only** path by which never-rated assets get improved: post-deletion those assets are reachable only via real corrective evidence. Intended per the evidence rules; listed so the diff review doesn't misread it.
- *Dedup/cooldown → fingerprints* (§4.5): rejection backoff retained; fingerprint gains a model-id term.

**Shared helpers minted (net-add ≈+500 total, dwarfed by deletions):** envelope facade, `RunContext`, `serializeFrontmatterQuoted`, single `resolveParentRef`/`isDerivedMemory`.

---

## 6. Memory Lifecycle (0.9.0 scope — engine refactored, state model built)

Per DEV-4 and normative §25 (as amended): the consolidation **engine** is a refactor of the existing ~6,200-LOC consolidate/dedup/memory-improve cluster; the lifecycle **state model** is new construction around it, budgeted in §12.1. Three verbs — `revise` / `learn` / `consolidate` — with `consolidate` the only op that may retire source content; its formalize path is implemented **as an internal learn-recipe invocation plus a retirement transaction** (cleanest factoring of DEV-5).

**Ships in 0.9.0 (Chunk 7.5):**
- **Operational retirement records in state.db** — `retired`/`quarantined` markers with grace timestamps, a restore command, and holds — layered on the existing `archiveMemory` move. Operational state is distinct from semantic status (`superseded` frontmatter stays semantic metadata; normative §25.2/D22).
- **Deterministic auto-retirement tier** (normative §25.9 rows 1–4): byte-identical duplicates, deterministic-equivalent content, explicit supersession with valid successor, TTL-expired ephemerals — unifying `dedup.ts`, the memory-improve LOOK/CHANGE cleanup, and TTL policy.
- **Item/byte pressure + health**: high/low-water computation, health reporting, and blocked-intake **SKIP-with-warning** (no new queue tier — sessions remain the durable evidence store and re-extraction picks up when pressure clears; normative §25.4 as amended).
- **All semantic retirement proposal-gated**: merge-with-retirement and formalize-then-retire queue as proposals; human approval is the disposition authority (normative §25.6 reviewed mode). **Unattended semantic retirement is OFF** until the claim extractor exists and passes its benchmark (0.9.1).
- **FTS-only sandbox replay as the advisory retirement gate**: snapshot + candidate-overlay temp index, replay canaries + logged per-source queries with successor-following, reusing `scoreCanary`/rank-metrics (~800–1,500 LOC of glue). The sandbox is built from the run snapshot + candidate FileChanges only — never the live index (D19).
- **One archive encoding** (D27): the workspace content-addressed store (`$DATA/archive/blobs/sha256/<digest>`, owner-only modes) is the target; the bundle-local `archiveMemory` move is the bounded stopgap only until it lands in this same chunk. There are never two coexisting retirement encodings.
- The LLM-directed hard ops (`handleMergeOp` `consolidate.ts:2117`, `handleDeleteOp` `:2416`, `handleContradictOp` `:2693`, `handlePromoteOp` `:2477`) route through the retirement transaction + archive — never a bare file delete.
- **Grace/purge live outside the improve run**: a deterministic lifecycle sweep at improve-run start plus an explicit `akm memory purge` command (normative §24.6/§25.5 placement rules).

**Deferred to 0.9.1+ (each with its trigger):** claim extraction + its benchmark (then unattended retirement can turn on); full rank-parity sandbox replay (after the §13.2 ranking ablations); cross-bundle two-phase (when a second-bundle consumer exists); read-only retirement overlay (when read-only installed memory components exist); purge automation + legal holds (manual purge first); quarantine automation (manual `akm memory quarantine` ships as the stopgap).

**Preserve:** the transactional discipline (`writeJournal`/`checkForIncompleteJournal`/`cleanupJournal`, backup/recovery); the LOOK/CHANGE separation and signal-delta corrective-evidence gate (2026-05-26 synchronized-wave fix); no lossy in-place reconsolidation (raw assets + additive distill + no-op gate + git history); the hot-capture guard; **the canary probe + `canary_queries` store** (this gate's harness — carved out of the §13.2 measurement pass). `resolveParentRef`/`isDerivedMemory` divergence (name-keyed vs path-keyed) collapses to one keyed-on-ref impl so the contradiction-edge producer/consumer cannot disagree.

---

## 7. Index / Search / Read / Changes Sweep

### 7.1 Normalized model
One `IndexDocument` (renamed `StashEntry` + typed provenance + pinned signal fields, §2.2). `validateStashEntry` (`metadata.ts:292,296`) relaxes from the closed `isAssetType` gate to an open-token check (Chunk 1.5); its ordering-dependency doc-comment (`:287-291`) is deleted.

### 7.2 Recognition/placement/renderer are adapter-owned
`matchers.ts` + `file-context` specificity + `path-resolver` disk-probe + `walker.walkStash` gone. `ensure-index` staleness and `graph-extraction` type↔dir maps read adapter directory metadata (bidirectional: `:944` dir→type, `:1159` type→dir, plus include-flag). `resolveViaIndex(lookup)` and symlink containment survive.

### 7.3 Provenance-type string-set pin (DoD contract test)
The deleted closed union is replaced by a lint/test pinning the open provenance-type set, sourced from adapter metadata. It must cover every consumer that parsed the closed list:
- `db-search.ts:320` `parseRefPrefixQuery(query, getAssetTypes())` — retargeted to the new anchored ref grammar (normative §11.1): prefix queries key on `bundle//` and known-`type` filter tokens, not the dead type-alternation.
- `base-linter` `REF_RE` — rebuilt on the anchored body-ref grammar (fully-qualified `bundle//conceptId`; bundle slug excludes `:`/`.`/`#`), which is what keeps lint missing-ref and `akm mv` xref-rewriting safe post-drop-ref.
- `ranking-contributors.ts:11` `TYPE_BOOST`, `salience.ts:135` `DEFAULT_TYPE_ENCODING_WEIGHTS`, `config-schema.ts:915-926` graph-include list (also fixing the runtime SUPPORTED-set/`fact` desync), website-ingest `'website'`/`'knowledge'` stamping (`:180,385`).
- **Shipped assets and hints**: the same lint greps `src/assets/hints/*`, `src/assets/help/*`, `scripts/akm-asset/*`, and `scripts/akm-eval/cases/*` for the dead `type:name` grammar — agent-facing strings must migrate in the same chunk as the CLI change (§16).

### 7.4 Read path wiki removal
`show.ts:428-432` `forcedWikiMatch` (keyed on `source.wikiName`) + `search-source.ts:29,63,75,88,113,119` `SearchSource.wikiName` + `db-search.ts:94,101` + `metadata.ts:684` + `indexer.ts:836` deleted with the wiki *asset-type* death (Chunk 4). Wiki pages stay first-class under the restored `llm-wiki` adapter (DEV-7): `searchInWiki` (`wiki.ts:713`) retargets the adapter's component filter (`--adapter llm-wiki` / component provenance), not a `knowledge` re-stamp.

### 7.5 db.ts decomposition + arrow inversion
`db.ts` (2063) splits into table repositories under `storage/repositories/`; the storage→indexer opener imports (`index-db.ts:5`, `registry-cache.ts:6`) invert to indexer→storage. Routine component persistence is the **diff persist** (adapter spec §4 — upsert-by-ref, row ids preserved); only the explicit `--full` rebuild performs the global wipe, which becomes one shared truncation including `utility_scores_scoped` (B4) with the usage-event detach-and-relink behavior kept. **Preserve** FK pre-flight guard (`db.ts:847`), vec-table transaction (`:858-864`), incremental FTS dirty-queue (`:774`), per-row corrupt-JSON skip-with-warn (do NOT reintroduce silent swallow), `deleteRelatedRows` cascade completeness (`:650-738`).

---

## 8. Activation & Runtime + Three-DB Model

### 8.1 Three DBs (merge workflow.db in)
Today FOUR DBs: index.db, state.db, workflow.db (in `storage/locations.ts:27-46`) and logs.db (path in `core/logs-db.ts:60` — outside the locations facade, a fold-in for the sweep). Target THREE:

- **state.db** (durable): events, proposals, task_history, improve_runs, extract_sessions, **+ migrated workflow_runs/steps/units, + migrated usage_events (rescued from index.db, §3.2), + the new `bindings` and memory-lifecycle retirement tables**.
- **index.db** (fully regenerable search cache — true only after the usage_events rescue).
- **logs.db** (high-volume purgeable) — **KEEP SEPARATE** (`#579`, `docs/technical/logs-audit.md`), joined via ATTACH.

### 8.2 workflow.db → state.db merge mechanics

1. The cutover DDL `CREATE TABLE`s `workflow_runs`/`workflow_run_steps`/`workflow_run_units` at FINAL shape (fold the 10 `WORKFLOW_MIGRATIONS` bodies `workflows/db.ts:178-368` into one baseline DDL) — plus the new `bindings` table and the migrated `usage_events` (§3.2) — inside the §3.3 journaled cutover (exact ATTACH sequencing in §3.3 item 3).
2. `bootstrapPreVersioningDb` (`workflows/db.ts:398`) dies (0.7-era, irrelevant post-cutover).
3. Journaled deletion of the physical workflow.db + sidecars (§3.3 item 6).

**Blast radius (corrected):** the runtime gateway is `withWorkflowRunsRepo` (`workflow-runs-repository.ts:650`); its `WorkflowRunsRepository(db)` constructor (`:220`) takes an **injected** Database and owns all table-scoped SQL — re-pointing to `withStateDb` requires **zero SQL rewrite**. But there are **two more direct workflow.db openers** outside it: `core/migration-backup.ts:638` (`activeWorkflowClaims` — gates artifact replacement by reading leases) and `cli/config-migrate.ts:643`. Re-point: `workflows/exec/brief.ts`, `workflows/exec/watch.ts`, `cli/config-migrate.ts` (`runWorkflowMigrations`), and `activeWorkflowClaims` (reads state.db post-merge; retains the workflow.db probe for pre-cutover generations). Delete `workflows/db.ts`, `getWorkflowDbPath`, `StorageLocations.workflowDb` — but `WORKFLOW_MIGRATIONS` survives as the **frozen ids+checksums copy in `src/migrate/legacy/`** (§3.3 item 1) so pre-cutover backups remain verifiable/restorable; the migration-backup manifest/journal format bumps with backward-read of the three-artifact shape. This chunk is several hundred LOC of careful coordination rework, not net −500 (§12.1 ledger updated).

### 8.3 Preserve
Shared migration engine (append-only ledger, SHA-256 body sealing, transaction-per-migration, ordered-prefix assertion); `applyStandardPragmas` (30s busy_timeout, FK); maintenance-barrier/migration-operation guards; backup-verified-restorable fail-closed path; `core/events.ts` `EventsContext` DI (the exemplar RunContext copies); workflow frozen-plan integrity (plan_json/plan_hash migration 006), per-unit claim/lease/heartbeat (008/009).

---

## 9. Salience / Feedback / Ranking

### 9.1 Kept intact
Salience 3-vector model + `asset_salience`/`asset_outcome` tables + `upsertAssetSalience` CASE non-lowering guard (`salience.ts:442-455`) + `isContentEncodingRow` provenance heuristic (`:408`); `computeSalience`, `computeValenceScore`, `evaluateCollapseAlerts` (the decomposition-target shape); `DEFAULT_TYPE_ENCODING_WEIGHTS` table; deterministic ranking/bm25 column weights + curate-golden nDCG/MRR harness.

### 9.2 Dead-lane deletions NOW
- `review_pressure`: `outcome-loop.ts:127-305` compute/decay/return + `migrations.ts:564,570` column+index. `updateAssetOutcome` is called only at `preparation.ts:1630` which reads **only** `result.outcomeScore`; no consumer reads `.reviewPressure`. (−60)
- `ValenceScore.lane`: computed, never read (only `.valence`/`.attention` consumed). (−25)

### 9.3 Parity-flip DEFERRED (reconciled with saturation finding)
The salience **outcome weight is LIVE-but-unproven** (`w_o=0.15` applied by default), not inert — corrected premise D10. There is **no single config default to flip**: `outcomeWeightEnabled` (`config-schema.ts:861`) has **no `.default()`**; the runtime default lives in the read expression `!== false` at **3 sites**: `distill.ts:749`, `salience.ts:356`, `preparation.ts:1728`. The parity flip requires **~4 edits**, not one line:
1. Change the `!== false` reads to `=== true` (or add `.default(false)` and honor it) at all 3 sites.
2. Correct the `config-schema.ts:857-860` comment (currently falsely "Default false (parity)").
Machinery (weight-selection block, tables, CASE guards, `isContentEncodingRow`) is **kept untouched** under this reversible flag. The flip is **deferred** (parity-first), not a deletion — reconciled with the saturation-harness finding that keeps the table proven-neutral rather than dropping it. The parity flip and the whole outcome-loop / encoding-salience / scoped-utility apparatus resolve **together** in the **0.9.1 measurement pass** (§13.2): one nDCG/MRR + saturation-harness run at `w_o=0` decides keep-or-delete for the entire cluster at once, rather than litigating each contributor in 0.9.0.

### 9.4 Wave-1 type-only severs (this area)
`salience.ts:52` (`import type AkmAssetType`), `:650` cast; `eligibility.ts:9` import, `:39` scope validation → open-token, `:169`/`:477` casts. All string-keyed underneath; severance is type-only.

---

## 10. Cross-Cutting Debt Clean-Up

### 10.1 Ambient-config threading (D2/A2)
`loadConfig` ×90, `resolveStashDir` ×56, `?? loadConfig|resolveStashDir|getDbPath` 56 sites, 22 `_set*ForTests` seams. Thread a `RunContext` from the CLI boundary; no ambient reads in leaves; retire test seams as call sites convert. (−250). Exemplar: `core/events.ts` `EventsContext`.

### 10.2 Config over-engineering
252 `.optional()` / 3 `.default()` / 1415 LOC → per-process discriminated schemas with real `.default()`s; drop reserved/advisory/observe-only knobs (§4.2). `mergeInformationFloor` is NOT purely advisory (live gate `anti-collapse.ts:143`) — deleting its schema changes behavior; only the misleading comment is fixed, the field stays.

### 10.3 DRY consolidations
Frontmatter serializer (5→1), `resolveParentRef`/`isDerivedMemory` (2→1 each), `mergeLegacyEntry` (3→1), `caps()`/`homeDir()` (9→1), mirror-freshness (2→1), session-log skeleton, spawn ladder, semver engine extraction, duration residue → `core/time.ts`.

### 10.4 Concrete defects
- `--since` parser (B1 headline already fixed): remove residual `consolidate.ts:2825` shadow (returns input unchanged vs canonical throw), `extract.ts:414` `[mhd]/i` (reintroduces m-ambiguity), `memory-improve.ts:377`.
- `indexer.ts:956-977` full-rebuild wipe missing `utility_scores_scoped` (B4).
- `npm.ts:55` `path()` throws (interface violation).
- `config-sources.ts:35` non-exhaustive `parseSourceSpec` switch.

### 10.5 Dead / unwired
`walker.walkStash`, `review_pressure`, `ValenceScore.lane`, `improve-auto-accept` exploration, `calibration`, `procedural`, dedup/cooldown/gate, legacy-import, `void config;`/`void sources;`, calibration/exploration schema subtrees.

### 10.6 Misleading names
`getEmbeddableEntryCount` (a delegating alias — inline it), `improve-result-file.ts` (writes DB row), `dangerous-vault-key` LintIssueType, `sources/wiki-fetchers/`, `outcomeWeightEnabled` comment, `formatShowPlain` (embeds policy), stale `database.ts:14` "not CI-tested" comment, the 7 P2 result-extractor "NOT registered anywhere" headers, `builder-shared.ts:52` "schema unconsumed" (8 builders consume it).

### 10.7 Additional cross-cutting workstreams (review pass)

- **Import-cycle elimination + CI gate.** 62 circular import cycles at HEAD with real layering inversions: `core/improve-types.ts` imports `commands/improve/*`; `core/config` imports `integrations/agent/engine-resolution`; `core/common.ts` chains through asset-registry → output/renderers → commands/env; `harnesses/index.ts`'s "dependency-graph LEAF" claim is false; tasks/backends barrel self-cycles. Fix: move improve result types down into core; split config↔engine-resolution; make the harness-registry leaf claim true; the taxonomy deletion (Chunk 3) kills the asset-registry subset. **Gate:** a dependency-cruiser/madge CI rule — cycle count 62 → 0, no upward edges — so Chunks 1–6 cannot re-introduce cycles. (Chunk 9; ~1–2 days, mostly type moves)
- **Single argv parse.** ~30 raw `process.argv` reads + a startup `process.argv` mutation bypass citty (repeated flags, `no-` booleans, `--` passthrough, double-reads). Normalize argv exactly once at entry into a typed ParsedInvocation, pass it down with RunContext; lint-restrict `process.argv` to `src/cli.ts`. (Chunk 9; −150 to −250)
- **`appendEvent` context adoption.** The DI fast path the plan cites as the RunContext exemplar has **zero** production adopters — all ~85 event sites double-open state.db (throwaway preflight + ledger assert) per event, heaviest inside improve loop stages. RunContext carries the open state.db handle; `appendEvent` consumes it; a test asserts hot paths never hit the slow path (~170 redundant opens per improve cycle removed). (Chunks 7/9)
- **Typed-error sweep.** 204 raw `throw new Error(` beside the AkmError/JSON-envelope contract (79 user-facing in commands/) + 6 out-of-hierarchy Error subclasses → UsageError/NotFoundError/ConfigError (or mapped) with stable codes. Mechanical, folds into per-directory chunks. (Chunk 9)
- **`llm/structured-call.ts` decision.** The "centralizes ~20 call sites" seam has 1 adopter; ten files still call `chatCompletion` raw. Finish the migration in the files Chunk 7 already rewrites (preferred, −100 to −200) or delete the seam. (Chunk 7)
- **Workflow driver god-fns (corrects §13.4's "no god-fn treatment needed"):** `exec/report.ts` hides a 438-line `reportWorkflowUnitWithBarrier` (file 1,798 LOC / 3 exports) and `native-executor.ts` a 212-line `executeStepPlan`; `step-work.ts` is genuinely decomposed. Split report's barrier fn into its own header's five named phases, in the same PR as W2's finalize-lock split (both edit report.ts). (Chunk 8; −250 to −350 inline complexity)
- **Opportunistic:** `setup.ts`'s 205-line `runSetupWizard` + four near-identical non-interactive entry points — decompose only if setup is touched for adapter-era onboarding.

---

## 11. Single-Track Execution Order

In-branch chunks. Each chunk: deletion ledger, local green gate (`typecheck + unit + affected integration` **+ the §15 safety suites green at every chunk boundary**), net-LOC-removed asserted, and its named §15 test bucket landed in the same chunk. **Chunk 0 golden capture must re-anchor drifted lines** (`classifyBySmartMd` is at `matchers.ts:181`, not `:197`; re-measure config-schema before sizing). **The adapter-contract and identity fixes are already folded into the specs (adapter spec §§1–4 as amended); Chunk 2 mints adapters against the amended contract only.**

**Chunk 0 — Golden capture & oracles.** Snapshot recognition/placement/renderer/lint outputs for all 14 formats; capture `deriveCanonicalAssetNameFromStashRoot` minting oracle (`mv-cli.ts:769,1266`); re-anchor all line numbers at HEAD; capture **filter-behavior goldens** (proposed/belief/scope result sets) and whyMatched alongside rank metrics; build the **orphan-bearing migration fixture** (deleted-asset salience rows, bare refs, `.derived` twins) and the **rc-train FROM-state fixture**; inventory the §15 golden/characterization assets with their frozen-vs-re-baseline designation. Gate: golden fixtures committed. Net: 0.

**Chunk 1 — Adapter base + util home.** Introduce the amended `BundleAdapter` interface (recognize-required/index-optional, `ValidateContext`, `affectedItems`) + the core `scanComponent` walk; relocate `SCRIPT_EXTENSIONS`/`WORKFLOW_EXTENSIONS`/`canonicalizeWorkflowName` + ref grammar constants to `core/recognition-util.ts`. Frozen COPY of the full legacy resolver surface into `migrate/legacy/legacy-layout.ts` (§3.4). Net: ~0.

**Chunk 1.5 — Open the type token (Wave-1 type-only severs).** `common.ts:29-88` union block, `salience.ts:52/650`, `eligibility.ts:9/39/169/477`, `mv-cli.ts:51,145,154,743`, `asset-ref.ts:109`. Relax `validateStashEntry` to open-token. Gate: grep `AkmAssetType` → **0**. Net: −80.

**Chunk 2 — Per-format adapters (10 adapters covering the 14 formats).** Each stamps recognize / placeNew / directoryList / presentation-table entries / `validate` locally (incl. the 6 static-only renderer mappings; the 9 index-time metadata contributors move into `recognize`). Adapters are minted against the amended contract only (recognize-required, `ValidateContext`, `affectedItems`, ordered `looksLikeRoot` probes). Skill adapter gains the Agent Skills contract (§4.5). Untrusted-content presentation clamp + trusted labeling land here with the presentation table. Net: adapters ≈ net-zero-to-negative (replace deleted globals).

**Chunk 3 — Delete taxonomy globals.** `asset-registry.ts`, `asset-spec` registry/renderer/action, `matchers.ts` competition, `file-context:242-265`, `path-resolver` disk-probe, `LINTER_MAP`+9 linters, `output/renderers.ts` type-registry. Repoint graph-extraction/ensure-index/walker/write-source/sources-resolve/provider-utils/git-stash/build-index to adapter metadata. Gate: grep `TYPE_DIRS` → **0**, `resolveAssetPathFromName` → **0**, `runMatchers` → **0**. Net: ~−1000+.

**Chunk 4 — Wiki asset-type death; LLM Wiki *adapter* restored.** The `wiki` *asset-type* dies (delete the type token, `wikiName` config special-case at 5 sites + indexer/search + read path `show.ts:428-432` + `SearchSource.wikiName`; rename `wiki-fetchers/`→`snapshot-fetchers/` keeping youtube/website; collapse `resolve-standards-context` Feature-A). But the **LLM Wiki adapter is a first-class built-in** (DEV-7): relocate the native wiki semantics from `wiki/wiki.ts`/`wiki-templates.ts` into an `llm-wiki` adapter that owns `schema.md`/`index.md`/`log.md`/`raw/`/`pages/`/xrefs/citations/ingest + validation — do **not** fold wiki pages into `knowledge`. Gate: grep `wikiName` → **0**; `wiki` type token → **0**; `llm-wiki` adapter conformance tests green. Net: smaller than the prior −1300 (adapter retained, not deleted).

**Chunk 5 — IndexDocument + db.ts split.** Rename `StashEntry`→`IndexDocument` + provenance + pinned signal columns (adapter spec §3); **schema-column migration** (`entry_key/stash_dir/entry_type/entry_json` → the new column set) with utility/usage re-keyed onto `item_ref`; **diff persistence** (upsert-by-ref, drain-before-transaction, zero-document preflight — adapter spec §4) replaces truncate paths; split `db.ts` into storage repos + `jsonColumn()` helper; invert storage↔indexer arrow; unify scored/enumerate filter path; L0/L1/L2 derived index artifacts (cards/outlines per normative §15.2); `item_links` table + consumers; fold `.stash.json` legacyOverrides + `mergeLegacyEntry` → migrator. Gate: grep `StashEntry` → **0**, `.stash.json`/`loadStashFile` → **0**; §12.3 parity gate green incl. filter parity. Net: ~−320 (before L0/L1/L2 adds).

**Chunk 6 — Proposal → FileChange[] + one transaction.** Collapse 3 FS journal engines into one FileChange transaction (preserve fsync + before-hash); `Proposal{changes:FileChange[]}`; dedup/cooldown → **fingerprints (with model-id term) + retained rejection backoff** in this same chunk (§4.5); delete the confidence gate; `bulkAdjudicateProposals`; export `#fragment` refs; legacy-import → migrator. Gate: grep `parseAssetRef` → **0**; journal dirs removed. Net: ~−850.

**Chunk 6.5 — Bindings/activation (Tier A — install≠activate consolidation).** Consolidate today's scattered install≠activation enforcement — the `registryId` first-party/third-party block-vs-warn (`env-binding.ts:110-121`), the add-time dangerous-key scan (`add-cli.ts:55`), task `enabled:` state, and `writable` (`search-source.ts:28`) — into ONE workspace activation-policy point, and confirm-by-test that installing a bundle with tasks/env/workflows grants nothing until an explicit enable. Keep the untrusted read-path clamp (Chunk 2/5 presentation + trusted labeling, mapping the dangerous-key block/warn asymmetry onto `BundleInstallation.trusted`, normative §28.2) as the security value. **env/secret handling is UNCHANGED** — they stay whole-file assets inside stashes/bundles (`<stash>/env/`, `<stash>/secrets/`) resolved from the stash, with the existing `registryId` policy; nothing moves workspace-side. **DEFERRED to Tier B** (until a real untrusted-bundle-ships-a-runnable-export consumer exists): the persisted `workspace_bindings` record, export digests + update-change detection (normative §18.5), rebind-on-update, and the `akm bind|unbind|bindings` CLI — no current safety property depends on them (install≠activation already holds; no digest/approval record exists today). Net: **+200 to +400** (consolidation, not the +1,300–1,800 full record; budgeted, §12.1). *(2026-07-13 refinement — supersedes the earlier "restore bindings full, DEV-3.")*

**Chunk 7 — improve decomposition + dead-lane deletions.** Decompose the 4 god fns + consolidate ops; three-verb envelope (`revise`/`learn`/`consolidate`); delete self-consistency/exploration/calibration/procedural/autotune/review_pressure/ValenceScore.lane/P0-A/multi-cycle **with the §5 behavior-change ledger attached**; trim promotion-policy literal; RunContext into `processSession` + `appendEvent` ctx adoption (§10.7); finish-or-delete `structured-call` (§10.7); serializer/resolveParentRef consolidation. Net: ~−3900.

**Chunk 7.5 — Memory lifecycle state model (restored, DEV-4; scope per §6).** Retirement records + grace + restore + holds; deterministic auto-retirement tier; pressure/health + intake SKIP-with-warning; proposal-gated semantic retirement (unattended OFF); FTS-only sandbox replay gate reusing `scoreCanary`/rank-metrics; workspace CAS archive (owner-only) as the single encoding; `akm memory purge`/`quarantine` commands; lifecycle sweep at improve-run start. Net: **+2,500 to +3,000** (budgeted, §12.1).

**Chunk 8 — Three-DB merge + migration cutover + config/lockfile.** The §3.3 journaled cutover (workflow DDL fold + bindings DDL + usage_events rescue + full re-key + orphan quarantine + ATTACH sequence); delete `workflows/db.ts` + workflowDb locations/paths (frozen WORKFLOW_MIGRATIONS copy retained, §8.2); index.db quarantine-rename + out-of-gate rebuild; **config migration** `stashDir`/`sources[]`/`installed[]`/`wikiName` → `bundles`/`defaultBundle`/`bindings` map + **bundle lock state** (normative §10.2; supersedes the per-source `integrations/lockfile.ts` shape); report.ts barrier-fn decomposition with the W2 finalize-lock split (§10.7). Throwaway migrator `@removeIn` next-minor. Gate: 4→3 DBs; backup-verified restore green **including a pre-cutover backup restored by the post-cutover binary**; orphan fixture completes-with-quarantine; rc-train FROM-state fixture green. Net: ~−200 (coordination rework priced in).

**Chunk 9 — Cross-cutting sweep.** Ambient RunContext threading (retire the 18 `_set*ForTests` seams); config discriminated schemas + reserved-knob deletion; output helpers/shape-registry dedup; health/tasks god decomposition; cli argv normalization to one ParsedInvocation (§10.7) + duration residue + caps(×10)/homeDir/mirror/session-log/spawn/semver/connection dedup; npm.path() + parseSourceSpec fixes; typed-error sweep (§10.7); import-cycle workstream + madge CI gate 62→0 (§10.7); delete stale `database.ts:14` comment + add Node 24 to node-smoke/release-gates matrices. Gate: grep `resolveStashDir` residual only in RunContext builder; cycle count 0. Net: ~−2000.

**Chunk 10 — Contract-surface + docs/assets sweep (§16).** STABILITY.md/roadmap/AGENTS.md ref-contract rewrite (decision D28); CHANGELOG normalization + the one true 0.9.0 migration note; `docs/migration/v0.8-to-v0.9.md` + `release-notes/0.9.0.md` rewritten to this refactor's story; stash-skeleton conventions → adapters + stamped-copy refresh decision; improve-strategy `allowedTypes` schema + shipped JSONs + user-file migration; published `schemas/` regen + remove `schemas/**` from ci paths-ignore; docs three-tier sweep (rewrite ref.md/concepts/cli/classification/architecture/features; archive superseded plans; posts untouched); embedded assets (hints/help/akm-asset/akm-eval cases) migrated with the §7.3 shipped-assets lint; scripts/ into biome+tsc; `check:changed` fixed; `noExplicitAny`→error (16 sites) + evaluate `noUncheckedIndexedAccess`; example-stash re-laid out; CLI convergence per normative §29 (bundle family lands with Chunk 6.5; the `akm bind|unbind|bindings` subcommands are Tier B, deferred; `wiki`/`manifest`/`curate`/`propose <type>` folds land with the chunks that delete them). Net: docs/assets, LOC-neutral in src.

**Zero-count grep gates (scope: `src/` + `scripts/` + `src/assets/`; tests are driven to zero by the §15 ratchet on the same identifiers; docs by the Chunk 10 sweep):** `TYPE_DIRS`, `AkmAssetType`, `parseAssetRef`, `wikiName`, `StashEntry`, `resolveStashDir` (outside RunContext builder), `.stash.json`, `getAssetTypes`, `ASSET_SPECS`, `LINTER_MAP`.

---

## 12. Net-Simplification Ledger, DoD, Contract Tests, Risks

### 12.1 Net-simplification ledger (by area)

| Area | Net LOC |
|---|---|
| Asset-type core + config + standards | −550 to −700 |
| index/search/read/changes | −320 (pre-adapter recognition) |
| improve/memory/salience (deletions) | −3900 |
| changes/proposals/wiki/lint/mv | −2,600 (wiki adapter retained, not deleted; dedup replacement −80 not −120) |
| sources/registry/integrations/setup | −400 to −450 |
| workflows/storage/DBs/output/health/tasks/cli | −2,200 (Chunk 8 coordination rework priced in; summarize row dropped) |
| Residual confident deletions folded in (§13.1) | −≈4,300 (+ 1 MB echarts asset via CDN; HTML report kept) |
| **Deletions subtotal** | **≈ −13,000 to −15,000** |
| Adapters + RunContext + shared helpers (adds) | +≈600 |
| **Bindings/activation — Tier A consolidation (Chunk 6.5; persisted record + CLI deferred to Tier B)** | **+200 to +400** |
| **Memory-lifecycle state model (restored, DEV-4 — Chunk 7.5)** | **+2,500 to +3,000** |
| Progressive disclosure L0/L1/L2 artifacts + `#fragment` + `item_links` | +500 to +900 |
| **Adds subtotal (budgeted)** | **≈ +3,900 to +4,900** |
| **TOTAL (0.9.0, src)** | **≈ −8,100 to −11,100 net removed (+1 MB asset dropped)** |
| Test churn (ledgered separately, §15; not counted in the src target) | ~15 files deleted / ~150 codemodded / ~40–60 rewritten / ~10 goldens re-baselined + new §31 suites |
| 0.9.1 measurement-pass prove-or-delete tier (§13.2) | up to a further −6,000 to −12,000 |

### 12.2 Definition of Done

1. All zero-count grep gates pass at their declared scopes (§11).
2. 4→3 DBs; cutover journaled and fail-closed per §3.3; backup-verified restore green **including pre-cutover backups restored by the post-cutover binary**; orphan fixture completes-with-quarantine; throwaway migrator `@removeIn` next-minor.
3. Every format handled by one adapter; no type-competition matcher/renderer/action/linter registry remains (the named-function renderer module and `TYPE_PRESENTATION` table are the replacement, not a violation).
4. `Proposal` carries `FileChange[]`; one transaction applies all mutation (proposal/revert/mv).
5. improve = **three verbs** (`revise`/`learn`/`consolidate`) over passes; no god fn >~200 LOC in improve.
6. Salience machinery intact; dead lanes (review_pressure, ValenceScore.lane) gone; outcome-weight under reversible parity flag; behavior-change ledger (§5) reviewed.
7. Ambient `loadConfig`/`resolveStashDir` gone from leaves; RunContext threaded; `appendEvent` fast path adopted on hot loops.
8. Net src LOC removed > added per the §12.1 ledger (≥ −7,000), with the restored-subsystem adds reported as their own signed line.
9. All preserve-list infra (S26 + canary probe/store) present and exercised by a test.
10. **Bindings (Tier A):** install≠activate — installing a bundle with tasks/env/workflows grants nothing until an explicit enable, verified by test, with the enforcement consolidated to one workspace policy point; env/secret handling unchanged. (The persisted binding record + export-digest re-approval + `akm bind` CLI are Tier B, deferred — §13.3.)
11. **Memory lifecycle:** high-water triggers deterministic cleanup then proposal-gated consolidation; blocked intake skips with a health warning; unattended semantic retirement is off; retirement is restorable within grace.
12. **Trust:** untrusted installations are labeled in search/show and carry no executable-flavored actions; a stray `.env` outside a sensitivity-governed component never gets its body indexed.
13. Import-cycle count is 0 with the CI gate armed.
14. Docs/assets/schemas surfaces migrated (Chunk 10): no shipped asset, hint, published schema, or normative doc teaches the dead grammar.

### 12.3 Architecture contract tests

- **Ref/type pin** (§7.3): anchored body-ref grammar resolves in lint/mv/search-prefix; presentation/ranking type tables + shipped-assets lint agree on the known-type spelling set.
- **Golden recognition/placement/renderer/lint** parity for all 14 formats (Chunk 0 fixtures) — plus `index() == fold(recognize)` conformance for adapters overriding `index()`, and per-adapter `looksLikeRoot` fires on its own golden root and no sibling's.
- **Search parity gate**: nDCG/MRR/recall/banned-hit **+ filter-behavior parity (proposed/belief/scope) + whyMatched parity**; canary re-mint as a named step.
- **Canonical-name minting** oracle parity (`deriveCanonicalAssetNameFromStashRoot`).
- **git exact-path staging** still scopes to adapter `directoryList()` (not nothing-staged).
- **Migration round-trip**: rc-train fixture DB → cutover → all live refs re-keyed, expected orphans quarantined (not aborted), restore-on-fault green, pre-cutover backup verifiable post-cutover.
- **One transaction**: mid-apply fault leaves no partial write (before-hash abort).
- **Install≠activate** (DoD 10, Tier A): install grants nothing; an explicit enable grants exactly what was approved. (Digest-change-forces-re-review is a Tier-B test, deferred with the persisted record.)
- **Memory lifecycle** (DoD 11): water-mark trigger order; claim-coverage-blocks-unattended-retirement; sandbox replay non-regression; restore-within-grace.
- **Trust clamp** (DoD 12): `type: script` in an untrusted okf bundle renders the generic action; untrusted env export with `LD_PRELOAD` hard-errors; stray `.env` body never indexed.

### 12.4 Risks & mitigations

- **git-stash pathspec silent degrade** — a preserved S26 feature (`git-stash.ts:241`) is built from dying `Object.values(TYPE_DIRS)`; if the adapter `directoryList()` is not wired, `git add -- <pathspecs>` scopes to nothing and commits skip. Mitigation: contract test in 12.3; wire before Chunk 3 lands.
- **Install-time recognition underweighted** — `provider-utils.detectStashRoot` (`:33-197`) and `git-provider.hasExtractedRepo` (`:188-202`) are second recognition sites; `akm add` fails to detect a valid bundle root if only the index path is repointed. Mitigation: thread adapter directory-list into both.
- **website snapshot machinery mis-deleted with wiki** — `fetchWebsiteMarkdownSnapshot`/youtube feed the knowledge path, not wiki. Mitigation: rename-not-delete `wiki-fetchers/`.
- **Migration boundary faults** — the cutover's non-atomic edges are filesystem operations (workflow.db delete, index.db quarantine-rename), not the SQL transaction. Mitigation: the §3.3 journaled phases; index rebuild outside the fail-closed gate; ATTACH sequencing as specified (verified empirically on the actual runtime).
- **Parity-flip premise** — outcome weight is default-ON, not inert; a naive "flip the config default" is a no-op (no `.default()` exists). Mitigation: the 3-site `!== false` edit + comment fix, deferred, reversible.
- **Line drift** — several plan anchors already drifted (`classifyBySmartMd` :181, `processSession` :550/19-args, `stepSmallModelConnection` :455). Mitigation: Chunk 0 re-anchors before any golden capture.
- **Test-wave stall** — the first chunk touching `asset-spec.ts` turns ~2,000 test ref-literals red at once. Mitigation: the §15 codemod lands atomically with the ref-grammar change; safety suites are port-first.
- **Restored-subsystem scope creep** — the budgeted add is the memory-lifecycle state model (+2,500–3,000) plus Tier-A binding consolidation (+200–400); anything beyond the §6/Chunk 6.5 scopes (**the full persisted binding record + export digests + rebind/CLI**, claim extractor, rank-parity replay, two-phase, overlay, purge/quarantine automation) is explicitly Tier B / 0.9.1+ and must not slip in.

---

## 13. Residual Complexity Integration (from the residual-complexity audit)

The audit (companion `akm-0.9.0-residual-complexity-audit.md`) assumed this plan fully implemented and found the gold-plating that still survives. It is folded in three ways below. Rule unchanged: net removal, no new machinery.

### 13.1 Confident deletions folded into the chunks (≈ −4,300 LOC + 1 MB)

Pure removals, no design decision. Each is assigned to an existing chunk; add to that chunk's deletion ledger and grep-gate.

| Deletion | Evidence | Chunk | ~LOC |
|---|---|---|---|
| Vendored `echarts.min.js` → **CDN** (KEEP the HTML health report — maintainer decision) | `echarts.min.js` = 1,034,102 B inlined by default (`html-report.ts:384`). **The CDN mechanism already exists** (`html-report.ts:41` `ECHARTS_CDN` + `:383` `buildEchartsTag` switch on `AKM_ECHARTS`) — the work is only to **flip the default `inline`→`cdn`** and drop the vendored asset, not implement anything. Report + `md-report`/JSON paths stay. Caveat: charts then need network at view time (text/tables still render offline). | 9 | −1 MB asset (report LOC kept) |
| `recombine`/`synthesis` cross-episodic subsystem — supersedes §5's "keep as learn recipe" | `recombine.ts` 1009 + `recombine-repository.ts` 290 + `migrations.ts:679` table; `default.json:15` enabled:false; sibling measured **0% accept** (`synthesize.json:2`) | 7 | −1,300 |
| Second workflow codec — collapse classic-markdown into the YAML program codec (markdown is a strict subset → same IR, `ir/freeze.ts:145`) | `renderer.ts:10` "two formats, one asset type"; every op implemented twice | 8 | −650 |
| Env-gated deterministic embedder facade → test fixture | `deterministic.ts:8` "NEVER used in production (env-gated, off)"; only `AKM_EMBED_DETERMINISTIC=1` reaches it; no config/CLI sets it | 9 | −110 |
| `core/eval/rank-metrics.ts` → relocate under `scripts/akm-eval/` | only importer is `scripts/akm-eval/.../curate-metrics.ts:7` re-export; **zero** `src/` importers | 9 | −180 (move) |
| Filesystem plugin-loader for a one-element fetcher registry → inline | one-element registry (youtube) behind a generic loader | 4 | −55 |
| `--format html` generic template framework → health-only render (every other command's "HTML" is JSON-in-`<pre>`, `cli/shared.ts:205`) | `html-render.ts:26` per-command template + unused `default.html` | 9 | −160 |
| `review_pressure` / `ValenceScore.lane` (already §9.2) | no readers | 7 | −85 |

These raise the 0.9.0 total to **≈ −13,000 to −15,000 net** (§12.1).

### 13.2 0.9.1 measurement pass (prove-or-delete tier, up to a further −6,000 to −12,000)

Do **not** litigate these in 0.9.0 — they are default-on subsystems whose value is *unmeasured*, and one harness run resolves them together. Gate a single **0.9.1 measurement pass** on one nDCG/MRR + saturation-harness run against the curate-golden set (the same run the §9.3 parity flip needs):

- **Cluster A — the near-zero-signal apparatus** (~600 LOC + tables): outcome loop, encoding-salience NLP model (`encoding-salience.ts`, 258), scoped-utility EMA (`utility_scores_scoped`), dual weight-triple + parity flag, and `loadSalienceRankScores` (the only cross-DB reach on the search hot path, §14.2 A3). The code's own tripwire reports `corr=+0.0104` at n=5,706 and emits `outcome_proxy_dead` (`preparation.ts:1678`). Run at `w_o=0`; if rankings don't move, delete the loop + `review_pressure` + scoped table + parity triple, and fall encoding back to the existing `DEFAULT_TYPE_ENCODING_WEIGHTS` stub.
- **Graph extraction** (~4,288 LOC, `indexer/graph/*` + `llm/graph-extract.ts`): default-on, per-batch LLM cost, one conditional `computeGraphBoost` (`db-search.ts:782`) with no nDCG proof. Must show a measured rank delta or go default-off + drop the boost. (Native `item_links` are navigation/lint data and are NOT part of this measurement — adapter spec §9.)
- **Collapse-ALERT loop only** (~530 LOC): `collapse-detector.ts:22` "observe-only… nothing is ever blocked"; advisory alerts + full scans every cycle. Must have caught one real event or collapse to a single cheap health metric. **CARVE-OUT: the canary probe (`scoreCanary`/`buildCanaryQuery`) and the `canary_queries` store are NOT in this tier** — they are the memory-lifecycle retirement gate's harness (§6) and moved to the §13.4 preserve list. Only the alert/monitor loop around them is prove-or-delete.
- **`mergeInformationFloor`** (verified observe-only, §1.4): prove the floor should become a real gate, or delete it with this cluster.

Batch them: one measurement run decides all of these at once.

**Run it offline, not against the live production loop.** These gates do not depend on the workstation's improve loop generating telemetry — most are already deterministic: nDCG/MRR/recall/leapfrog run on the `curate-golden` fixtures + `AKM_EMBED_DETERMINISTIC` via the pure `core/eval/rank-metrics.ts` (no LLM, no live data); the retrieval runner needs only a built index.db; the collapse/canary recall+entropy gate is FTS-only, no-LLM by hard invariant (`collapse-detector.ts:18-20`). The outcome-proxy corr tripwire (`+0.0104`) is deterministic math over a populated state.db (≥500 rows) — **seed it** from a one-time export of the real `asset_outcome` distribution (n≈5,706 today), or from synthetic `usage_events`+`proposals`, so no live loop is required and the verdict still reflects real usage shape. Only proposal *generation* needs a model, satisfied by a local Ollama/llama.cpp/lmstudio endpoint (the eval judge already speaks these) at zero API cost. The harness reuses `createSandbox` (`scripts/akm-eval`), the deterministic/local embedders, `--dry-run` seams, `akm extract` + session fixtures, and the Phase-6 read-replay recorder; it must add (a) a state.db seeder for the n≥500 tripwire, (b) a baseline-vs-candidate index.db overlay driver for the canary gate, and (c) an LLM record/replay (or local-endpoint) seam for the proposal stages. This keeps the measurement reproducible in CI and off the workstation's GPUs — decoupling the release gate from live-telemetry health and from GPU load on the dev box.

### 13.3 Restored subsystems and retained simplifications (final)

The residual audit's scope-down of bindings/memory/facets was overruled by the maintainer reconciliation (DEV-3/4/5); this section records the final shape:

- **Bindings/activation** — **Tier A IN SCOPE (Chunk 6.5); persisted record + CLI deferred to Tier B** (2026-07-13 refinement, supersedes the DEV-3 "restore full"). Ground-truth of the current code: install≠activation, workspace-owned engines (credentials never in bundles), runtime ref→values resolution (`resolveEnvBinding`, `${secret:NAME}`), and `registryId` first/third-party policy ALREADY exist; the only genuinely-new machinery is a *persisted* approval/enable/trust record with an export digest + rebind-on-update, for ~one consumer today. **Tier A (0.9.0):** consolidate those existing behaviors into one workspace activation-policy point + keep the untrusted read-path clamp; **env/secret unchanged** (stay whole-file assets in stashes/bundles with existing `registryId` policy — nothing moves workspace-side). **Tier B (defer until a real untrusted-bundle-ships-a-runnable-export consumer exists):** the `workspace_bindings` record, export digests, rebind-on-update (normative §18.5), and the `akm bind|unbind|bindings` CLI. Deferring loses no current safety property (install≠activation already holds; no digest/approval record exists today). Budgeted +200–400 (consolidation), not +1,300–1,800.
- **Memory lifecycle** — IN SCOPE (DEV-4, Chunk 7.5) at the §6 scope: the consolidation *engine* is a refactor; the lifecycle *state model* is budgeted new construction (+2,500–3,000). Claim extractor, rank-parity replay, two-phase, overlay, and purge/quarantine automation are 0.9.1+.
- **Adapter capabilities** — optional methods on one `BundleAdapter` interface (DEV-6), never an `extends` hierarchy; renderer/action mapping is a data table over a named-function core module (§2.3).
- **Outcome-weight parity flag** — still deferred, resolved in the §13.2 measurement pass rather than carried indefinitely.
- **Storage `Repository<Row,Domain>` base class** → do **NOT** introduce (§14 F8). 12 of 13 repos are plain function modules; the open/borrow duplication is already solved by `managed-db.ts`. Ship only the `jsonColumn()` codec helper and keep the function-module convention — a class hierarchy over function modules is framework-before-value.

### 13.4 Leave alone (do not over-cut)

Embeddings + FTS/vector hybrid ranking core (broadly-used); the three OS scheduler backends — **VERIFIED load-bearing (§14 F-tasks): there is NO in-process scheduler; `tasks/embedded.ts` only lists YAML templates for the setup wizard, so AKM delegates all recurring scheduling to the OS, and dropping launchd/schtasks would leave macOS/Windows with no scheduling at all. Residual-audit finding #8 is WITHDRAWN.**; the JSON output envelope and human/agent shape axis (load-bearing); `archiveMemory` and the extract/consolidate core (the ~4 processes with proven live output); the `ndcg`/`recall`/`mrr` math (relocate, don't delete); **the canary probe + `canary_queries` store** (§13.2 carve-out — the memory-lifecycle gate's harness). **Also verified load-bearing and left alone:** the workflow frozen-plan / run-lease / per-unit journal / resume machinery — *with the correction (§10.7) that the shared `step-work.ts` layer is well-decomposed but the two drivers are not*: `exec/report.ts` hides a 438-line `reportWorkflowUnitWithBarrier` and `native-executor.ts` a 212-line `executeStepPlan`, both split in Chunk 8; the shared SQLite migration engine + `managed-db` + provider seam; the engine/spawn/dispatch runtime (`spawn.runAgent`, `engine-resolution`, `runner`); the harness registry (a real DRY win — once §10.7 makes its leaf claim true). See §14.

---

## 14. Survivor Value + Architecture Audit (verified, not assumed)

Four audits checked the ~44K LOC the greenfield analysis called "load-bearing" — not to accept it on faith, but to (a) confirm it actually provides value and (b) find any part needing cleaner architecture. **Verdict: the survivors are genuinely load-bearing** — retrieval core, workflow runtime, storage/migration engine, and engine/spawn/dispatch runtime are all VALUE-CONFIRMED with real consumers + dedicated tests. No survivor subsystem is low-value. The residual gold-plating is thin scaffolding around proven pipelines, plus a few architecture smells and two corrections to prior findings.

### 14.1 Corrections to earlier findings

- **Scheduler backends — residual-audit finding #8 WITHDRAWN.** `tasks/embedded.ts` is not a runner/scheduler (only lists templates); `tasks/runner.ts` is a one-shot executor invoked *by* the OS scheduler. All recurring scheduling is delegated to cron/launchd/schtasks; each has genuine host-independent format-builder tests (`tasks-{launchd,schtasks,cron}-backend.test.ts`). Keep all three (§13.4).
- **echarts→CDN is a default-flip, not an implementation.** The CDN path already exists (`html-report.ts:41` `ECHARTS_CDN`, `:383` `buildEchartsTag`/`AKM_ECHARTS`); flip the default and drop the vendored asset (§13.1).
- **Plan's own `Repository<Row,Domain>` base class → don't build it** (§13.3): 12/13 repos are function modules; ship `jsonColumn()` only.

### 14.2 Additional REFACTOR-ARCHITECTURE (fold into named chunks)

| # | Finding | Evidence | Target | Chunk | ~LOC |
|---|---------|----------|--------|-------|------|
| A1 | Dead search-hit-enricher registration framework | `registerSearchHitEnricher`/`additionalEnrichers`/`_reset*` (`search-hit-enrichers.ts:105`) have **zero callers**; `enrichSearchHit` always uses the fixed default list | collapse to a fixed array; drop the register/reset machinery + `enrichers` param | 5 | −25 |
| A2 | `buildWhyMatched` re-derives ranking scoring (drift seam) | `db-search.ts:837` re-scans matches + `:776` recomputes boost constants byte-identical to `metadataRankingContributor` (`ranking-contributors.ts:292`) | record fired contributors in `applyScoreContributors`, derive `whyMatched` from that; delete the parallel scorer | 5 | −40 |
| A3 | `loadSalienceRankScores` = the only cross-DB reach on the search hot path | `ranking.ts:97` opens **state.db per query** to apply the outcome-derived `salience-ranking` contributor (`SALIENCE_WEIGHT=0.2`) — the same signal the tripwire measures at `corr=+0.0104` | add this consumer to the §13.2 `w_o=0` measurement; if outcome is noise it dies here too, removing the index.db→state.db coupling | 13.2 | −(with cluster A) |
| W1 | `runtime/ ↔ exec/` layer inversion | `runtime/runs.ts:27` + `unit-checkin.ts:21` import *up* into `exec/` (`frozen-judge`, `param-secrets`, `GATE_EVALUATION_PHASE`) → mutual dependency | move those 3 primitives down into `runtime/` (or `workflows/core/`); dependency flows `exec→runtime` only | 8 | ~180 moved |
| W2 | `engine_lease_*` overloaded as two concurrency primitives | durable single-driver lease (90s TTL heartbeat) *and* short-lived finalize/settle mutex (`report.ts:774,1070`) share one column pair | give the settle mutex its own `finalize_lock_*` (or typed holder + `acquireFinalizeLock`); lands free in the §3.3/§8 cutover DDL rewrite | 8 | ~0 (schema) |
| H1 | `AkmHarness` capability→field presence enforced at runtime, not compile time | 14-field descriptor with 5 `?`-optional facet fields; `session-logs/index.ts:41` **throws at module load** when `sessionLogs===true` but provider absent | capability-discriminated union (required-when-true typing) so it's a compile error; retire the load-time throw + presence test. **NOTE: the runtime/session/format 3-object split the plan floated is NOT warranted** — spawn + engine-resolution are already facet-decoupled | 9 | type-safety refactor |
| H2 | Health report conflates view-model + HTML assembly | `buildHealthHtmlReplacements` (`html-report.ts:401`, ~657) computes arithmetic/staleness/trends AND emits HTML inline; no typed seam | extract pure `AkmHealthResult→HealthReportViewModel` (unit-testable) + thin VM→fragment renderer — deeper than §4.7's line-count split | 9 | restructure |
| H3 | `runAgent` in-file kill-ladder duplicated | SIGTERM→SIGKILL ladder inlined 2× (`spawn.ts:527,545`) on top of the cross-file dup §4.6 already targets | one `scheduleKillLadder(proc,{reason})` covers both in-file copies + the `sdk-runner` copy | 9 | −(with §4.6) |
| S1 | Source root-detect predicate + install-pipeline skeleton triplicated | 3× "is this a populated stash root?" (`git-provider.hasExtractedRepo`, `provider-utils.detectStashRoot`, `website-ingest.hasExtractedSite`); 3× materialize skeleton (git/npm/website) | one `isMaterializedStashRoot(dir, directoryList)` + a `materialize(spec)` template (medium confidence — tar/git/crawl differ) | 4.6 | −(broader than plan) |
| L1 | `text/registry.ts` dead `register/deregister` (symmetric to §13.1 #25) | only self-testing callers; near-byte-identical to `shapes/registry.ts` | fold into the §4.7 "3 parallel registries" consolidation → one generic `CommandRegistry<H>` factory | 9 | −(with §4.7) |

### 14.3 Additional small deletions (dead/reserved surface)

- **`AkmHarness.resume` field + `*_RESUME_FLAG` constants** — reserved-dead across all 10 harnesses; zero argv/workflow consumers (symmetric to the `effort` finding). Delete. (~30–40 LOC, Chunk 9)
- **`derivedMemoryEnricher` searchHints no-op branch** (`search-hit-enrichers.ts:83`) — self-described no-op. Delete. (~6 LOC, Chunk 5)
- **Retrieval-DB exports orphaned by recombine deletion** — `getEntitiesByEntryIds` (`db.ts:1109`), `getNeighborsByEntryId` (`:896`) have recombine/consolidate as their only consumers; remove in the **same chunk** as the recombine deletion (Chunk 7), not left as dead index-DB APIs.
- **Stale doc-comments (P2 harnesses)** — every P2 result-extractor header says "NOT registered anywhere" but each **is** registered (`native-executor.ts:1178`); `builder-shared.ts:52` says `schema` unconsumed but **8** builders consume `req.schema`. Fix in the P2 sweep so future audits aren't misled. `model-aliases.ts:45` covering only claude/opencode is hard evidence the 7 P2 harnesses can't dispatch end-to-end (reinforces the opt-in demotion, not deletion). Note: `resume` is declared on 6/10 harnesses with 2 flag constants (not "all 10") — the delete list in §14.3 shrinks accordingly; still all dead.

### 14.4 DoD gap — RESOLVED (stale)

- The "Node `better-sqlite3` driver is untested" claim is **stale at HEAD**: CI's `node-smoke` job compiles the native driver and runs smoke + parity suites under Node 20/22 on every commit. Remaining items (Chunk 9): delete the stale comment at `database.ts:14`, and add **Node 24** (current LTS) to the `node-smoke` and release-gates matrices. Do not add a redundant driver test.

### 14.5 Post-cutover prune (note in the §8 checklist)

- After the full re-key, `plan-classifier.ts:17-113`'s legacy-version-drift arms (`missing-plan`/`unsupported-version`/mismatched-metadata, ~80 LOC) become unreachable — collapse to a 2-state `supported | corrupt` classifier. Not a 0.9.0 deletion (pre-migration DBs still hit it); a next-minor follow-up so the dead defensive breadth isn't carried forward silently.

---

## 15. Test Strategy (the largest single line item)

Measured at HEAD: **588 test files / ~175K LOC / ~7,500 cases — 1.3× the size of src.** 220 files / 97.7K LOC (57% of test LOC) reference something this plan deletes: `StashEntry` in 37 files (218 uses), `parseAssetRef` in 12 (86), `TYPE_DIRS` in 9, `wikiName` in 5, quoted `type:name` ref literals in **186 files / 2,003 occurrences** (`memory:` 930, `skill:` 484, `workflow:` 298, `knowledge:` 230, …), and ~100 files hardcoding the type-directory layout. Realistic workload ≈ 35–45% of total refactor effort. Rules:

1. **Per-chunk pairing.** Every chunk names its test bucket and lands it in the same chunk; the chunk gate is not green until its bucket is.
2. **Codemod, atomically.** The ~2,003 ref literals + ~100 directory-layout literal files migrate via a script committed to `scripts/`, landing **atomically with the ref-grammar change** (Chunk 6), followed by an assertion-review pass. A grep ratchet (extend the existing `lint-isolation-ratchet` pattern) drives `StashEntry`/`parseAssetRef`/`TYPE_DIRS`/type-prefix literals in `tests/` to zero.
3. **Safety suites are port-first and green at every chunk boundary** (~4,700 LOC / ~22 files): traversal/escape (env-traversal, workflow-path-escape, tar-utils-scan, git-source-safety), symlink handling (12 files), redaction/dangerous-key, SQLite journal/busy/lock/contention/cross-proc, and the migration suites (`migration-lifecycle-regression` 1,062 LOC, `migration-backup` 405 — extended, not rewritten, to cover the §3.3 cutover). Fixed points: `_helpers/sandbox.ts`, `_preload.ts`, the mock.module-ban lint, and the hand-rolled sharding (documented Bun-race mitigation — do not touch).
4. **Taxonomy-pin deletions land with their replacements** (~13–16 files / ~2,500–3,000 LOC: asset-ref/asset-spec/asset-registry/exhaustive-registry-coverage/contracts pins, walker.test, wiki.test minus the fetcher subset): each deletion in the same commit as its §12.3 replacement contract test, so the exhaustiveness guard never gaps.
5. **Goldens re-baselined once, deliberately.** Enumerate the 35+ golden/characterization assets (CLI output baselines, the ranking-baseline fixture stash, SQLite-migration snapshots, 6 characterization suites); each is designated (a) frozen as migration-input fixture or (b) re-captured post-cutover in its designated chunk with a reviewed diff. Re-recording outside the designated chunk is forbidden.
6. **Manual-rewrite bucket** (~40–60 files / ~25–35K LOC): the 37 StashEntry consumers (incl. mv.test 1,829, indexer.test 1,694, e2e.test 1,931), 12 parseAssetRef files, install/recognition tests (source-providers/, provider-utils — the §12.4 risk area), keyed to the chunk that changes each API.
7. **New mandated suites** (normative §31): adapter conformance (with Chunk 2), search parity incl. filter parity (Chunk 5), transaction fault injection (Chunk 6), install≠activate (Chunk 6.5), water-mark/coverage/backpressure/restore (Chunk 7.5), migration crash/orphan/rc-FROM-state (Chunk 8), trust clamp (Chunk 2/5).
8. **Test-suite debt folded into the sweep:** consolidate the ~15 duplicated stash-builder helpers and 51 local `runCli` wrappers onto `_helpers` **before Chunk 2** (this is the choke-point that makes the fixture-layout codemod small); migrate the 108 rogue mkdtemp sites onto the sandbox helper so `sweep:tmp` can be demoted.
9. **Accounting:** test LOC does not count toward the §12.1 src target; the test ledger is reported alongside it.

---

## 16. Contract-Surface + Repo Sweep (Chunk 10 detail)

Surfaces outside `src/` that break under drop-ref, each a named work item:

- **STABILITY.md / roadmap.md / AGENTS.md (decision D28).** STABILITY.md's top Stable item is the `<type>:<name>` ref syntax; roadmap promises a 1.0 ref-format freeze; AGENTS.md states the old grammar as law. Rewrite all three to the new id scheme; the CHANGELOG carries the breaking-change migration note per STABILITY's own policy. This is a contract decision, recorded as D28 in the decision history.
- **The one true 0.9.0.** This refactor **is** 0.9.0 (maintainer decision); the rc-train's published story is subordinate to it. Work items: rewrite `docs/migration/v0.8-to-v0.9.md` and `docs/migration/release-notes/0.9.0.md` to describe this refactor's migration; normalize CHANGELOG headers (the file currently claims 0.9.0 both released and unreleased); reconcile SECURITY.md's support matrix; and pin the migrator FROM-state to rc-train installs (§3.4) — users on rc.x arrive at the cutover with the rc-era state layout.
- **stash-skeleton conventions** (9 per-type docs + `organization.md` teaching `knowledge:auth/...` refs and `--type` search): relocate into the owning adapters as adapter-owned conventions; rewrite around the new id/placement model; add a migration step (or documented non-goal) for copies already stamped into user stashes.
- **improve-strategies `allowedTypes`** (14 occurrences across 9 of 12 shipped JSONs): redefine the strategy schema against open type strings; update shipped JSONs; the migrator rewrites-or-warns on user-local strategy files.
- **Published `schemas/`** (npm-shipped, generated): regen `akm-config.json` post-cutover; document the enum break in the migration note; **remove `schemas/**` from ci.yml paths-ignore** (schema-only PRs currently merge with zero CI, defeating the drift check).
- **Docs sweep** (182 md files; 33 teach the old grammar): tier 1 rewrite — `docs/technical/ref.md` (becomes the new-id doc), `concepts.md`, `cli.md`, `classification.md` (→ adapter recognition), `architecture.md`, `features/*`; tier 2 archive — `src-reorganization-plan.md`, `refactoring-tasks.md`, one of the duplicate `search.md`/`search-updated.md`; tier 3 untouched — `docs/posts`. Also fix the type-count contradictions (ref.md says 10, STABILITY.md 11, actual 14) by deriving the doc list from the shipped adapters.
- **Embedded/agent-facing assets:** `src/assets/hints/cli-hints-*.md`, help files, `scripts/akm-asset/command_migrate-storage.md`, `scripts/akm-eval/cases/*` (judge-calibration probes embed `skill:`/`knowledge:` refs — `akm-eval-smoke.yml` fails at cutover otherwise) — migrated in the same chunk as the CLI ref change, enforced by the §7.3 shipped-assets lint.
- **scripts/ hygiene:** 13.5K LOC excluded from biome + tsc — add to both (the migrator lives here; it must not be the one unchecked codepath); fix or delete `check:changed` (references a nonexistent test file; AGENTS.md documents the bug instead of fixing it).
- **Lint/type ratchets:** `noExplicitAny` back to error (16 sites); evaluate `noUncheckedIndexedAccess` during the adapter port while registry accesses are being rewritten.
- **docs/example-stash** re-laid out to the new model; surviving `src/assets` templates (tasks/core, wiki templates, workflow-template) re-verified against their owning adapters.
- **Out of scope (verified clean):** install.sh/install.ps1 (no ref coupling), the seven GitHub workflow files (current; only akm-eval-smoke is cutover-sensitive via the cases above).
