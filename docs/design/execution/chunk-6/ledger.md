# Chunk 6 — deletion/behavior ledger

Opened at HEAD `b393317f` (W1-a residuals closed, full check green
4481/0/55). Work items land per brief order; this ledger records each
item's deletions, behavior changes, gate evidence, and net LOC as it
lands. Status: IN PROGRESS.

## Baseline records (pre-work)

- improve-auto-accept suites: 42 pass / 0 fail ×3 consecutive runs at
  `b393317f` (tests/integration/commands/improve/improve-auto-accept.test.ts
  + tests/cli/auto-accept.test.ts) — the ledgered order-dependent flake did
  not reproduce at this HEAD; any future red is attributable to the diff
  under test.
- Frozen outcome oracles green at `b393317f` (full-check integration
  bucket): journal/proposal-txn.json, journal/move-txn.json.
- Architecture ratchets 28/28 at `b393317f`.
