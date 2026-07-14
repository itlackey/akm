# Chunk 0a — Hygiene goldens: chunk gate report (WI-08)

- **Chunk**: 0a (order 1, Wave 1) — "Hygiene goldens"
- **Branch**: `akm-090/chunk-0a` (worktree `/home/user/akm-worktrees/chunk-0a`)
- **Base at capture**: `3d9ee7b1917e8c4872f135fe9993d94b61b36ed1` (== head of `claude/akm-architecture-refactor-fubvd7` at brief authoring time)
- **Authority**: `docs/design/akm-0.9.0-bundle-adapter-architecture-plan.md` §11 Chunk 0a, §5, §12.3, §12.4, §15 rules 1/3/5/7/9; `docs/design/execution/chunk-0a/brief.md`; `docs/design/execution/chunk-0a/anchors.md`.
- **This item**: WI-08 — runs the full gate (no new src/tests of its own), audits WI-01..WI-07's landed work, and writes this report. Covers R7, R9, R10, R11, R13.

## 1. Deletion ledger — EMPTY

This is a capture-only chunk (plan §11 Chunk 0a). No production code in `src/` was touched and nothing was deleted anywhere. The ledger is committed explicitly empty per the manifest's hard gate (plan §15 rule 9 / brief §1 "Out of scope BY DESIGN").

| Deleted item | LOC | Rationale |
|---|---|---|
| — | — | — (no deletions in this chunk) |

## 2. Net-LOC (reported, not gated)

Per plan §15 rule 9 and the manifest's hard rules, net-LOC is **reported, not gated** — deletion (elsewhere, not in this chunk) is gated by inventory + zero-count greps, never by a LOC number.

### 2.1 `src/` — verified zero

```
git diff --stat 3d9ee7b1917e8c4872f135fe9993d94b61b36ed1..HEAD -- src/
```
produces **no output** (empty diff). Confirmed independently by the fixed-point/`src/` audit in §5 below. R10 satisfied.

### 2.2 Test-suite baseline denominators at `3d9ee7b` (verified exact, not stale)

Two denominators are in play and must not be conflated (brief §2.5, WI-08 step 6):

| Denominator | Basis | Files | LOC |
|---|---|---|---|
| All `tests/**/*.ts` | plan §15 header basis | 588 | 175,041 |
| `*.test.ts`-only | narrower, suite-files-only cut | 564 | 172,155 |

Both were re-measured directly against the `3d9ee7b` tree (`git ls-tree -r 3d9ee7b -- tests`, filtered by extension, summed with `wc -l` per blob) rather than trusted from the plan text. **Both match their respective brief/plan figures exactly** — the plan §15 header's `588/175,041` is correct at this HEAD and is *not* stale; it is the basis this chunk's added LOC is ledgered against below.

### 2.3 This chunk's added test/fixture LOC, ledgered against the all-`tests/**/*.ts` denominator

`git diff --shortstat 3d9ee7b..HEAD` (repo-wide, all paths): **78 files changed, 10,581 insertions(+), 0 deletions(-)**. Zero deletions anywhere confirms every change WI-01..07 made was purely additive (no rewrites of existing lines).

Breakdown by category (measured by summing tracked-blob line counts before/after, cross-checked against the shortstat total — 8,262 + 1,780 + 539 = 10,581, reconciles exactly):

| Category | Files added/changed | LOC added | Notes |
|---|---|---|---|
| `tests/**/*.ts` (suite files + `_helpers/golden.ts` + `fixture-refs.ts` modules) | 20 | 8,262 | Directly extends the plan §15 basis denominator: 175,041 -> 183,303 (+4.72%), 588 -> 608 files. Of these 20, 15 are `*.test.ts` suite files (+7,533 LOC against the narrower 172,155 denominator: 564 -> 579 files) and 5 are non-`.test.ts` support modules (`tests/_helpers/golden.ts` + one `fixture-refs.ts` per area: `improve/`, `journal/`, `consolidate/`, `cli/`). |
| `tests/fixtures/goldens/**/*.json` (golden fixtures + `DESIGNATIONS.json`) | 52 | 1,780 | Golden JSON is fixture data, not `.ts` source, so it sits outside the `tests/**/*.ts` glob denominator proper; ledgered here separately as the "fixture LOC" half of "test/fixture LOC" per WI-08 step 6's instruction. 51 golden assets + 1 `DESIGNATIONS.json` registry. |
| `docs/design/execution/chunk-0a/**` (`anchors.md`, `brief.md`) | 2 | 539 | Design-doc-execution artifacts, not test/fixture LOC; listed for completeness. `report.md` (this file) adds further docs LOC on top, captured in the final commit's own diffstat. |
| **Total** | **78** (incl. `.gitkeep`s) | **10,581** | Matches `git diff --shortstat` exactly. |

**Reading**: this chunk added 8,262 lines of `.ts` test code (suites + helpers + fixture-ref constant modules) and 1,780 lines of JSON fixture data, against a starting `tests/**/*.ts` population of 175,041 LOC — i.e. roughly 5.7% combined growth (the fixture JSON lives alongside but outside the `.ts` glob). `src/` net-LOC is exactly 0. Nothing here is a gate; it is recorded so later chunks (which *do* delete, per plan §15 rule 9's inventory+grep gate) have a clean before/after baseline to diff against.

## 3. Designation table (mirror of `DESIGNATIONS.json`)

51 entries, one per golden asset under `tests/fixtures/goldens/**` (excluding `fixture-refs.ts` modules and `DESIGNATIONS.json` itself, per the registry's own policy). Policed by `tests/goldens-designations.test.ts` (WI-01), confirmed green — see §8.

| Asset | Designation | reBaselineChunk | Consumer(s) |
|---|---|---|---|
| `improve/self-consistency.json` | re-baseline | 7 | `tests/commands/improve/goldens-self-consistency.test.ts` |
| `improve/p0a-selection.json` | re-baseline | 7 | `tests/commands/improve/goldens-p0a-selection.test.ts` |
| `journal/proposal-txn.json` | frozen-migration-input | - | `tests/commands/proposal/goldens-proposal-txn.test.ts` |
| `journal/proposal-recovery.json` | frozen-migration-input | - | `tests/integration/goldens-proposal-recovery.test.ts` |
| `journal/move-txn.json` | frozen-migration-input | - | `tests/commands/goldens-mv-txn.test.ts` |
| `journal/move-recovery.json` | frozen-migration-input | - | `tests/integration/goldens-mv-recovery.test.ts` |
| `consolidate/consolidate-ops.json` | frozen-migration-input | - | `tests/commands/consolidate/goldens-consolidate-ops.test.ts` |
| `consolidate/merge-plans.json` | frozen-migration-input | - | `tests/commands/consolidate/goldens-merge-plans.test.ts` |
| `consolidate/journal-lifecycle.json` | frozen-migration-input | - | `tests/commands/consolidate/goldens-consolidate-journal.test.ts` |
| `consolidate/journal-recovery.json` | frozen-migration-input | - | `tests/commands/consolidate/goldens-consolidate-journal.test.ts` |
| `consolidate/journal-guard-verdicts.json` | frozen-migration-input | - | `tests/commands/consolidate/goldens-consolidate-journal.test.ts` |
| `improve/signal-delta-gate.json` | frozen-migration-input | - | `tests/commands/improve/goldens-signal-delta-gate.test.ts` |
| `cli/a-config-list.json` .. `cli/a-show-shapes.json` (Family A, 11 assets, excl. the two re-baseline ones below) | frozen-migration-input | - | `tests/commands/goldens-cli-output.test.ts` |
| `cli/a-search-text.json` | re-baseline | 5 | `tests/commands/goldens-cli-output.test.ts` |
| `cli/a-show-per-type.json` | re-baseline | 5 | `tests/commands/goldens-cli-output.test.ts` |
| `cli/b-health-*.json` (6 assets) | frozen-migration-input | - | `tests/commands/goldens-cli-health-tasks.test.ts` |
| `cli/c-tasks-*.json` (2 assets) | frozen-migration-input | - | `tests/commands/goldens-cli-health-tasks.test.ts` |
| `cli/d-help*.json`, `d-quiet-search.json`, `d-setup-no-init.json`, `d-shape-summary-gate.json`, `d-version.json` (7 assets, excl. the one re-baseline below) | frozen-migration-input | - | `tests/commands/goldens-cli-output.test.ts` |
| `cli/d-show-lines-view.json` | re-baseline | 5 | `tests/commands/goldens-cli-output.test.ts` |
| `cli/e-events-since.json`, `e-extract-since.json`, `e-health-since.json` | frozen-migration-input | - | `tests/commands/goldens-duration-flags.test.ts` |
| `cli/f-config-error.json`, `f-not-found.json`, `f-raw-error-sites.json`, `f-usage-error.json` | frozen-migration-input | - | `tests/commands/goldens-cli-output.test.ts` |
| `improve/since-to-iso-identity-fallback.json` | frozen-migration-input | - | `tests/commands/goldens-duration-flags.test.ts` |
| `improve/resolve-relative-dates.json` | frozen-migration-input | - | `tests/commands/goldens-duration-flags.test.ts` |

Full per-asset notes (rationale, caveats, deviations) are in `tests/fixtures/goldens/DESIGNATIONS.json` itself — this table is a summary mirror, not a replacement. Designation split: **5 `re-baseline`** (2 @ Chunk 7 for the improve SC/P0-A lanes the plan deliberately deletes; 3 @ Chunk 5 for ref-serializing CLI text outputs the grammar codemod will re-key), **46 `frozen-migration-input`** (preservation oracles for Chunks 6/7/9 that must reproduce these outcomes exactly).

## 4. Anchor-drift record

`docs/design/execution/chunk-0a/anchors.md` (committed by WI-01, before any capture item) re-measures every plan line anchor at HEAD `3d9ee7b` and supersedes the plan's line numbers for this chunk and every chunk that consumes its goldens (Chunks 7, 6, 9 per plan §12.4). Link: [`anchors.md`](./anchors.md).

Known §5-ledger corrections carried into `anchors.md` §2.6, recorded here again for Chunk 7/6/9's diff review (brief §2.6 — do NOT act on them in this chunk):

1. **§5 bullet 2 is stale**: P0-A is not the only path improving never-rated assets. The proactive-maintenance lane ships `enabled:true` by default (`src/assets/improve-strategies/default.json`, selector `preparation.ts:1351-1369`) and the #608 high-salience lane also rescues zero-feedback refs. WI-02's `p0a-selection.json` isolates (proactive-OFF) and attributes (per-lane counts) accordingly.
2. `processSession` takes **20** positional args, not 19 (`extract.ts:552`).
3. Calibration auto-tune implementation lives in `preparation.ts:121-204`/`calibration.ts:204,269`/`config-schema.ts:814-820`, not `improve.ts:497` (which is now only a comment block at HEAD). Chunk 7's D9 deletion inventory must be re-pointed there.
4. The SC deletion range must extend to `loop-stages.ts:335-365` (winner-persist tail), `reflect.ts:148/1537-1563` (`draftMode` option + branch), `improve.ts:203/208` (SC knobs), and the `reflect-sc-` sourceRun grammar — all outside the plan's original `loop-stages.ts:307-331` range.
5. Chunk 6's collapse scope must include `repository.ts:1532-1619` (`prepareProposalTransaction`/`publishProposalAsset`, the fsync + before-hash half) and `mv-cli.ts:543-673` + `:999-1018` (`applyMoveFilesystem`/`persistMoveEvent`) or the mandated fsync/before-hash preservation is unverifiable — both ranges sit outside the plan's stated anchors and WI-03/WI-04 route their success-path goldens through the real command paths specifically to exercise them.

Additionally, `anchors.md` §2.5 documents the revised §15.3 boundary-set enumeration (basis, exclusions, reconciliation) — replayed in full in §7 below rather than restated here.

## 5. Fixed-point + `src/` audit (R10)

```
$ git diff --stat 3d9ee7b1917e8c4872f135fe9993d94b61b36ed1..HEAD -- \
    tests/_helpers/sandbox.ts tests/_preload.ts \
    scripts/lint-tests-isolation.ts scripts/test-unit.sh scripts/run-test-shard.sh
(no output -- empty diff)

$ git diff --stat 3d9ee7b1917e8c4872f135fe9993d94b61b36ed1..HEAD -- src/
(no output -- empty diff)
```

Both diffs are empty. None of the five fixed points (`tests/_helpers/sandbox.ts`, `tests/_preload.ts`, the mock.module-ban lint, `scripts/test-unit.sh`, `scripts/run-test-shard.sh`) were touched, and `src/` is untouched in full. R10 satisfied.

## 6. Fixture-commit audit (R7)

- `git status --porcelain` — clean (verified before and during this work item; the only pending change before the final commit is `report.md` itself).
- Designation meta-test (`tests/goldens-designations.test.ts`) — green, part of the `check:fast` unit run (§8).
- Every fixture named by WI-02..WI-07's "Files" sections is present as a committed file — cross-checked directly (24 explicit non-glob paths + all golden-area glob contents): all present. 51 `tests/fixtures/goldens/**/*.json` assets, all with exactly one `DESIGNATIONS.json` entry (§3).
- All 15 golden/meta suite files present: `tests/goldens-designations.test.ts`, `tests/golden-normalize.test.ts`, `tests/commands/improve/goldens-self-consistency.test.ts`, `tests/commands/improve/goldens-p0a-selection.test.ts`, `tests/commands/proposal/goldens-proposal-txn.test.ts`, `tests/integration/goldens-proposal-recovery.test.ts`, `tests/commands/goldens-mv-txn.test.ts`, `tests/integration/goldens-mv-recovery.test.ts`, `tests/commands/consolidate/goldens-consolidate-ops.test.ts`, `tests/commands/consolidate/goldens-merge-plans.test.ts`, `tests/commands/consolidate/goldens-consolidate-journal.test.ts`, `tests/commands/improve/goldens-signal-delta-gate.test.ts`, `tests/commands/goldens-cli-output.test.ts`, `tests/commands/goldens-cli-health-tasks.test.ts`, `tests/commands/goldens-duration-flags.test.ts`.

R7 satisfied.

## 7. §15.3 boundary replay -- the 38-file set (R9)

### 7.1 Enumeration basis (reproducible)

Filename grep over `tests/**/*.test.ts`, one pattern per category -- `traversal|escape|safety|scan`, `redact|dangerous`, `lock|busy|journal|contention`, `migration` -- then every hit confirmed in or excluded by content inspection; the symlink category has no dedicated filenames and is enumerated by content grep instead. Verified at `3d9ee7b` (brief §2.5, carried verbatim into `anchors.md` §2.5).

### 7.2 Per-category file list (28 dedicated + 10 symlink carriers = 38 files / 11,240 LOC)

**Traversal/escape (5 files, 782 LOC)** -- unit: `tests/env-traversal.test.ts` (134), `tests/workflow-path-escape.test.ts` (173), `tests/stash-dir-safety.test.ts` (117, ruled IN -- #473 regression, same catastrophic-path threat class); integration: `tests/integration/tar-utils-scan.test.ts` (80), `tests/integration/git-source-safety.test.ts` (278).

**Redaction/dangerous-key (7 files, 866 LOC)** -- unit: `tests/redaction.test.ts` (149), `tests/config-cli-redaction.test.ts` (86), `tests/env-run-dangerous-key-block.test.ts` (57), `tests/vault-dangerous-key-install-gate.test.ts` (109), `tests/vault-dangerous-key-lint.test.ts` (344), `tests/commands/improve/improve-redaction.test.ts` (67 -- this is the redaction coverage for the improve surface Chunk 7 rewrites), `tests/commands/wiki-ingest-redaction.test.ts` (54).

**SQLite journal/busy/lock/contention/cross-proc (10 files, 1,709 LOC)** -- unit: `tests/sqlite-journal-mode.test.ts` (326), `tests/db-busy-timeout.test.ts` (88), `tests/index-writer-lock.test.ts` (109), `tests/commands/improve/improve-lock-invariants.test.ts` (119), `tests/commands/improve/improve-db-locking.test.ts` (290), `tests/commands/improve/improve-skip-if-locked.test.ts` (141 -- the improve-lock trio covers the improve surface Chunk 7 rewrites); integration: `tests/integration/index-writer-lock-crossproc.test.ts` (46), `tests/integration/workflow-db-contention.test.ts` (185), `tests/integration/file-lock.test.ts` (350), `tests/integration/improve-lock-serialization.test.ts` (55).

**Migration (6 files, 2,279 LOC)** -- unit: `tests/migration-lifecycle-regression.test.ts` (1,062), `tests/migration-backup.test.ts` (405), `tests/storage/engine-cutover-historical-migrations.test.ts` (84), `tests/workflows/migrations.test.ts` (251), `tests/storage/sqlite-migrations.characterization.test.ts` (273 -- dual-listed, also a §15 rule-5 characterization asset; replay-only here, never re-recorded in 0a); integration: `tests/integration/migration-apply-crash.test.ts` (204).

**Symlink carriers (10 files, 5,604 LOC, embedded -- no dedicated filenames)** -- unit: `tests/commands/improve/improve-dry-run-side-effects.test.ts`, `tests/commands/mv.test.ts`, `tests/coverage-hardening/sources-resolution.test.ts`, `tests/source-providers/provider-utils.test.ts`, `tests/source-resolve.test.ts`, `tests/source.test.ts`; integration: `tests/integration/indexer.test.ts`, `tests/integration/package-launcher.test.ts`, `tests/integration/ripgrep-install.test.ts`, `tests/integration/walker.test.ts`. `tests/commands/mv.test.ts` and `tests/integration/walker.test.ts` carry the symlink-containment coverage for `mv-cli.ts` -- the surface Chunk 6 rewrites -- so their presence in the boundary record matters downstream.

All five plan-named categories (traversal/escape, symlink, redaction/dangerous-key, SQLite lock/contention, migration) are represented.

**Independently re-verified during this work item**: `wc -l` over all 38 file paths sums to exactly **11,240** -- matches the brief/`anchors.md` figure exactly. All 38 files confirmed present on disk before the replay ran.

### 7.3 Explicit exclusions (grep hits ruled OUT, with rationale)

- `tests/preload-safety.test.ts` (52 LOC) -- verifies the *test-harness* sandbox anchoring of `_preload.ts` itself (a fixed point); test-infra self-check, not a product safety surface -- it runs in every `check:fast` regardless.
- `tests/lockfile.test.ts` (259 LOC) -- filename false positive: "lockfile" is the sources manifest `akm.lock`; tests `readLockfile`/`writeLockfile` JSON parsing and atomic write, not lock/contention.
- `tests/frontmatter-block-scalar.test.ts` (92 LOC) -- grep false positive, "lock" inside "block-scalar"; YAML parsing.
- `tests/migration-help.test.ts` (126 LOC) -- renders `akm help migrate` CLI guidance, a Chunk 9 argv/output surface baselined by WI-07 family D, not a data-migration suite.
- `tests/contracts/migration-baseline.test.ts` (23 LOC) -- doc-contract test asserting design-doc sections exist, no runtime migration behavior.
- `tests/file-context.test.ts` (720 LOC) -- NOT symlink coverage; grep shows only a variable named `realPath`.

All six exclusion files independently confirmed present on disk with the stated LOC (`wc -l`): 52 / 259 / 92 / 126 / 23 / 720.

### 7.4 Reconciliation vs plan §15 rule 3's "~22 files / ~4,700 LOC"

The plan figure corresponds to a narrower cut: the previous 19-file enumeration (4,240 LOC) plus the three most obvious omissions (`improve-redaction` 67, `wiki-ingest-redaction` 54, `improve-lock-invariants` 119) is exactly 22 files / 4,480 LOC -- inside the plan's `~` tolerance. The strict basis-stated enumeration in `anchors.md` adds six more in-category files (`improve-db-locking` 290, `improve-skip-if-locked` 141, `stash-dir-safety` 117, `engine-cutover-historical-migrations` 84, `workflows/migrations` 251, `sqlite-migrations.characterization` 273 = +1,156 LOC), landing at 28/5,636. Union with the 10 symlink carriers (5,604 LOC, no overlap) gives the 38/11,240 replay set. This is a conservative replay list -- over-inclusion costs seconds of test time; silent under-inclusion is the review-blocker class this revision fixes.

Note: `tests/sqlite-journal-mode.test.ts` is about SQLite PRAGMA `journal_mode` -- unrelated to the three FS journal engines (proposal/reject/mv); not conflated with the journal-engine goldens (WI-03/WI-04) anywhere in this chunk.

### 7.5 Downstream-relevance notes

- `tests/commands/mv.test.ts` and `tests/integration/walker.test.ts` cover the **Chunk 6 mv surface** (symlink-containment coverage for `mv-cli.ts`, the engine Chunk 6 collapses).
- `tests/commands/improve/improve-redaction.test.ts` and the improve-lock trio (`improve-lock-invariants.test.ts`, `improve-db-locking.test.ts`, `improve-skip-if-locked.test.ts`) cover the **Chunk 7 improve surface** (the self-consistency/P0-A lanes Chunk 7 deletes).

### 7.6 Replay command and result

See §8.4 for the exact command line and captured pass/fail counts.

## 8. Gate confirmation -- command outputs

### 8.1 `bun install --frozen-lockfile`

No-op, as expected (lockfile already satisfied):
```
$ bun install --frozen-lockfile
bun install v1.3.11 (af24e281)
Checked 111 installs across 144 packages (no changes) [346.00ms]
```

### 8.2 `bun run check:fast`

Full, uninterrupted run (lint -> tsc --noEmit -> sharded unit suite):

```
$ bun run check:fast
$ bunx biome check src/ tests/ && bun scripts/lint-tests-isolation.ts && bun scripts/lint-license-headers.ts && bun scripts/lint-runtime-boundary.ts && bun scripts/lint-repository-sql.ts && bun scripts/gen-config-schema.ts --check
Checked 1162 files in 2s. No fixes applied.
lint-tests-isolation: OK — no isolation / determinism violations found
✓ MPL-2.0 header present in all 476 src/**/*.ts files.
lint-runtime-boundary: OK — runtime primitives are confined to src/storage/database.ts and src/runtime.ts
lint-repository-sql: OK — registry + workflow-runtime reach storage only through src/storage/repositories
schemas/akm-config.json is up to date.
$ bash scripts/test-unit.sh
── unit: 28668 pass / 0 fail across 4 process-shards
```

Trailing line confirmed: **`── unit: 28668 pass / 0 fail across 4 process-shards`**, exit code 0. `tsc --noEmit` produced no output (silent success, as expected — no type errors). Lint (biome + the four repo lint scripts + config-schema regen check) all green. `tests/goldens-designations.test.ts` (the R12 designation meta-test) and all 13 WI-02..07 golden suites are part of this run and passed within the 28,668 total.

### 8.3 `bun run check`

First full end-to-end run (`lint && tsc --noEmit && test:unit && test:integration`) surfaced one **flaky, pre-existing, unrelated** failure in the integration suite:

```
$ bun run check
[... lint/tsc/unit identical to §8.2 ...]
$ bun run sweep:tmp && bun test --timeout=30000 ./tests/integration
tests/integration/workflow-crash-windows.test.ts:
(fail) multi-process crash windows > Window A: SIGKILL after the unit row is
  running but before finish -> resume re-dispatches it exactly once and
  completes [917.26ms]
  expect(received).toBe(expected)
  Expected: 0
  Received: 3

 880 pass
 50 skip
 1 fail
 2984 expect() calls
Ran 931 tests across 80 files. [162.78s]
error: script "test:integration" exited with code 1
error: script "check" exited with code 1
```

**Investigation (not hidden, not waved away):** `tests/integration/workflow-crash-windows.test.ts` is untouched by this chunk — `git diff --stat 3d9ee7b..HEAD -- tests/integration/workflow-crash-windows.test.ts` is empty, and the file's own history shows its last change predates the chunk-0a base commit entirely. It is not one of the 38 §15.3 boundary files, not one of the 13 WI-02..07 golden suites, and does not exercise any surface this chunk baselines (it is a real-`bun`-subprocess SIGKILL crash-window test for the *workflow/task-runner* engine, timing-synchronized on marker files + journal polling — see the file's own header comment). Re-running it in isolation immediately after the full 28,668-test unit run (which had just saturated all 4 cores) reproduced a *different* sub-test failing (Window B this time, not Window A):

```
$ bun test --timeout=30000 tests/integration/workflow-crash-windows.test.ts
(fail) multi-process crash windows > Window B: SIGKILL after the unit
  completes but before the step does -> resume reuses the unit, replaces
  the dangling gate row, finalizes once [571.23ms]
 1 pass
 1 fail
```

A second immediate isolated re-run passed clean:

```
$ bun test --timeout=30000 tests/integration/workflow-crash-windows.test.ts
 2 pass
 0 fail
Ran 2 tests across 1 file. [1.86s]
```

A different sub-test failing on each attempt, both timing-sensitive real-SIGKILL windows, both clearing on a clean-CPU retry, is the signature of **pre-existing CPU-contention flakiness** (the failure surfaced only when `test:integration` was launched back-to-back with the just-completed 28,668-test unit run on a 4-core box), not a regression this chunk introduced — consistent with `src/` being completely untouched (§5). To get an authoritative, uncontended confirmation, `test:integration` was re-run standalone (own `sweep:tmp` + fresh process, no concurrent unit suite):

```
$ bun run test:integration
$ bun scripts/sweep-test-tmp.ts
$ bun test --timeout=30000 ./tests/integration
 881 pass
 50 skip
 0 fail
 2985 expect() calls
Ran 931 tests across 80 files. [163.67s]
```

**Result: green, 0 fail.** Combined with the already-green `lint` + `tsc --noEmit` + `test:unit` (§8.2, unaffected by `test:integration`'s outcome since they ran and passed first in the same pipeline), all four `check` stages are confirmed green — the flaky failure is recorded above rather than hidden, per this work item's honesty requirement, and diagnosed as pre-existing/unrelated rather than silently retried away.

### 8.4 Targeted §15.3 boundary replay

38-file set (28 dedicated + 10 symlink carriers), run standalone with the mandated explicit timeout:

```
$ bun test --timeout=30000 <38 files per §7.2>
tests/vault-dangerous-key-install-gate.test.ts:
{ "ok": false, "error": "Install blocked: stash \"evil/stash\" contains
  dangerous env keys...", "code": "DANGEROUS_VAULT_KEY", ... }
[improve] another improve run holds the lock (PID ..., started ...);
  skipping (--skip-if-locked)

 428 pass
 0 fail
 2 snapshots, 3413 expect() calls
Ran 428 tests across 38 files. [52.29s]
```

**428 pass / 0 fail across all 38 files, exit code 0.** The two logged lines above (`"ok": false` dangerous-key-block JSON and the `[improve] ... skipping` message) are *expected* stdout/stderr emitted by the dangerous-key-gate and skip-if-locked tests themselves as part of asserting those behaviors — not failures or warnings about the run. All five plan-named §15.3 categories (traversal/escape, symlink, redaction/dangerous-key, SQLite lock/contention, migration) are exercised and green.

## 9. Characterization surprises

Per brief §1 ("Capture, not aspiration... surprising outcomes get a code comment + a note in `report.md`, not a 'fix'") and Risk 8, the following surprising-but-real behaviors were captured as-is during WI-01..WI-07 and are recorded here for the maintainer:

1. **Consolidate journal recovery: "completed >= operations" leaves a permanent orphaned backup dir** (`tests/fixtures/goldens/consolidate/journal-recovery.json`, `tests/commands/consolidate/goldens-consolidate-journal.test.ts`). `checkForIncompleteJournal` (`consolidate.ts:692-735`) treats a journal whose `completed.length >= operations.length` as *not* incomplete -- no throw, no removal. This means such a journal's own `.akm/consolidate-backup/<TS>/` directory becomes a permanent orphan that no code path this suite could find ever reclaims. Journal-recovery paths had **zero existing test coverage** before WI-06; this latent behavior is now frozen as the oracle, not fixed, per the chunk's capture-only mandate.
2. **Proposal accept target-mutated-during-displace abort does not restore the target byte-identically, and leaves two orphaned artifacts.** The brief's `testsFirst` description expected the surfaced abort message `"Proposal target changed while its backup was being acquired"` and a byte-identical restore. The real HEAD behavior (captured in `tests/fixtures/goldens/journal/proposal-txn.json`, documented in the suite's file-header DEVIATION comment) is: `publishProposalAsset`'s catch block calls `rollbackPreparedProposalTransaction`, which independently re-checks the asset's hash against `originalHash` and -- because the external mutation persists -- finds its own divergence and throws a *different*, shadowing error (`"Cannot roll back proposal transaction: <path> diverged."`) before the original "Proposal target changed..." message can propagate. The asset is left holding the externally-mutated content (not restored), and the transaction directory plus a stray `.akm-proposal-<txnId>.publish` file are orphaned (neither `cleanupProposalPublication` nor `cleanupProposalTransaction` runs, since the rollback call itself threw). Recorded as a DEVIATION from the brief, captured per the test-first protocol's "the brief turns out to be wrong about the code" clause -- the minimal faithful interpretation is to golden what actually happens.
3. **Mv REPLACE-window divergent-citer abort surfaces a wrapped, two-part error string**, not a bare `"refusing to replace divergent citer"` prefix as the brief's `testsFirst` description implied: the real string is `"Move failed (refusing to replace divergent citer <path>) and rollback failed (cannot restore <path>: file diverged after exclusive ownership)."` (`tests/fixtures/goldens/journal/move-txn.json`, `tests/commands/goldens-mv-txn.test.ts` DEVIATION 2). Also, `_setMvMutationHookForTests` never fires between the stage and replace windows (only post-filesystem-commit) -- `spyOn` interception was used instead to reach this scenario.
4. **P0-A once-per-asset gate is event-driven, not proposal-record-driven** (not a bug, but a non-obvious invariant worth flagging): `buildLatestProposalTsMap` sources exclusively from `reflect_invoked` events. A persisted reflect proposal with no corresponding event does **not** block re-rescue of the same asset. This is by design at HEAD, documented in `tests/fixtures/goldens/improve/p0a-selection.json`'s `notes` field and the owning suite, and is load-bearing for how Chunk 7's diff review must read the lane's deletion (a naive read of "did a proposal get created" would misjudge the gate).
5. **§5 ledger bullet 2 is factually stale at this HEAD** (not a code surprise, but a plan-doc correction): P0-A is not the only lane rescuing never-rated assets -- proactive-maintenance (default `enabled:true`) and the #608 high-salience lane also do. WI-02's goldens isolate and attribute per-lane so Chunk 7's diff review doesn't misattribute removed selections.

No other surprising outcomes were flagged by WI-01..07's suite comments beyond the above (searched via `DEVIATION`/`CHARACTERIZATION` markers across `DESIGNATIONS.json` and the golden suite files).

## 10. Acceptance checklist (WI-08)

- [x] [R7] All golden fixtures from R1-R5 exist as committed files on `akm-090/chunk-0a` -- audited in §6, all present.
- [x] [R9] `check:fast` + `check` green at the boundary; the 38-file §15.3 boundary set replayed green -- outputs in §8, category list + basis + exclusions + reconciliation in §7.
- [x] [R10] Fixed-point diff empty; `src/` diff empty -- confirmed in §5.
- [x] [R11] `report.md` committed with empty deletion ledger + reported (not gated) net-LOC, test LOC ledgered separately -- §1, §2.
- [x] [R13] The chunk's §15.5 + §15.7 bucket (consolidate preservation goldens, WI-05/WI-06) is landed and green in this same chunk, replayable by Chunks 7/6/9 as the preservation oracle -- confirmed via the designation table (§3) and the green suite run (§8).
