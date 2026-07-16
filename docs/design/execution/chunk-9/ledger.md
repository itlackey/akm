# Chunk 9 — deletion/behavior ledger

Opened at HEAD `365f5b09` (chunk 6 closed; full check green 4454/0/55 in
the integration stage, exit 0 overall). Work items land per brief order;
this ledger records each item's deletions, behavior changes, gate
evidence, and net LOC as it lands. Status: IN PROGRESS.

## Baseline records (pre-work, at 365f5b09)

- Import-cycle ratchet: 107 participants == 107-entry baseline (armed at
  chunk-7 HEAD 43d6f10; nothing trimmed by chunks 6/7). Dynamic-import
  companion: 32 files / 100 call sites.
- run-context-adoption ratchet baseline: 8 (improve.ts:1,
  loop-stages.ts:7). createRunContext src constructors: 0.
- fn-size ratchet: SRC_FN_SIZE_BASELINE ≤20 entries (shrink-tolerant);
  improve/** absolute-empty gate green. Chunk-9-owned entries:
  buildHealthHtmlReplacements 646, akmHealth 272, projectRunMetrics 270,
  stepSmallModelConnection 272, stepLlm 250, runAgent 298.
- `_set*ForTests` seams: 19 definitions (3 fs-txn crash + 2 migration
  crash hooks + 13 ambient-DI + 1 dead).
- resolveStashDir src invocations: ~49 across 27 files.
- Bare `throw new Error(`: src/commands 78, src/core 26, src total 211;
  6 out-of-hierarchy Error subclasses.
- Frozen goldens: 47 sha-pinned (lint-verified); architecture ratchets
  28/28 green; goldens-designations 7/7.

## Decisions pending (brief "Decisions REQUIRED" 1–5)

To be recorded here as they are made, before the affected work items
land: (1) crash-window seam retention; (2) adoption of the two unowned
cycle SCCs; (3) the 30-file taxonomy-residual reading of gate 2;
(4) --format html surface; (5) deterministic-embedder relocation no-op.

## Decisions 1–3 recorded (session, per brief recommendations; maintainer may override)

(1) Crash-window seams RETAINED: the fs-txn trio
(_setTxnMutationHookForTests + the proposal/mv wrappers) and the two
migration hooks (_setRestoreRollbackBoundaryHookForTests,
_setAfterPendingOperationCheckHookForTests) are fault-injection points
that subprocess crash runners and the chunk-6 fault suite depend on — a
RunContext thread does not replace a crash hook. The §10.1 retirement
set is therefore the 13 ambient-DI seams; ledgered deviation from the
plan-letter "18 seams" (true count 19; see anchors A.1).
(2) The two unowned cycle SCCs (harness config-import trio, improve
command trio) are ADOPTED into Chunk 9's kill set — both are small
type-leaf severs, and DoD 11's enumeration simply missed them; without
adoption gate 2's "every other participant dead" is unsatisfiable.
(3) Gate 2's "taxonomy set" is read as the 30-file residual of the
mega-SCC after Chunk 9's config/harness cuts (held cyclic by the
output/renderers.ts hub; anchors D.4.3) plus the C5 and C8 trios.

## WI-9.1 — small deletions cluster (landed with this entry)

Deletions: (a) dead seam _setSaveConfigForTests + its saveConfigOverride
indirection (config.ts — zero callers anywhere; saveConfig now calls
saveConfigReal directly); (b) database.ts:14 stale "not CI-tested this
pass" claim rewritten (node-smoke + node-compat DO run in CI); (c) §14.3
resume machinery: HarnessResumeSupport interface, AkmHarness.resume? +
BaseHarness mirror, the 6 harness declarations, PI_RESUME_FLAG +
AMAZONQ_RESUME_FLAG (+ their exports/imports), and the stale doc-comment
references across 8 harness files — zero production readers existed;
4 test files updated (resume-matrix assertions removed, imports
trimmed); (e) getImproveProcessConfig's vestigial `_config` param
removed with all 8 src + 7 test call sites. Ripples fixed in the same
change: finalizeMerge no longer destructures ctx.config;
emitDistillLessonProposal + buildDistillMessages lost their now-dead
`config` arg fields (internal callers updated); countNewExtractCandidates
keeps its (dead) first param UNDERSCORED because its signature feeds the
extractCandidateCountFn test seam — full removal rides WI-9.10's context
rework; three now-purposeless cfg constructions removed from
config.test.ts. (f) ci.yml: the Node-fallback verification moved out of
the `check` job into a dedicated `node-smoke` job with a
node-version matrix ["20.12.0", "22", "24"] — CENSUS CORRECTION to plan
§14.4: there was NO pre-existing matrix and NO Node 22 coverage; the
matrix is introduced, not extended. release.yml already builds on Node
24; no release-gates workflow exists (plan framing inaccurate — recorded,
nothing further owed here).

DEFERRED from the brief's WI-9.1 list: (d) pushOnCommit deletion —
CENSUS CORRECTION: the knob is NOT schema-only. write-source.ts:304 maps
the deprecated per-asset intent onto the batch push gate (with the
one-time deprecation warning at :323–334) and improve.ts:938 reads it in
the push-default chain. Deleting it changes push behavior for configs
that set it — moved to WI-9.6 with its own decision (complete the
deprecation vs keep the warn+map window one more minor).

Adversarial review: 1 blocker + 3 concerns, all fixed pre-commit. The
blocker: the new node-smoke job ran the smoke/compat suites without
`bun run build`, and scripts/node-smoke.ts fails fast when
dist/cli-node.mjs is missing — the build step the old in-job ordering
provided implicitly was restored explicitly. Concerns: ledger call-site
count corrected (8 src + 7 test); a duplicate assertion + the
now-inexpressible "does not implicitly consult" test collapsed in
config.test.ts; five further stale resume comments swept (aider ×3,
openhands ×2, opencode-sdk ×1 across builder/index/harness files).

Gates: tsc clean; biome full-tree clean; zero-count greps
(_setSaveConfigForTests 0; HarnessResumeSupport|RESUME_FLAG|
AkmHarness.resume 0 in src TS); harness+agent+config suites 448/0
post-fix; improve bucket green; architecture ratchets 28/28 un-piped;
full lint green (47 frozen goldens hash-verified).
