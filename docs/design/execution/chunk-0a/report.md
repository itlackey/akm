# Chunk 0a — Hygiene goldens: chunk report

- **Chunk**: 0a (order 1, Wave 1) — "Hygiene goldens"
- **Branch**: `akm-090/chunk-0a` (worktree `/home/user/akm-worktrees/chunk-0a`)
- **Base / merge-base**: `3d9ee7b1917e8c4872f135fe9993d94b61b36ed1` (head of `claude/akm-architecture-refactor-fubvd7` at brief-authoring time)
- **HEAD at audit**: `ea4bed66`
- **Authority**: `docs/design/akm-0.9.0-bundle-adapter-architecture-plan.md` §11 Chunk 0a, §5, §12.4, §15.5, §15.7; `docs/design/execution/chunk-0a/brief.md`; `docs/design/execution/chunk-0a/anchors.md`.
- **Auditor**: whole-chunk audit (Opus 4.8). This report supersedes and consolidates the WI-08 gate report; the full WI-08 forensic detail remains in git history at `ea4bed66`.

## 0. Verdict

**PASS.** All eight work items are `done` (single attempt each, no escalations). Every manifest chunk gate is green. `src/` and `scripts/` diffs are empty (0 production LOC, matching the manifest `netLoc: "0 (capture-only)"` estimate exactly). The chunk's §15.5 + §15.7 test bucket landed and is green. The one non-green mark in the gate ledger — a single-invocation `bun run check` flake — is a pre-existing, CPU-contention SIGKILL-timing flake in `tests/integration/workflow-crash-windows.test.ts`, a file this chunk never touches (empty diff vs base); the decomposed local-green gate (tsc + unit + standalone integration + safety replay) is independently green. Accounted for below (§4), not a chunk-0a regression.

## 1. Per-item outcomes

| Item | Title | Status | Attempts | Key commits | Escalation |
|---|---|---|---|---|---|
| WI-01 | Golden-fixture infra + designation registry | done | 1 | `0803a08`, `b01c254`, `c447492` | — |
| WI-02 | improve-run goldens (self-consistency + P0-A) | done | 1 | `2d8889c`, `f7412ac` | — |
| WI-03 | proposal accept/revert/reject journal goldens | done | 1 | `85d7600`, `30e39bb`, `376f3a3` | — |
| WI-04 | mv move-transaction engine goldens | done | 1 | `6ccff8a`, `54facb8` | — |
| WI-05 | consolidate op-outcome + mergePlans goldens | done | 1 | `a7550dd`, `c62c59d`, `4991071` | — |
| WI-06 | consolidate journal round-trip + signal-delta gate goldens | done | 1 | `5d3e1aa`, `e2c241c` | — |
| WI-07 | CLI output baseline goldens | done | 1 | `68b3549`, `1e93ff8` | — |
| WI-08 | chunk gate report (green run, ledgers, designation audit) | done | 1 | `ea4bed66` | — |

No item was blocked; there are **no escalation files** for this chunk. The gate-repair pass made **no commits** and is recorded as `DISPUTED` (see §4) — the only reported failure was the out-of-scope pre-existing flake, which correctly received no forced fix.

Every item followed the test-first protocol (a `test(...)` commit that fails first, then a `feat(...)` capture commit). WI-01 additionally committed the anchor record (`c447492`) before any capture item ran, satisfying the §12.4 line-drift gate.

## 2. Gate table

| Gate | Result | Basis |
|---|---|---|
| **Manifest: Golden fixtures committed** | GREEN | 51 golden JSON assets + `DESIGNATIONS.json` + 4 `fixture-refs.ts` modules committed; working tree clean; designation meta-test green. |
| **Manifest: Plan line anchors re-measured at HEAD before capture (§12.4)** | GREEN | `anchors.md` committed at `c447492` (before first capture `f7412ac`); spot-checks confirm HEAD source (e.g. `processSession` = 20 params). |
| Global: Zero-count greps (§11), chunk-scoped | GREEN (n/a) | 0a is manifest order 1; every deletion grep targets a strictly-later chunk, so all are out of scope this run. |
| Global: Safety suites port-first + green at boundary (§15.3); fixed points untouched | GREEN | Fixed-point diff empty; 38-file / 11,240-LOC boundary set replayed 428 pass / 0 fail standalone. |
| Global: Named §15 bucket lands this chunk (§15.5 + §15.7) | GREEN | 15 golden suite files present + green within the 28,668-test unit run. |
| Global: Per-chunk deletion ledger committed (HARD) | GREEN | Explicitly-empty ledger committed (capture-only chunk, no deletions). |
| Global: Net-LOC reported, never gated | GREEN | `src/` + `scripts/` diff empty; reported below, not gated. |
| Global: No new trust/approval/security machinery; memory lifecycle deferred | GREEN | `src/` untouched entirely; tests/docs diff contains only golden content-hashing (sha256 for fixture comparison), no trust/lifecycle machinery. |
| Global: Local green gate (tsc + unit + affected integration + safety) | GREEN | tsc silent; unit 28,668/0; standalone integration 881 pass / 50 skip / 0 fail; safety replay 428/0. |
| `bun run check` (single combined invocation) | FLAKED — accounted (§4) | Combined back-to-back run hit a CPU-contention flake in an untouched file; decomposed superset gate above is green. |

Independently re-verified during this audit: `src/`+`scripts/` diff empty; only `tests/` (76 files) and `docs/` (3 files) touched; 52 `*.json` under `tests/fixtures/goldens/` (51 assets + `DESIGNATIONS.json`); designation registry parses to 51 entries (46 frozen-migration-input / 5 re-baseline: `improve/self-consistency.json` + `improve/p0a-selection.json` @ Chunk 7, `cli/a-search-text.json` + `cli/a-show-per-type.json` + `cli/d-show-lines-view.json` @ Chunk 5); golden meta-tests (`goldens-designations`, `golden-normalize`) re-run green here (30 pass / 0 fail).

## 3. Net-LOC actuals vs estimate

- **Manifest estimate**: `netLoc: "0 (capture-only)"` — i.e. zero net production LOC.
- **Actual `src/` + `scripts/`**: `git diff --shortstat 3d9ee7b..HEAD -- src/ scripts/` → empty. **Delta vs estimate: 0.** The estimate is met exactly.
- **Total additive churn** (`git diff --shortstat 3d9ee7b..HEAD`, all paths): **79 files changed, +10,880 / −0** — purely additive, zero deletions anywhere.
  - `tests/**/*.ts` (15 golden suite files + 5 helper/fixture-ref modules): ~8,262 LOC.
  - `tests/fixtures/goldens/**/*.json` (51 assets + `DESIGNATIONS.json`): ~1,780 LOC.
  - `docs/design/execution/chunk-0a/**` (`anchors.md`, `brief.md`, `report.md`): ~838 LOC.

Net production LOC is the gated-adjacent number and it is **0**, on estimate. The ~10,880 additive test/fixture/doc LOC is reported per §15 rule 9 and is **not** gated — it gives later chunks (which do delete, gated by inventory + zero-count greps) a clean before/after baseline.

## 4. The one non-green gate — accounted for

`bun run check` as a single invocation failed once on `tests/integration/workflow-crash-windows.test.ts > 'Window A'` (`expect 0, received 3`). This is **not** a chunk-0a regression:

- The file is untouched by this chunk — `git diff --stat 3d9ee7b..HEAD -- tests/integration/workflow-crash-windows.test.ts` is empty; last real edit predates the base commit.
- `src/` is untouched entirely, so a capture-only chunk cannot logically regress a real-subprocess SIGKILL crash-recovery test.
- It is not one of the 38 §15.3 boundary files nor one of the 15 golden suites.
- The flake reproduces on a *different* subtest each back-to-back run (Window A, then Window B) and clears on standalone rerun — the signature of real-`bun`-subprocess SIGKILL timing sensitivity under CPU contention (surfaced only when `test:integration` launched immediately after the 28,668-test unit run saturated all cores).
- Standalone `bun run test:integration` (fresh process): **881 pass / 50 skip / 0 fail** — matches the committed figures.
- CI (`.github/workflows/check.yml`) runs `bun run check` with no retry/quarantine, so this is a pre-existing repo-wide property, not introduced here.

The gate-repair pass correctly declined to touch it: a "fix" would edit `workflow-crash-windows.test.ts` / `workflow-crossproc.ts` — outside this chunk's brief — and would risk weakening a crash-recovery oracle that Chunks 6/9 depend on. Recommendation for downstream chunks running the full `check`: run `test:unit` and `test:integration` as separate gate steps, or rerun uncontended, to avoid the contention flake.

## 5. §15 test bucket — landed

- **§15.5 (goldens, capture-only; each asset designated frozen vs re-baseline)**: 15 golden suite files landed. improve self-consistency + P0-A goldens are designated `re-baseline @ Chunk 7` (the lanes the plan deletes); journal (3 engines) + consolidate + CLI goldens are `frozen-migration-input` preservation oracles (with 3 ref-serializing CLI fixtures `re-baseline @ Chunk 5`).
- **§15.7 (consolidate behavior-preservation goldens captured here)**: consolidate op-outcome (`consolidate-ops.json`), mergePlans (`merge-plans.json`), journal round-trip (`journal-lifecycle` / `journal-recovery` / `journal-guard-verdicts`), and signal-delta gate goldens all present and green.

Goldens are grammar-agnostic where possible per §12.4 — assertions pin counts/outcomes (`callCount`, `persistedProposalCount`, per-lane histograms, journal phase states), and the WI-01 normalizer scrubs ids/timestamps to `<ID>`/`<TXN>`/`<TS>` — minimizing Wave-1 rebase friction; ref-serializing fixtures are the ones flagged `re-baseline @ 5`.

## 6. Minors carried forward (non-blocking)

None of these gate the chunk; recorded for downstream owners.

**WI-01 (golden infra):**
1. `<TXN>` override in `golden.ts:104-106` reclassifies every `<ID>` under a transaction-named key — a key-name (not content) heuristic; WI-03/WI-04 authors own extending it if a real fixture co-locates proposal + transaction ids under one transaction-named key. (Handled by those items.)
2. Module doc comment overstates coverage: `idempotencyMetadataKey` does not contain "transaction" and its value is a key-name string, never a UUID — actual coverage is via `mutationTransactionId`. Doc-comment wording nit.
3. `fileTreeManifest` / `sha256File` (incl. `walkFileTree` symlink-follow branch) have no direct unit coverage; optionally add when WI-02+ first consumes them.
4. Process: the pre-capture `── unit: N pass / 0 fail` line was not captured by the WI-01 developer (suite exceeded the time budget). Later confirmed green (28,668/0) by WI-08.

**WI-02 (improve goldens):**
1. Report claimed `improve-eligibility.test.ts` unaffected; on a loaded box one test hits its hardcoded 5000ms timeout in isolation — a pre-existing slow-box flake in a file byte-identical to base, not a WI-02 defect.
2/3/4. DRY (4 harness helpers duplicated across the two suites), each scenario executed twice (capture kept independent of within-file order — deliberate), and the lane-attribution scenario is name-sort-dependent (documented; fixture is re-baseline @ 7). All optional.

**WI-03 / WI-04 (journal goldens):** `proposal-txn.json` and `move-txn.json` are designated `frozen-migration-input` while carrying ref/path literals that Chunk 5's grammar codemod will re-key. Mitigated with explicit prose caveats in the fixture `notes[]` and `DESIGNATIONS.json` (schema permits one designation per path). Defensible (Chunk 5 changes ref spelling, not captured behavior). **Chunk 5 hand-off action**: either re-designate these ref-serializing journal goldens `re-baseline @ 5` so the codemod picks them up mechanically, or confirm the frozen+caveat convention with the maintainer. Plus per-item DRY nits (capture blocks re-implement assertion setup — deliberate, documented).

**WI-05 (consolidate ops):** DESIGNATIONS note says hot fixtures write `captureMode:hot`/`beliefState:asserted` but the fixture writes only `captureMode:hot` (the field `consolidateGuardStatus` reads) — reword the note. Scenarios drive op-handlers directly rather than via a full `akmConsolidate()` run (justified; selection loop covered by mergePlans + pre-existing suite). Test-scaffold casts and narrative comments — nits.

**WI-06 (consolidate journal + signal-delta):** Re-recording `journal-lifecycle.json` under `AKM_UPDATE_GOLDENS=1` yields a cosmetic biome-vs-serializer whitespace diff on short arrays (values byte-identical after parse; suite green either way) — optionally reconcile `saveGolden` array formatting with biome. Signal-delta truth-table rows 4/5/6 serialize identically after `<TS>` normalization but carry different `eligible` values; ordering semantics are pinned by the inline truth-table tests, so coverage is complete.

**WI-07 (CLI goldens):** (a) `formatShowPlain` `isCommandOutputSkill` APPLY sub-branch not captured (only the YAML else path) — optional. (b) The `show <ref> lines` scenario hard-codes `knowledge:lines-fixture.md` instead of sourcing from `fixture-refs.ts`, so Chunk 5's re-key codemod cannot find it mechanically — asset is already flagged `re-baseline @ 5` for manual re-capture; optionally add a `D_LINES_KNOWLEDGE_NAME` constant. (c) `a-search.json` argv term derives from `A_SCRIPT_NAME`; a future fixture-refs rename would drift this frozen fixture — boundary call, optionally document.

**WI-08 (gate):** `bun run check` single-invocation flake — see §4.

## 7. Characterization surprises captured (frozen as oracle, not fixed)

Per the capture-only mandate, these real-but-surprising HEAD behaviors are goldened as-is and documented for the Chunk 6/7/9 diff reviews:

1. **Consolidate journal recovery** treats `completed.length >= operations.length` as not-incomplete → the journal's backup dir becomes a permanent orphan (`consolidate.ts:692-735`). Zero prior test coverage; now frozen.
2. **Proposal accept target-mutated-during-displace abort** does not restore byte-identically and leaves two orphaned artifacts; `rollbackPreparedProposalTransaction` throws a shadowing `"...diverged."` error before the surfaced `"Proposal target changed..."` message propagates. Captured as a documented DEVIATION from the brief's expectation.
3. **Mv REPLACE-window divergent-citer abort** surfaces a wrapped two-part error (`"Move failed (...) and rollback failed (...)."`), not a bare prefix; `_setMvMutationHookForTests` never fires mid-window (spyOn used).
4. **P0-A once-per-asset gate is event-driven** (`buildLatestProposalTsMap` from `reflect_invoked` events), not proposal-record-driven — a persisted proposal without a matching event does not block re-rescue. Load-bearing for Chunk 7's deletion read.
5. **§5 ledger bullet 2 is stale at HEAD**: P0-A is not the only lane rescuing never-rated assets — proactive-maintenance (default `enabled:true`) and the #608 high-salience lane also do. WI-02 goldens isolate/attribute per-lane. (Anchor-drift correction, carried in `anchors.md` §2.6; do **not** act on it in this chunk.)

## 8. Anchor-drift corrections for downstream (from `anchors.md`)

Recorded so Chunks 7/6/9 diff reviews use the re-measured anchors, not the stale plan line numbers (do not act in 0a):

- `processSession` takes **20** positional args (`extract.ts:552`), not 19.
- Calibration auto-tune lives in `preparation.ts:121-204` / `calibration.ts:204,269` / `config-schema.ts:814-820`, not `improve.ts:497`.
- The SC deletion range extends beyond the plan's `loop-stages.ts:307-331` to `loop-stages.ts:335-365`, `reflect.ts:148/1537-1563`, `improve.ts:203/208`, and the `reflect-sc-` sourceRun grammar.
- Chunk 6's collapse scope must include `repository.ts:1532-1619` (fsync + before-hash half) and `mv-cli.ts:543-673` + `:999-1018`, or the fsync/before-hash preservation is unverifiable — WI-03/WI-04 route success-path goldens through the real command paths to exercise them.

## 9. Auditor conclusion

All work items done; all manifest and global chunk gates green; the sole red mark is a documented, out-of-scope, pre-existing environmental flake with the decomposed local-green gate independently green. Diff is purely additive and entirely within brief scope (only `tests/` + `docs/`, `src/`/`scripts/` untouched). Net production LOC = 0, on estimate. §15.5 + §15.7 buckets landed and green. No new trust/approval machinery; memory lifecycle untouched. **Chunk 0a accepted (PASS).**
