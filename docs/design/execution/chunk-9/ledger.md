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
