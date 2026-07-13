# AKM 0.9.0 — Comprehensive Clean-Up Implementation Plan

**Bundle Adapters, Drop-Ref + Full Re-Key, improve Decomposition, and a Whole-Repo Debt Sweep**

Status: APPROVED architecture. This is an implementation plan, not a proposal. Baseline HEAD: `b7877d9` / `cf44e11` (post engine-strategy cutover). Single track, in-branch, no intermediate release.

**Companion spec:** the concrete bundle/adapter *how* — the adapter contract, per-format adapters, indexing, and the **OKF (Open Knowledge Format) foundation** (AKM bundles are OKF bundles; AKM is OKF-compatible by default) — is specified in [`akm-0.9.0-bundle-adapter-spec.md`](./akm-0.9.0-bundle-adapter-spec.md). Read it alongside §2/§7 here.

---

## 1. Executive Summary

### 1.1 What 0.9.0 is

0.9.0 is a **single-track, no-release, net-simplification** refactor that replaces AKM's asset-type taxonomy with **bundle adapters**, drops the `[origin//]type:name` ref for an **opaque adapter-owned id** with a **one-time full state re-key**, decomposes the **improve god-modules** into named passes, and **sweeps every remaining structural debt** the subsystem review surfaced so the churn stops. There is no `0.8.x → 0.9.0` compatibility window, no dual-write, no feature flags kept past cutover. One atomic migration, one throwaway migrator (`@removeIn 0.10.0`), one green branch that merges when the whole thing is done.

### 1.2 Four objectives (no debate, no re-scope)

1. **Asset-types → bundle adapters.** Delete `AssetSpec` / `AkmAssetType` closed union / `TYPE_DIRS` / global matchers / renderer+action registries / `StashEntry`-as-model / type-derived paths / `[origin//]type:name` refs. Bundle adapters own native formats, on-disk conventions, authoring rules, recognition, placement, renderer, and L1 validation. Core owns install / index / search / change-transaction / state / bindings / improve.
2. **Drop-ref + full re-key.** `type:name` refs become opaque bundle-scoped adapter-owned ids. One atomic `0.8 → 0.9` migration re-keys **all** state, fail-closed, backup-verified, throwaway migrator.
3. **Decompose improve.** Four god functions (`runImprovePreparationStage` ~1544, `akmImprove` ~943, `akmReflect` ~707, `akmDistill` ~635) become thin orchestrators over named passes on an explicit `RunContext`, mirroring the already-decomposed `consolidate.ts`. Two verbs: `revise` (reflect) and `learn` (extract/distill/inference/recombine/synthesis).
4. **Sweep all remaining debt.** Ambient-config threading, config over-engineering, DRY consolidations, concrete defects, dead/unwired code, misleading names — comprehensively, so this is one-and-done.

### 1.3 Hard rules

- **NET LOC REMOVED must exceed added.** Target ≈ **−9,000 to −10,500 net** across the repo (§12 ledger).
- **No new features. No new machinery/frameworks.** Adapters, `RunContext`, and the shared `Repository<Row,Domain>` base are *refactors of existing coupled functionality into proper boundaries*, not new subsystems.
- **Keep valuable features + proven infra** (audit S26): `writeFileAtomic`, symlink containment, SQLite hardening, git exact-path staging, credential redaction, engine freezing, workflow frozen-plan, scheduler safety, deterministic search benchmarks, typed errors. Every §-level preserve list is binding.

### 1.4 Corrections folded from the sweep (supersede the committed plan)

- Ref/migration decision **superseded**: DROP-REF + FULL-RE-KEY, no compat, no dual-write (was: ref-preserving migration).
- `config-schema.ts` is **1415 LOC / 252 `.optional()` / 3 `.default()`** (verified), not the stale §4 figure of 1012/219.
- `akmConsolidateInner` is **already decomposed** — do not re-plan it; current large consolidate targets are `planConsolidation` (~433), `handleMergeOp` (~298), `handlePromoteOp` (~215).
- `SearchDocument` / `IndexDocument` **do not exist** (grep-verified zero hits). The normalized model must be **minted from the existing `StashEntry`** plus added provenance fields.
- Already-fixed, **do not re-churn**: `runFtsQuery` swallow (B7), `improve?.default` deep-chain (A3), `m=months vs minutes` conflict (B1 headline), `CONFIG_SUBCOMMAND_SET` desync (B2), grid-search-at-import (distill policy), `FEEDBACK_FAILURE_MODES` dup, `asNonEmptyString`/`firstString` dup, `writeFileAtomic` dead branch, `setup/legacy-config.ts` (already deleted), `AGENT_PLATFORMS` trap. Residual debt around each is separately named below.
- **Residual-complexity audit folded in** (companion `akm-0.9.0-residual-complexity-audit.md`, integrated in §13): ~4,300 LOC of **confident gold-plating deletions** fold into the chunks below (net-LOC ledger updated); a further ~6,000–12,000 LOC of **default-on-but-unproven** subsystems (graph extraction, collapse/canary monitor, the outcome-loop/encoding-salience/scoped-utility apparatus) go to a **single 0.9.1 measurement pass** rather than being litigated here; and the plan's **own new machinery** (bindings/activation, adapter facets, second supersession encoding) is **scoped down before it ships** (§13.3) — cheaper not to build than to remove later.

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

- **`SearchDocument`** — *minted by renaming `StashEntry`* (`indexer/passes/metadata.ts:60`, ~40 fields) and **adding typed provenance** (`sourceRef`, `origin`, `contentHash`) that today is carried out-of-band on `DbIndexedEntry.{filePath,stashDir}` and resolved at query time (`db-search.ts:100,210`). Drop the wiki-only fields `wikiRole`/`pageKind` (`metadata.ts:106,112`) into the knowledge fold. This is a **rename + field move**, not a new type.
- **`AssetRef`** — opaque bundle-scoped id string. `asset-ref.ts` (140 LOC) survives as a **pure parser**: grammar + `makeAssetRef`/`refToString` + `validateName` traversal/null-byte/drive-letter guards (`:121-136`). Delete the closed-union `isAssetType` gate (`:109`), `TYPE_ALIASES` (`:25-27`), and the vault `UsageError` (`:98-103`).
- **`Proposal`** — one object `{ changes: FileChange[]; beforeHash; status; evidence }`. Today it carries a single `payload{content,frontmatter?}` blob (`proposal/repository.ts:287`, `proposals-repository.ts:66-69`) that cannot express multi-file consolidate. This is a **shape change**, +40 LOC, the only net-add in the changes area.
- **`FileChange`** — `{ path; before?; after?; op }`, applied by one core transaction.

### 2.3 Adapter base + facets

One `BundleAdapter` interface, one adapter per native format. Facets (each replacing a deleted global slice):

| Facet | Replaces (deleted global) |
|---|---|
| `recognize(FileContext) → SearchDocument?` | `matchers.ts` global competition + `file-context.runMatchers` specificity contest (`:242-265`) + `classifyBySmartMd` (`:181-222`) |
| `placeNew(ref) → path` | `TYPE_DIRS[type]` + `resolveAssetPathFromName` (`path-resolver.ts:28-33`, `write-source.ts:488-493`, `sources/resolve.ts:21-110`) |
| `directoryList() → string[]` | `Object.values(TYPE_DIRS)` (git-stash pathspecs, provider-utils root detection, graph-extraction) |
| `renderer` / `action` (locally stamped) | `asset-registry.ts` static `TYPE_TO_RENDERER`/`ACTION_BUILDERS` (`:21-58`) + `asset-spec` `rendererName`/`actionBuilder` split-brain |
| `validateL1(FileContext) → LintIssue[]` | `LINTER_MAP`/`getLinterForType` + 9 per-type linter classes |

**Split-brain resolution (gap filled):** `asset-registry` statically maps renderers/actions for **all 14** types; `asset-spec` *also* carries `rendererName`/`actionBuilder` for only **8** (workflow/env/secret/wiki/lesson/task/session/fact). The remaining **6** (script/skill/command/agent/knowledge/memory) get their renderer **only** from the static registry map. Each per-format adapter must **locally stamp its own renderer+action**; the 6 static-only mappings must not be lost in the port.

**Facet scope-down (§13.3 — avoid framework-before-second-consumer):** do NOT mint per-format facet *interfaces* for the trivial cases. `renderer`/`action` for most formats are pure constant maps — keep them as a small **data-driven format table**, not a class per format. Write real per-format code only where `recognize`/`validateL1` genuinely differ (skill SKILL.md, workflow codec, wiki→knowledge, env/secret safety). Do **not** introduce a `MemoryLifecycleAdapter`/`AuthoringAdapter`/`ExportAdapter` interface hierarchy — a memory-lifecycle facet would have exactly one implementer today; express it as ordinary functions in the memory module.

---

## 3. Identity & Full Re-Key Migration

### 3.1 The new identity

`[origin//]type:name` → **opaque bundle-scoped adapter-owned id**. `type` is no longer part of identity; it becomes an **open provenance string** on `SearchDocument`, guarded only by the §7.3 provenance-string-set pin (a lint/test), never by a closed union.

### 3.2 Complete state re-key list (state.db)

Every table/column keyed on the old ref is re-keyed in one transaction:

- `asset_salience` (ref), `asset_outcome` (ref) — re-key via the `rekeyStateDbForMove` SQL pattern (`mv-cli.ts:928,957`), generalized to a full-table pass.
- `proposals` (`entry_ref`), `usage_events` (`entry_ref` — the feedback keying, preserved finding), `improve_runs`, `extract_sessions`, `task_history`.
- `workflow_runs` / `workflow_run_steps` / `workflow_run_units` — after they are merged into state.db (§8).
- index.db is **regenerable** — it is dropped and rebuilt post-migration, not re-keyed.

### 3.3 One-time atomic, fail-closed

- Single migration `state-018` (cutover). Wrap the entire re-key + `workflow.db` ATTACH/`INSERT…SELECT` (§8) in one transaction on the shared engine (`storage/engines/sqlite-migrations.ts`: append-only ledger, SHA-256 body sealing, transaction-per-migration).
- **Backup-verified-restorable** first (`core/migration-backup.ts`): fail-closed-to-restore on any nonzero orphan.
- No dual-write, no `0.8` read path retained after commit.

### 3.4 Throwaway migrator

- `src/migrate/legacy/` holds the `0.8 → 0.9` migrator, **all** tagged `@removeIn 0.10.0`.
- `src/migrate/legacy/legacy-layout.ts` seeds from a **frozen COPY** (not `git-mv`) of `SCRIPT_EXTENSIONS`/`WORKFLOW_EXTENSIONS`/`canonicalizeWorkflowName` so the live util home can evolve without touching the migrator.
- The pre-0.9 filesystem-proposal import (`proposal/legacy-import.ts` 131 LOC + `proposal_fs_imports` table + `proposals-repository.ts:258-302` ledger) folds into this single migrator and is deleted from the live path.

---

## 4. Comprehensive DELETE / MOVE / REPLACE / DECOMPOSE Inventory

Net-LOC is signed. "Repoint" = consumer edited to read adapter metadata; counted where the deleted source lives.

### 4.1 Asset-type core

| Action | Target (file:line) | LOC | Net |
|---|---|---|---|
| DELETE | `core/asset/asset-registry.ts` (whole; `:21-100` renderer/action maps) | 100 | −100 |
| DELETE | `asset-spec.ts:326-328` TYPE_DIRS + `:297-320` register/deregister/getAssetTypes + registry/renderer/action body | ~230 of 359 | −230 |
| MOVE | `asset-spec.ts` `SCRIPT_EXTENSIONS` (`:104`, 17 exts), `WORKFLOW_EXTENSIONS` (`:42`), `canonicalizeWorkflowName` (`:55`) → live util home (`core/recognition-util.ts`) | ~30 | 0 |
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
| RENAME | `:473-474,484` `mergeInformationFloor` "ADVISORY; never refused" comment — it **is** a live gate at `anti-collapse.ts:143` | 0 | 0 |
| DELETE | `config.ts:250-256` `getImproveProcessConfig` vestigial `_config` param | 1 | −1 |

### 4.3 Index / search / read

| Action | Target | LOC | Net |
|---|---|---|---|
| MINT | `StashEntry` (`metadata.ts:60`) → `SearchDocument` + provenance fields; drop wiki fields `wikiRole`/`pageKind` | — | −40 |
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
| CONSOLIDATE | 9 per-type linters + `registry.ts` `LINTER_MAP`/`getLinterForType` + `types.ts AssetLinter` → `runBaseChecks` + adapter `validateL1` | — | −250 |
| INLINE | `lint/index.ts:37` `STASH_SUBDIRS` + subdir→linter routing (`:117-189`) | 40 | −40 |
| ADD | Skill adapter `validateL1`: Anthropic SKILL.md contract (name≤64, desc≤1024, body<~500 lines) — genuinely new, small | — | +? |
| DECOMPOSE | `repository.ts:2069` `formatUnifiedDiff` / `:2093` `formatNewAssetDiff` | 30 | −30 |
| CONSOLIDATE | `proposal-cli.ts:109-163,213-275` bulk accept/reject loops → `bulkAdjudicateProposals` in `proposal.ts` | 70 | −70 |
| DELETE | `proposal/legacy-import.ts` + `proposals-repository.ts:258-302` + `proposal_fs_imports` table → migrator | 160 | −160 |
| DELETE | `repository.ts:439,482,487,659` dedup/cooldown machinery (callers already pass `force:true`) | 120 | −120 |
| DELETE | `repository.ts:874` `recordGateDecision` + `Proposal.gateDecision` + drain confidence gate | 80 | −80 |
| DECOMPOSE | `repository.ts:198` `ProposalPayload` single-content → `FileChange[]` | — | +40 |
| RENAME | `lint/types.ts:15` `dangerous-vault-key` LintIssueType (vault removed 0.9.0) | 0 | 0 |
| THREAD | `write-source.ts:487-501` `resolveAssetFilePath` TYPE_DIRS → adapter `placeNew` (KEEP git exact-path boundary, `sanitizeCommitMessage`, `isWithin`) | — | −15 |
| THREAD | `drain.ts:42`, `propose.ts:19`, `repository.ts:50` TYPE_DIRS importers | — | −20 |
| MOVE | base-linter ref grammar `REF_BOUNDARY_PREFIX_CLASS_SRC`/`REF_SLUG_CHAR_CLASS_SRC` (`:173-174`, consumed by `mv-cli.ts:64-65`) → live util home; REF_RE type-alternation sourced from adapters | — | −20 |

### 4.6 sources / registry / integrations / setup

| Action | Target | LOC | Net |
|---|---|---|---|
| CONSOLIDATE | `caps()` byte-identical across 8 harness `index.ts` + `homeDir()` (`claude/config-import.ts:22`) → BaseHarness/shared | 70/8 | −78 |
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
| DECOMPOSE | `health/improve-metrics.ts:191` `summarizeImproveCompleted` (~440) | — | net-neutral |
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

**Two verbs, one envelope:**
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

**Deleted from loop AND config-schema (D7/D9):** self-confidence authorization, exploration promotion (`improve-auto-accept.ts:77-215`), Jaccard self-consistency voting (`loop-stages.ts:117-160,307-331`), confidence/calibration auto-tuning (`calibration.ts`, `improve.ts:497`), procedural-in-core (`procedural.ts`).

**Shared helpers minted (net-add ≈+500 total, dwarfed by deletions):** envelope facade, `RunContext`, `serializeFrontmatterQuoted`, single `resolveParentRef`/`isDerivedMemory`.

---

## 6. Memory Lifecycle (Refactor of consolidate)

Memory lifecycle stays in the consolidate module, re-expressed as **non-destructive `learn` recipes** — never hard-delete.

- **Activation scope-down (§13.3):** keep today's **implicit activation** for 0.9.0. Do NOT mint a `workspace_bindings` table, export digests, or a trust-decision layer — grep shows **zero** `workspace_bindings`/`bindWorkspace` consumers today and one implicit workspace. The install→bind→enable *lifecycle* is the eventual proper design, but building the table + trust machinery now is framework-before-second-consumer; defer until a real multi-workspace consumer exists.
- The LLM-directed hard ops become non-destructive: `handleMergeOp` (`consolidate.ts:2117`), `handleDeleteOp` (`:2416`), `handleContradictOp` (`:2693`), `handlePromoteOp` (`:2477`, memory→lesson) → route through the **existing** `archiveMemory` primitive (`consolidate.ts:838`) via the new `FileChange` transaction. **One supersession encoding only** — reuse `archiveMemory`'s archive-move + `superseded_by` frontmatter + git history; do **not** add a second in-place `supersededBy`+demotion representation that every downstream reader would then have to understand (§13.3).
- **Preserve** the transactional discipline: `writeJournal`/`checkForIncompleteJournal`/`cleanupJournal`, backup/recovery; the LOOK/CHANGE separation and signal-delta corrective-evidence gate (2026-05-26 synchronized-wave fix); no lossy in-place reconsolidation (raw assets + additive distill + no-op gate + git history).
- `resolveParentRef`/`isDerivedMemory` divergence (name-keyed vs path-keyed) collapses to one keyed-on-ref impl so the contradiction-edge producer/consumer cannot disagree.

---

## 7. Index / Search / Read / Changes Sweep

### 7.1 Normalized model
One `SearchDocument` (renamed `StashEntry` + typed provenance). `validateStashEntry` (`metadata.ts:292,296`) relaxes from the closed `isAssetType` gate to an open-token check (Chunk 1.5); its ordering-dependency doc-comment (`:287-291`) is deleted.

### 7.2 Recognition/placement/renderer are adapter-owned
`matchers.ts` + `file-context` specificity + `path-resolver` disk-probe + `walker.walkStash` gone. `ensure-index` staleness and `graph-extraction` type↔dir maps read adapter directory metadata (bidirectional: `:944` dir→type, `:1159` type→dir, plus include-flag). `resolveViaIndex(lookup)` and symlink containment survive.

### 7.3 Provenance-type string-set pin (DoD contract test)
The deleted closed union is replaced by a lint/test pinning the open provenance-type set, sourced from adapter metadata. It must cover every consumer that parsed the closed list:
- `db-search.ts:320` `parseRefPrefixQuery(query, getAssetTypes())` — or `type:name` prefix queries silently stop recognizing types.
- `base-linter` `REF_RE` type-alternation.
- `ranking-contributors.ts:11` `TYPE_BOOST`, `salience.ts:135` `DEFAULT_TYPE_ENCODING_WEIGHTS`, `common.ts` `ASSET_TYPES` tuple, `config-schema.ts:915-926` graph-include list, website-ingest `'website'`/`'knowledge'` stamping (`:180,385`).

### 7.4 Read path wiki removal
`show.ts:428-432` `forcedWikiMatch` (keyed on `source.wikiName`) + `search-source.ts:29,63,75,88,113,119` `SearchSource.wikiName` + `db-search.ts:94,101` + `metadata.ts:684` + `indexer.ts:836` deleted with the wiki fold. `searchInWiki` (`wiki.ts:713`) retargets `knowledge`.

### 7.5 db.ts decomposition + arrow inversion
`db.ts` (2063) splits into table repositories under `storage/repositories/`; the storage→indexer opener imports (`index-db.ts:5`, `registry-cache.ts:6`) invert to indexer→storage. Full-rebuild wipe becomes one shared truncation including `utility_scores_scoped` (B4). **Preserve** FK pre-flight guard (`db.ts:847`), vec-table transaction (`:858-864`), incremental FTS dirty-queue (`:774`), per-row corrupt-JSON skip-with-warn (do NOT reintroduce silent swallow), `deleteRelatedRows` cascade completeness (`:650-738`).

---

## 8. Activation & Runtime + Three-DB Model

### 8.1 Three DBs (merge workflow.db in)
Today FOUR DBs (`storage/locations.ts:28-32`): index.db, state.db, workflow.db, logs.db. Target THREE:

- **state.db** (durable): events, proposals, task_history, improve_runs, extract_sessions **+ migrated workflow_runs/steps/units**.
- **index.db** (regenerable search cache).
- **logs.db** (high-volume purgeable) — **KEEP SEPARATE** (`#579`, `docs/technical/logs-audit.md`), joined via ATTACH.

### 8.2 workflow.db → state.db merge mechanics (gap filled)
The bundle plan never described this merge; it is an approved target that must be specified:
1. state.db migration `state-018` `CREATE TABLE`s `workflow_runs`/`workflow_run_steps`/`workflow_run_units` at FINAL shape (fold the 10 `WORKFLOW_MIGRATIONS` bodies `workflows/db.ts:178-368` into one baseline DDL).
2. One-time `ATTACH` old workflow.db, `INSERT…SELECT` the three tables into state.db inside the **same** cutover transaction as the state re-key (§3.3).
3. `bootstrapPreVersioningDb` (`workflows/db.ts:398`) dies (0.7-era, irrelevant post-cutover).
4. Delete physical workflow.db.

**Blast radius is small and single-seam:** the only DB-opening gateway is `withWorkflowRunsRepo` (`workflow-runs-repository.ts:650`); its `WorkflowRunsRepository(db)` constructor (`:220`) already takes an **injected** Database and owns all table-scoped SQL — re-pointing to `withStateDb` requires **zero SQL rewrite**. Re-point also: `workflows/exec/brief.ts`, `workflows/exec/watch.ts`, `cli/config-migrate.ts:45` (`runWorkflowMigrations`). Delete `workflows/db.ts`, `getWorkflowDbPath`, `StorageLocations.workflowDb`, `WORKFLOW_MIGRATIONS`, and the workflow.db branches in `migration-backup.ts` (collapse to one state.db backup to verify-restore).

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
`getEmbeddableEntryCount`, `improve-result-file.ts` (writes DB row), `dangerous-vault-key` LintIssueType, `sources/wiki-fetchers/`, `outcomeWeightEnabled` comment, `mergeInformationFloor` comment, `formatShowPlain` (embeds policy).

---

## 11. Single-Track Execution Order

In-branch chunks. Each chunk: deletion ledger, local green gate (`typecheck + unit + affected integration`), net-LOC-removed asserted. **Chunk 0 golden capture must re-anchor drifted lines** (`classifyBySmartMd` is at `matchers.ts:181`, not `:197`; re-measure config-schema before sizing).

**Chunk 0 — Golden capture & oracles.** Snapshot recognition/placement/renderer/lint outputs for all 14 formats; capture `deriveCanonicalAssetNameFromStashRoot` minting oracle (`mv-cli.ts:769,1266`); re-anchor all line numbers at HEAD. Gate: golden fixtures committed. Net: 0.

**Chunk 1 — Adapter base + util home.** Introduce `BundleAdapter` interface; relocate `SCRIPT_EXTENSIONS`/`WORKFLOW_EXTENSIONS`/`canonicalizeWorkflowName` + ref grammar constants to `core/recognition-util.ts`. Frozen COPY into `migrate/legacy/legacy-layout.ts`. Net: ~0.

**Chunk 1.5 — Open the type token (Wave-1 type-only severs).** `common.ts:29-88` union block, `salience.ts:52/650`, `eligibility.ts:9/39/169/477`, `mv-cli.ts:51,145,154,743`, `asset-ref.ts:109`. Relax `validateStashEntry` to open-token. Gate: grep `AkmAssetType` → **0**. Net: −80.

**Chunk 2 — Per-format adapters (14).** Each stamps recognize/placeNew/directoryList/renderer/action/validateL1 locally (incl 6 static-only renderer mappings). Skill adapter gains SKILL.md contract. Net: adapters ≈ net-zero-to-negative (replace deleted globals).

**Chunk 3 — Delete taxonomy globals.** `asset-registry.ts`, `asset-spec` registry/renderer/action, `matchers.ts` competition, `file-context:242-265`, `path-resolver` disk-probe, `LINTER_MAP`+9 linters, `output/renderers.ts` type-registry. Repoint graph-extraction/ensure-index/walker/write-source/sources-resolve/provider-utils/git-stash/build-index to adapter metadata. Gate: grep `TYPE_DIRS` → **0**, `resolveAssetPathFromName` → **0**, `runMatchers` → **0**. Net: ~−1000+.

**Chunk 4 — Wiki death.** Delete `wiki/wiki.ts`, `wiki-templates.ts`, template asset; broken-xref → base-linter missing-ref; fold `wikiRole`/`pageKind` → knowledge; delete `wikiName` (5 config sites + indexer/search + read path `show.ts:428-432` + `SearchSource.wikiName`); rename `wiki-fetchers/`→`snapshot-fetchers/` (keep youtube/website); collapse `resolve-standards-context` Feature-A. Gate: grep `wikiName` → **0**, `wiki` type token → **0**. Net: ~−1300.

**Chunk 5 — SearchDocument + db.ts split.** Rename `StashEntry`→`SearchDocument` + provenance; split `db.ts` into storage repos + `Repository<Row,Domain>` base; invert storage↔indexer arrow; unify scored/enumerate filter path; fold `.stash.json` legacyOverrides + `mergeLegacyEntry` → migrator. Gate: grep `StashEntry` → **0**, `.stash.json`/`loadStashFile` → **0**. Net: ~−320.

**Chunk 6 — Proposal → FileChange[] + one transaction.** Collapse 3 FS journal engines into one FileChange transaction (preserve fsync + before-hash); `Proposal{changes:FileChange[]}`; delete dedup/cooldown/gate; `bulkAdjudicateProposals`; legacy-import → migrator. Gate: grep `parseAssetRef` → **0**; journal dirs removed. Net: ~−900.

**Chunk 7 — improve decomposition + dead-lane deletions.** Decompose the 4 god fns + consolidate ops (non-destructive learn recipes); delete self-consistency/exploration/calibration/procedural/autotune/review_pressure/ValenceScore.lane; trim promotion-policy literal; RunContext into `processSession`; serializer/resolveParentRef consolidation. Net: ~−3900.

**Chunk 8 — Three-DB merge + migration cutover.** `state-018` (workflow DDL fold + full re-key + workflow.db ATTACH INSERT…SELECT, one atomic fail-closed txn); delete `workflows/db.ts` + workflowDb locations/paths/backup branches; drop+rebuild index.db. Throwaway migrator `@removeIn 0.10.0`. Gate: 4→3 DBs; backup-verified restore green. Net: ~−500.

**Chunk 9 — Cross-cutting sweep.** Ambient RunContext threading (retire `_set*ForTests`); config discriminated schemas + reserved-knob deletion; output helpers/shape-registry dedup; health/tasks god decomposition; cli argv-rescanner + duration residue + caps/homeDir/mirror/session-log/spawn/semver/connection dedup; npm.path() + parseSourceSpec fixes. Gate: grep `resolveStashDir` residual only in RunContext builder. Net: ~−2000.

**Zero-count grep gates (must all pass at merge):** `TYPE_DIRS`, `AkmAssetType`, `parseAssetRef`, `wikiName`, `StashEntry`, `resolveStashDir` (outside RunContext builder), `.stash.json`, `getAssetTypes`, `ASSET_SPECS`, `LINTER_MAP`.

---

## 12. Net-Simplification Ledger, DoD, Contract Tests, Risks

### 12.1 Net-simplification ledger (by area)

| Area | Net LOC |
|---|---|
| Asset-type core + config + standards | −550 to −700 |
| index/search/read/changes | −320 (pre-adapter recognition) |
| improve/memory/salience | −3900 |
| changes/proposals/wiki/lint/mv | −3000 |
| sources/registry/integrations/setup | −400 to −450 |
| workflows/storage/DBs/output/health/tasks/cli | −2500 |
| Adapters + RunContext + shared helpers (adds) | +≈600 |
| Residual confident deletions folded in (§13.1) | −≈2,500 (+ 1 MB echarts asset via CDN; HTML report kept) |
| **TOTAL (0.9.0)** | **≈ −11,000 to −13,000 net removed (+1 MB asset dropped)** |
| 0.9.1 measurement-pass prove-or-delete tier (§13.2) | up to a further −6,000 to −12,000 |

### 12.2 Definition of Done

1. All zero-count grep gates pass.
2. 4→3 DBs; migration atomic, fail-closed, backup-verified restore green; throwaway migrator `@removeIn 0.10.0`.
3. Every format handled by one adapter; no global matcher/renderer/action/linter registry remains.
4. `Proposal` carries `FileChange[]`; one transaction applies all mutation (proposal/revert/mv).
5. improve = 2 verbs over passes; no god fn >~200 LOC in improve.
6. Salience machinery intact; dead lanes (review_pressure, ValenceScore.lane) gone; outcome-weight under reversible parity flag.
7. Ambient `loadConfig`/`resolveStashDir` gone from leaves; RunContext threaded.
8. Net LOC removed > added (≥ −9,000).
9. All preserve-list infra (S26) present and exercised by a test.

### 12.3 Architecture contract tests

- **Provenance-type pin** (§7.3): open type-set sourced from adapters; `type:name` prefix parsing + base-linter REF_RE + ranking/salience keys all resolve.
- **Golden recognition/placement/renderer/lint** parity for all 14 formats (Chunk 0 fixtures).
- **Canonical-name minting** oracle parity (`deriveCanonicalAssetNameFromStashRoot`).
- **git exact-path staging** still scopes to adapter `directoryList()` (not nothing-staged).
- **Migration round-trip**: 0.8 fixture DB → cutover → all refs re-keyed, zero orphans, restore-on-fault.
- **One transaction**: mid-apply fault leaves no partial write (before-hash abort).

### 12.4 Risks & mitigations

- **git-stash pathspec silent degrade** — a preserved S26 feature (`git-stash.ts:241`) is built from dying `Object.values(TYPE_DIRS)`; if the adapter `directoryList()` is not wired, `git add -- <pathspecs>` scopes to nothing and commits skip. Mitigation: contract test in 12.3; wire before Chunk 3 lands.
- **Install-time recognition underweighted** — `provider-utils.detectStashRoot` (`:33-197`) and `git-provider.hasExtractedRepo` (`:188-202`) are second recognition sites; `akm add` fails to detect a valid bundle root if only the index path is repointed. Mitigation: thread adapter directory-list into both.
- **website snapshot machinery mis-deleted with wiki** — `fetchWebsiteMarkdownSnapshot`/youtube feed the knowledge path, not wiki. Mitigation: rename-not-delete `wiki-fetchers/`.
- **Migration non-atomicity** — full re-key + workflow merge must share one transaction; a split leaves index.db/state.db inconsistent. Mitigation: single `state-018`, backup-verified fail-closed.
- **Parity-flip premise** — outcome weight is default-ON, not inert; a naive "flip the config default" is a no-op (no `.default()` exists). Mitigation: the 3-site `!== false` edit + comment fix, deferred, reversible.
- **Line drift** — several plan anchors already drifted (`classifyBySmartMd` :181, `processSession` :550/19-args, `stepSmallModelConnection` :455). Mitigation: Chunk 0 re-anchors before any golden capture.

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

- **Cluster A — the near-zero-signal apparatus** (~600 LOC + tables): outcome loop, encoding-salience NLP model (`encoding-salience.ts`, 258), scoped-utility EMA (`utility_scores_scoped`), dual weight-triple + parity flag. The code's own tripwire reports `corr=+0.0104` at n=5,706 and emits `outcome_proxy_dead` (`preparation.ts:1678`). Run at `w_o=0`; if rankings don't move, delete the loop + `review_pressure` + scoped table + parity triple, and fall encoding back to the existing `DEFAULT_TYPE_ENCODING_WEIGHTS` stub.
- **Graph extraction** (~4,288 LOC, `indexer/graph/*` + `llm/graph-extract.ts`): default-on, per-batch LLM cost, one conditional `computeGraphBoost` (`db-search.ts:782`) with no nDCG proof. Must show a measured rank delta or go default-off + drop the boost.
- **Collapse/canary monitor** (~900 LOC): `collapse-detector.ts:22` "observe-only… nothing is ever blocked"; runs FTS probes + full scans every cycle for advisory-only alerts. Must have caught one real event or collapse to a single cheap health metric.

Batch them: one measurement run decides all three at once.

### 13.3 Scope-down the plan's own new machinery (before it ships)

Framework-before-second-consumer additions this plan introduced, cut to the minimum (saves ~500–900 new LOC that would otherwise be built then removed):

- **Bindings/activation** → keep implicit activation for 0.9.0; no `workspace_bindings` table / export digests / trust layer (zero consumers today). (§6)
- **Adapter facets** → data-driven format table for trivial renderer/action; per-format code only where `recognize`/`validateL1` differ; no one-implementer lifecycle/authoring/export facet interfaces. (§2.3)
- **Supersession** → reuse the existing `archiveMemory` encoding only; no parallel in-place `supersededBy`+demotion representation. (§6)
- **Outcome-weight parity flag** → still deferred, but resolved in the §13.2 measurement pass rather than carried indefinitely.
- **Storage `Repository<Row,Domain>` base class (plan §4.7)** → do **NOT** introduce (§14 F8). 12 of 13 repos are plain function modules; the open/borrow duplication is already solved by `managed-db.ts`. Ship only the `jsonColumn()` codec helper and keep the function-module convention — a class hierarchy over function modules is framework-before-value, the same anti-pattern this section guards against.

### 13.4 Leave alone (do not over-cut)

Embeddings + FTS/vector hybrid ranking core (broadly-used); the three OS scheduler backends — **VERIFIED load-bearing (§14 F-tasks): there is NO in-process scheduler; `tasks/embedded.ts` only lists YAML templates for the setup wizard, so AKM delegates all recurring scheduling to the OS, and dropping launchd/schtasks would leave macOS/Windows with no scheduling at all. Residual-audit finding #8 is WITHDRAWN.**; the JSON output envelope and human/agent shape axis (load-bearing); `archiveMemory` and the extract/consolidate core (the ~4 processes with proven live output); the `ndcg`/`recall`/`mrr` math (relocate, don't delete). **Also verified load-bearing and left alone:** the workflow frozen-plan / run-lease / per-unit journal / resume machinery (well-decomposed already — no god-fn treatment needed); the shared SQLite migration engine + `managed-db` + provider seam; the engine/spawn/dispatch runtime (`spawn.runAgent`, `engine-resolution`, `runner`); the harness registry (a real DRY win). See §14.

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
| W2 | `engine_lease_*` overloaded as two concurrency primitives | durable single-driver lease (90s TTL heartbeat) *and* short-lived finalize/settle mutex (`report.ts:774,1070`) share one column pair | give the settle mutex its own `finalize_lock_*` (or typed holder + `acquireFinalizeLock`); lands free in the §8 `state-018` DDL rewrite | 8 | ~0 (schema) |
| H1 | `AkmHarness` capability→field presence enforced at runtime, not compile time | 14-field descriptor with 5 `?`-optional facet fields; `session-logs/index.ts:41` **throws at module load** when `sessionLogs===true` but provider absent | capability-discriminated union (required-when-true typing) so it's a compile error; retire the load-time throw + presence test. **NOTE: the runtime/session/format 3-object split the plan floated is NOT warranted** — spawn + engine-resolution are already facet-decoupled | 9 | type-safety refactor |
| H2 | Health report conflates view-model + HTML assembly | `buildHealthHtmlReplacements` (`html-report.ts:401`, ~657) computes arithmetic/staleness/trends AND emits HTML inline; no typed seam | extract pure `AkmHealthResult→HealthReportViewModel` (unit-testable) + thin VM→fragment renderer — deeper than §4.7's line-count split | 9 | restructure |
| H3 | `runAgent` in-file kill-ladder duplicated | SIGTERM→SIGKILL ladder inlined 2× (`spawn.ts:527,545`) on top of the cross-file dup §4.6 already targets | one `scheduleKillLadder(proc,{reason})` covers both in-file copies + the `sdk-runner` copy | 9 | −(with §4.6) |
| S1 | Source root-detect predicate + install-pipeline skeleton triplicated | 3× "is this a populated stash root?" (`git-provider.hasExtractedRepo`, `provider-utils.detectStashRoot`, `website-ingest.hasExtractedSite`); 3× materialize skeleton (git/npm/website) | one `isMaterializedStashRoot(dir, directoryList)` + a `materialize(spec)` template (medium confidence — tar/git/crawl differ) | 4.6 | −(broader than plan) |
| L1 | `text/registry.ts` dead `register/deregister` (symmetric to §13.1 #25) | only self-testing callers; near-byte-identical to `shapes/registry.ts` | fold into the §4.7 "3 parallel registries" consolidation → one generic `CommandRegistry<H>` factory | 9 | −(with §4.7) |

### 14.3 Additional small deletions (dead/reserved surface)

- **`AkmHarness.resume` field + `*_RESUME_FLAG` constants** — reserved-dead across all 10 harnesses; zero argv/workflow consumers (symmetric to the `effort` finding). Delete. (~30–40 LOC, Chunk 9)
- **`derivedMemoryEnricher` searchHints no-op branch** (`search-hit-enrichers.ts:83`) — self-described no-op. Delete. (~6 LOC, Chunk 5)
- **Retrieval-DB exports orphaned by recombine deletion** — `getEntitiesByEntryIds` (`db.ts:1109`), `getNeighborsByEntryId` (`:896`) have recombine/consolidate as their only consumers; remove in the **same chunk** as the recombine deletion (Chunk 7), not left as dead index-DB APIs.
- **Stale doc-comments (P2 harnesses)** — every P2 result-extractor header says "NOT registered anywhere" but each **is** registered (`native-executor.ts:1178`); `builder-shared.ts:52` says `schema` unconsumed but 4 builders consume `req.schema`. Fix in the P2 sweep so future audits aren't misled. `model-aliases.ts:45` covering only claude/opencode is hard evidence the 7 P2 harnesses can't dispatch end-to-end (reinforces the opt-in demotion, not deletion).

### 14.4 DoD gap surfaced

- **Node `better-sqlite3` driver is untested** (`database.ts:16` "additive, not CI-tested this pass"). The cross-runtime claim rests on an unexercised branch, and DoD §12.2 item 9 requires preserve-list infra to be exercised by a test. Add a Node-runtime test or explicitly scope the driver as Bun-first.

### 14.5 Post-cutover prune (note in the §8 checklist)

- After the full re-key, `plan-classifier.ts:17-113`'s legacy-version-drift arms (`missing-plan`/`unsupported-version`/mismatched-metadata, ~100 LOC) become unreachable — collapse to a 2-state `supported | corrupt` classifier. Not a 0.9.0 deletion (pre-migration DBs still hit it); a 0.10 follow-up so the dead defensive breadth isn't carried forward silently.
