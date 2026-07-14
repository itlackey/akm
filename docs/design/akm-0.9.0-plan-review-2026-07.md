# Implementation Plan Review — AKM 0.9.0 Comprehensive Clean-Up

> **Disposition (2026-07-13):** the §11 pre-execution checklist has been **applied to the plan in place** — reconciliation edits (chunks 6.5/7.5/10, rebuilt §12.1 ledger with signed adds, DoD 1–14, extended §12.3 contract tests, superseded passages struck); migration rewrite (§3.3 journaled cutover-as-code, usage_events rescue, orphan taxonomy, verified ATTACH sequence, index-rebuild boundary, thick legacy reader, rc FROM-state); §15 test strategy and §16 contract-surface sweep added; refuted/drifted claims corrected in §1.4/§4; canary carve-out in §13.2; the §8 missed-debt workstreams added as §10.7. The versioning question is resolved by maintainer decision: **this refactor IS 0.9.0** — the rc-train's published migration docs are rewritten to it (plan §16). This report is retained as the review record.
>
> **Superseded-scope addendum (2026-07-14, D30):** this report's binding and memory-lifecycle asks were subsequently rescoped — bindings ship at **Tier A only** (the Binding-DDL/`akm bind`-CLI/digest items here are Tier B, deferred indefinitely), the **memory-lifecycle chunk was removed entirely** (deferred behind the claim extractor), all new trust/approval machinery was dropped, net-LOC was demoted to a reported ledger, and the chunks were resequenced hygiene-first. See deviation-analysis §4.3a–3c and history D30 for the current scope.

**Scope:** deep review of `akm-0.9.0-bundle-adapter-architecture-plan.md` (and its companions: the reconciled bundle-adapter spec, the residual-complexity audit, the greenfield-vs-refactor decision, the deviation analysis) as an *executable implementation plan*. The plan is the authority for 0.9.0; nothing already shipped in the rc train has precedence over it — existing code, including the rc-era migration machinery, is evaluated below strictly on whether it serves the plan's own requirements.

**Method:** ~90 factual code claims from the plan were verified against HEAD (`3fe3aef`) with fresh greps and line counts (no doc line numbers trusted); the migration design was tested empirically against the actual runtime (bun:sqlite / SQLite 3.51.2 ATTACH/transaction semantics); the chunk order, ledger, DoD, and contract tests were audited against the reconciled scope; and three sweeps hunted for work the plan misses (the test suite, repo surfaces outside `src/`, and `src/` debt outside the plan's inventory).

**Companion report:** `akm-target-design-review-2026-07.md` covers the target architecture itself.

---

## 1. Verdict

**The plan's code inventory is unusually accurate — and the plan is not executable as written.** Those two things are both true and the distinction matters:

- The **§4 DELETE/MOVE/REPLACE inventory and the §13–14 audits are of genuinely high quality.** Of ~90 verified claims, the large majority are CONFIRMED, many with exact-LOC matches (the improve/salience bundle went 15-for-15, several to the line). The 14/8/6 renderer split-brain claim is exactly right. The dead lanes are really dead, the god functions really are that size, the tripwire really reads corr=+0.0104. Whoever wrote this read the code.
- But the plan fails as an *execution document* on four fronts: **(A)** the 2026-07-13 reconciliation was applied as a banner while the operational core — §11 chunks, §12.1 ledger, §12.2 DoD, §12.3 contract tests — still encodes the pre-reconciliation scope, and §6 still contains the affirmative instruction *not* to build bindings; **(B)** the §3/§8 migration design contains one outright data-loss defect (`usage_events`) and a core mechanism (`state-018` as a sealed static-SQL migration) that cannot be implemented in the existing engine; **(C)** the test suite — *larger than src* and 57%-by-LOC coupled to identifiers the plan deletes — is budgeted at zero; **(D)** whole contract surfaces outside `src/` (STABILITY.md, published schemas, shipped assets/hints, user-stamped conventions, docs) break under drop-ref with no plan chunk.
- A handful of the plan's own claims are **refuted** and would cause wrong changes if executed as written (§3).

**Recommendation:** one focused re-edit pass of the plan (roughly the items in §8) before Chunk 0 starts. The architecture is decided; this is about making the document match the decided scope and fixing specific mechanical defects. Nothing found here argues for changing course.

---

## 2. Claim-accuracy scorecard

Verified per-bundle against HEAD. Summary: **~70 CONFIRMED, 3 REFUTED, ~17 DRIFTED/PARTIAL.**

### 2.1 REFUTED — would cause wrong changes if executed

1. **`mergeInformationFloor` is genuinely advisory — the plan's "correction" is itself the error.** Plan §4.2/§10.2 asserts the schema comment ("ADVISORY; never refused") is misleading because the floor "IS a live gate at anti-collapse.ts:143" and warns that deleting the schema would change behavior. Reality: `checkMergeInformationFloor` computes pass/fail, but its only production caller (`consolidate.ts:2343-2354`) counts the violation, pushes a warning — "merge proceeds (v1 observe-only)" — and continues to write the merge. The schema comment is *accurate*. Fix the plan: drop the RENAME item; the field is an observe-only metric and can be handled like the other observe-only knobs (and it is a candidate for the same prove-or-delete treatment as the collapse detector).
2. **Proposal dedup/cooldown is live machinery, not bypassed.** Plan §4.5 deletes it because "callers already pass force:true." Only 3 of 11 `createProposal` call sites force (the two human CLI paths and recombine's promote path); **all automated improve pipelines rely on the dedup/cooldown guard today.** Deleting it is a behavior change for every unattended path and must be sequenced *with* its replacement (the §23.6 fingerprint scheme) — and per the design review, the rejection-backoff windows (14d reflect / 30d distill / 7d other) should be *retained alongside* fingerprints, not deleted, because fingerprints alone re-propose near-identical rewrites the day after a human rejection whenever any new evidence lands.
3. **The Node/better-sqlite3 DoD gap (§14.4) is stale.** CI's `node-smoke` job compiles the native driver and runs smoke + parity suites under Node 20 and 22 **on every commit**; only the code comment at `database.ts:14` is stale. Replace the plan item with: delete the stale comment, and add Node 24 (current LTS) to the `node-smoke`/release-gates matrices — the actual residual gap.

### 2.2 DRIFTED/PARTIAL — right idea, wrong details (correct before executing the affected rows)

| Plan claim | Correction |
|---|---|
| `SCRIPT_EXTENSIONS` 17 extensions | 16 (`asset-spec.ts:104-121`) |
| `classifyBySmartMd` in file-context.ts | Lives in `matchers.ts:181`; the registry+competition (`runMatchers`) is in `file-context.ts:242-265` |
| Closed-union `isAssetType` gate in asset-ref | Runtime-open: checks `Object.hasOwn(TYPE_DIRS, type)`, so dynamically registered types pass; only the TS union is closed. (Chunk 1.5's "type-only severs" framing is *more* right than the plan knows) |
| `common.ts:29-88` hand-maintained ASSET_TYPES block | Registry-derived (`Object.freeze([...getAssetTypes()])`); ~45–50 non-contiguous lines |
| ImproveProcessConfigSchema "~40 'only meaningful on X' comments" | 30 (god object confirmed, ~263 lines at `config-schema.ts:311-573`) |
| `GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED` incl. "stale `wiki`" | 10-type hardcode exact; but `wiki` is a live registered type — its graph-staleness is inference. **New finding:** the runtime SUPPORTED set silently drops schema-allowed `fact` — a real desync to fix |
| `getEmbeddableEntryCount` "byte-identical" to `getEntryCount` | Delegating alias (`return getEntryCount(db)`), redundant but not duplicated SQL |
| "3 divergent `mergeLegacyEntry` copies" | 3 copies, but 2 are textually identical; only `indexer.ts:1727` diverges (forces source/quality/confidence) |
| `caps()` byte-identical across 8 harness files | **10** files (9 index.ts + opencode-sdk/harness.ts, identical md5) |
| P2 harnesses "codex-extras", builders ~1086 / extractors ~1103 LOC | Dir is `codex`; 946 / 1014 LOC. Stale "NOT registered anywhere" headers confirmed on all 7 — but `builder-shared.ts`'s "no builder consumes schema" is stale the other way: **8** builders consume `req.schema` |
| `AkmHarness.resume` reserved-dead "across all 10 harnesses" | Declared on 6/10; only 2 `*_RESUME_FLAG` constants exist. All genuinely dead — delete list shrinks |
| `rank-metrics.ts` only importer is the scripts shim | Plus one direct test importer (`collapse-detector.test.ts`) — relocation must move that import too |
| `locations.ts:28-32` lists four DBs | Lists three; logs.db's path lives in `core/logs-db.ts:60`. Four DBs is still true |
| §8.2 "only DB-opening gateway is `withWorkflowRunsRepo`" | Two more direct openers: `migration-backup.ts:638` (`activeWorkflowClaims`) and `config-migrate.ts:643` — both load-bearing for the cutover (§4) |
| `plan-classifier.ts` legacy arms ~100 LOC | ~80 LOC; still reachable today (correctly scheduled as post-cutover prune) |
| §4.7 DECOMPOSE `summarizeImproveCompleted` (~440) | **Already refactored** — 5 lines at HEAD (`summarizeImproveRuns`/`projectRunMetrics` split landed). Remove the row |
| `recordGateDecision` + "drain confidence gate" | Components exist, but drain is explicitly deterministic/non-confidence-gated (`drain.ts:6`); the confidence gate is `runAutoAcceptGate` in improve-auto-accept.ts. Aim the deletion there |
| `_set*ForTests` ×22 | 18 distinct seams. loadConfig ×89 and resolveStashDir ×56 confirmed exact |
| synthesize.json "0% accept" cited for recombine | The 0% note refers to procedural compilation (#615), not recombine. Recombine deletion stands on its own evidence (default-off, opt-in only) |
| `LINTER_MAP` in lint/index.ts | Lives in `lint/registry.ts` (routing in index.ts confirmed) |

### 2.3 CONFIRMED highlights worth keeping on the record

The 14/8/6 renderer/action split-brain (exact); walkStash+DirectoryGroup dead in src; StashEntry 37 fields with wiki-only `wikiRole`/`pageKind`, zero `SearchDocument`/`IndexDocument` hits; config-schema 1415 LOC / 252 `.optional()` / 3 `.default()` (exact); `outcomeWeightEnabled` triple-negative `!== false` at exactly the 3 claimed sites with the false "Default false (parity)" comment; corr=+0.0104 tripwire + `outcome_proxy_dead`; review_pressure zero readers; ValenceScore.lane never read; the 840-LOC promotion-policy literal read only for `.selectedModel`; god-function sizes (1544/943/707/635) to the line; three FS journal engines; ProposalPayload single-content; wiki.ts 1182 LOC; 9 linters + REF_RE; echarts 1,034,102 bytes with the CDN switch already present; embedded.ts not-a-scheduler (finding #8 correctly withdrawn); two workflow codecs → same IR; W1 layer inversion; W2 lease overload; three argv re-scanners; EventsContext as DI exemplar (but see §7.4); duration-parser residue; installed bundles grant nothing at install (see §6.1 of the design review).

---

## 3. CRITICAL — The reconciliation was never applied to the plan's operational core

The 2026-07-13 reconciliation restored six items into 0.9.0 scope (bindings/activation, full memory lifecycle, third verb, LLM Wiki adapter, progressive disclosure, `#fragment` refs). Audit of the plan document itself:

- **Bindings:** no chunk, no `Binding` DDL in the §3.2 re-key/schema list, no `akm bind` CLI item, no DoD item, no contract test — and §6 still affirmatively instructs "keep today's implicit activation… Do NOT mint a workspace_bindings table."
- **Memory lifecycle:** no chunk covers states, water-marks/backpressure, claim coverage, sandbox non-regression, the archive store, purge, overlay, or two-phase. Chunk 7 still says "consolidate ops (non-destructive learn recipes)" — pre-reconciliation language.
- **Third verb:** §1.2/§5 updated, but DoD item 5 still reads "improve = 2 verbs over passes."
- **Progressive disclosure and `#fragment`:** zero occurrences anywhere in the plan.
- **LLM Wiki adapter:** the only restored item genuinely integrated (Chunk 4 rewritten with a conformance gate) — though its ledger row still embeds the old −1,000 wiki deletion.

A banner saying "passages below are superseded" converts an implementation plan into a puzzle. An implementer executing chunk-by-chunk reads §11 and §12, not the deviation-analysis appendix. **Fix: apply the reconciliation as in-place edits** — add the missing chunks (suggested: Chunk 6.5 bindings + Binding DDL in the cutover; Chunk 7.5 memory lifecycle at the scope recommended in the design review §8; extend Chunk 5 with the L0/L1/L2 index artifacts; extend Chunk 6 with `#fragment`), add DoD items and §12.3 contract tests for install≠activate, water-mark/backpressure, claim-coverage-blocks-unattended-retirement, and canary non-regression, and strike every superseded passage. Add a doc-level zero-count gate mirroring the code gates: grep the plan for "Do NOT mint", "two verbs", "fold into knowledge" → 0.

### 3.1 The ledger and the hard rule are no longer honest

- §12.1 still shows "+≈600 adds / TOTAL ≈ −11,000 to −13,000." Verified against src, the restored subsystems are ~90% greenfield: memory-lifecycle state model ~2,500–3,000 LOC (grep: zero hits for highWater/lowWater/backpressure/claim-coverage/CAS-archive/quarantine; `consolidate.ts` contributes journaling plus a 50-line `archiveMemory`); bindings ~1,300–1,800 (zero hits for workspace_bindings/BindingRecord; table+repo, CLI, digest detection, retrofitting runtime handlers); L0/L1/L2 ~400–800; `#fragment` ~100; wiki-adapter swing ~+1,200–1,400 vs the ledger row. **Realistic unbudgeted adds: +5,500–8,500 src LOC**, dragging the honest total toward −4,000 to −8,000 — likely violating the plan's own DoD 8 (≥ −9,000 net). The plan also carries three different totals (§1.3: −9,000–10,500; §12.1: −11,000–13,000; §13.1: −13,000–15,000) and two different residual-fold numbers (−2,500 vs −4,300).
- §1.3's hard rule — "No new features. No new machinery… No element is a green-field addition" — is now a false premise the ledger, DoD, and chunk sizing all lean on. Either restate it honestly ("no new machinery EXCEPT the spec-mandated bindings + memory-lifecycle subsystems, budgeted at +X") or re-litigate DEV-3/4 with real cost numbers. Don't start execution while the plan's foundational rule and its scope contradict.

### 3.2 Internal ordering conflict: the restored lifecycle depends on machinery scheduled for deletion

Normative §25.7 makes "protected retrieval canaries MUST not regress" a retirement gate; the only canary machinery in the repo is exactly the collapse/canary cluster (~900 LOC) that plan §13.2 assigns to the 0.9.1 prove-or-delete pass. 0.9.0 would build a MUST-level safety gate on a subsystem the same plan schedules for probable deletion one release later. **Fix: split the cluster** — move the canary probe + `canary_queries` store into §13.4's preserve list (they become the memory lifecycle's verification harness), leaving only the advisory collapse-alert loop in the 0.9.1 tier.

---

## 4. CRITICAL — Migration mechanics (§3 + §8): one data-loss defect, one unimplementable mechanism, and an always-failing gate

The shape (merge workflow.db via ATTACH + INSERT…SELECT; fail-closed; backup-verified; throwaway migrator) is right. The specifics are not. The plan is the authority here — these findings are about what the plan must itself specify for its own fail-closed promise to be real, not about deferring to rc-era code.

### 4.1 Dropping index.db destroys `usage_events` — data loss as written

Plan §3.2 lists `usage_events` in the *state.db* re-key list and simultaneously declares index.db "regenerable — dropped and rebuilt." **`usage_events` lives in index.db** (`usage-events.ts:66`, wired via `schema.ts:415`). It is 90-day durable feedback history that today's full rebuild deliberately preserves (entry_id nulled, entry_ref kept for re-link, `indexer.ts:970-976`), and it is not in the backup manifest (`ARTIFACT_NAMES = config.json/state.db/workflow.db`). Chunk 8 as written permanently deletes the very feedback data §3.2 calls "the feedback keying, preserved finding." **Fix:** migrate `usage_events` into state.db during the cutover (ATTACH index.db read-only alongside workflow.db; INSERT…SELECT with entry_ref re-keyed in the same pass) — which also aligns with the normative spec's own §14.4 note that durable feedback should key by item ref so index rebuilds don't erase learning — or exclude the file-drop and truncate only truly regenerable tables. Either way, add the table's home to the backup manifest before the cutover ships.

### 4.2 `state-018` cannot be a sealed static-SQL migration — the mechanism needs to be specified as code

The shared engine defines a migration as `{id, up: string}` — a static SQL string, SHA-256-sealed over id+body, executed inside the engine's own transaction, with an idempotency/no-DROP contract. Two parts of the cutover cannot be expressed that way: the ATTACH target path is runtime-resolved (embedding it breaks checksum sealing across installs), and the old-ref→new-id mapping requires reading the old filesystem layout — code, not SQL. ("state-018" also breaks the `NNN-name` ledger convention; the existing `beforeMigration` hook has no after-hook for DETACH.) **Fix:** don't model the cutover as a registry migration body. Two plan-compatible options: (a) a dedicated, journaled cutover step in the migrate-apply flow that runs between ledger-current and committed; (b) extend the engine with a functional-migration variant (`id + run(db)` + a defined sealing story — version string + row-count attestations instead of body hash). Specify one.

### 4.3 The cutover's fail-closed story depends on backup/restore machinery §8.2 tells you to delete

Whatever vehicle runs the cutover, the plan's own §3.3 requirements (backup-verified-restorable, fail-closed) mean: the pre-cutover backup **contains workflow.db**, and the post-cutover binary must still be able to verify and restore that backup. §8.2's instruction to delete `WORKFLOW_MIGRATIONS` and the workflow.db branches of `migration-backup.ts` breaks exactly that (verification inspects the bundled workflow.db against `WORKFLOW_MIGRATIONS`; `inspectMigrationState` could no longer classify a lingering workflow.db; `activeWorkflowClaims` — a direct workflow.db opener the single-seam claim missed — gates artifact replacement). There is also an existing coordination layer (`akm migrate apply` phase journals, generation fingerprints, WAL/SHM-safe publication) that the state.db open path *forces* the cutover through regardless (`openStateDatabase` refuses a canonical DB with a pending ledger and points at `migrate apply`). The plan may keep, rework, or replace that coordinator — it is subordinate to the plan — but it must *decide*, because the current text silently assumes a three-artifact world it simultaneously deletes. **Fix:** rewrite §8.2 as a delta against whatever coordination vehicle §4.2 chooses: keep a frozen copy of `WORKFLOW_MIGRATIONS` ids+checksums in `src/migrate/legacy/` (`@removeIn`) so pre-cutover backups stay verifiable; bump the manifest/journal format with backward-read of the three-artifact shape; repoint `activeWorkflowClaims` to state.db post-merge while retaining the workflow.db probe for pre-cutover generations; and re-estimate Chunk 8 — the three-artifact-shaped coordination code (`migration-backup.ts` 1,261 LOC + `config-migrate.ts` 737 LOC) makes this several hundred LOC of careful change, not net −500.

### 4.4 "Fail-closed on any nonzero orphan" fails every mature installation

Orphaned old-ref rows are an acknowledged steady state: mv-cli's own comments document orphan salience rows of previously-deleted assets; `events.ref` is append-only history including long-deleted assets; `consolidation_judged` retains dead entry_keys by design; no purge path exists for asset_salience/asset_outcome. Plus refs exist in three key spellings (bare, `origin//`, `.derived` twins) the migrator must merge. A gate that aborts on *any* unmappable row means the migration never completes for a real user — while the fixture-based DoD test passes. **Fix:** define an orphan taxonomy: (a) rows whose old ref maps to no live asset = EXPECTED — carry through under a quarantined `legacy_orphans` table (auditable, purgeable), report counts; (b) integrity failures — mapping collisions, row-count mismatches, unparseable refs — = fail-closed-to-restore. Add a second DoD fixture that *contains* orphans and asserts completion-with-quarantine.

### 4.5 ATTACH sequencing — empirically verified against the actual runtime

Tested on bun:sqlite / SQLite 3.51.2: ATTACH inside an explicit transaction **succeeds** (the classic restriction was lifted in 3.21) — but **DETACH inside the same transaction fails** ("database is locked"), ATTACH is connection-level and survives rollback (naive retry then fails "already in use"), and ATTACHing a nonexistent path **silently creates an empty file** — a re-run after the physical delete would "succeed" while copying zero rows. WAL cross-file atomicity is a non-issue for the transaction itself (writes go only to state.db; workflow.db is read-only source); the genuinely non-atomic boundaries are the *filesystem* operations after COMMIT (delete workflow.db, drop index.db), which no SQL transaction covers and which therefore need the journaled-phase treatment. **Fix — specify this exact sequence in §8.2:** assert workflow.db exists (skip merge on fresh installs); ATTACH outside any transaction (idempotence: check `PRAGMA database_list` first); BEGIN IMMEDIATE; INSERT…SELECT + full re-key; COMMIT; DETACH; then journaled, idempotent deletion of workflow.db + `-wal`/`-shm` sidecars keyed on the committed ledger row.

### 4.6 The index.db drop/rebuild has no defined fail-closed boundary

Rebuild requires the new adapters + indexer and can invoke LLM inference and embedding — both can fail offline or midway. If index.db is dropped before the state commit and the commit fails, restore brings back state but the old index (and §4.1's usage_events) is gone; if rebuild fails after commit, is that a rollback trigger? §12.4's mitigation ("single state-018") cannot make a separate file consistent with a SQLite transaction. **Fix:** index.db is touched only after the state cutover commits; "drop" = journaled rename-to-quarantine, never an early unlink; rebuild is *outside* the fail-closed gate (best-effort; the indexer already self-heals on next run); a rebuild failure must not roll back a committed state cutover.

### 4.7 The frozen legacy reader (§3.4) is far too thin

Freezing `SCRIPT_EXTENSIONS`/`WORKFLOW_EXTENSIONS`/`canonicalizeWorkflowName` covers a fraction of old-ref resolution. Actually needed: the full per-type `ASSET_SPECS` surface (stashDir, `toAssetPath` with skills' SKILL.md dir-entry form and wiki layout), origin→source resolution (same type:name can exist in multiple sources), the disk-candidate fallback ladder, and the three legacy key spellings. Simpler and more robust than freezing the resolver: **have the migrator walk the old layout per source and build the old-ref→path map from disk, persist that map, and have the cutover consume only the map** — with an explicit ordering rule that the map is computed before any filesystem re-layout. Also: the migrator's FROM-state must be pinned precisely — real installs arriving at the cutover include rc-train state (state ledger at 017, workflow.db present, vault already removed), not a pristine "0.8" layout; fixtures must cover that FROM-state.

### 4.8 Hygiene

Route the cutover's state.db handle through `applyStandardPragmas` (the config-migrate runner opens raw, no busy_timeout — a full-table re-key under residual reader contention hits SQLITE_BUSY); name the migration `018-<name>`; amend the engine's idempotency/no-DROP contract note for whichever vehicle is chosen.

---

## 5. MAJOR — Four normative work areas have no plan chunk at all

Grep-verified absent from every chunk, gate, and ledger row:

1. **Config migration.** The target config is a `bundles:` map + `defaultBundle` + `bindings:` replacing `stashDir`/`sources[]`/`installed[]`/`wikiName` — a breaking change to every config consumer (config-schema is 1,415 LOC; `loadConfig` ×89). Zero hits in src for the new keys; no chunk performs the migration (§4.2 only decomposes/deletes knobs; the state cutover covers DBs, not config.json).
2. **Lock state.** Normative §10.2 requires resolved lock state (bundle id, source, revision, integrity, manifest digest, adapter ids/versions). Today's `integrations/lockfile.ts` (144 LOC) is per-source install provenance with none of those fields. The plan never mentions the lockfile — the source→bundle lock migration is unowned.
3. **Registry/local search separation** (normative §17, acceptance 25). The plan touches registry only for semver extraction and build-index repointing.
4. **CLI reshape** (normative §29: `akm bundle …` family, `bind|unbind|bindings`, folding `wiki`/`manifest`/`curate`/`clone`/`propose <type>`). The plan's CLI work is limited to argv-rescanner dedup — yet Chunk 4 deletes `akm wiki` and drop-ref guts `propose <type>`, so the command-surface question is forced *during* execution. Either add a CLI-convergence chunk or explicitly defer §29 (it is SHOULD-level) with the wiki/propose replacements named.

**Fix:** add a config+lockfile migration chunk (naturally paired with the Chunk 8 cutover, since migrate-status already classifies config independently), a registry-separation item, and a CLI-convergence chunk or an explicit deferral decision.

---

## 6. MAJOR — The test suite is the largest unbudgeted line item in the plan

Measured at HEAD: **588 test files / ~175K LOC / ~7,500 cases — the tests tree is 1.3× src.** The plan's total test content is six contract-test bullets (§12.3), DoD item 9, and one file deletion (walker.test.ts).

- **Blast radius:** 220 files / 97,668 LOC (37% of files, **57% of test LOC**) reference at least one thing the plan deletes. Per identifier: `StashEntry` 37 files/218 uses; `parseAssetRef` 12/86; `TYPE_DIRS` 9/29; `wikiName` 5/36; quoted `type:name` ref literals in **186 files / 2,003 occurrences** (`memory:` 930, `skill:` 484, `workflow:` 298, `knowledge:` 230, …); ~100 files hardcode the type-directory layout (`skills/`, `memories/`, …) that adapter `directoryList()` invalidates.
- **The §11 zero-count grep gates are unscoped** ("must all pass at merge"): taken literally they force full test migration inside the chunk sequence; implicitly src-scoped, merge-green still requires the rewrites because fixtures, goldens, and assertions encode the old layout throughout.
- **Load-bearing safety suites (~4,700 LOC / ~22 files) must be ported first, not rewritten:** traversal/escape (env-traversal, workflow-path-escape, tar-utils-scan, git-source-safety), symlink handling (12 files), redaction/dangerous-key, SQLite journal/busy/lock/contention/cross-proc, and the migration suites (migration-lifecycle-regression 1,062 LOC; migration-backup 405) — the last being exactly what the Chunk 8 cutover's own DoD depends on. Also fixed points: `_helpers/sandbox.ts` (406 LOC of env/XDG isolation), `_preload.ts`, and the mock.module-ban lint that lets the suite run without Bun's racy `--isolate`.
- **Taxonomy-pinning tests (~2,500 LOC / ~13 files) should be deleted, not migrated** (asset-ref/asset-spec/asset-registry/exhaustive-registry-coverage/contracts pins, most of wiki.test) — each deletion landing in the same commit as its §12.3 replacement so the exhaustiveness guard never gaps.
- **35+ golden/characterization assets** (CLI output baselines, the ranking-baseline fixture stash in old taxonomy layout, SQLite-migration snapshots, 6 characterization suites) will silently pin pre-refactor behavior or get blindly re-recorded unless each is designated either (a) frozen as 0.8-migration input fixture or (b) re-captured once, in a designated chunk, with reviewed diffs.
- **Test-suite debt worth folding into the sweep:** ~15 duplicated stash-builder helpers and 51 local `runCli` wrappers (consolidating onto `_helpers` first makes the fixture-layout codemod dramatically smaller — do this *before* Chunk 2); 108 mkdtemp sites bypassing the sandbox helper (the leak surface behind the `sweep:tmp` backstop); 33 raw sleeps; a flat 230-file root sprawl. Do **not** touch the hand-rolled sharding/no-parallel harness — it encodes documented Bun-race mitigation.
- **Realistic workload: ~15 files deleted, ~150 codemodded (scripted, with a grep ratchet), ~40–60 substantively rewritten (~25–35K LOC incl. mv/indexer/e2e), ~10 goldens re-baselined, plus the §31-mandated new conformance/parity/fault suites — on the order of 4–7 person-weeks, i.e. 35–45% of total refactor effort, currently budgeted at zero.**

**Fix:** add a test-strategy section: per-chunk pairing of src change → named test bucket; the ref-literal codemod lands atomically with the ref-grammar change behind a script committed to `scripts/`; safety suites green at every chunk boundary; taxonomy-pin deletions only with their replacements; goldens re-baselined once with reviewed diffs; a grep ratchet (the `lint-isolation-ratchet` pattern already in-tree) driving doomed identifiers to zero; and an explicit decision whether test LOC counts in the −9,000 DoD.

---

## 7. MAJOR — Repo surfaces outside src/ that break under the plan, with no chunk

1. **STABILITY.md pins the thing the plan deletes as its top Stable item** — "Asset ref syntax — `<type>:<name>`…" with an additive-within-minor policy, and roadmap.md promises a 1.0 ref-format freeze. AGENTS.md states the old grammar as law for coding agents. This is a *contract decision*, not a docs chore: the plan needs a numbered decision (deprecation posture, CHANGELOG migration note, STABILITY/roadmap/AGENTS rewrite) in the same spirit as its code decisions.
2. **The 0.9.0 version label needs one explicit reconciliation task.** The plan is the authority for what 0.9.0 *is* — but the repo currently carries a competing story: `0.9.0-rc.4` artifacts, a dated `[0.9.0] — 2026-06-30` CHANGELOG header *below* later-dated entries, `docs/migration/v0.8-to-v0.9.md` + `release-notes/0.9.0.md` describing an engine/strategy cutover, and SECURITY.md declaring 0.9.x active. Add a chunk: rewrite the migration docs/release notes so the published 0.9.0 story is the plan's; normalize the CHANGELOG headers; and pin the migrator FROM-state to include rc-train installs (§4.7). If instead the maintainer prefers renumbering, every `@removeIn 0.10.0` tag and the §14.5 "0.10 follow-up" notes shift — either way, decide once, in writing, before Chunk 8 is specified.
3. **`src/assets/stash-skeleton` encodes the doomed taxonomy** — nine per-type convention docs plus `organization.md` literally teaching `knowledge:auth/...` refs and `--type` search. Under the adapter model these are adapter-owned. Worse: they are **stamped into every user stash at setup**, so existing stashes keep steering agents to dead syntax after cutover — the migration needs a refresh step or a documented non-goal.
4. **improve-strategies JSONs hardcode `allowedTypes` closed-union lists** (14 occurrences across 9 of 12 shipped files) — and user-customized strategy files in the wild share the shape: a schema redefinition *and* a data-migration question the plan never mentions.
5. **Published `schemas/` is a shipped npm surface with hardcoded type enums** (`akm-config.json` 16,638 lines, generated), and **CI's `paths-ignore: schemas/**` lets schema-only PRs merge with zero CI** — the drift check never runs on exactly the files it guards. Add schemas to the cutover surface and remove the paths-ignore (or add a dedicated drift job).
6. **Docs sweep:** 33 user-facing docs teach the `type:name` grammar — including the entire normative `docs/technical/ref.md` and `classification.md` (which documents the matcher competition being deleted) — and the docs already contradict each other on the type count (ref.md: 10; STABILITY.md: 11; plan: 14). Three tiers: rewrite normative docs; archive superseded plans (`src-reorganization-plan.md`, `refactoring-tasks.md`, one of the duplicate search docs); leave historical posts. Update AGENTS.md in the same chunk.
7. **Agent-facing embedded assets teach dead refs at runtime:** `src/assets/hints/cli-hints-*.md` (`--type workflow`, `--xref knowledge:auth-flow`, `akm proposal diff skill:akm-dream`), help files, `scripts/akm-asset/command_migrate-storage.md`, and the akm-eval judge-calibration cases (which will break `akm-eval-smoke.yml` at cutover). Add an embedded-assets sweep chunk + extend the §7.3 lint to grep shipped assets for the dead grammar.
8. **Small sweep items:** 13.5K LOC of `scripts/` excluded from both biome and tsc (the 0.9 migrator will live there — it must not be the one unchecked codepath); `check:changed` references a nonexistent test file (AGENTS.md documents the bug instead of fixing it); `noExplicitAny` demoted to warn (only 16 `: any` sites — re-promote is nearly free) and `noUncheckedIndexedAccess` is the natural ratchet to evaluate *during* the adapter port; `docs/example-stash` models the old layout; re-verify surviving `src/assets` templates (tasks/core, wiki templates, workflow-template) against their new owning adapters.

---

## 8. MAJOR — src/ debt the plan misses and should absorb

Ranked; none duplicates the plan's existing inventory:

1. **62 circular import cycles with real layering inversions** (madge over `src/cli.ts`): `core/improve-types.ts` imports from `commands/improve/*` (12 cycles); `core/config` imports `integrations/agent/engine-resolution`; `core/common.ts` chains through asset-registry → output/renderers → commands/env; `harnesses/index.ts`'s self-declared "dependency-graph LEAF" status is false today; tasks/backends barrel cycles. The docs name only the single W1 runtime↔exec inversion. A rename-heavy refactor on a 62-cycle graph risks TDZ/init-order breakage (the opencode-sdk comment shows it has already bitten once). **Add a workstream:** move improve result types down into core; split config↔engine-resolution; make the harness-registry leaf claim true; and gate the whole refactor with a dependency-cruiser/madge CI rule (cycle count 62 → 0, no upward edges) so Chunks 1–6 can't silently re-introduce cycles. ~1–2 days plus the lint gate.
2. **The plan's "workflow exec is well-decomposed, no god-fn treatment needed" claim (§13.4) is falsified for the drivers:** `exec/report.ts` is 1,798 LOC with 3 exports hiding a **438-line** `reportWorkflowUnitWithBarrier` (its own doc header already names the five phases), and `native-executor.ts`'s `executeStepPlan` is 212 lines. `step-work.ts` genuinely is decomposed, so the claim holds for the shared layer only. Fold the report.ts split into the same PR as W2's finalize-lock work (both edit that file). Est. −250 to −350 inline complexity.
3. **~30 raw `process.argv` reads + a startup argv mutation bypass citty** (repeated flags, `no-` booleans, `--` passthrough, double-reads of the same flag from citty *and* argv), creating dual parsing sources of truth and prod-vs-test divergence (in-process test invocation sees different parsing than the real CLI). Since 0.9.0 already rewires every command for RunContext: normalize argv exactly once at entry into a typed ParsedInvocation, pass it down, and lint-restrict `process.argv` to `src/cli.ts`. Est. −150 to −250 LOC and a whole divergence class.
4. **`appendEvent`'s DI fast path has zero production adopters** — all ~85 call sites take the slow path: two SQLite opens + a full migration-ledger assertion **per event**, heaviest inside the improve loop stages (10 sites in preparation.ts alone). The irony: the plan holds up `core/events.ts` EventsContext as *the* RunContext exemplar without noticing the exemplar is unadopted. Make events an explicit, measured part of the RunContext threading: the context carries the open state.db handle; assert via test that hot paths never hit the slow path. Removes ~170 redundant opens per improve cycle.
5. **Typed-error sweep:** 204 raw `throw new Error(` beside the AkmError/JSON-envelope contract (79 in commands/ are user-facing validation), plus 6 ad-hoc Error subclasses outside the hierarchy — in a tool whose primary consumers parse JSON errors. Mechanical, ~0 net LOC, folds into the per-directory chunks.
6. **`llm/structured-call.ts`** — the "shared LLM-call-and-classify seam… centralizes ~20 call sites" has exactly **1 adopter**; ten files still call `chatCompletion` directly, re-inlining the classify/fallback scaffold. Finish the migration (most call sites live in files the plan already rewrites) or delete the seam. (Also: the plan-adjacent docs' `call-ai.ts` reference is stale — file already deleted.)
7. **Opportunistic:** `setup.ts`'s 205-line `runSetupWizard` + four near-identical non-interactive entry points — decompose only if setup is touched for adapter-era onboarding.

---

## 9. Chunk-order and gate corrections

- **Chunk 0** must additionally: re-anchor *all* drifted references from §2.2 of this review (not just the three the plan names); capture the golden fixtures **including filter-behavior parity** (proposed/belief/scope result sets) per the design review §6.3, not just rank metrics; build the orphan-bearing migration fixture (§4.4); and schedule the canary re-mint as a named step.
- **Before Chunk 2** (adapters): land the adapter-contract fixes from the design review §6 (recognize-required/index-optional, diff persist, signals fields, item-scoped incrementality, ValidateContext, probe order) — ten adapters minted against the current interface would all need rework.
- **Chunk 2/5 boundary:** "SearchDocument = rename + field move" understates the schema migration (`entry_key/stash_dir/entry_type/entry_json` → the new column set) and its interaction with §6.1's diff-persist requirement; specify which chunk owns the column migration and the utility/usage re-key to item_ref.
- **Chunk 6:** sequence the dedup/cooldown deletion *with* fingerprint introduction (§2.1 item 2), retaining rejection backoff.
- **Chunk 7:** attach the **behavior-change ledger**: self-consistency voting (default-ON for utility ≥ 0.7 refs — deletion = 3×→1× reflect calls on the hottest refs) and the P0-A high-retrieval lane (currently the *only* improvement path for never-rated assets) are live behavior changes, not dead-code removals; same-run multi-cycle deletion is default-preserving (default 1). Also remove the stale `summarizeImproveCompleted` row (§2.2).
- **Chunk 8:** rewrite per §4 (usage_events migration; cutover-as-code vehicle; frozen WORKFLOW_MIGRATIONS copy; orphan taxonomy; the verified ATTACH sequence; index-rebuild outside the fail-closed gate; rc-train FROM-state fixture).
- **Chunk 9:** update per §2.1/§2.2 (mergeInformationFloor item dropped; Node-24 matrix instead of a redundant driver test; caps() ×10; resume-field delete list shrunk).
- **New chunks:** bindings (6.5), memory lifecycle (7.5, at the design review's recommended 0.9.0 scope), config+lockfile migration (with 8), CLI convergence or explicit deferral, docs/assets/schemas sweep, test-strategy (cross-cutting).
- **Gates:** scope every zero-count grep gate explicitly (src/ vs repo-wide vs shipped-assets); add the cycle-count gate (62→0); add the doc-level superseded-passage gate (§3).

---

## 10. What the plan gets right (keep it)

Worth stating plainly, because the volume of findings above could obscure it:

- **The greenfield-vs-refactor decision (option B) held up under independent measurement.** The survivor math is real; the deletions concentrate exactly where the plan says; the five decisive reasons all check out. Nothing in this review argues for a rewrite.
- **The §4 inventory is executable-grade in most rows** — the taxonomy deletions, the improve god-function map, the dead-lane list (every lane verified wired exactly as claimed), the DRY consolidations (caps/session-log/spawn/serializers/duration), the wiki blast-radius map, and the §14 survivor audit's corrections (scheduler backends withdrawn; echarts as a default-flip; Repository<Row,Domain> not built) are all accurate and well-judged.
- **The preserve lists are the right lists.** The S26 infrastructure set, the FTS/bm25 parity anchor, the salience-machinery-intact-under-flag posture, and the 0.9.1 batch-measurement design (one harness run resolving outcome/graph/collapse together) are sound engineering — subject only to the canary carve-out (§3.2).
- **Chunk 0's golden-capture instinct and the zero-count grep-gate discipline are exactly right** — this review's asks mostly *extend* those mechanisms (to filters, docs, assets, tests, cycles) rather than replace them.

---

## 11. Consolidated pre-execution checklist

1. Apply the reconciliation as in-place edits; add the five missing chunks/DoD/tests; strike superseded passages; doc-level grep gate. (§3)
2. Republish one honest ledger (+5.5–8.5K adds signed) and restate or re-litigate the "no new machinery" rule and DoD 8. (§3.1)
3. Move canary probes/store to the preserve list. (§3.2)
4. Rewrite §3/§8 migration per §4: usage_events rescue; cutover-as-code vehicle; backup-verify continuity (frozen WORKFLOW_MIGRATIONS); orphan taxonomy + orphan fixture; exact ATTACH sequence; index-rebuild boundary; thin→thick legacy reader (walk-the-old-layout map); rc-train FROM-state.
5. Add the config+lockfile migration, registry separation, and CLI convergence (or explicit deferral) chunks. (§5)
6. Add the test-strategy section with the codemod/port/delete/re-baseline buckets and budget. (§6)
7. Add the STABILITY/versioning contract decision and the assets/schemas/docs sweep chunks. (§7)
8. Fold in the missed src debt: cycle gate, report.ts god-fn, argv normalization, appendEvent adoption, typed-error sweep, structured-call decision. (§8)
9. Correct the three refuted claims and seventeen drifted details before executing their rows. (§2)
10. Land the adapter-contract and identity fixes from the companion design review before Chunk 2. (design review §5–§6)
