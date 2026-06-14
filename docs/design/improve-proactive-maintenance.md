# Design: Proactive-Maintenance Selector for `akm improve`

Status: Layer 1 shipped (pending review); Layer 2 proposed
Author: improve-pipeline investigation
Date: 2026-06-14
Related commits: `6a5e0ca4`, `4c1700b2`, `c0c09308`, `a020504f`, `e8fb4bf1`
Related issues: #377, #419, #580, #607

## 1. Problem

`akm improve` produces almost no reflect/distill output in steady state.

Measured from the live `state.db`:

- Every recent run rejects the **entire ~11,700-ref pool** as `no_new_signal`.
- `improve_completed` metadata shows `plannedRefs: 0`, `reflectActions: 0`,
  `distillActions: 0`, `rejectedActions: ~11,000` per run.
- Output (`promoted` events) is dominated by **consolidate + extract**, not
  reflect/distill, which have been near-zero the whole time.

### The "wrong goal" caveat

The June 5–12 window looked like "high output", but it was **two transient
anomalies that reverted, not a regression**:

1. A 06-11 `extract` backfill of ~9,425 invocations, partly caused by a
   `journal.jsonl` `sessionId` collision bug.
2. A 06-12 `consolidate` flush.

Restoring raw promotion volume is therefore the **wrong** success metric — much
of that volume was noise. The real goal is steady, *useful* maintenance of the
corpus, not a high `promoted` count. See §7 (Observability).

## 2. Root cause

### 2.1 The eligibility gate is load-bearing — do not remove it

The improve eligibility model is a **signal-delta gate**. An asset is reflected
or distilled only if:

- **(a)** it has fresh feedback since its last proposal
  (`isSignalDeltaEligible`, `src/commands/improve/improve.ts:808`), or
- **(b)** it is a high-retrieval asset never reflected before — the **P0-A**
  fallback (`src/commands/improve/improve.ts:2421-2471`), which by design fires
  **at most once per asset, ever**
  (`... && !lastReflectProposalTs.has(ref)`, `improve.ts:2451`).

This gate is **load-bearing**:

- It was introduced in commit `6a5e0ca4` to fix a real 2026-05-26
  "synchronized wave" incident — 54 refs firing simultaneously when 30-day
  cooldowns expired together.
- A budget-cap design (`explorationBudget`, #377 / #419) was tried and
  **deliberately removed** in commit `4c1700b2`, with the rationale:
  *"usage is the gate; rate control is the scheduler's job."*

**Therefore: the gate must NOT be ripped out, and cooldowns must NOT be
reintroduced.**

### 2.2 The missing proactive lane (the actual defect)

The model has **no proactive lane**. In steady state — a mature stash with
sparse feedback — it does nothing. This is the cache "no-access = no-work"
pathology: an asset that is heavily *read* but never *written-to* and never
*given explicit feedback* is invisible to improve forever.

### 2.3 Three compounding bugs

1. **P0-A control-flow bug.** Zero-feedback assets fall into the
   `fullySkipped` `else` branch one phase *before* the fallback can see them:
   `noFeedbackCandidates` is filtered from `processableRefs`, which already
   excludes them, so P0-A is effectively **dead for its intended population**.
   Result: **12,776 of 13,328 eligible assets (95.9%) have never been
   reflected.**
2. **`getRetrievalCounts` undercount** (`src/indexer/db/db.ts:1860`). It
   raw-matches `entry_ref` with no normalization (stash-prefixed vs. bare refs
   → roughly half the signal lost) and **ignores `curate` events**
   (`entry_ref` NULL).
3. **Per-ref skip-event write amplification.** The `fullySkipped` branch wrote
   one `improve_skipped` DB event **per ref** (~11K/run, ~400K rows/day),
   contributing to the 900 s task timeouts.

## 3. Guiding principle: separate "decide to LOOK" from "decide to CHANGE"

From prior-art research:

- **LOOK** (selection) should be **cheap, liberal, and never zero** —
  staleness/priority driven.
- **CHANGE** (mutation) should be **conservative, gated, and default no-op**.

Pure signal-gating stalls (our current state). Pure unconditional sweeping is
worse — it generates noise that can actively **damage** a corpus. The
*"Useful Memories Become Faulty When Continuously Updated by LLMs"* finding
reports **54% of previously-solved tasks failed after consolidation drift**
(https://dylanzsz.github.io/faulty-memory/).

**Crucially, akm already has the CHANGE gate.** A liberal proactive selector is
therefore *safe*, because every proposal it emits still has to pass the existing
no-op gates:

- **#580** (commit `c0c09308`) suppresses empty-diff / cosmetic-only reflect
  proposals (`src/commands/improve/reflect.ts:1389`,
  `classifyReflectChange` → `reflect_skipped_noop` / `reflect_skipped_cosmetic`).
- **distill** is additive/reversible — ADD / UPDATE / NOOP merge modes
  (`src/commands/improve/distill.ts:988-1007`); redundant memories go to a
  recoverable archive, not deletion.

So a liberal selector at most *proposes* more candidates; non-substantive ones
are discarded for free.

### Prior art

| Source | Idea applied |
|---|---|
| FSRS / SM-2 | Staleness-based scheduling (review-when-due) |
| GDSF cache priority | recency × frequency / cost ranking |
| Generational GC | Hot assets often, stable assets rarely (future cadence) |
| PostgreSQL autovacuum | Accumulation-threshold trigger |
| Generative Agents reflection | Importance-accumulation trigger |
| SEDM | Verifiable write admission (mirrors our #580/distill gates) |

## 4. Design

### Layer 1 — bug fixes (SHIPPED, pending review)

Branch `fix/improve-proactive-eligibility-a91a` (commit `e8fb4bf1`):

- **Revives P0-A** for zero-feedback high-retrieval assets (fixes §2.3 bug 1).
- **Fixes `getRetrievalCounts`** (§2.3 bug 2): bareRef normalization via
  `parseAssetRef`, and counts `curate` events; `curate.ts` now writes per-item
  `entry_ref` rows.
- **Aggregates the `no_new_signal` event** into one counted event (fixes §2.3
  bug 3); `health.ts buildImproveSkipSummary` honors the count.
- Tests added: `tests/get-retrieval-counts.test.ts`,
  `tests/commands/improve/improve-eligibility.test.ts`. Typecheck + lint clean,
  no regressions.

> **Branch-name caveat.** The canonical branch is
> `fix/improve-proactive-eligibility-a91a`. An orphaned worktree held the
> un-suffixed name `fix/improve-proactive-eligibility`; use the `-a91a` branch.

Layer 1 fixes are necessary but not sufficient — they make P0-A *work*, but
P0-A still fires at most once per asset. They do not provide an ongoing
proactive lane. That is Layer 2.

### Layer 2 — proactive-maintenance selector (PROPOSED, validated by prototype)

A **due-gated, composite-priority, bounded rotating sweep** that plugs in as a
**new eligibility SOURCE alongside signal-delta and P0-A — not replacing
them**. `mergedRefs` in `improve.ts:2469-2471` gains a third contributor.

**Due-gating.** A ref is "due" if it has never been reflected, or was last
reflected more than `DUE_DAYS` (default 30) ago. Re-reflecting within `DUE_DAYS`
is skipped — this per-ref cooldown is what *guarantees rotation* (every selected
ref leaves the due set until it ages back in), so the sweep cannot re-pick the
same head every run.

**Composite priority** (rank the due set, take the top N):

```
priority =
  ( importance_by_type
    × log(1 + correctedRetrievalFreq)
    × (0.1 + 0.5 ^ (useAgeDays / 21)) )
  / log10(sizeBytes)
```

`importance_by_type`:

| Type | Weight |
|---|---|
| skill, agent | 1.5 |
| command, workflow | 1.3 |
| lesson | 1.2 |
| knowledge | 1.0 |
| script | 0.9 |
| memory | 0.7 |

> `correctedRetrievalFreq` **requires the Layer 1 fix 2** corrected count.
> With the old undercount, frequency is badly understated and the ranking
> collapses toward naive oldest-first (see §5).

**Bounded rotating sweep.** `N = 25` per run. At ~96 runs/day this sweeps the
full due-pool in ~5.3 days. Mirror the `consolidate` "bounded, ordered,
rotating" pattern (cf. `a020504f`, oldest-modified-first ordering before limit).

**Generational cadence (future work).** Tier assets so hot ones are revisited
more often than stable ones (generational-GC analogy). Not in the first cut.

**Config / profile knobs.** Today `--min-retrieval-count` is **CLI-only** and
**no scheduler sets it**, so P0-A never engages under cron. Layer 2 must expose
its knobs (`DUE_DAYS`, `N`, the proactive-selector enable flag, importance
weights) via **config / profile**, so the scheduler can actually turn it on.

## 5. Prototype results (read-only dry-run against the live stash)

- Eligible pool **13,328**; **96.0% "due"** (never reflected or >30d);
  **12,776 never reflected**, only **552 ever reflected**.
- **Composite priority vastly beats naive oldest-first**: top-25 average
  retrieval frequency **55.8 vs 4.4 (~12×)**; only **2/25 overlap**. → Build
  with priority, **not** pure oldest-first.
- Top candidates are heavily-used skills/agents/commands never once reflected
  (e.g. `application-security-review`, `openpalm-stack-diagnostics`).
- Estimated real-change yield: **~30–50% on the priority head**, **~10–20% in
  the tail**. No-ops are discarded for free by the #580 / distill gates.
- Without the corrected retrieval count, frequency is badly undercounted and
  ranking collapses to oldest-first — Layer 1 fix 2 is a hard dependency.

## 6. Why this avoids the synchronized-wave regression

The 2026-05-26 incident (`6a5e0ca4`) was caused by **timer expiry**: many refs
shared a 30-day cooldown that expired *on the same day*, so they all became
eligible at once. The proactive selector is **not timer-driven** — it takes a
**fixed top-N of the due set every run** regardless of how many refs are due.
The due set can be 13,000 strong and still only 25 fire per run. Rate is bounded
by N, not by the calendar. This is exactly the "rate control is the scheduler's
job" principle from `4c1700b2`, implemented as a bounded selector rather than a
reintroduced cooldown.

## 7. Observability and success metrics

**STOP using `promoted` count as the success metric** (see §1 caveat).

Track instead:

- **Coverage** — is every asset reflected at least once within N days? Target:
  the due backlog trends to zero and stays bounded.
- **Accepted-change rate vs. a do-nothing baseline** — of proposals the
  selector emits, what fraction pass the #580 / distill gates and are accepted?
  This measures *useful* work, and guards against drift: if accepted-change rate
  collapses, the selector is churning.
- Per-source attribution on `improve_completed` (signal-delta vs P0-A vs
  proactive) so we can see which lane is doing the work.

## 8. Rollout plan

1. **Merge Layer 1** (`e8fb4bf1`, the `-a91a` branch) after review.
2. **Enable the proactive selector behind a profile flag**, with a **one-time
   higher-N backlog drain** to clear the 96%-due backlog, then settle to
   `N = 25`.
3. **Monitor** coverage and accepted-change rate (§7); confirm no
   synchronized-wave behavior and no corpus-drift signal before defaulting on.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Corpus drift / faulty-memory (54% regression evidence) | Existing #580 noise gate + reversible distill ADD/UPDATE/NOOP + recoverable archive; track accepted-change rate to detect churn |
| Cost / runaway volume | Bounded by N per run; rate is N, not calendar-driven |
| Synchronized wave returns | Top-N of due set, not timer expiry (§6) |
| Ranking collapses to oldest-first | Hard-depend on Layer 1 corrected retrieval count |
| Selector never engages under cron | Expose knobs via config/profile (today min-retrieval-count is CLI-only) |

## 10. References

Prior art:

- FSRS / SM-2 spaced-repetition scheduling
- GDSF cache replacement (recency × frequency / cost)
- Generational garbage collection
- PostgreSQL autovacuum accumulation threshold
- Generative Agents (importance-accumulation reflection trigger)
- SEDM (verifiable write admission)
- "Useful Memories Become Faulty When Continuously Updated by LLMs" —
  https://dylanzsz.github.io/faulty-memory/

akm commits / issues:

- `6a5e0ca4` — signal-delta + pool-delta eligibility, removed cooldowns (gate origin)
- `4c1700b2` — removed cold-start exploration budget (#377 / #419)
- `c0c09308` — #580 suppress empty-diff / cosmetic reflect proposals
- `a020504f` — consolidate oldest-modified-first ordering before limit (bounded-rotating pattern)
- `e8fb4bf1` — Layer 1 bug fixes (branch `fix/improve-proactive-eligibility-a91a`)
