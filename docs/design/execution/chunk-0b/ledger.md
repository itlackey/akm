# Chunk 0b — execution ledger (append-only)

Migration goldens & oracles. Capture-only (netLoc 0). Branch:
`claude/akm-architecture-refactor-fubvd7` (single designated branch; the
manifest's per-chunk branch names are not used in this execution).

## Opened — grounding census + brief

- `anchors.md` (236 lines): line-drift re-anchoring (§12.4), the 14-format
  producer inventory, the `deriveCanonicalAssetNameFromStashRoot` minting
  oracle, filter/whyMatched/rank surfaces, the migration-fixture shapes for
  Chunk 8, the §15.5 golden inventory (50 DESIGNATIONS entries: 47
  frozen-migration-input + 3 re-baseline), and 6 headline findings.
- `brief.md`: 8 work items (WI-0b.1..8), decisions D0b-1..4, an 8-item trap
  list. All bound to census anchors.

### Decisions recorded (maintainer may override)
- **D0b-1** goldens under `tests/fixtures/goldens/**` (DESIGNATIONS-policed);
  parity goldens are FROZEN behavior oracles.
- **D0b-2** re-key generator = 4 key shapes ({bare,origin-qualified}×{plain,
  .derived}); harness encodes Chunk-8 invariants (most-recently-updated wins),
  exercises simultaneous-collision — the stronger rule the current
  delete-then-rename `rekeyStateDbForMove` does not implement.
- **D0b-3** designation vocabulary for frozen behavior oracles — resolved in
  WI-0b.1.
- **D0b-4** dedicated 14-type fixture stash (`minimal/` has only 5).

### Census findings carried forward (not 0b's to fix, flagged for later chunks)
- Config "discriminated schemas" = 9 named `ProcessConfigSchema` consts, not
  `z.discriminatedUnion`; wide monolith retained by design (grep trap).
- `processSession` threaded into `ExtractSessionRunCtx`, not minted RunContext.
- `src/core/eval/rank-metrics.ts` GONE → `scripts/akm-eval/src/rank-metrics.ts`.
- Micro-drifts folded into WI-0b.1: `lint-goldens-presence.ts:74` "51"→"50";
  characterization-suite count is 7 not 6.
