# AKM 0.9.0 — Comprehensive Clean-Up Implementation Plan

**Bundle Adapters, Drop-Ref + Full Re-Key, improve Decomposition, and a Whole-Repo Debt Sweep**

Status: APPROVED architecture. This is an implementation plan, not a proposal. Baseline HEAD: `b7877d9` / `cf44e11` (post engine-strategy cutover). Single track, in-branch, no intermediate release.

**Companion spec:** the concrete bundle/adapter *how* is in [`akm-0.9.0-bundle-adapter-spec.md`](./akm-0.9.0-bundle-adapter-spec.md), reconciled with the normative `akm-format-neutral-bundle-workspace-spec.md` **v0.3** (amended in place; §18/§25 carry release-staging notes). Read it alongside §2/§7.

**Reconciliation status (2026-07-14, final):** the maintainer decisions — OKF hybrid with open `type`; ref = `[bundle//]conceptId`; the third `consolidate` verb; LLM Wiki adapter restored; **bindings at Tier A** (deviation §4.3a); **memory lifecycle DEFERRED entirely to 0.9.1+** (deviation §4.3b); **no new trust/approval/security machinery** (deviation §4.3a note); net-LOC demoted from gate to reported ledger; **hygiene-first two-wave sequencing** — are **applied in place throughout this document**. The chunk sequence (§11), ledger (§12.1), DoD (§12.2), and contract tests (§12.3) encode this scope, and the review-pass findings (`akm-0.9.0-plan-review-2026-07.md`, `akm-target-design-review-2026-07.md`, plus the external code-quality review incorporated 2026-07-14) are folded in. No passage below is superseded by a banner; this text is current. Doc gate: the superseded phrasings (the bindings-deferral imperative, the two-verb count, the wiki-into-knowledge fold, the full-DEV-3/DEV-4 restore) grep to zero outside this sentence.

---

## 1. Executive Summary

### 1.1 What 0.9.0 is — two halves with different justifications

0.9.0 is a **single-track, no-release, net-simplification** refactor with two honestly-distinct halves:

- **The hygiene half** — improve god-function decomposition (SRP), `RunContext` dependency injection (DIP), one `FileChange[]` transaction replacing three journal engines (DRY), and the whole-repo debt sweep. This half is justified purely on code quality and testability; it is independent of the identity migration and **lands first (Wave 1, §11)** so its value banks even if the migration half re-plans.
- **The migration half** — asset-type taxonomy → bundle adapters (OCP: a new format becomes one new adapter instead of shotgun surgery across `TYPE_DIRS`/matchers/registries/linters), and the `[origin//]type:name` → `[bundle//]conceptId` re-key. This half is justified by the format-neutral product direction, not hygiene; it carries most of the risk (the re-key touches 2,003 test ref-literals and 57% of test LOC) and is sequenced second (Wave 2, §11) with its own goldens and gates.

There is no compatibility window, no dual-write, no feature flags kept past cutover. One journaled migration, one throwaway migrator (`@removeIn 0.10.0`), one green branch that merges when the whole thing is done. Known trade-off, accepted: the open `type` string trades the closed union's compile-time exhaustiveness for a lint/test spelling pin — mitigated by typing AKM's own known-type tables over a `KNOWN_TYPES` const tuple (compile-time exhaustiveness for our tables; open strings for the data; §2.3).

### 1.2 Objectives

1. **Asset-types → bundle adapters.** Delete `AssetSpec` / `AkmAssetType` closed union / `TYPE_DIRS` / global matchers / renderer+action registries / `StashEntry`-as-model / type-derived paths / `[origin//]type:name` refs. Bundle adapters own native formats, on-disk conventions, authoring rules, recognition, placement, renderer, and L1 validation. Core owns install / index / search / change-transaction / state / activation policy / improve.
2. **Drop-ref + full re-key.** `type:name` refs become opaque bundle-scoped adapter-owned ids. One journaled migration re-keys **all** state, fail-closed, backup-verified, throwaway migrator.
3. **Decompose improve.** Four god functions (`runImprovePreparationStage` ~1544, `akmImprove` ~943, `akmReflect` ~707, `akmDistill` ~635) become thin orchestrators over named passes on an explicit `RunContext`, mirroring the already-decomposed `consolidate.ts`. **Three verbs** (naming only, zero new machinery): `revise` (reflect), `learn` (extract/distill/inference), and `consolidate` (the existing memory-tier ops, decomposed — §6).
4. **Sweep all remaining debt.** Ambient-config threading, config over-engineering, DRY consolidations, concrete defects, dead/unwired code, misleading names — comprehensively, so this is one-and-done.

### 1.3 Hard rules

- **Deletion is gated by inventory, not by a LOC number.** The hard gates are the zero-count greps, the per-chunk deletion ledgers, and the parity/contract/behavior tests. Net-LOC is **reported** via the §12.1 ledger with signed adds (current projection ≈ −11,100 to −13,700 net across src) — tracked and published, never a pass/fail threshold that pressures deletion decisions. Test LOC is ledgered separately (§15).
- **No new machinery. No new trust/approval/security machinery in particular** (2026-07-14 decision): labeling, action clamps, approval prompts, digests, and trust records are rejected for 0.9.0 as false-confidence machinery that forces brittle-code maintenance — existing protections in code today (env/secret redaction renderers, the `registryId` dangerous-key block/warn, the add-time dangerous-key scan) survive the port unchanged, and nothing is added. The only budgeted adds are the Tier-A activation-policy consolidation (+200–400, §13.3) and the retrieval-surface items (L0/L1/L2, `item_links`, `#fragment`). Adapters, `RunContext`, and the `jsonColumn()` helper remain *refactors of existing coupled functionality into proper boundaries*.
- **Keep valuable features + proven infra** (audit S26): `writeFileAtomic`, symlink containment, SQLite hardening, git exact-path staging, credential redaction, engine freezing, workflow frozen-plan, scheduler safety, deterministic search benchmarks, typed errors, **and the retrieval-canary probe + store** (the offline measurement harness's gate, §13.2 carve-out). Every §-level preserve list is binding.

### 1.4 Corrections folded from the sweep and the review pass

- Ref/migration decision **superseded**: DROP-REF + FULL-RE-KEY, no compat, no dual-write (was: ref-preserving migration).
- `config-schema.ts` is **1415 LOC / 252 `.optional()` / 3 `.default()`** (verified), not the stale §4 figure of 1012/219.
- `akmConsolidateInner` is **already decomposed** — do not re-plan it; current large consolidate targets are `planConsolidation` (~426), `handleMergeOp` (~298), `handlePromoteOp` (~215).
- `IndexDocument` **does not exist yet** (grep-verified zero hits). The normalized model is **minted from the existing `StashEntry`** plus provenance + the pinned query-time signal fields (adapter spec §3) — a rename + field move + signal promotion, with the schema-column migration owned by Chunk 5.
- Already-fixed, **do not re-churn**: `runFtsQuery` swallow (B7), `improve?.default` deep-chain (A3), `m=months vs minutes` conflict (B1 headline), `CONFIG_SUBCOMMAND_SET` desync (B2), grid-search-at-import (distill policy), `FEEDBACK_FAILURE_MODES` dup, `asNonEmptyString`/`firstString` dup, `writeFileAtomic` dead branch, `setup/legacy-config.ts` (already deleted), `AGENT_PLATFORMS` trap, **`summarizeImproveCompleted`** (already refactored to a 5-line delegate — the §4.7 decompose row is dropped). Residual debt around each is separately named below.
- **Corrected by verification (review pass):** `mergeInformationFloor` **is genuinely advisory** — `checkMergeInformationFloor` counts + warns and "merge proceeds (v1 observe-only)" (consolidate.ts caller); the schema comment was right and the earlier "live gate" correction was wrong. The field joins the §13.2 measurement pass (prove the floor should gate, or delete it with the collapse cluster). — Proposal **dedup/cooldown is live machinery** for 8 of 11 `createProposal` call sites (only the two human CLI paths and recombine's promote force-bypass it); its deletion is re-scoped in §4.5 to land **with** the fingerprint replacement, retaining rejection backoff. — The Node/`better-sqlite3` DoD gap is **stale**: CI's `node-smoke` job gates the driver on Node 20/22 every commit; the real items are deleting the stale `database.ts:14` comment and adding Node 24 to the matrices (§14.4). — Detail drift fixed in place: `SCRIPT_EXTENSIONS` = 16; `classifyBySmartMd` lives in `matchers.ts:181`; `caps()` is byte-identical across **10** files; P2 harness dir is `codex`, builders/extractors sum 946/1014 LOC; `AkmHarness.resume` is declared on 6/10 harnesses with 2 flag constants; `_set*ForTests` = 18 seams; the runtime graph-include SUPPORTED set silently drops schema-allowed `fact` (desync to fix in §4.2); `workflow.db` has two direct openers besides the repo gateway (§8.2).
- **Landed upstream during the plan's life — mark done, do not re-plan:** the reflect double disk-read collapse (§4.4's −30 sub-item) shipped in main's improve stabilization and is already at HEAD.
- **Residual-complexity audit folded in** (companion `akm-0.9.0-residual-complexity-audit.md`, integrated in §13): ~4,300 LOC of **confident gold-plating deletions** fold into the chunks below (net-LOC ledger updated); a further ~6,000–12,000 LOC of **default-on-but-unproven** subsystems (graph extraction, the collapse-alert loop, the outcome-loop/encoding-salience/scoped-utility apparatus) go to a **single 0.9.1 measurement pass** rather than being litigated here. On the audit's scope-downs, the final dispositions (2026-07-14) largely vindicate it: bindings ship at **Tier A only** (consolidation of existing enforcement, +200–400 — deviation §4.3a), the **memory-lifecycle state model is deferred entirely** (deviation §4.3b), and the retained simplifications stand — renderer/action as a data table over a named-function module, optional methods instead of an interface hierarchy, no `Repository<Row,Domain>` base class (§13.3).

---

## 2. Target Proper-Core Architecture

### 2.1 The boundary

```
CLI boundary ── builds ──▶ RunContext { config, stashDir, dbs, adapters, clock, logger }
                                   │
        ┌──────────────────────────┼───────────────────────────────┐
   BUNDLE ADAPTERS (per format)   CORE (format-agnostic)        STORAGE (DB repos)
   own: recognize / placeNew /    owns: install, index, search,  own: table SQL as plain
        renderer / action /             change-transaction,          function modules +
        validate / native               state, activation policy      jsonColumn() helper
        conventions                     (Tier A), improve
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
| `TYPE_PRESENTATION` data table → named-function renderer module | `asset-registry.ts` static `TYPE_TO_RENDERER`/`ACTION_BUILDERS` (`:21-58`) + `asset-spec` `rendererName`/`actionBuilder` split-brain |
| `validate(c, changes, ctx: ValidateContext)` — ctx = snapshot+overlay reads + `resolveRef` (adapter spec §2) | `LINTER_MAP`/`getLinterForType` + 9 per-type linter classes |
| `affectedItems?()` item-scoped incrementality | dir-staleness whole-dir regenerate (behavior-preserving for multi-file items: skill = the dir, wiki `schema.md` coupling) |

**Split-brain resolution (gap filled):** `asset-registry` statically maps renderers/actions for **all 14** types; `asset-spec` *also* carries `rendererName`/`actionBuilder` for only **8** (workflow/env/secret/wiki/lesson/task/session/fact). The remaining **6** (script/skill/command/agent/knowledge/memory) get their renderer **only** from the static registry map. Each per-format adapter must **locally stamp its own renderer+action**; the 6 static-only mappings must not be lost in the port.

**Shape discipline (§13.3):** capabilities are **optional methods on the one `BundleAdapter` interface** (DEV-6, normative §12) — no `MemoryLifecycleAdapter`/`AuthoringAdapter`/`ExportAdapter` `extends` hierarchy. This is **not** the `AkmHarness` H1 defect the plan fixes elsewhere: H1's smell is a *separate capability boolean* that can disagree with an optional field's presence at runtime; on `BundleAdapter` there is no separate flag — **method presence IS the capability**, so nothing can desync. `renderer`/`action` mappings stay a **data table** keyed on the open `type`, pointing at a small named-function core module (env/secret redaction is renderer *behavior* and survives as code, keyed on the adapter — normative §15.3). Write real per-format code only where `recognize`/`validate` genuinely differ (skill SKILL.md, workflow codec, llm-wiki, env/secret safety).

**Compile-time safety mitigation (external review, 2026-07-14):** the open `type` string trades the closed union's exhaustiveness checking for a runtime lookup — a real loss, mitigated structurally rather than by tests alone. AKM's own known-type tables are typed over a const tuple:

```ts
export const KNOWN_TYPES = ["knowledge", "workflow", "task", "skill", /* … */] as const;
export type KnownType = (typeof KNOWN_TYPES)[number];
export const TYPE_PRESENTATION: Record<KnownType, Presentation> = { /* compiler enforces exhaustiveness */ };
export function presentationFor(type: string | undefined): Presentation { /* open-string lookup, generic fallback */ }
```

The compiler again enforces that every known type has a presentation/ranking entry (restoring what the union gave us for *our* tables), while the data space stays open (third-party `type`s fall through to the generic entry). The §7.3 spelling pin then only has to guard the *cross-surface* consistency (tables vs shipped assets vs docs), not existence.

---

## 3. Identity & Full Re-Key Migration

### 3.1 The new identity

`[origin//]type:name` → **`[bundle//]conceptId`** (path identity; normative §7.8/§11). `type` is no longer part of identity; it becomes an **open descriptive string** on `IndexDocument`, guarded only by the §7.3 known-type spelling pin (a lint/test), never by a closed union.

### 3.2 Complete state re-key list

Every table/column keyed on the old ref is re-keyed in the cutover, under the §3.3 mechanics:

- `asset_salience` (ref), `asset_outcome` (ref) — re-key via the `rekeyStateDbForMove` SQL pattern (`mv-cli.ts:928,957`), generalized to a full-table pass with the three-spelling merge (bare / `origin//` / `.derived` twins → one fully-qualified key; deterministic per-table merge: event rows carried as-is, scalar fields most-recently-updated wins).
- `proposals` (`entry_ref`), `improve_runs`, `extract_sessions`, `task_history`, `consolidation_judged` (`entry_key`). *(No `bindings` table — the persisted binding record is Tier B and is deliberately NOT minted in the 0.9.0 cutover; if Tier B ever lands it adds its table via an ordinary later migration, not a second cutover. Same for memory-lifecycle retirement tables — deferred, §6.)*
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
| DECOMPOSE | `reflect.ts:948` `akmReflect` (~676 at HEAD) → passes (the double disk-read collapse already landed upstream — §1.4; do not re-plan) | — | −400 |
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

**Three verbs, one envelope** (revise / learn / **consolidate** — naming only; consolidate names the existing memory-tier ops, decomposed with behavior preserved, §6):
- `revise` = reflect. `learn` = extract / distill / inference / recombine / synthesis.
- Each verb emits a single `Proposal { FileChange[] + beforeHash + status }` through one envelope facade.
- All passes read files **only from the run's hash-manifest snapshot** (D6). (The reflect double disk-read this rule was named after already landed upstream — §1.4.)

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

## 6. Memory: consolidate decomposition only — the lifecycle state model is DEFERRED (2026-07-14 decision)

The external code-quality review called the §25 lifecycle state model what it is: **feature work in a refactor's clothing** — +2,500–3,000 LOC of new construction (operational states, grace/restore, CAS archive, sandbox replay, water-marks) whose central safety gate (claim coverage) depends on an extractor that does not exist. Maintainer decision (deviation §4.3b): **0.9.0 ships none of it.** The entire lifecycle waits for 0.9.1+ and starts only when the claim extractor + its benchmark exist.

**Ships in 0.9.0 (part of Chunk 7):**
- **Decomposition only.** `planConsolidation` (~426), `handleMergeOp` (~298), `handlePromoteOp` (~215) decompose into named passes like the other god functions. The **three-verb naming** (`revise`/`learn`/`consolidate`) is adopted as vocabulary — zero new machinery; `consolidate` names the existing memory-tier ops.
- **Existing behavior preserved exactly, verified by test:** the current merge/delete/promote/contradict ops through the existing `archiveMemory` bundle-local move (`consolidate.ts:838`) + `superseded_by` frontmatter + git history; the journals (`writeJournal`/`checkForIncompleteJournal`/`cleanupJournal`) and backup/recovery; the LOOK/CHANGE separation and signal-delta corrective-evidence gate (2026-05-26 synchronized-wave fix); the hot-capture guard; contradiction preserve-and-qualify; proposal-gating exactly as today. No new states, no water-marks, no pressure computation, no intake blocking, no CAS archive, no sandbox gate, no purge/quarantine commands.
- `resolveParentRef`/`isDerivedMemory` divergence (name-keyed vs path-keyed) collapses to one keyed-on-ref impl so the contradiction-edge producer/consumer cannot disagree (a DRY fix, not lifecycle work).

**Deferred to 0.9.1+ (normative §25 is target-state; nothing there is 0.9.0 scope):** the claim extractor + benchmark first — it is the load-bearing dependency; then operational retirement records, deterministic auto-retirement unification, pressure/health, the workspace CAS archive (D27 stands as the *target* decision; `archiveMemory`'s bundle-local move remains the status quo until then), sandbox replay, grace/restore, purge/quarantine, overlay, cross-bundle two-phase. Revisit on concrete demand, not on a schedule.

**Preserve list (binding):** everything named in "existing behavior preserved" above, plus **the canary probe + `canary_queries` store** (the offline measurement harness's retrieval gate, §13.2 carve-out).

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

- **state.db** (durable): events, proposals, task_history, improve_runs, extract_sessions, **+ migrated workflow_runs/steps/units, + migrated usage_events (rescued from index.db, §3.2)**. *(No bindings or lifecycle tables — Tier B / deferred; added by ordinary later migrations if they ever land.)*
- **index.db** (fully regenerable search cache — true only after the usage_events rescue).
- **logs.db** (high-volume purgeable) — **KEEP SEPARATE** (`#579`, `docs/technical/logs-audit.md`), joined via ATTACH.

### 8.2 workflow.db → state.db merge mechanics

1. The cutover DDL `CREATE TABLE`s `workflow_runs`/`workflow_run_steps`/`workflow_run_units` at FINAL shape (fold the 10 `WORKFLOW_MIGRATIONS` bodies `workflows/db.ts:178-368` into one baseline DDL) — plus the migrated `usage_events` (§3.2); **nothing else** (no bindings/lifecycle tables, §3.2) — inside the §3.3 journaled cutover (exact ATTACH sequencing in §3.3 item 3).
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

- **Import-cycle elimination + CI gate.** 62 circular import cycles at HEAD with real layering inversions: `core/improve-types.ts` imports `commands/improve/*`; `core/config` imports `integrations/agent/engine-resolution`; `core/common.ts` chains through asset-registry → output/renderers → commands/env; `harnesses/index.ts`'s "dependency-graph LEAF" claim is false; tasks/backends barrel self-cycles. Fix: move improve result types down into core; split config↔engine-resolution; make the harness-registry leaf claim true; the taxonomy deletion (Chunk 3) kills the asset-registry subset. **Gate:** the dependency-free ratchet `scripts/lint-import-cycles.ts` + `tests/architecture/import-cycle-ratchet.test.ts` (TS-AST static graph, Tarjan SCC; dynamic `import()` excluded as the sanctioned lazy-loading escape hatch) — **pre-armed at the chunk-7 HEAD (gate hardening, 2026-07-16)** with a shrink-only 107-file participant baseline plus a companion per-file dynamic-`import()` count ratchet (converting a static import to `import()` to dodge a cycle red is a visible violation, not an escape hatch), so Chunks 6/9 and all of Wave 2 cannot add a NEW file to the knot even before this workstream lands. Kill ownership (DoD 11): Chunk 9 takes the named knots + the small unowned local knots; the taxonomy set stays until Chunk 3, the indexer-db trio until Chunk 5's split, the workflows-runtime trio until Chunk 8's report decomposition — the baseline is EMPTY after Chunk 8 and the ratchet absolute. (Chunk 9; ~1–2 days, mostly type moves)
- **Single argv parse.** ~30 raw `process.argv` reads + a startup `process.argv` mutation bypass citty (repeated flags, `no-` booleans, `--` passthrough, double-reads). Normalize argv exactly once at entry into a typed ParsedInvocation, pass it down with RunContext; lint-restrict `process.argv` to `src/cli.ts`. (Chunk 9; −150 to −250)
- **`appendEvent` context adoption.** The DI fast path the plan cites as the RunContext exemplar has **zero** production adopters — all ~85 event sites double-open state.db (throwaway preflight + ledger assert) per event, heaviest inside improve loop stages. RunContext carries the open state.db handle; `appendEvent` consumes it; a test asserts hot paths never hit the slow path (~170 redundant opens per improve cycle removed). (Chunks 7/9)
- **Typed-error sweep.** 204 raw `throw new Error(` beside the AkmError/JSON-envelope contract (79 user-facing in commands/) + 6 out-of-hierarchy Error subclasses → UsageError/NotFoundError/ConfigError (or mapped) with stable codes. Mechanical, folds into per-directory chunks. (Chunk 9)
- **`llm/structured-call.ts` decision.** The "centralizes ~20 call sites" seam has 1 adopter; ten files still call `chatCompletion` raw. Finish the migration in the files Chunk 7 already rewrites (preferred, −100 to −200) or delete the seam. (Chunk 7)
- **Workflow driver god-fns (corrects §13.4's "no god-fn treatment needed"):** `exec/report.ts` hides a 438-line `reportWorkflowUnitWithBarrier` (file 1,798 LOC / 3 exports) and `native-executor.ts` a 212-line `executeStepPlan`; `step-work.ts` is genuinely decomposed. Split report's barrier fn into its own header's five named phases, in the same PR as W2's finalize-lock split (both edit report.ts). (Chunk 8; −250 to −350 inline complexity)
- **Opportunistic:** `setup.ts`'s 205-line `runSetupWizard` + four near-identical non-interactive entry points — decompose only if setup is touched for adapter-era onboarding.

---

## 11. Execution Order — Two Waves (hygiene first)

**Sequencing decision (external review, incorporated 2026-07-14):** the pure-hygiene half is unambiguous, high-value, and independent of the ref grammar; it lands **first** so its value banks even if the migration half re-plans. Wave 1 runs entirely on the current `type:name` grammar — its outputs (decomposed improve, one FileChange transaction, RunContext threading, DRY sweep) are re-keyed at cutover like all other state. Chunk IDs are stable; **the execution order is: Wave 1 = Chunks 0a, 7, 6, 9. Wave 2 = Chunks 0b, 1, 1.5, 2, 3, 4, 5, 6.5, 8, 10.**

In-branch chunks. Each chunk: deletion ledger, local green gate (`typecheck + unit + affected integration` **+ the §15 safety suites green at every chunk boundary**), net-LOC reported, and its named §15 test bucket landed in the same chunk. **Chunk 0b golden capture must re-anchor drifted lines** (`classifyBySmartMd` is at `matchers.ts:181`, not `:197`; re-measure config-schema before sizing). **The adapter-contract and identity fixes are already folded into the specs (adapter spec §§1–4 as amended); Chunk 2 mints adapters against the amended contract only.**

### WAVE 1 — Hygiene (no ref-grammar dependency)

**Chunk 0a — Hygiene goldens.** Behavior baselines for the surfaces Wave 1 touches: improve-run output goldens (the §5 behavior-change ledger baseline — self-consistency call counts, P0-A selection sets), proposal/transaction round-trip goldens (all three journal engines), CLI output baselines for the commands the sweep rewires. Gate: fixtures committed. Net: 0.

**Chunk 7 — improve decomposition + dead-lane deletions (Wave 1).** Decompose the 4 god fns + the consolidate ops (`planConsolidation`/`handleMergeOp`/`handlePromoteOp` → named passes; existing behavior preserved exactly per §6 — **no lifecycle state model, deferred**); adopt the three-verb naming (`revise`/`learn`/`consolidate` — vocabulary only); delete self-consistency/exploration/calibration/procedural/autotune/review_pressure/ValenceScore.lane/P0-A/multi-cycle **with the §5 behavior-change ledger attached**; trim promotion-policy literal; RunContext into `processSession` + `appendEvent` ctx adoption (§10.7); finish-or-delete `structured-call` (§10.7); serializer/resolveParentRef consolidation. Net: ~−3900.

**Chunk 6 — Proposal → FileChange[] + one transaction (Wave 1).** Collapse 3 FS journal engines into one FileChange transaction (preserve fsync + before-hash); `Proposal{changes:FileChange[]}`; dedup/cooldown → **fingerprints (with model-id term) + retained rejection backoff** in this same chunk (§4.5); delete the confidence gate; `bulkAdjudicateProposals`. Runs on the current ref grammar; proposal keys re-key at cutover like all state. *(Moved to Wave 2 with the grammar: export `#fragment` refs, the `parseAssetRef → 0` gate, and the legacy-import → migrator fold — the migrator home doesn't exist until Chunk 1.)* Gate: journal dirs removed; one-transaction fault tests green. Net: ~−800.

**Chunk 9 — Cross-cutting sweep (Wave 1).** Ambient RunContext threading (retire the 18 `_set*ForTests` seams); config discriminated schemas + reserved-knob deletion; output helpers/shape-registry dedup; health/tasks god decomposition; cli argv normalization to one ParsedInvocation (§10.7) + duration residue + caps(×10)/homeDir/mirror/session-log/spawn/semver/connection dedup; npm.path() + parseSourceSpec fixes; typed-error sweep (§10.7); import-cycle workstream (§10.7 — Wave 1 kills the non-taxonomy cycles: improve-types, config↔integrations, harness/tasks barrels; the CI gate lands as a **ratchet** — no new cycles, count monotonically decreasing — and hits **0** when Chunk 3 deletes the taxonomy cycles); delete stale `database.ts:14` comment + add Node 24 to node-smoke/release-gates matrices. Gate: grep `resolveStashDir` residual only in RunContext builder; cycle-ratchet baseline trimmed to the later-chunk-owned knots ONLY — taxonomy → C3, indexer-db trio → C5, workflows-runtime trio → C8 (ownership map in DoD 11; the ratchet itself was pre-armed at the chunk-7 HEAD — §10.7); grep `ImproveRunContext` → **0** (the legacy dual context unifies into the minted RunContext, emptying the `run-context-adoption` ratchet baseline and flipping it absolute); `createRunContext` constructed at every improve verb entry — adoption verified by the ratchet, not by prose. Net: ~−2000.

### WAVE 2 — Identity migration + adapters

**Chunk 0b — Migration goldens & oracles.** Snapshot recognition/placement/renderer/lint outputs for all 14 formats; capture `deriveCanonicalAssetNameFromStashRoot` minting oracle (`mv-cli.ts:769,1266`); re-anchor all line numbers at HEAD; capture **filter-behavior goldens** (proposed/belief/scope result sets) and whyMatched alongside rank metrics; build the **orphan-bearing migration fixture** (deleted-asset salience rows, bare refs, `.derived` twins) and the **rc-train FROM-state fixture**; inventory the §15 golden/characterization assets with their frozen-vs-re-baseline designation; build the **re-key merge property fixtures** (seeded three-spelling state generator + invariant harness — §12.3, exercised by Chunk 8). Gate: golden fixtures committed. Net: 0.

**Chunk 1 — Adapter base + util home.** Introduce the amended `BundleAdapter` interface (recognize-required/index-optional, `ValidateContext`, `affectedItems`) + the core `scanComponent` walk; relocate `SCRIPT_EXTENSIONS`/`WORKFLOW_EXTENSIONS`/`canonicalizeWorkflowName` + ref grammar constants to `core/recognition-util.ts`. Frozen COPY of the full legacy resolver surface into `migrate/legacy/legacy-layout.ts` (§3.4). Net: ~0.

**Chunk 1.5 — Open the type token (type-only severs).** `common.ts:29-88` union block, `salience.ts:52/650`, `eligibility.ts:9/39/169/477`, `mv-cli.ts:51,145,154,743`, `asset-ref.ts:109`. Relax `validateStashEntry` to open-token; mint the `KNOWN_TYPES` const tuple + typed tables (§2.3). Gate: grep `AkmAssetType` → **0**. Net: −80.

**Chunk 2 — Per-format adapters (10 adapters covering the 14 formats).** Each stamps recognize / placeNew / directoryList / presentation-table entries / `validate` locally (incl. the 6 static-only renderer mappings; the 9 index-time metadata contributors move into `recognize`). Adapters are minted against the amended contract only (recognize-required, `ValidateContext`, `affectedItems`, ordered `looksLikeRoot` probes). Skill adapter gains the Agent Skills contract (§4.5). The existing env/secret redaction renderers port as adapter-keyed presentation (behavior-preserving; **no new trust machinery** — §1.3). Net: adapters ≈ net-zero-to-negative (replace deleted globals).

**Chunk 3 — Delete taxonomy globals.** `asset-registry.ts`, `asset-spec` registry/renderer/action, `matchers.ts` competition, `file-context:242-265`, `path-resolver` disk-probe, `LINTER_MAP`+9 linters, `output/renderers.ts` type-registry. Repoint graph-extraction/ensure-index/walker/write-source/sources-resolve/provider-utils/git-stash/build-index to adapter metadata. Gate: grep `TYPE_DIRS` → **0**, `resolveAssetPathFromName` → **0**, `runMatchers` → **0**; the taxonomy participants leave the pre-armed cycle baseline (DoD 11 ownership map — the indexer-db and workflows-runtime knots remain until Chunks 5/8). Net: ~−1000+.

**Chunk 4 — Wiki asset-type death; LLM Wiki *adapter* restored.** The `wiki` *asset-type* dies (delete the type token, `wikiName` config special-case at 5 sites + indexer/search + read path `show.ts:428-432` + `SearchSource.wikiName`; rename `wiki-fetchers/`→`snapshot-fetchers/` keeping youtube/website; collapse `resolve-standards-context` Feature-A). But the **LLM Wiki adapter is a first-class built-in** (DEV-7): relocate the native wiki semantics from `wiki/wiki.ts`/`wiki-templates.ts` into an `llm-wiki` adapter that owns `schema.md`/`index.md`/`log.md`/`raw/`/`pages/`/xrefs/citations/ingest + validation — do **not** fold wiki pages into `knowledge`. Gate: grep `wikiName` → **0**; `wiki` type token → **0**; `llm-wiki` adapter conformance tests green. Net: smaller than the prior −1300 (adapter retained, not deleted).

**Chunk 5 — IndexDocument + ref grammar + db.ts split.** Rename `StashEntry`→`IndexDocument` + provenance + pinned signal columns (adapter spec §3); **the `[bundle//]conceptId` grammar lands here** — anchored body-ref form, REF_RE retarget, export `#fragment` refs, `parseAssetRef` deletion; **schema-column migration** (`entry_key/stash_dir/entry_type/entry_json` → the new column set) with utility/usage re-keyed onto `item_ref`; **diff persistence** (upsert-by-ref, drain-before-transaction, zero-document preflight — adapter spec §4) replaces truncate paths; split `db.ts` into storage repos + `jsonColumn()` helper; invert storage↔indexer arrow; unify scored/enumerate filter path; L0/L1/L2 derived index artifacts (cards/outlines per normative §15.2); `item_links` table + consumers; fold `.stash.json` legacyOverrides + `mergeLegacyEntry` + the pre-0.9 proposal legacy-import → migrator. Gate: grep `StashEntry` → **0**, `parseAssetRef` → **0**, `.stash.json`/`loadStashFile` → **0**; §12.3 parity gate green incl. filter parity; the test codemod commit is **script-only** with the ≥20-literal mutation spot-check recorded (§15 rule 2 — "mechanically regenerated" includes `DESIGNATIONS.json` path/hash updates the script emits when fixture paths move); the db split lands cycle-free — the indexer db/entry-mapper/schema trio leaves the pre-armed cycle baseline (DoD 11). Net: ~−480. **Execution staging (ref-grammar decision, `akm-0.9.0-ref-grammar-decision.md` §4 — binding):** the flip lands as F0 (pin the D-R2 qualified conceptId spelling + parity re-proof) → F1 (resolver + dual-input readers repointed onto `item_ref`) → F2 (the script-only codemod, behind the F1 readers) → F3 (segregated hand bucket) → F4 (indexer swap to `scanComponent` + `StashEntry`→`IndexDocument` + UNIQUE `item_ref` + state re-key + D-R6 reserved-filename exclusion) → F5 (old grammar + dual-input shim deleted, closing the §11.4 window inside the chunk). Codemod and grep gates unchanged.

**Chunk 6.5 — Activation policy (Tier A — install≠activate consolidation).** Consolidate today's scattered install≠activation enforcement — the `registryId` first-party/third-party block-vs-warn (`env-binding.ts:110-121`), the add-time dangerous-key scan (`add-cli.ts:74-215`), task `enabled:` state (YAML + `runner.ts:159` fire-time check), and `writable` (`search-source.ts:35`) — into ONE workspace activation-policy point, and confirm-by-test that installing a bundle with tasks/env/workflows grants nothing until an explicit enable. **These are ports of existing behavior; the conformance tests assert the existing rules still fire after the config migration** (e.g. env injection from a registry-installed source still hard-blocks dangerous keys). **No new trust/approval machinery ships** (2026-07-14 decision, §1.3): no labeling, no action clamps, no confirm prompts, no digests, no trust records. **env/secret handling is UNCHANGED** — whole-file assets inside stashes/bundles (`<stash>/env/`, `<stash>/secrets/`), resolved from the stash, with the existing `registryId` policy; nothing moves workspace-side. Accepted-by-design residual (documented, not gated): workflow refs resolve across installed sources and re-read current disk content per invocation — crontab semantics; operators choose what they install and reference. **DEFERRED to Tier B (indefinitely; revisit only on concrete demand):** the persisted `workspace_bindings` record, export digests + update-change detection, rebind-on-update, and the `akm bind|unbind|bindings` CLI. Net: **+200 to +400** (decision logic consolidates; the interactive confirm/rollback UX in add-cli stays where it is). *(2026-07-13/14 refinements — supersede the earlier "restore bindings full, DEV-3.")*

**Chunk 8 — Three-DB merge + migration cutover + config/lockfile.** The §3.3 journaled cutover (workflow DDL fold + usage_events rescue + full re-key + orphan quarantine + ATTACH sequence; **no bindings/lifecycle DDL** — §3.2); delete `workflows/db.ts` + workflowDb locations/paths (frozen WORKFLOW_MIGRATIONS copy retained, §8.2); index.db quarantine-rename + out-of-gate rebuild; **config migration** `stashDir`/`sources[]`/`installed[]`/`wikiName` → `bundles`/`defaultBundle` + **bundle lock state** (normative §10.2; supersedes the per-source `integrations/lockfile.ts` shape; the `bindings:` config map is Tier B — **not emitted** by the 0.9.0 migrator, mirrored in Chunk 10's schemas item); report.ts barrier-fn decomposition with the W2 finalize-lock split (§10.7). Throwaway migrator `@removeIn` next-minor. Gate: 4→3 DBs; backup-verified restore green **including a pre-cutover backup restored by the post-cutover binary**; orphan fixture completes-with-quarantine; rc-train FROM-state fixture green; **re-key merge property test green over ≥1000 generated cases** (Chunk 0b generator; §12.3 — the hand-built fixtures alone do not satisfy this); the workflows-runtime trio leaves the pre-armed cycle baseline with the report.ts decomposition — the baseline is EMPTY here and the ratchet absolute (DoD 11). Net: ~−200 (coordination rework priced in).

**Chunk 10 — Contract-surface + docs/assets sweep (§16).** STABILITY.md/roadmap/AGENTS.md ref-contract rewrite (decision D28); CHANGELOG normalization + the one true 0.9.0 migration note; `docs/migration/v0.8-to-v0.9.md` + `release-notes/0.9.0.md` rewritten to this refactor's story; stash-skeleton conventions → adapters + stamped-copy refresh decision; improve-strategy `allowedTypes` schema + shipped JSONs + user-file migration; published `schemas/` regen (no `bindings:` key emitted — Tier B) + remove `schemas/**` from ci paths-ignore; docs three-tier sweep (rewrite ref.md/concepts/cli/classification/architecture/features; archive superseded plans; posts untouched); embedded assets (hints/help/akm-asset/akm-eval cases) migrated with the §7.3 shipped-assets lint; scripts/ into biome+tsc; `check:changed` fixed; `noExplicitAny`→error (16 sites) + evaluate `noUncheckedIndexedAccess`; example-stash re-laid out; CLI convergence per normative §29 (the bundle command family; the `akm bind|unbind|bindings` subcommands are Tier B, deferred; `wiki`/`manifest`/`curate`/`propose <type>` folds land with the chunks that delete them). Net: docs/assets, LOC-neutral in src.

**Zero-count grep gates (scope: `src/` + `scripts/` + `src/assets/`, excluding `src/migrate/legacy/` — the frozen §3.4 copy retains dead identifiers by design, and renaming them inside the copy to appease greps would defeat its frozenness; tests are driven to zero by the §15 ratchet on the same identifiers; docs by the Chunk 10 sweep):** `TYPE_DIRS`, `AkmAssetType`, `parseAssetRef`, `wikiName`, `StashEntry`, `resolveStashDir` (outside RunContext builder), `.stash.json`, `getAssetTypes`, `ASSET_SPECS`, `LINTER_MAP`.

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
| Activation policy — Tier A consolidation (Chunk 6.5; persisted record + CLI deferred to Tier B) | +200 to +400 |
| Memory lifecycle | **+0 — deferred entirely to 0.9.1+ (§6, deviation §4.3b)** |
| Progressive disclosure L0/L1/L2 artifacts + `#fragment` + `item_links` | +500 to +900 |
| **Adds subtotal (budgeted)** | **≈ +1,300 to +1,900** |
| **TOTAL (0.9.0, src) — REPORTED, not a gate (§1.3)** | **≈ −11,100 to −13,700 net removed (+1 MB asset dropped)** |
| Test churn (ledgered separately, §15; not counted in the src ledger) | ~15 files deleted / ~150 codemodded / ~40–60 rewritten / ~10 goldens re-baselined + new §31 suites |
| 0.9.1 measurement-pass prove-or-delete tier (§13.2) | up to a further −6,000 to −12,000 |

### 12.2 Definition of Done

1. All zero-count grep gates pass at their declared scopes (§11).
2. 4→3 DBs; cutover journaled and fail-closed per §3.3; backup-verified restore green **including pre-cutover backups restored by the post-cutover binary**; orphan fixture completes-with-quarantine; throwaway migrator `@removeIn` next-minor.
3. Every format handled by one adapter; no type-competition matcher/renderer/action/linter registry remains (the named-function renderer module and `TYPE_PRESENTATION` table are the replacement, not a violation).
4. `Proposal` carries `FileChange[]`; one transaction applies all mutation (proposal/revert/mv).
5. improve = **three verbs** (`revise`/`learn`/`consolidate`) over passes; no god fn >~200 LOC in improve; consolidate behavior preserved exactly per §6 (goldens from Chunk 0a).
6. Salience machinery intact; dead lanes (review_pressure, ValenceScore.lane) gone; outcome-weight under reversible parity flag; behavior-change ledger (§5) reviewed.
7. Ambient `loadConfig`/`resolveStashDir` gone from leaves; RunContext threaded; `appendEvent` fast path adopted on hot loops.
8. The §12.1 ledger is **published with actuals** (deletions, signed adds, net) — reported, not gated (§1.3); the deletion inventory itself is gated by item 1's zero-count greps and the per-chunk deletion ledgers.
9. All preserve-list infra (S26 + canary probe/store) present and exercised by a test.
10. **Activation (Tier A):** install≠activate — installing a bundle with tasks/env/workflows grants nothing until an explicit enable, verified by test, with the enforcement consolidated to one workspace policy point; env/secret handling unchanged; the existing `registryId` dangerous-key rule fires identically post-config-migration. **No new trust/approval machinery shipped** (§1.3). (Persisted record + digests + `akm bind` CLI are Tier B, deferred — §13.3.)
11. Import-cycle participant baseline is EMPTY and the pre-armed ratchet (armed 2026-07-16 at the chunk-7 HEAD — §10.7) is absolute. Ownership of the kills: Chunk 9 the §10.7-named knots plus the small unowned local knots (graph pair, graph-db pair, ranking pair, proposal repository↔validators, wiki-fetchers back-edge, write-source↔git, events pair); Chunk 3 the taxonomy set; Chunk 5 the indexer db/entry-mapper/schema trio (db split lands cycle-free); Chunk 8 the workflows-runtime step-work/runs/unit-checkin trio (report decomposition) — baseline empty from there.
12. Docs/assets/schemas surfaces migrated (Chunk 10): no shipped asset, hint, published schema, or normative doc teaches the dead grammar.

### 12.3 Architecture contract tests

- **Ref/type pin** (§7.3): anchored body-ref grammar resolves in lint/mv/search-prefix; presentation/ranking type tables (typed over `KNOWN_TYPES`, §2.3) + shipped-assets lint agree on the known-type spelling set.
- **Golden recognition/placement/renderer/lint** parity for all 14 formats (Chunk 0b fixtures) — plus `index() == fold(recognize)` conformance for adapters overriding `index()`, and per-adapter `looksLikeRoot` fires on its own golden root and no sibling's.
- **Search parity gate**: nDCG/MRR/recall/banned-hit **+ filter-behavior parity (proposed/belief/scope) + whyMatched parity**; canary re-mint as a named step.
- **Canonical-name minting** oracle parity (`deriveCanonicalAssetNameFromStashRoot`).
- **git exact-path staging** still scopes to adapter `directoryList()` (not nothing-staged).
- **Migration round-trip**: rc-train fixture DB → cutover → all live refs re-keyed, expected orphans quarantined (not aborted), restore-on-fault green, pre-cutover backup verifiable post-cutover.
- **Re-key merge property test** (gate hardening, 2026-07-16): a seeded generator (Chunk 0b) produces randomized state across the three ref spellings (bare / origin-qualified / `.derived` twins); the Chunk 8 cutover must hold the merge invariants over ≥1000 generated cases — no key lost, event rows carried as-is with counts preserved, scalar fields most-recently-updated wins, output deterministic and idempotent. The two hand-built fixtures (orphan-bearing, rc-train) do NOT satisfy this on their own: the three-spelling merge is an algebra, and two examples cannot pin an algebra.
- **One transaction**: mid-apply fault leaves no partial write (before-hash abort).
- **Consolidate behavior preservation** (DoD 5): the decomposed passes reproduce the Chunk 0a goldens — merge/delete/promote/contradict outcomes, journal round-trip, hot-capture guard, contradiction preserve-and-qualify — byte-for-byte where deterministic.
- **Install≠activate port-preservation** (DoD 10, Tier A): install grants nothing; an explicit enable grants exactly what it grants today; env injection from a registry-installed source still hard-blocks dangerous keys after the config migration. (Digest-change-forces-re-review is a Tier-B test, deferred with the persisted record.)

### 12.4 Risks & mitigations

- **git-stash pathspec silent degrade** — a preserved S26 feature (`git-stash.ts:241`) is built from dying `Object.values(TYPE_DIRS)`; if the adapter `directoryList()` is not wired, `git add -- <pathspecs>` scopes to nothing and commits skip. Mitigation: contract test in 12.3; wire before Chunk 3 lands.
- **Install-time recognition underweighted** — `provider-utils.detectStashRoot` (`:33-197`) and `git-provider.hasExtractedRepo` (`:188-202`) are second recognition sites; `akm add` fails to detect a valid bundle root if only the index path is repointed. Mitigation: thread adapter directory-list into both.
- **website snapshot machinery mis-deleted with wiki** — `fetchWebsiteMarkdownSnapshot`/youtube feed the knowledge path, not wiki. Mitigation: rename-not-delete `wiki-fetchers/`.
- **Migration boundary faults** — the cutover's non-atomic edges are filesystem operations (workflow.db delete, index.db quarantine-rename), not the SQL transaction. Mitigation: the §3.3 journaled phases; index rebuild outside the fail-closed gate; ATTACH sequencing as specified (verified empirically on the actual runtime).
- **Parity-flip premise** — outcome weight is default-ON, not inert; a naive "flip the config default" is a no-op (no `.default()` exists). Mitigation: the 3-site `!== false` edit + comment fix, deferred, reversible.
- **Line drift** — several plan anchors already drifted (`classifyBySmartMd` :181, `processSession` :550/19-args, `stepSmallModelConnection` :455). Mitigation: Chunks 0a/0b re-anchor before any golden capture in their wave.
- **Test-wave stall** — the first chunk touching `asset-spec.ts` turns ~2,000 test ref-literals red at once. Mitigation: the §15 codemod lands atomically with the ref-grammar change; safety suites are port-first.
- **Scope creep on the adds** — the only budgeted adds are the Tier-A activation-policy consolidation (+200–400) and the retrieval-surface items (+500–900). Anything lifecycle-shaped (states, water-marks, pressure, CAS archive, sandbox gate, purge/quarantine — §6) or trust-shaped (labels, clamps, prompts, digests, records — §1.3) is deferred/rejected and **must not slip in** through a chunk's side door. Early-warning sign: if threading source/trust context to the task runner or native executor exceeds ~150 LOC inside Chunk 6.5, stop and re-scope rather than creep toward the record.
- **Wave-1 rebase friction** — Wave 1 lands on the current grammar; Wave 2's re-key then touches Wave 1's outputs (proposal keys, decomposed-pass state reads). Mitigation: Wave 1 outputs are re-keyed by the same §3.2 pass as all other state — no special-casing; the Chunk 0a goldens are grammar-agnostic where possible (counts/outcomes, not raw refs).

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
| Env-gated deterministic embedder: relocate test scaffolding only — **the `AKM_EMBED_DETERMINISTIC` env-gated switch STAYS in the production embedder facade** (`embedder.ts:120,154`). The akm-eval harness sets the env var on subprocesses of the real akm binary (`curate-bench.ts:159`), and the §13.2 offline measurement pass depends on that hook; ripping it out to a test fixture would break the harness | `deterministic.ts:8` "NEVER used in production (env-gated, off)"; consumers: tests + `scripts/akm-eval` black-box runs | 9 | −60 (scaffolding only) |
| `core/eval/rank-metrics.ts` → relocate under `scripts/akm-eval/` | only importer is `scripts/akm-eval/.../curate-metrics.ts:7` re-export; **zero** `src/` importers | 9 | −180 (move) |
| Filesystem plugin-loader for a one-element fetcher registry → inline | one-element registry (youtube) behind a generic loader | 4 | −55 |
| `--format html` generic template framework → health-only render (every other command's "HTML" is JSON-in-`<pre>`, `cli/shared.ts:205`) | `html-render.ts:26` per-command template + unused `default.html` | 9 | −160 |
| `review_pressure` / `ValenceScore.lane` (already §9.2) | no readers | 7 | −85 |

These raise the 0.9.0 total to **≈ −13,000 to −15,000 net** (§12.1).

### 13.2 0.9.1 measurement pass (prove-or-delete tier, up to a further −6,000 to −12,000)

Do **not** litigate these in 0.9.0 — they are default-on subsystems whose value is *unmeasured*, and one harness run resolves them together. Gate a single **0.9.1 measurement pass** on one nDCG/MRR + saturation-harness run against the curate-golden set (the same run the §9.3 parity flip needs):

- **Cluster A — the near-zero-signal apparatus** (~600 LOC + tables): outcome loop, encoding-salience NLP model (`encoding-salience.ts`, 258), scoped-utility EMA (`utility_scores_scoped`), dual weight-triple + parity flag, and `loadSalienceRankScores` (the only cross-DB reach on the search hot path, §14.2 A3). The code's own tripwire reports `corr=+0.0104` at n=5,706 and emits `outcome_proxy_dead` (`preparation.ts:1678`). Run at `w_o=0`; if rankings don't move, delete the loop + `review_pressure` + scoped table + parity triple, and fall encoding back to the existing `DEFAULT_TYPE_ENCODING_WEIGHTS` stub.
- **Graph extraction** (~4,288 LOC, `indexer/graph/*` + `llm/graph-extract.ts`): default-on, per-batch LLM cost, one conditional `computeGraphBoost` (`db-search.ts:782`) with no nDCG proof. Must show a measured rank delta or go default-off + drop the boost. (Native `item_links` are navigation/lint data and are NOT part of this measurement — adapter spec §9.)
- **Collapse-ALERT loop only** (~530 LOC): `collapse-detector.ts:22` "observe-only… nothing is ever blocked"; advisory alerts + full scans every cycle. Must have caught one real event or collapse to a single cheap health metric. **CARVE-OUT: the canary probe (`scoreCanary`/`buildCanaryQuery`) and the `canary_queries` store are NOT in this tier** — they are the offline measurement harness's retrieval gate (this section) and the deferred lifecycle's future gate (§6); moved to the §13.4 preserve list. Only the alert/monitor loop around them is prove-or-delete.
- **`mergeInformationFloor`** (verified observe-only, §1.4): prove the floor should become a real gate, or delete it with this cluster.

Batch them: one measurement run decides all of these at once.

**Run it offline, not against the live production loop.** These gates do not depend on the workstation's improve loop generating telemetry — most are already deterministic: nDCG/MRR/recall/leapfrog run on the `curate-golden` fixtures + `AKM_EMBED_DETERMINISTIC` via the pure `core/eval/rank-metrics.ts` (no LLM, no live data); the retrieval runner needs only a built index.db; the collapse/canary recall+entropy gate is FTS-only, no-LLM by hard invariant (`collapse-detector.ts:18-20`). The outcome-proxy corr tripwire (`+0.0104`) is deterministic math over a populated state.db (≥500 rows) — **seed it** from a one-time export of the real `asset_outcome` distribution (n≈5,706 today), or from synthetic `usage_events`+`proposals`, so no live loop is required and the verdict still reflects real usage shape. Only proposal *generation* needs a model, satisfied by a local Ollama/llama.cpp/lmstudio endpoint (the eval judge already speaks these) at zero API cost. The harness reuses `createSandbox` (`scripts/akm-eval`), the deterministic/local embedders (the `AKM_EMBED_DETERMINISTIC` facade hook is on the preserve list — §13.1's relocation moves scaffolding only), `--dry-run` seams, `akm extract` + session fixtures, and the Phase-6 record/replay subsystem (`akm-eval-replay` + the three JSONL capture logs); it must add (a) **an `asset_outcome` exporter + state.db seeder** for the n≥500 tripwire — the exporter is a **one-shot throwaway script** (`scripts/export-asset-outcome.ts` or similar, local dev/testing only, not a product surface, deleted when the measurement pass concludes) since no export mechanism exists today, (b) a baseline-vs-candidate index.db overlay driver for the canary gate (the A/B two-sandbox pattern already exists in `graph-ablation.ts`), and (c) an LLM record/replay (or local-endpoint) seam for the proposal stages. These three adds are explicit 0.9.1 line items so they don't become silent scope. This keeps the measurement reproducible in CI and off the workstation's GPUs — decoupling the release gate from live-telemetry health and from GPU load on the dev box.

### 13.3 Final scope dispositions (2026-07-14)

The residual audit's instincts were largely vindicated by the final decisions; this section records the final shape:

- **Bindings/activation — Tier A IN SCOPE (Chunk 6.5); everything else Tier B, deferred indefinitely** (2026-07-13/14 refinements, supersede the DEV-3 "restore full"). Ground-truth of the current code: install≠activation, workspace-owned engines (credentials never in bundles), runtime ref→values resolution (`resolveEnvBinding`, `${secret:NAME}`), and `registryId` first/third-party policy ALREADY exist; the only genuinely-new machinery would be a *persisted* approval/enable/trust record with an export digest + rebind-on-update, for ~one consumer today. **Tier A (0.9.0):** consolidate those existing behaviors into one workspace activation-policy point — ports only, no new trust/approval machinery of any kind (§1.3; the earlier "read-path clamp" idea is dropped with the rest). **env/secret unchanged** (whole-file assets in stashes/bundles with existing `registryId` policy — nothing moves workspace-side). **Tier B (deferred indefinitely; revisit only on concrete demand — no trigger-watching machinery):** the `workspace_bindings` record, export digests, rebind-on-update, and the `akm bind|unbind|bindings` CLI. Rationale: approval/trust machinery built ahead of demand is false-confidence machinery that must be maintained as brittle code; the accepted residual is documented in Chunk 6.5. Budgeted +200–400.
- **Memory lifecycle — DEFERRED ENTIRELY (2026-07-14 decision, deviation §4.3b; supersedes the DEV-4 "restore full").** 0.9.0 ships only the consolidate decomposition with behavior preserved (§6). The lifecycle state model waits for the claim extractor + benchmark, then gets its own design pass. Normative §25 is target-state, not 0.9.0 scope.
- **Adapter capabilities** — optional methods on one `BundleAdapter` interface (DEV-6), never an `extends` hierarchy; renderer/action mapping is a data table typed over `KNOWN_TYPES` (§2.3) pointing at a named-function core module.
- **Outcome-weight parity flag** — still deferred, resolved in the §13.2 measurement pass rather than carried indefinitely.
- **Storage `Repository<Row,Domain>` base class** → do **NOT** introduce (§14 F8). 12 of 13 repos are plain function modules; the open/borrow duplication is already solved by `managed-db.ts`. Ship only the `jsonColumn()` codec helper and keep the function-module convention — a class hierarchy over function modules is framework-before-value.

### 13.4 Leave alone (do not over-cut)

Embeddings + FTS/vector hybrid ranking core (broadly-used); the three OS scheduler backends — **VERIFIED load-bearing (§14 F-tasks): there is NO in-process scheduler; `tasks/embedded.ts` only lists YAML templates for the setup wizard, so AKM delegates all recurring scheduling to the OS, and dropping launchd/schtasks would leave macOS/Windows with no scheduling at all. Residual-audit finding #8 is WITHDRAWN.**; the JSON output envelope and human/agent shape axis (load-bearing); `archiveMemory` and the extract/consolidate core (the ~4 processes with proven live output); the `ndcg`/`recall`/`mrr` math (relocate, don't delete); **the canary probe + `canary_queries` store** (§13.2 carve-out — the offline measurement harness's retrieval gate, and the deferred lifecycle's future gate). **Also verified load-bearing and left alone:** the workflow frozen-plan / run-lease / per-unit journal / resume machinery — *with the correction (§10.7) that the shared `step-work.ts` layer is well-decomposed but the two drivers are not*: `exec/report.ts` hides a 438-line `reportWorkflowUnitWithBarrier` and `native-executor.ts` a 212-line `executeStepPlan`, both split in Chunk 8; the shared SQLite migration engine + `managed-db` + provider seam; the engine/spawn/dispatch runtime (`spawn.runAgent`, `engine-resolution`, `runner`); the harness registry (a real DRY win — once §10.7 makes its leaf claim true). See §14.

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
2. **Codemod, atomically — and script-only.** The ~2,003 ref literals + ~100 directory-layout literal files migrate via a script committed to `scripts/`, landing **atomically with the ref-grammar change** (Chunk 5, Wave 2). The codemod COMMIT contains only the script plus its mechanically regenerated output — **zero hand-edited test hunks**; hand edits go in separate, individually reviewable commits (mixing them into the codemod commit is an adherence blocker — the reviewable artifact is the script, not 2,003 diff hunks no reviewer can actually read). The assertion-review pass is then backed by a **mutation spot-check** recorded in the chunk report: revert ≥20 randomly sampled re-keyed literals and confirm the suite goes red — a sample that stays green means the codemod neutered assertions and the gate fails. A grep ratchet (extend the existing `lint-isolation-ratchet` pattern) drives `StashEntry`/`parseAssetRef`/`TYPE_DIRS`/type-prefix literals in `tests/` to zero.
3. **Safety suites are port-first and green at every chunk boundary** (~4,700 LOC / ~22 files): traversal/escape (env-traversal, workflow-path-escape, tar-utils-scan, git-source-safety), symlink handling (12 files), redaction/dangerous-key, SQLite journal/busy/lock/contention/cross-proc, and the migration suites (`migration-lifecycle-regression` 1,062 LOC, `migration-backup` 405 — extended, not rewritten, to cover the §3.3 cutover). Fixed points: `_helpers/sandbox.ts`, `_preload.ts`, the mock.module-ban lint, and the hand-rolled sharding (documented Bun-race mitigation — do not touch).
4. **Taxonomy-pin deletions land with their replacements** (~13–16 files / ~2,500–3,000 LOC: asset-ref/asset-spec/asset-registry/exhaustive-registry-coverage/contracts pins, walker.test, wiki.test minus the fetcher subset): each deletion in the same commit as its §12.3 replacement contract test, so the exhaustiveness guard never gaps.
5. **Goldens re-baselined once, deliberately — and mechanically present.** Enumerate the 35+ golden/characterization assets (CLI output baselines, the ranking-baseline fixture stash, SQLite-migration snapshots, 6 characterization suites); each is designated (a) frozen as migration-input fixture or (b) re-captured post-cutover in its designated chunk with a reviewed diff. Re-recording outside the designated chunk is forbidden. **Presence and integrity are a lint, not a promise** (gate hardening, 2026-07-16, after the 07-15 purge deleted the entire Chunk 0a oracle set and the chunk gates kept passing vacuously): `scripts/lint-goldens-presence.ts` (in `bun run lint`) fails when `DESIGNATIONS.json` or any registered asset/consumer suite is missing, when a `frozen-migration-input` asset's bytes no longer match its registry sha256 pin (so `AKM_UPDATE_GOLDENS=1` cannot silently re-record a frozen oracle), or when a consumer suite is gutted (no `expectGolden`/`loadGolden` call, `.skip(`, or no reference to its fixture path). A gate that references goldens is RED — never skipped — when the referenced files are absent. **Surface-owner rule:** a chunk the plan orders to change an asset's pinned surface becomes that asset's re-baseline owner — re-designate the entry before the change lands (the five journal-engine-shape fixtures are so designated `re-baseline @ Chunk 6`; the outcome-level txn oracles stay frozen). The 0a set (49 surviving designations; SC/P0A retired by chunk 7's ledger) was restored from git and re-validated green at the chunk-7 HEAD.
6. **Manual-rewrite bucket** (~40–60 files / ~25–35K LOC): the 37 StashEntry consumers (incl. mv.test 1,829, indexer.test 1,694, e2e.test 1,931), 12 parseAssetRef files, install/recognition tests (source-providers/, provider-utils — the §12.4 risk area), keyed to the chunk that changes each API.
7. **New mandated suites** (normative §31, as staged): consolidate behavior-preservation goldens (Chunk 0a/7), transaction fault injection (Chunk 6), adapter conformance (Chunk 2), search parity incl. filter parity (Chunk 5), install≠activate port-preservation (Chunk 6.5), migration crash/orphan/rc-FROM-state (Chunk 8). *(Lifecycle and trust suites are deferred with their subsystems.)*
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
