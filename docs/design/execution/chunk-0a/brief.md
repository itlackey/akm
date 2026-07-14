# Chunk 0a — Hygiene goldens: implementation brief

- **Chunk**: 0a (order 1, Wave 1) — "Hygiene goldens"
- **Branch**: `akm-090/chunk-0a` (worktree `/home/user/akm-worktrees/chunk-0a`)
- **Base/HEAD at capture**: `3d9ee7b1917e8c4872f135fe9993d94b61b36ed1` (== head of `claude/akm-architecture-refactor-fubvd7`, zero divergence, clean tree)
- **Authority**: `docs/design/akm-0.9.0-bundle-adapter-architecture-plan.md` (plan §11 Chunk 0a, §5, §12.3, §12.4, §15 rules 1/3/5/7/9). Where the plan says "preserve behavior", **current HEAD behavior is the oracle** — this chunk captures that oracle.
- **Net-LOC**: 0 in `src/` (capture-only). Test/fixture LOC is ledgered separately (plan §15 rule 9), reported not gated.

## 1. What this chunk is — and is not

This chunk produces **behavior baselines** for every surface Wave 1 (Chunks 7, 6, 9) touches, committed as golden fixtures + runnable suites that are **green against current HEAD behavior**:

1. **Improve-run goldens** — the §5 behavior-change ledger baseline: self-consistency reflect call counts (R1) and P0-A selection sets (R2). Chunk 7 deletes both lanes; these goldens are what makes the diff review able to verify the change is *exactly* the intended one.
2. **Proposal/transaction round-trip goldens** for all three FS journal engines (R3): proposal accept/revert, reject, and mv move. Chunk 6 collapses them into one FileChange transaction and must prove preservation of observable outcomes including fsync + before-hash semantics.
3. **Consolidate behavior-preservation goldens** (R5, §15.7): merge/delete/promote/contradict outcomes, journal round-trip, hot-capture guard, contradiction preserve-and-qualify — byte-for-byte where deterministic. Chunk 7's decomposed passes must reproduce these (plan §12.2 DoD 5, §12.3).
4. **CLI output baselines** for the commands Chunk 9 rewires (R4): output helpers/shape registries, health (+ HTML report path), tasks, argv-handling surfaces, duration-flag surfaces, error envelopes.

**Capture, not aspiration.** Every suite asserts what the code does *today*, even where that behavior is surprising (documented cases below). Surprising outcomes get a code comment + a note in `report.md`, not a "fix".

### Out of scope BY DESIGN (plan §1.3, §6 — violations are review BLOCKERS)

- **NO production `src/` changes of any kind.** This chunk lands only under `tests/` and `docs/design/execution/chunk-0a/`.
- **NO new trust/approval/security machinery**: no labeling, no action clamps, no confirm prompts, no digests, no trust records. Do not "helpfully" add hash-gating, approval steps, or sanitization to any golden harness.
- **Memory lifecycle is DEFERRED entirely** (plan §6): no states, water-marks, pressure, CAS archive, sandbox gate, purge/quarantine. Goldens pin *existing* behavior (`archiveMemory`, `superseded_by`, `beliefState`) — they do not model a lifecycle.
- **Fixed points — do not modify** (plan §15 rule 3): `tests/_helpers/sandbox.ts`, `tests/_preload.ts`, the mock.module-ban lint (`scripts/lint-tests-isolation.ts` Rule 6), the hand-rolled sharding (`scripts/test-unit.sh`, `scripts/run-test-shard.sh`). New suites work *within* these: no `mock.module` (use `overrideSeam`/`withSeam` from `tests/_helpers/seams.ts`), no process spawns outside `tests/integration/` (lint Rule 5's spawn allowlist is empty and the ratchet meta-test pins the combined allowlist at exactly 63 — do not add entries), auto-inclusion in shards is automatic (no registration).
- Deletion is gated by inventory + zero-count greps elsewhere, never by LOC; there are **no deletions in this chunk** (the ledger is committed empty).

## 2. Re-measured anchors (R8 — gate 2, done FIRST)

Plan line anchors were re-measured at HEAD `3d9ee7b` and spot-verified during brief authoring. **These values supersede the plan's line numbers everywhere in this chunk. Do not copy plan line numbers into suite comments — use this table.** WI-01 commits this table as `docs/design/execution/chunk-0a/anchors.md` before any capture begins.

### 2.1 Improve loop (Chunk 7 baseline surfaces)

| Surface | Plan anchor | HEAD truth |
|---|---|---|
| Self-consistency helpers | `loop-stages.ts:117-160` | `src/commands/improve/loop-stages.ts:116-173` — `SC_THRESHOLD` (default 0.7) `:118`, `SC_N` (default 3, clamped 2..5) `:119`, `jaccardSimilarity` `:125-135`, `pickMajorityVote` `:142-173` |
| SC trigger/fan-out/persist | `loop-stages.ts:307-331` | `:308-365` — `useConsistency = refUtility >= SC_THRESHOLD && SC_N >= 2` `:311`, N-sample loop `:315` (budget check `:316`), zero-sample fallback draft `:328-333`, winner `:325`, **winner-persist via `createProposal` `:335-359`** (sourceRun `` `reflect-sc-${Date.now()}` `` `:340`; dedup/cooldown diversion `:346-356`), non-SC single call `:360-365`. The winner-persist tail sits OUTSIDE the plan's 307-331 deletion range — Chunk 7's inventory must include it, plus `reflect.ts` `draftMode` option `:148` and draft branch `:1537-1563`. |
| SC knobs | — | Programmatic only: `AkmImproveOptions.selfConsistencyThreshold`/`selfConsistencyN` (`improve.ts:203`, `:208`). **Zero CLI flag / config-schema hits** — default-ON for every CLI improve run, exactly as §5 ledger bullet 1 states. |
| `akmImprove` | `improve.ts:413` | `:401`; `reflectFn`/`distillFn` DI defaults `:412-413`; `maxCycles` `:474`; cycle loop `for (let cycleIndex...` `:914` (plan said :939) |
| Calibration auto-tune | `improve.ts:497` | `:494-510` is now only a comment block. Implementation moved: `maybeAutoTuneThreshold` `preparation.ts:121-204` (config gate read `:129`), call sites `preparation.ts:505`, `:2355`, `loop-stages.ts:707`, schema knob `config-schema.ts:814-820`, scorer `calibration.ts:204,269`. **Chunk 7's D9 deletion inventory must be re-pointed at these files, not improve.ts.** |
| `runImprovePreparationStage` | `preparation.ts:825` | `:838` |
| P0-A high-retrieval lane | `preparation.ts:1033-1040` | **~240 lines stale.** `RETRIEVAL_COUNT_THRESHOLD = options.minRetrievalCount ?? 5` `:1270`; candidate union (no-signal processableRefs + deferred `noFeedbackPool`, deduped) `:1274-1282`; gate `count > 0 && count >= threshold && !lastReflectProposalTs.has(ref)` `:1327-1330` (fires at most once per asset); lane stamp `eligibilitySource='high-retrieval'` `:1555` (re-stamp `:2039`); `noFeedbackPool` partition `:1094-1153`; full lane context `:1191-1362`. Retrieval counts via `getRetrievalCounts` over index.db usage_events `:1307-1311`. |
| Signal-delta gate (§6 preserve) | — | `src/commands/improve/eligibility.ts`: `buildLatestFeedbackTsMap` `:349`, `buildLatestProposalTsMap` `:382`, `isSignalDeltaEligible` `:421-431`; `buildUtilityMap` `:467-495`. Partition wiring `preparation.ts:1030-1153`. |
| `akmReflect` | `reflect.ts:948` | EXACT. `draftMode` branch skips `createProposal`, returns synthetic `sc-draft-*` proposal `:1537-1563`; `eligibilitySource` into event metadata `:961` and persisted proposal `:1581`. |
| `akmDistill` | `distill.ts:678` | `:680` |
| `processSession` | `extract.ts:550`, "19 args" | `:552`, **TWENTY** positional params (`standardsContext` appended since the plan was written) |

### 2.2 Journal engines (Chunk 6 baseline surfaces) — `src/commands/proposal/repository.ts` (2100 LOC), `src/commands/mv-cli.ts` (1413 LOC)

| Surface | Plan anchor | HEAD truth |
|---|---|---|
| Proposal-txn engine | `repository.ts:1036-1416` | Phases `:1036-1042` (prepared → asset-published → proposal-persisted → index-finalized → event-finalized → committed); journal `ProposalTransactionJournal` `:1044-1063` (carries `originalHash` before-hash, `publishedHash`); journal home `getDataDir()/proposal-transactions/<sha24>/<uuid>/journal.json` `:1082-1085`; fsync discipline (tmp+fsync+rename+dir-fsync) `:1101-1126`; rollback divergence refusal `:1156-1183`; finalize `:1275-1308`; recovery `:1310-1403` (`recoverProposalTransactionsForStash` `:1357`). **Plan range both overshoots into the reject engine (`:1404-1416`) and MISSES `prepareProposalTransaction` `:1532-1599` + `publishProposalAsset` `:1601-1619` (the fsync + before-hash half; abort message "Proposal target changed while its backup was being acquired" `:1608`) and the orchestrators `promoteProposal` `:1643`/`promoteProposalWithLease` `:1653-1756` (idempotent re-accept `:1703-1718`, backup-before-write `:1728-1737`), `revertProposal` `:1790-~2005`.** Test seam `_setProposalMutationHookForTests` `:1074-1076`. |
| Reject-txn engine | `repository.ts:1417-1530` | Starts `:1405` (phase type; journal interface `:1407-1415` — **no paths, no hashes: DB-only**). `rejectTransactionRoot` `:1417`, journal write `:1421-1427`, phase-idempotent finalize `:1434-1476`, recovery `:1478-1496`, `rejectProposalDurably` `:1498-1530`. CLI wrapper `proposal.ts:169-186` runs `recoverProposalTransactionsForStash` first. |
| Move-txn engine | `mv-cli.ts:309-541, 1020-1120` | `:309-541` EXACT (`MoveJournal` `:309-347` incl. per-citer `originalHash`/`replacementHash` + source/twin hashes; journal home **inside the stash** `<stashDir>/.akm/mv-transactions/<uuid>/journal.json`; fsync journal write `:387-393`; rollback divergence refusal `:401-451`; `validateCommittedMove` `:453-474`; recovery `:493-541`). **Plan's second range misses `applyMoveFilesystem` `:543-673` (the actual fsync + before-hash apply engine: stage-divergence abort `:576`, replace-divergence abort `:632`, expectedNewHash re-check `:644/:648`, linkSync+unlinkSync publication `:645-651`) and `persistMoveEvent` `:999-1018`.** `finalizeMoveTransaction` `:1020-1080`; post-filesystem-commit is roll-forward-only (`:1394-1395`); recovery callers: mv run `:1237`, promote `repository.ts:1702` (+`:1959`, `:1397`), `index-written-assets.ts:72`, `indexer.ts:558`. Seam `_setMvMutationHookForTests` `:358-360`. |
| Dedup/cooldown/gate (Chunk 6 context) | — | ALL EXACT: `ProposalSkipReason` `:439`, `COOLDOWN_MS` `:476-480`, `cooldownMsForSource` `:482`, `contentHash` `:487`, `createProposal` `:540`, `checkDedupAndCooldown` `:659-729`, `recordGateDecision` `:874` |

### 2.3 Consolidate (Chunk 7 §15.7 oracle surfaces) — `src/commands/improve/consolidate.ts` (3,118 LOC)

All EXACT unless noted: `getJournalPath` `:657`, `getBackupDir` `:661`, `removeStaleJournal` `:665-690`, `checkForIncompleteJournal` `:692-735` (invoked at `akmConsolidateInner` entry `:1012`; `recoveryMode` default `"abort"`), `writeJournal` `:737-747`, `markJournalCompleted` `:749-759`, `cleanupJournal` `:761-774`, `backupFile` `:776-783`, `injectGenerationFrontmatter` `:796-825`, `archiveMemory` `:838-878` (**`superseded_by` written only at `:863`**), `akmConsolidateInner` `:1938`, `planConsolidation` `:1387-1812` (anti-collapse shuffle `:1454-1496`, all-hot chunk skip `:1617-1636`), `applyConsolidationPlan` `:1821-1936` (journal first `:1846`, boundary git commit `:1915-1917`, cleanup `:1919`), `handleMergeOp` `:2117-2413` (hot pre-flight `:2174-2194`, post-generation re-check `:2253-2274`, injected `generateMergedContentFn` via `ConsolidateOpContext` `:2113`), `handleDeleteOp` `:2416-2474` (hot refusal `:2438-2445`, archive call `:2450`), `handlePromoteOp` `:2477-2690` (gates in order: within-run dedup `:2492`, slug/ref validation `:2498-2515`, pending-by-ref `:2518-2523`, existing-file `:2527-2532`, sanitize `:2546-2552`, superseded refusal `:2557-2563`, 100-char floor `:2575-2583`, body-cacheHash dedup `:2596-2609`, frontmatter validation `:2624-2629`, description-into-body + xrefs union `:2641-2649`, `checkPreEmitDedup` `:2656-2666`, `createProposal` `:2668`), `handleContradictOp` `:2693-2738` (confidence ≥ 0.92 gate `:2699-2707`), `parseSinceToIso` `:2824` (plan :2825), `narrowToIncrementalCandidates` `:2833`, `generateMergedContent` `:2951`. Hot-capture verdicts: `consolidate/eligibility.ts` `isHotCapturedMemory` `:35`, `consolidateGuardStatus` `:60`; capture side `remember-cli.ts:188,288`. Contradict primitive: `writeContradictEdge` `memory-belief.ts:89` (metadata-only, sorted-set append, never weakens `archived`). `mergePlans` `consolidate/merge.ts:35` (precedence `:80-110`). **The narrow/plan/apply decomposition + op-handler extraction already exists at HEAD — goldens freeze CURRENT handler outcomes, not an inline-branch shape.**

### 2.4 CLI/output surfaces (Chunk 9 baseline surfaces)

| Surface | Plan anchor | HEAD truth |
|---|---|---|
| `formatShowPlain` | `helpers.ts:528` | EXACT (`src/output/text/helpers.ts`, 1418 LOC, 63 top-level fns; APPLY/workflow agent-directive branches `:632-656`) |
| Shape/text registries | §4.7 | `src/output/shapes.ts:78-97` (BUILT_IN), `:127-146` (`shapeForCommand`, `--shape summary` gated to show via `:124`); `src/output/shapes/registry.ts`; `src/output/text/registry.ts` (null→YAML fallback); passthrough fallback `src/output/shapes/passthrough.ts` |
| `renderers.ts` | §4.7 | 871 LOC — per-asset-type AssetRenderer registry (show/search CONTENT per type), not CLI text. Deletion is Chunk 3; show-content baselines double as Chunk 3 goldens. |
| `akmHealth` | `health.ts:132` | EXACT (`:132-404`); CLI wiring `cli.ts:341-434` (repeated `--windows` via `parseAllFlagValues` at **`src/cli/shared.ts:226`**, used `cli.ts:371`; html branch `:384-403`; md `:415-422`; exit codes fail→1 / warn→4 `:427-432`); `buildHealthHtmlReplacements` `html-report.ts:405` (plan :401) |
| Tasks | §4.7 (runner 698 LOC) | `tasks-cli.ts` 235 LOC; `src/tasks/runner.ts` **894 LOC** (drifted +196); `runTask` `:121` |
| Argv re-scanners | `cli.ts:137,602,652` | `resolveHelpMigrateVersionArg` `:138-160` (+ `wasHelpMigrateFlagValueConsumedAsVersion` `:162-185`); `isTaskRunWithId` `:599-606` + `shouldBypassConfigStartup` `:609-620`; startup block `:641-716` (`normalizeShowArgv` `:644`, `applyEarlyStderrFlags` call `:651`, `initOutputMode` `:654`, summary-gate `:665-668`); no- boolean `:271`; global error envelopes `:41-73`. **`parseAllFlagValues` is in `src/cli/shared.ts:226`, not cli.ts — the Chunk 9 item spans two files.** |
| `--since` residues | `consolidate.ts:2825`, `extract.ts:414`, `memory-improve.ts:377` | `parseSinceToIso` `consolidate.ts:2824` — **config-driven** (`improve.processes.consolidate.incrementalSince`, `preparation.ts:419`, `config-schema.ts:368`), returns input unchanged on non-match, NOT reachable from any CLI flag; `parseSinceArg` `extract.ts:411` with case-insensitive `[mhd]` regex `:416` (so `5M` = 5 minutes, diverging from core `DURATION_UNITS`), wired to `akm extract --since` (`extract-cli.ts:101`); `memory-improve.ts:377` EXACT line but it is inside `resolveRelativeDates` `:362-391` — **memory-content phrase rewriting against a referenceDate, not flag parsing**. Canonical parser: `src/core/time.ts`. |
| Typed-error denominators | §10.7 | EXACT: 204 raw `throw new Error(` in `src/`, 79 in `src/commands/` |

### 2.5 Test infrastructure facts

- `tests/_helpers/cli.ts` — `runCliCapture` `:135` (in-process CLI harness; replays `normalizeShowArgv` + `initOutputMode` + citty; **deliberately skips the real `import.meta.main` startup block** — pure-startup behaviors need spawn-based integration tests, pattern `tests/integration/show-argv-entrypoint.test.ts`).
- `tests/_helpers/sandbox.ts` — `withIsolatedAkmStorage` `:280` (FIXED POINT — use, don't edit); `tests/_helpers/seams.ts` — `overrideSeam` `:20`.
- LLM transport seam: `_setChatCompletionForTests` `src/llm/client.ts:274` (pattern: `tests/commands/consolidate/consolidate-judged-cache.test.ts:47`).
- Utility seeding: `upsertUtilityScore` `src/indexer/db/db.ts:1402` (usage pattern `tests/get-retrieval-counts.test.ts:151`); retrieval seeding: `insertUsageEvent` with `event_type:'search'` + `entry_ref` (pattern `improve-eligibility.test.ts:652-661`); proactive-lane isolation: `configWithoutPoolGuard` (`improve-eligibility.test.ts:93`).
- `_preload.ts` afterEach tripwire THROWS on leaked env/cwd/fetch — always go through `withEnv`/`withIsolatedAkmStorage`.
- `bunfig.toml`: bun 1.3.14 ignores `[test] timeout` — targeted runs need explicit `bun test --timeout=30000 <paths>`.
- Safety suites (§15.3, must be green at chunk boundary): 19 files / 4,240 LOC at this HEAD — unit scope: `env-traversal`, `workflow-path-escape`, `redaction`, `config-cli-redaction`, `env-run-dangerous-key-block`, `vault-dangerous-key-install-gate`, `vault-dangerous-key-lint`, `sqlite-journal-mode`, `db-busy-timeout`, `index-writer-lock`, `migration-lifecycle-regression`, `migration-backup`; integration scope: `tar-utils-scan`, `git-source-safety`, `index-writer-lock-crossproc`, `workflow-db-contention`, `file-lock`, `improve-lock-serialization`, `migration-apply-crash`. **`tests/sqlite-journal-mode.test.ts` is about SQLite PRAGMA journal_mode — unrelated to the three FS journal engines; do not conflate or touch.**

### 2.6 Known §5-ledger corrections (record for Chunk 7's diff review — do NOT act on them here)

1. **§5 bullet 2 is stale**: P0-A is NOT the only path improving never-rated assets at this HEAD. The proactive-maintenance lane ships `enabled:true` in the default strategy (`src/assets/improve-strategies/default.json`, selector `preparation.ts:1351-1369`) and the #608 high-salience lane also rescues zero-feedback refs. P0-A goldens must isolate/attribute per lane (WI-02).
2. `processSession` takes 20 positional args, not 19.
3. Calibration auto-tune implementation lives in `preparation.ts:121`/`calibration.ts`/`config-schema.ts:814-820`, not `improve.ts:497`.
4. The SC deletion range must extend to `loop-stages.ts:335-365`, `reflect.ts:148/1537-1563`, `improve.ts:203/208`, and the `reflect-sc-` sourceRun grammar.
5. Chunk 6's collapse scope must include `repository.ts:1532-1619` and `mv-cli.ts:543-673` + `:999-1018` or the mandated fsync/before-hash preservation is unverifiable.

## 3. Conventions minted by this chunk (binding for all work items)

### 3.1 Golden home and format

- Fixture data: `tests/fixtures/goldens/<area>/<scenario>.json` (areas: `improve/`, `journal/`, `consolidate/`, `cli/`). JSON, 2-space, sorted keys, trailing newline.
- Each area README-free; scenario metadata lives inside the fixture (`{ scenario, capturedAtHead, config, ... }`) and in `DESIGNATIONS.json`.
- Loader/normalizer: new `tests/_helpers/golden.ts` (NOT a fixed point — new file). Provides `loadGolden(path)`, `expectGolden(path, actual)` (deep-equal after normalization), and an explicit regeneration mode via env `AKM_UPDATE_GOLDENS=1` set by the *developer invocation*, never inside a test (the `_preload` tripwire polices test-set env). Regeneration outside an asset's designated chunk is forbidden (plan §15 rule 5) — it shows up as a git diff on a frozen path and is a review BLOCKER.

### 3.2 Grammar-agnostic encoding (R6 — plan §12.4)

1. Prefer **counts, outcomes, key-sets, error-prefixes, phase names** over raw `type:name` ref strings.
2. Normalization placeholders applied by `tests/_helpers/golden.ts` before compare/serialize: `<TS>` (ISO timestamps AND `timestampForFilename` tokens in filenames/frontmatter/journals), `<ID>` (proposal ids/uuids), `<TXN>` (transaction ids), `<STASH>`/`<DATA>`/`<TMP>` (sandbox roots), `<DUR>` (durations/`durationMs`).
3. Where a ref string is unavoidable (journal payloads, proposal.ref, mv from/to, text outputs), it must be **fixture-local** (never a production ref) and routed through a single shared constants module per area (`tests/fixtures/goldens/<area>/fixture-refs.ts`) so Chunk 5's §15.2 test codemod rewrites goldens mechanically at the grammar cutover. Any asset that serializes refs is designated `re-baseline` @ Chunk 5.
4. Journal **phase sequences are recorded as informational data** (`journalPhasesObserved: [...]`), never asserted against journal file bytes or directory layouts — Chunk 6 replaces the journals; only observable outcomes (file trees, DB status, exactly-once events, abort prefixes, recovery end-states) are the preserved contract.
5. Frontmatter is compared as parsed objects (key-order-proof), EXCEPT the plan's byte-for-byte cases: contradict output files and merge primary output files also pin exact raw bytes (after `<TS>` normalization).

### 3.3 Frozen-vs-re-baseline designation (R12 — plan §15 rule 5)

New central registry `tests/fixtures/goldens/DESIGNATIONS.json`: an array of entries
`{ "path": "tests/fixtures/goldens/improve/self-consistency.json", "designation": "frozen-migration-input" | "re-baseline", "reBaselineChunk": "<manifest chunk id, required iff re-baseline>", "consumers": ["<suite paths>"], "notes": "<why>" }`.

Policed by a meta-test (WI-01): every file under `tests/fixtures/goldens/**` (and every golden-flavored asset this chunk adds elsewhere) has exactly one entry; `designation` is valid; `reBaselineChunk` is a real manifest chunk id; every entry's path exists. Designation policy for 0a's assets:

| Asset family | Designation | Rationale |
|---|---|---|
| SC call-count + P0-A selection goldens | `re-baseline` @ **7** | They baseline behavior Chunk 7 deliberately deletes (3×→1×; lane removal); re-captured there with a reviewed diff = the §5 ledger verification |
| Journal-engine outcome goldens | `frozen-migration-input` (ref-serializing fixtures: `re-baseline` @ **5**) | Preservation oracle through Chunk 6; Chunk 5's grammar codemod mechanically re-keys ref-bearing ones |
| Consolidate behavior-preservation goldens | `frozen-migration-input` (ref-serializing: `re-baseline` @ **5**) | Chunk 7 DoD 5 oracle — must stay green through Chunk 7 |
| CLI output baselines | `frozen-migration-input` (text outputs embedding refs: `re-baseline` @ **5**) | Chunk 9 oracle ("CLI output baselines from Chunk 0a stay green") |

The full 35+-asset repo-wide enumeration is Chunk 0b's item; 0a designates only what it captures.

### 3.4 Unit vs integration scope placement

- **Unit scope** (`tests/` outside `tests/integration/` — gates every `check:fast`): all in-process capture, including CLI baselines via `runCliCapture`, journal success/abort scenarios, consolidate goldens, improve goldens. No spawns.
- **Integration scope** (`tests/integration/` — gates `bun run check`): crash/SIGKILL recovery scenarios only, reusing/parameterizing the existing crash runners (`tests/integration/_helpers/proposal-crash-runner.ts`, `tests/integration/_helpers/mv-crash-runner.ts`). This split means the round-trip *outcome* goldens gate check:fast while crash windows gate the full check — both run at the chunk boundary (R9).

## 4. Work items (dependency order)

---

### WI-01 — Golden infrastructure, designation registry, and anchor record

**testMode**: test-first · **dependsOn**: — · **estLoc**: ~350 (tests+fixtures) + ~120 (docs)

Covers **R8** (gate 2), **R12** (mechanism), **R6** (mechanism), **R10** (constraint baked into conventions).

**Tests first**
- `tests/goldens-designations.test.ts` — meta-test: (a) every file under `tests/fixtures/goldens/**` (excluding `fixture-refs.ts` modules and `DESIGNATIONS.json` itself) has exactly one `DESIGNATIONS.json` entry; (b) `designation ∈ {frozen-migration-input, re-baseline}`; (c) `reBaselineChunk` present iff `re-baseline` and is a chunk id from `docs/design/akm-0.9.0-chunk-manifest.json`; (d) every entry's `path` exists; (e) every `consumers[]` path exists. Write it against an empty-but-valid registry first (green with zero assets).
- `tests/golden-normalize.test.ts` — unit cases for the normalizer: ISO-timestamp → `<TS>` (incl. `timestampForFilename`'s `[:.]→-` form embedded in filenames), uuid/proposal-id → `<ID>`/`<TXN>`, sandbox-root substitution → `<STASH>`/`<DATA>`/`<TMP>`, `durationMs` → `<DUR>`, stability (idempotent, key-sorted serialization).

**Steps**
1. Create `tests/_helpers/golden.ts`: `normalizeGolden(value, roots)` (placeholder rules §3.2), `loadGolden`, `saveGolden` (only under `AKM_UPDATE_GOLDENS=1`), `expectGolden` (load-or-record + deep-equal), `sha256File`, `fileTreeManifest(dir)` → sorted `{relPosixPath: sha256}`.
2. Create `tests/fixtures/goldens/DESIGNATIONS.json` (empty `{"entries": []}` shape + `$schema`-style comment field describing §3.3 policy) and the four area directories with `.gitkeep`.
3. Commit the re-measured anchor table (brief §2, verbatim) as `docs/design/execution/chunk-0a/anchors.md`, headed by the HEAD sha and the rule "these values supersede plan line numbers for this chunk".
4. Run `bun run check:fast` and confirm the trailing `── unit: N pass / 0 fail` line (the pre-capture green precondition; see Risks).

**Files**: `tests/_helpers/golden.ts`, `tests/goldens-designations.test.ts`, `tests/golden-normalize.test.ts`, `tests/fixtures/goldens/DESIGNATIONS.json`, `docs/design/execution/chunk-0a/anchors.md`

**Acceptance**
- [R8] `anchors.md` committed with every anchor from the requirement inventory re-measured at `3d9ee7b`, corrected values marked vs plan; committed BEFORE any capture item merges.
- [R12] Designation meta-test green; policy table (§3.3) encoded in the registry file.
- [R6] Normalizer implements all placeholder classes with unit coverage.
- [R10] `git diff` touches none of: `tests/_helpers/sandbox.ts`, `tests/_preload.ts`, `scripts/lint-tests-isolation.ts`, `scripts/test-unit.sh`, `scripts/run-test-shard.sh`.

---

### WI-02 — Improve-run goldens: self-consistency call counts + P0-A selection sets

**testMode**: characterization-preserve · **dependsOn**: WI-01 · **estLoc**: ~550

Covers **R1**, **R2**; applies **R6/R12** (assets designated `re-baseline` @ 7).

**Tests first** (the suites ARE the deliverable; they must be green against HEAD behavior)
- `tests/commands/improve/goldens-self-consistency.test.ts` — cases:
  1. utility 0.9 ref → exactly **3** injected-`reflectFn` calls, all `draftMode:true`, exactly **1** persisted proposal (`listProposals`, `repository.ts:736`) with `sourceRun` prefix `reflect-sc-`;
  2. utility 0.3 ref → exactly **1** call, no `draftMode`;
  3. boundary utility exactly **0.7** → 3 calls (`>=` comparison at `loop-stages.ts:311`);
  4. mixed run (2 hot + 2 cold) → per-ref call-count histogram + total proposal count.
- `tests/commands/improve/goldens-p0a-selection.test.ts` — cases:
  1. never-rated ref with 5 seeded retrievals → selected, injected `reflectFn` sees `eligibilitySource:'high-retrieval'`;
  2. 4 retrievals → not selected;
  3. once-per-asset: run once (produces a reflect proposal), run again → **zero** P0-A selections (`lastReflectProposalTs` gate `preparation.ts:1329`);
  4. lane isolation: with `configWithoutPoolGuard()` (proactive OFF) the selection set is P0-A-only;
  5. lane attribution: with DEFAULT config (proactive ON per `src/assets/improve-strategies/default.json`) capture per-lane selection COUNTS `{high-retrieval, proactive, high-salience, signal-delta}` — this documents §2.6 correction 1 so Chunk 7's diff review attributes removals to the correct lane.

**Steps**
1. Harness per `tests/commands/improve/improve-eligibility.test.ts`: sandboxed env dirs, `writeMemory` fixture assets (fixture-local names from `tests/fixtures/goldens/improve/fixture-refs.ts`), `akmIndex`, feedback events with injected `now` so refs pass the signal-delta gate, `insertUsageEvent` for retrievals, `upsertUtilityScore` (`db.ts:1402`) for utility seeding.
2. Drive full `akmImprove` with injected `reflectFn`/`distillFn` (the sanctioned DI seam, `improve.ts:142-143/412-413`) that record `(ref, options.draftMode, options.eligibilitySource)` per call. **Generous `budgetMs`** so `loop-stages.ts:316` never truncates; **fresh stash per case** so winner-persist is not diverted into the dedup/cooldown branch (`:346-356`).
3. Serialize goldens via `expectGolden` to `tests/fixtures/goldens/improve/self-consistency.json` and `.../p0a-selection.json`: counts, draftMode histograms, per-lane counts, fixture-local membership, once-per-asset outcomes. NO production refs, no event-count assertions.
4. Suite comments must state: (a) stubbed `reflectFn` means `reflect_invoked` events are NOT emitted per SC sample — counts come from stub invocations; production telemetry sees 3 `reflect_invoked` per hot ref (`reflect.ts:953`); (b) these goldens are re-baselined in Chunk 7 (designation).
5. Add both fixtures to `DESIGNATIONS.json` as `re-baseline` @ `7`, consumers = the two suites.

**Files**: `tests/commands/improve/goldens-self-consistency.test.ts`, `tests/commands/improve/goldens-p0a-selection.test.ts`, `tests/fixtures/goldens/improve/fixture-refs.ts`, `tests/fixtures/goldens/improve/self-consistency.json`, `tests/fixtures/goldens/improve/p0a-selection.json`, `tests/fixtures/goldens/DESIGNATIONS.json`

**Acceptance**
- [R1] 3×-vs-1× reflect call counts pinned per utility tier incl. the 0.7 boundary; SC winner persists exactly one proposal with `reflect-sc-` prefix; suite green at HEAD.
- [R2] P0-A selection sets pinned: threshold, once-per-asset, per-lane attribution incl. proactive/high-salience isolation run.
- [R6] Fixtures contain counts/outcomes/fixture-local names only; verified by reading the fixture (no `type:` production literals).
- [R12] Both assets designated `re-baseline` @ 7 in `DESIGNATIONS.json`; meta-test green.
- [R13] Suites run in unit scope (gate `check:fast`).

---

### WI-03 — Journal round-trip goldens: proposal accept/revert + reject engines

**testMode**: characterization-preserve · **dependsOn**: WI-01 · **estLoc**: ~600

Covers **R3** (engines 1+2 of 3); applies **R6/R12**.

**Tests first**
- `tests/commands/proposal/goldens-proposal-txn.test.ts` (unit scope, in-process) — scenarios:
  1. accept new-asset success → `fileTreeManifest` over stash+target, proposal `status:accepted`, `acceptedContentHash` present, exactly one `promoted` event by `idempotencyKey === transactionId`, journal dir empty after;
  2. accept overwrite-existing → backup captured before write (`repository.ts:1728-1737`), `originalHash` recorded;
  3. idempotent re-accept short-circuit (`:1703-1718`) → no second event, byte-identical tree;
  4. target-mutated-during-displace abort → use `_setProposalMutationHookForTests` (`:1074`) to mutate the target between prepare and publish; assert error prefix `"Proposal target changed while its backup was being acquired"` (`:1608`) and original restored byte-identical;
  5. revert success restore → tree + `status:reverted` + immediate index; revert refuse-clobber when asset content came from another proposal (behavior of `tests/proposals.test.ts:1022`);
  6. reject success → status flip + exactly one `rejected` event (idempotencyKey=transactionId); non-pending reject → `UsageError` `INVALID_FLAG_VALUE`; **reject while the target asset is concurrently modified → succeeds** (pins "reject engine has NO before-hash" — a unified transaction must not invent hash checks here);
  7. `createProposal` skip-record shapes: `duplicate_pending`, `content_hash_match` (vs pending AND vs most-recent rejected), `cooldown`, `force` bypass → golden the `{skipped, reason, existingProposalId?}` key-sets and `reason` strings, NOT message wording (fingerprint scheme in Chunk 6 changes wording).
- `tests/integration/goldens-proposal-recovery.test.ts` (integration scope) — parameterize `tests/integration/_helpers/proposal-crash-runner.ts`:
  1. accept SIGKILL at each of the 5 pre-commit phases → recovered end state (prepared rolls back; all later phases roll forward; serialize tree + status + exactly-once event);
  2. revert crash per phase → exactly-once semantics;
  3. reject crash at prepared/state-persisted/event-finalized → exactly one `rejected` event;
  4. reject-recovers-pending-accept ordering (`proposal.ts:169-186` path).

**Steps**
1. Build scenarios on `withIsolatedAkmStorage` + fixture-local refs from `tests/fixtures/goldens/journal/fixture-refs.ts`.
2. Serialize per scenario to `tests/fixtures/goldens/journal/proposal-<scenario>.json`: `{ fileTree, dbOutcome: {status, acceptedContentHashPresent, backupContentPresent}, events: {byIdempotencyKeyCount}, abortErrorPrefix?, journalPhasesObserved (informational) }` — phases captured via the mutation hook, encoded as data per §3.2 rule 4.
3. The success-path scenarios MUST route through `prepareProposalTransaction`/`publishProposalAsset` (`:1532-1619`) — i.e., through real `promoteProposal`, not internals — so the fsync/before-hash half outside the plan's range is exercised (§2.6 correction 5).
4. Do not modify `proposal-crash-runner.ts` semantics; extend by parameterization (new scenario args), or add a sibling runner file if signature changes would touch existing suites.
5. Add fixtures to `DESIGNATIONS.json`: `frozen-migration-input` (consumers both suites; ref-serializing fixtures flagged `re-baseline` @ `5` with a note).

**Files**: `tests/commands/proposal/goldens-proposal-txn.test.ts`, `tests/integration/goldens-proposal-recovery.test.ts`, `tests/fixtures/goldens/journal/fixture-refs.ts`, `tests/fixtures/goldens/journal/proposal-*.json`, `tests/fixtures/goldens/DESIGNATIONS.json`, (possibly) `tests/integration/_helpers/proposal-crash-runner.ts` (parameterization only)

**Acceptance**
- [R3] Accept/revert/reject round-trip outcomes serialized as committed fixtures: file states, journal lifecycle (informational), before-hash abort behavior (accept) AND absence-of-before-hash (reject), exactly-once events, fsync paths exercised end-to-end; both suites green at HEAD.
- [R6] No journal bytes/paths asserted; phase names informational; refs fixture-local.
- [R12] Every fixture designated; ref-bearing ones flagged @ 5.
- [R13] Outcome suite in unit scope; crash suite in integration scope; both green.

---

### WI-04 — Journal round-trip goldens: mv move engine

**testMode**: characterization-preserve · **dependsOn**: WI-01, WI-03 (shares `journal/` conventions + fixture-refs module) · **estLoc**: ~550

Covers **R3** (engine 3 of 3); applies **R6/R12**.

**Tests first**
- `tests/commands/goldens-mv-txn.test.ts` (unit scope) — scenarios:
  1. move with body-ref + frontmatter-ref + task-yaml citers and a `.derived.md` twin → `fileTreeManifest`, rewrote counts, `readOnlyCiters`, exactly one mv event;
  2. divergent-citer abort pre-commit (mutate a citer via `_setMvMutationHookForTests` `:358-360` between stage and replace) → error prefix `"refusing to stage divergent citer"` / `"refusing to replace divergent citer"` (`:576`/`:632`), everything byte-identical after;
  3. divergent-committed-target recovery refusal → prefix `"Cannot finalize move"` (`validateCommittedMove` `:453-474`);
  4. transient re-key failure retains journal, next mutation completes forward (behavior of `tests/commands/mv.test.ts:353/:379`).
- `tests/integration/goldens-mv-recovery.test.ts` (integration scope) — parameterize `tests/integration/_helpers/mv-crash-runner.ts`:
  1. crash at `applying` → full rollback, byte-identical tree;
  2. crash at `filesystem-committed` / `index-finalized` / `state-finalized` / `event-finalized` → roll forward, exactly one mv event (`idempotencyMetadataKey:'mutationTransactionId'`), index + state rows re-keyed;
  3. recovery entry points pinned INDIVIDUALLY: `mv` run (`:1237`), proposal promote (`repository.ts:1702`), indexer full + targeted (`indexer.ts:558`, `index-written-assets.ts:72`) — each finishes a pending committed move (this pins the dual journal-home discovery semantics Chunk 6 could silently change: mv journal lives in-stash, proposal journals in `getDataDir()`).

**Steps**
1. Same encoding as WI-03 (`tests/fixtures/goldens/journal/move-<scenario>.json`), phases informational, `<TXN>`/`<TS>` normalized.
2. Success scenarios drive the real `mv` command path so `applyMoveFilesystem` (`:543-673`) and `persistMoveEvent` (`:999-1018`) — both outside the plan's ranges — are exercised (§2.6 correction 5).
3. Note in the fixture: post-filesystem-commit is roll-forward-only ("never rolls back", `:1394-1395`) — a preserved contract, not an implementation detail.
4. Designate: `frozen-migration-input`; ref-serializing fixtures `re-baseline` @ `5`.

**Files**: `tests/commands/goldens-mv-txn.test.ts`, `tests/integration/goldens-mv-recovery.test.ts`, `tests/fixtures/goldens/journal/move-*.json`, `tests/fixtures/goldens/DESIGNATIONS.json`, (possibly) `tests/integration/_helpers/mv-crash-runner.ts` (parameterization only)

**Acceptance**
- [R3] Move round-trip outcomes committed: citer/twin rewrite trees, before-hash aborts at both stage and replace windows, roll-forward-only contract, exactly-once event, all four recovery entry points; suites green at HEAD.
- [R6/R12/R13] Same criteria as WI-03.

---

### WI-05 — Consolidate behavior-preservation goldens: op outcomes

**testMode**: characterization-preserve · **dependsOn**: WI-01 · **estLoc**: ~600

Covers **R5** (op outcomes + archiveMemory + proposal-gating + mergePlans); applies **R6/R12**.

**Tests first**
- `tests/commands/consolidate/goldens-consolidate-ops.test.ts` — scenarios (each: fixture stash of memory `.md` files + stubbed chunk-plan via `overrideSeam(_setChatCompletionForTests, ...)` + injected `generateMergedContentFn` via `ConsolidateOpContext` (`consolidate.ts:2113`) → run consolidate → snapshot):
  1. **merge** 1 primary + 1 secondary → primary output pinned **byte-for-byte** after `<TS>` normalization (generation=max+1, xrefs sorted union — `injectGenerationFrontmatter` `:796-825`); secondary archived (`.akm/archive/<TS>-<opIndex>-<name>.md` with fm `{status:'superseded', superseded_at:<TS>, superseded_by:<primary>, superseded_reason:'merged into primary'}`) then deleted; counts;
  2. **merge** 1 primary + **2 secondaries** → deliberately capture the one-`generateMergedContent`-call / all-secondaries-archived asymmetry (Chunk 7 must reproduce it exactly);
  3. merge refusal matrix → hot participant, unparseable participant (`skipReason: merge_participant_blocked`, pre-flight `:2174-2194` + post-generation re-check `:2253-2274`), missing/truncated description, generation guard;
  4. **delete** normal → archive fm (`status/superseded_at/superseded_reason`, NO `superseded_by`) + live delete; delete hot → `captureMode_hot_refused` (`:2438-2445`); delete already-gone;
  5. **promote** happy path → proposal payload pinned (description merged INTO body fm `:2641-2649`, xrefs union) + gate matrix in `:2477-2690` order: within-run dedup, superseded refusal, <100-char floor, pending-dup by body cacheHash, slug-variant `checkPreEmitDedup`, existing-knowledge-file idempotency — golden the gate OUTCOMES (skip/emit + reason), not guard message wording;
  6. **contradict** ≥0.92 → **byte-for-byte** output file (sorted-set `contradictedBy` append + `beliefState:'contradicted'` — timestamp-free, the plan's true byte-for-byte case); idempotent re-run; `archived` state preserved (never weakened); <0.92 skip; missing confidence defaults 1.0 (`:2699-2707`);
- `tests/commands/consolidate/goldens-merge-plans.test.ts` — pure-function goldens for `mergePlans` (`merge.ts:35`, precedence `:80-110`): hallucinated-ref drop, merge-wins-over-delete, promote-queued-before-merge, contradict pair-dedup — truly byte-for-byte JSON in/out.

**Steps**
1. Default config throughout, recorded in each fixture's `config` field: dedup pre-pass OFF (#617 default), judgedCache TRUE, hotProbation OFF, antiCollapse ON, `semanticSearchMode:'off'` (clustering no-op → plan phase deterministic).
2. Encoding: one JSON manifest per scenario `{relPath → {frontmatter: object, body: string}}` (key-order-proof) PLUS raw-bytes pins for contradict and merge-primary outputs (§3.2 rule 5). Hot memories minted via the `remember` hot-capture path (`remember-cli.ts:188,288` writes `captureMode:'hot'`).
3. Do not perturb the shared `writeContradictEdge` primitive's other callers (memory-contradiction-detect, `resolveFamilyContradictions`) — consolidate-path goldens only.
4. Extend, don't duplicate, the 13 existing `tests/commands/consolidate/*` suites — goldens serialize outcomes those suites assert piecemeal; where an existing test already pins a behavior, reference it in the fixture `notes` instead of re-asserting.
5. Designate all fixtures `frozen-migration-input` (Chunk 7 DoD 5 oracle); ref-serializing ones `re-baseline` @ `5`.

**Files**: `tests/commands/consolidate/goldens-consolidate-ops.test.ts`, `tests/commands/consolidate/goldens-merge-plans.test.ts`, `tests/fixtures/goldens/consolidate/fixture-refs.ts`, `tests/fixtures/goldens/consolidate/*.json`, `tests/fixtures/goldens/DESIGNATIONS.json`

**Acceptance**
- [R5] merge/delete/promote/contradict outcomes committed incl. `archiveMemory` + `superseded_by` frontmatter, proposal-gating exactly as today (only promote is proposal-gated; merge/delete/contradict mutate directly), contradict + merge-primary byte-for-byte; suites green at HEAD.
- [R5] mergePlans precedence table committed as pure-function goldens.
- [R6] Refs round-trip through fixture constants; op semantics key the scenarios, not ref literals.
- [R12/R13] Designated; unit scope; green.

---

### WI-06 — Consolidate goldens: journal round-trip, hot-capture guard, signal-delta gate

**testMode**: characterization-preserve · **dependsOn**: WI-01, WI-05 (shares consolidate harness) · **estLoc**: ~450

Covers **R5** (journal round-trip + backup/recovery, hot-capture guard, LOOK/CHANGE + signal-delta gate per §6 preserve list); applies **R6/R12**.

**Tests first**
- `tests/commands/consolidate/goldens-consolidate-journal.test.ts` — scenarios:
  1. full-run journal lifecycle → `writeJournal` shape `{startedAt:<TS>, operations, completed:[], backupTimestamp:<TS>}` (`:737-747`), per-op `backupFile` copies in `.akm/consolidate-backup/<TS>/`, `markJournalCompleted` appends, `cleanupJournal` removes journal + backup dir (`:761-774`) — end state: neither exists;
  2. incomplete journal + `recoveryMode:"abort"` (default) → throws with backup-dir hint; unreadable journal → `ConfigError` `INVALID_CONFIG_FILE`; `recoveryMode:"clean"` → `removeStaleJournal` (`:665-690`) unlinks journal AND backup dir (backupTimestamp, else startedAt `[:.]→-`); completed>=operations → silent cleanup (`checkForIncompleteJournal` `:692-735`, invoked at `:1012`);
  3. all-hot chunk → **zero** LLM calls (stub invocation count 0) + `judgedNoAction` accounting (`:1617-1636`);
  4. hot-capture verdict matrix → `consolidateGuardStatus` (`consolidate/eligibility.ts:60`) unit goldens for hot/safe/unparseable/missing (prompt-level annotation already covered by `consolidate-chunks.test.ts` — reference, don't duplicate).
- `tests/commands/improve/goldens-signal-delta-gate.test.ts` — pins the §6 preserve-list gate WITHOUT pinning the P0-A lane (which Chunk 7 deletes): `isSignalDeltaEligible` truth table (`eligibility.ts:421-431`), `buildLatestFeedbackTsMap` signal/note filter (`:349`), `buildLatestProposalTsMap` cursor rules (`:382`), and the `eligibleRefs`/`distillOnlyRefs`/`noFeedbackPool` partition **counts** from a full preparation run (lanes NOT asserted).

**Steps**
1. Journal scenarios: run real `akmConsolidate` with stubbed LLM; craft interrupted state by writing a journal fixture file (JSON, `<TS>`-normalized on capture) rather than by killing processes — keeps this unit-scope.
2. **Characterization warning**: journal recovery paths have ZERO existing test coverage — surprising outcomes (e.g., asymmetric cleanup between abort/clean) are captured as-is, flagged with a `notes` field in the fixture and listed in `report.md` for the maintainer; do NOT fix.
3. Signal-delta goldens seed feedback/proposal events with injected `now` (improve-eligibility patterns) and run `runImprovePreparationStage` via `akmImprove` with recording stubs; partition counts only.
4. Designate: journal + guard fixtures `frozen-migration-input`; signal-delta fixture `frozen-migration-input` (the gate survives Chunk 7 — §6 binding preserve list).

**Files**: `tests/commands/consolidate/goldens-consolidate-journal.test.ts`, `tests/commands/improve/goldens-signal-delta-gate.test.ts`, `tests/fixtures/goldens/consolidate/journal-*.json`, `tests/fixtures/goldens/improve/signal-delta-gate.json`, `tests/fixtures/goldens/DESIGNATIONS.json`

**Acceptance**
- [R5] Journal round-trip (write/check/cleanup + backup/recovery incl. abort/clean modes), hot-capture guard (verdicts + all-hot zero-LLM skip), and the signal-delta corrective-evidence gate + LOOK/CHANGE partition pinned; suites green at HEAD.
- [R5] Goldens deliberately avoid pinning P0-A lane selection or SC voting (Chunk 7 deletion conflict — see Risks).
- [R6/R12/R13] Encoding, designation, unit-scope criteria as above.

---

### WI-07 — CLI output baselines for the Chunk 9 sweep

**testMode**: characterization-preserve · **dependsOn**: WI-01 · **estLoc**: ~600

Covers **R4**; applies **R6/R12**.

**Tests first** (all unit scope via `runCliCapture` — NO spawns; extend, never duplicate, `tests/integration/output-baseline.test.ts` / `output-baseline-graph.test.ts` / `tests/html-output-cli.test.ts` / the 15 `*-cli-envelope` suites)
- `tests/commands/goldens-cli-output.test.ts` — families A/D/F:
  - A (helpers + shape/text registries; each in `--format=json` and `--format=text`, detail brief+full where branching): `search <term>`; `show` for script/command/skill/agent/knowledge fixtures (command fixture with AND without an active workflow to hit `formatShowPlain` APPLY-directive branches `helpers.ts:632-656`); `show ... --shape=agent` and `--shape=summary`; `list`; `info`; `curate <term>`; `history <ref>` (seeded usage events); `proposal list|show|diff` (seeded proposal); `env list` + `secret list` (redaction — baseline the redacted shape, do not add redaction); `events list` + `events tail --limit 1`; `config list`.
  - D (argv): `help migrate 0.6.0`; `help migrate --format json 0.6.0`; `help migrate --format=json` (no version → `MISSING_REQUIRED_ARGUMENT` envelope); `--version`; `--help`; `proposal list --shape=summary` (fail-fast `INVALID_SHAPE_VALUE` — summary is show-only, `shapes.ts:124`); `show <ref> lines 1-2 --format=text` (normalizeShowArgv view-mode); `setup --yes --no-init --dir <tmp>` (no- boolean `cli.ts:271`); `--quiet search x` (stderr suppression). If a `resolveHelpMigrateVersionArg` collision branch proves unreachable in-process, set/restore `process.argv` inside the test (the tripwire polices env/cwd/fetch, not argv); as a last resort add a spawn-based case to a NEW `tests/integration/goldens-cli-startup.test.ts` following `show-argv-entrypoint.test.ts`.
  - F (error envelopes): `show nonexistent:x` (NotFound, exit 1); `--format bogus` (Usage, exit 2); broken `config.json` + `list` (ConfigError, exit 78); 2-3 representative raw `throw new Error` sites in `src/commands/` captured as `ok:false` envelopes (message + code + exit) so the typed-error sweep preserves them.
- `tests/commands/goldens-cli-health-tasks.test.ts` — families B/C:
  - B (health; seeded state.db fixture + empty fixture): `health` (json); `health --format=text`; `health --group-by run --format=md`; `health --window-compare 24h --format=md`; repeated `--windows name=a,... --windows name=b,...` (the `parseAllFlagValues` path `cli.ts:371`); `health --since 7d --format=html --output <file>` and with `--compare 24h` → assert structural markers + `buildHealthHtmlReplacements` key-set at unit level (`html-report.ts:405`), NEVER html bytes; warn/fail fixtures pinning exit 4/1 (`cli.ts:427-432`).
  - C (tasks; fixture task YAML, command-type task running `true`): `tasks list`, `tasks show <id>`, `tasks run <id>` (scrub `<DUR>`/`<TS>`), `tasks history`, `tasks doctor`, `tasks run <id>` with invalid config.json (config-bypass path `cli.ts:609-620`).
- `tests/commands/goldens-duration-flags.test.ts` — family E (CLI + unit):
  - CLI: `extract --type claude-code --since 24h --dry-run`, `--since 30m|7d|<ISO>|garbage` (UsageError), **`--since 5M`** (case-variant: `[mhd]/i` at `extract.ts:416` makes it 5 MINUTES — pins the divergence from core `DURATION_UNITS` so Chunk 9 consolidation surfaces it at review); `health --since 5m`; `events list --since 24h` and `--since @offset:0`.
  - Unit goldens (not CLI-reachable): `parseSinceToIso` identity fallback on garbage input (`consolidate.ts:2824` — config-driven via `incrementalSince`; Chunk 9 must not silently swap it for core/time's throw); `resolveRelativeDates` phrase grammar (yesterday / last week|month|year / N days|weeks|months ago) with pinned `referenceDate` (`memory-improve.ts:362-391` — content rewriting, NOT flag parsing; must not be folded into duration grammar without this baseline making the change visible).

**Steps**
1. Assertions are **key-set + scrubbed-string** based (sorted `Object.keys`, `<STASH>`/`<TS>`/`<DUR>` scrubs) — never raw-byte CLI snapshots; where text output must embed refs, source them from `tests/fixtures/goldens/cli/fixture-refs.ts`.
2. Fixture stash built inline per `output-baseline.test.ts` convention (`withEnv` + mkdtemp XDG dirs + `AKM_STASH_DIR`); health state.db seeded via existing repository helpers.
3. Serialize per-command goldens to `tests/fixtures/goldens/cli/<family>-<command>.json` `{argv, exitCode, stdoutKeys|stdoutScrubbed, stderrScrubbed}`.
4. Designate: key-set/count assets `frozen-migration-input`; text outputs embedding refs `re-baseline` @ `5`.
5. Note in suite header: `runCliCapture` skips the real startup block — pure-startup behaviors (stale-index cleanup, banner, global rejection handlers) are exercised only by spawn-based integration tests and are NOT covered here.

**Files**: `tests/commands/goldens-cli-output.test.ts`, `tests/commands/goldens-cli-health-tasks.test.ts`, `tests/commands/goldens-duration-flags.test.ts`, `tests/fixtures/goldens/cli/fixture-refs.ts`, `tests/fixtures/goldens/cli/*.json`, `tests/fixtures/goldens/DESIGNATIONS.json`, (optional) `tests/integration/goldens-cli-startup.test.ts`

**Acceptance**
- [R4] Baselines committed for: helpers/shape-registry surfaces (incl. `formatShowPlain:528` both APPLY branches), renderers-backed show content per asset type, `akmHealth` json/text/md/html + exit codes + repeated `--windows`, tasks command family incl. config-bypass, argv surfaces (help/migrate/version, `--shape summary` gate, no- boolean, quiet), duration surfaces incl. the `[mhd]/i` case-variant and the two non-CLI residues as unit goldens; all green at HEAD.
- [R6] No raw-byte snapshots; refs via fixture constants; counts/key-sets preferred.
- [R12/R13] Designated; unit scope (gates `check:fast`).

---

### WI-08 — Chunk gate: green run, report, ledgers, designation audit

**testMode**: docs-assets · **dependsOn**: WI-01..WI-07 · **estLoc**: ~200 (docs only)

Covers **R7**, **R9**, **R11**, **R13** (gate), **R10** (final audit).

**Tests first**: none new — this item RUNS everything.

**Steps**
1. `bun install --frozen-lockfile` (must be no-op), then `bun run check:fast` — confirm the trailing `── unit: N pass / 0 fail` line from `scripts/test-unit.sh` (do not trust an interrupted run).
2. `bun run check` (adds `tests/integration` incl. the new recovery-golden suites and integration-scope safety suites).
3. Targeted safety replay (explicit, for the boundary record): `bun test --timeout=30000` over the 19 §15.3 files listed in §2.5.
4. Fixed-point audit: `git diff --stat <base>..HEAD -- tests/_helpers/sandbox.ts tests/_preload.ts scripts/lint-tests-isolation.ts scripts/test-unit.sh scripts/run-test-shard.sh` → MUST be empty; `git diff --stat <base>..HEAD -- src/` → MUST be empty.
5. Fixture-commit audit: `git status --porcelain` clean; designation meta-test green (every golden designated); every fixture named by WI-02..WI-07 present in the tree.
6. Write `docs/design/execution/chunk-0a/report.md`:
   - **Deletion ledger: EMPTY** (capture-only chunk) — committed explicitly per the manifest's hard gate.
   - **Net-LOC**: `src/` = 0 (verified); test+fixture LOC added (signed, from `git diff --shortstat`), ledgered separately per §15 rule 9; re-measured test-suite baseline at `3d9ee7b`: 564 files / 172,155 LOC (plan §15 header's 588/~175K is stale).
   - **Designation table**: asset → designation → reBaselineChunk → consumers (mirror of `DESIGNATIONS.json`).
   - **Anchor drift record**: link `anchors.md`; list the §2.6 ledger corrections for Chunks 7/6/9.
   - **Characterization surprises**: anything flagged in WI-06 step 2 (journal recovery) or elsewhere.
   - **Gate confirmation**: command outputs for steps 1-5.
7. Commit everything on `akm-090/chunk-0a`. Never push without the workflow's say-so.

**Files**: `docs/design/execution/chunk-0a/report.md`

**Acceptance**
- [R7] All golden fixtures from R1-R5 exist as committed files on `akm-090/chunk-0a`; audit in report.
- [R9] `check:fast` + `check` green at the boundary; 19 safety files replayed green; outputs recorded.
- [R10] Fixed-point diff empty; `src/` diff empty.
- [R11] report.md committed with empty deletion ledger + reported (not gated) net-LOC, test LOC ledgered separately.
- [R13] The chunk's §15.5 + §15.7 bucket is landed and green in this same chunk — replayable by Chunks 7/6/9 as the preservation oracle.

---

## 5. Requirement coverage matrix

| Req | Work items |
|---|---|
| R1 (SC call-count goldens) | WI-02 |
| R2 (P0-A selection goldens) | WI-02 |
| R3 (3 journal engines round-trip) | WI-03, WI-04 |
| R4 (CLI output baselines) | WI-07 |
| R5 (consolidate preservation goldens) | WI-05, WI-06 |
| R6 (grammar-agnostic encoding) | WI-01 (mechanism); enforced in WI-02..WI-07 acceptance |
| R7 (fixtures committed gate) | WI-02..WI-07 (commit as they land), WI-08 (audit) |
| R8 (re-anchor before capture) | WI-01 |
| R9 (chunk-boundary green gate) | WI-08 |
| R10 (fixed points untouched) | WI-01 (conventions), WI-08 (audit); constraint on all items |
| R11 (net-LOC + empty deletion ledger) | WI-08 |
| R12 (frozen-vs-re-baseline designation) | WI-01 (mechanism + meta-test); WI-02..WI-07 (designate); WI-08 (audit) |
| R13 (test bucket lands green in-chunk) | WI-02..WI-07 (suites), WI-08 (gate) |

## 6. Gate checklist

- **"Golden fixtures committed"** (manifest gate 1 / R7): satisfied by WI-02, WI-03, WI-04, WI-05, WI-06, WI-07 landing committed fixtures; final audit in WI-08.
- **"All plan line anchors re-measured at HEAD before capture"** (manifest gate 2 / R8): satisfied by WI-01 (`anchors.md`, committed before any capture item).
- Manifest global gates applying to this chunk: safety suites green at boundary (WI-08); named §15 test bucket lands in-chunk (WI-02..07 + WI-08); per-chunk deletion ledger committed — empty (WI-08); net-LOC reported, never gated (WI-08); no trust/lifecycle machinery (§1 out-of-scope, all items).

## 7. Risks and mitigations

1. **§5 ledger bullet 2 is factually stale**: proactive-maintenance (default-ON) and high-salience also improve never-rated assets. Unmitigated, P0-A goldens would attribute their selections to P0-A and Chunk 7's diff review would misread the deletion. → WI-02 captures both an isolated (proactive-OFF) set and a per-lane attribution set.
2. **Stub-driven reflect counts vs telemetry**: injected `reflectFn` bypasses `akmReflect`, so SC samples emit no `reflect_invoked` events — event-based counts would undercount. → Count stub invocations; document the production-telemetry note in the suite (WI-02 step 4).
3. **SC nondeterminism**: budget truncation (`loop-stages.ts:316`) and dedup/cooldown diversion (`:346-356`) can flip the 3×/1-proposal outcome. → Generous `budgetMs`, fresh stash per case (WI-02).
4. **Journal-internal encodings will be false-red in Chunk 6**: journal homes, phase names, txn layouts all change under one FileChange transaction. → §3.2 rule 4: outcomes only; phases informational (WI-03/04).
5. **Plan ranges miss the fsync/before-hash halves** (`repository.ts:1532-1619`, `mv-cli.ts:543-673`, `:999-1018`). → WI-03/WI-04 route through the real command paths so the gap is caught regardless of how Chunk 6 reads the plan; recorded in §2.6 for Chunk 6's inventory.
6. **Reject has no before-hash**: a unified transaction that adds hash gating would newly fail legitimate rejections. → WI-03 scenario 6 pins reject-during-concurrent-edit as succeeding today.
7. **Timestamp nondeterminism is pervasive and there is no clock seam** (`timestampForFilename`, `toISOString` in archive/journal/frontmatter). → `<TS>` normalization everywhere; contradict is the only truly timestamp-free byte-for-byte op — treated as such (WI-05).
8. **Journal-recovery goldens characterize untested code** (`checkForIncompleteJournal` paths have zero coverage) — latent bugs get frozen as oracle. → WI-06 flags surprising outcomes in fixture `notes` + report.md; never "fixes".
9. **Goldens must not pin what Chunk 7 deletes** beyond the two designated baselines: consolidate/improve goldens scope to the signal-delta GATE and partition, never P0-A lane membership or SC voting internals (WI-06).
10. **Multi-secondary merge asymmetry** (one LLM call, all secondaries archived) is current behavior Chunk 7 must reproduce. → WI-05 scenario 2 captures it deliberately.
11. **check:fast final verdict was pending at grounding time** (lint+tsc green; sharded unit run unconfirmed). → WI-01 step 4 makes confirming the green line a precondition to any capture.
12. **Spawn ban + allowlist ratchet (pinned at 63)**: any spawn outside `tests/integration/` fails lint. → CLI baselines exclusively via `runCliCapture`; crash scenarios live in integration scope (WI-03/04/07).
13. **`/dev/shm` cross-filesystem case silently skips where absent** — the existing behavior; Chunk 6 must keep an equivalent test. Recorded here so the collapse review checks it; 0a does not add CI infrastructure.
14. **Wave-2 rebase friction (§12.4)**: unavoidable ref literals invalidate at the Chunk 5 grammar cutover. → Fixture-constants routing + `re-baseline @ 5` designations make the re-key mechanical and policeable.
