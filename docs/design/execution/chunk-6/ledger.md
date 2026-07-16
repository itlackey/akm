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

## WI-6.6a — diff formatters decomposed (landed 4bd4502a)

formatUnifiedDiff + formatNewAssetDiff moved verbatim from repository.ts
into src/commands/proposal/diff-format.ts; pure-suite import repointed.
Behavior: none. Frozen outcome oracles byte-green; gates 28/28. Net:
repository.ts −41, new module +53 (doc header).

## Escalations recorded before WI-6.1/6.4 (from the gate/dedup grounding)

Two plan tensions requiring explicit decisions (recorded in the brief's
amendment section; neither blocks the other work items):

1. drain.ts (KEPT) is a live consumer of recordGateDecision +
   Proposal.gateDecision, which the plan's §4.5 DELETE row names
   wholesale. Options (a) retain-as-drain-owned vs (b) replace with
   WI-6.4 fingerprint/backoff records. Decision deferred to the session
   that lands WI-6.1; the deletion MUST NOT land before this is resolved.
2. consolidate.ts:1772 uses autoAccept === undefined as the interactive
   confirm-prompt trigger (dual-purpose knob). The knob's deletion needs a
   decided replacement trigger; the re-baseline-@6 consolidate goldens'
   autoAccept:100 bypass re-captures with it.

Also recorded: proposal-txn.json's skipShapes section requires
surface-owner re-designation BEFORE WI-6.4's fingerprint change (split
preferred); the DDL characterization suite must be RESTORED from
3927ff94^ and re-recorded alongside migration 019 (its snapshot is
orphaned at HEAD); health autoAccept window keys stay zero-valued
(frozen-golden-compatible); shipped default tasks' --auto-accept flag
semantics decided with WI-6.1.

## WI-6.6b — bulkAdjudicateProposals (landed with this entry)

The two near-identical bulk --generator loops in proposal-cli.ts (accept
:110–155, reject :214–259) + their verbatim-duplicated flag validation
collapse onto one bulkAdjudicateProposals(action, generator, filters) in
proposal.ts and a shared parseBulkFilterFlags CLI helper. Behavior
verbatim: same filter order (source → maxDiffLines on payload content
lines → olderThan on createdAt), same per-item accept/reject envelopes,
same dry-run record shape, same batch output shapes; the destructive
confirm prompt stays CLI-side. Suites: proposal-cli (bulk safety guard +
WS3 bulk paths) 44 green incl. frozen outcome oracles; gates 28/28.
Net: proposal-cli.ts −67, proposal.ts +63.
