# `akm improve` does no proactive maintenance in steady state — add a proactive-maintenance selector

## Problem

`akm improve` produces almost no reflect/distill output in steady state.

Measured from the live `state.db`:

- Every recent run rejects the **entire ~11,700-ref pool** as `no_new_signal`.
- `improve_completed` shows `plannedRefs: 0`, `reflectActions: 0`,
  `distillActions: 0`, `rejectedActions: ~11,000` per run.
- **12,776 of 13,328 eligible assets (95.9%) have never been reflected.**
- Output is dominated by consolidate + extract; reflect/distill are near-zero.

The June 5–12 "high output" was **two transient anomalies that reverted** (a
06-11 extract backfill from a `journal.jsonl` sessionId collision bug, and a
06-12 consolidate flush), **not** a regression. Restoring raw `promoted` volume
is the **wrong goal** — much of it was noise.

## Root cause

- The eligibility model is a **signal-delta gate** that is **load-bearing** —
  introduced in `6a5e0ca4` to fix the 2026-05-26 synchronized-wave incident; a
  budget-cap alternative was deliberately removed in `4c1700b2`. **Do not remove
  the gate or reintroduce cooldowns.**
- The gate has **no proactive lane**, so a mature stash with sparse feedback
  does nothing (cache "no-access = no-work" pathology).
- Three compounding bugs:
  1. **P0-A control-flow bug** — zero-feedback assets are filtered out one phase
     before the P0-A fallback can see them, so P0-A is dead for its intended
     population (`src/commands/improve/improve.ts:2421-2471`).
  2. **`getRetrievalCounts` undercount** — no ref normalization (stash-prefixed
     vs bare → ~half signal lost) and ignores `curate` events
     (`src/indexer/db/db.ts:1860`).
  3. **Per-ref skip writes** — one `improve_skipped` row per ref (~11K/run,
     ~400K rows/day), contributing to 900 s timeouts.

## Proposed solution

Separate **LOOK** (cheap, liberal, never zero) from **CHANGE** (conservative,
gated, default no-op). akm **already has the CHANGE gate** — #580 (`c0c09308`)
suppresses empty-diff/cosmetic reflects, and distill is additive/reversible — so
a liberal selector is safe; non-substantive proposals are discarded for free.

- **Layer 1 (SHIPPED, pending review)** — branch
  `fix/improve-proactive-eligibility-a91a` (`e8fb4bf1`): revive P0-A, fix
  `getRetrievalCounts` (normalize + count curate), aggregate the skip event.
  Tests added; typecheck + lint clean.
  *(Caveat: an orphaned worktree holds the un-suffixed branch name; use `-a91a`.)*
- **Layer 2 (PROPOSED)** — a **due-gated, composite-priority, bounded rotating
  sweep** added as a **new eligibility source alongside** signal-delta and P0-A
  (not replacing them):
  - Priority `= (importance_by_type × log(1+correctedRetrievalFreq) × (0.1 + 0.5^(useAgeDays/21))) / log10(sizeBytes)`
  - `N = 25`/run, due if never reflected or >30d; per-ref cooldown guarantees rotation.
  - Prototype: composite priority beats oldest-first **~12×** on retrieval freq
    (top-25 avg 55.8 vs 4.4); full due-pool sweep in ~5.3 days.
  - Requires the Layer 1 corrected retrieval count, else ranking collapses to
    oldest-first.
  - Expose knobs via **config/profile** (today `--min-retrieval-count` is
    CLI-only and no scheduler sets it).

Avoids the synchronized-wave regression because it takes a fixed top-N of the
due set per run (rate = N), not timer expiry.

## Design doc

`docs/design/improve-proactive-maintenance.md`

## Acceptance criteria

- [ ] Layer 1 (`e8fb4bf1`) reviewed and merged.
- [ ] Proactive selector added as a third eligibility source in
      `improve.ts` (signal-delta + P0-A unchanged).
- [ ] Composite-priority ranking implemented per the formula (not oldest-first).
- [ ] Due-gating + per-ref cooldown guarantees rotation (no head re-pick).
- [ ] `N`, `DUE_DAYS`, importance weights, and enable flag configurable via
      config/profile.
- [ ] One-time backlog-drain path to clear the ~96%-due backlog, then settle to `N=25`.
- [ ] Observability: per-source attribution on `improve_completed`; track
      **coverage** and **accepted-change rate vs do-nothing baseline**. Stop
      using `promoted` count as the success metric.
- [ ] Confirm no synchronized-wave behavior and no corpus-drift signal before
      defaulting on.

## Labels

`improve`, `enhancement`, `pipeline`, `needs-review`
