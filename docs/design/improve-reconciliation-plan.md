# `akm improve` — 0.9 reconciliation plan

> Companion to `improve-vs-brain-analysis.md` (the master map) and
> `improve-proactive-maintenance.md`. Written 2026-06-15 after the 0.9
> improve-tuning round splintered. This plan converges that round's scattered
> work onto a coherent architecture **without** abandoning the goal or reverting
> to the pre-0.9 state that already wasn't working.

## Part I — How it went off course (the explanation)

The brain-analysis doc states it plainly (§"How this session's work maps"): the
0.9 improve work — proactive lane, retrieval-as-salience, the kill-criterion,
LOOK/CHANGE — are **symptomatic fixes for Gaps 1 & 2** (no endogenous
encoding-time salience; no per-asset outcome loop). Each patch was built in
isolation, in its own module, on its own cadence.

The failure mode that produced "splintering":

1. **Every patch invented its own version of the same mechanism.** "What deserves
   attention" (salience, Gap 1) is now computed **three+ independent ways over
   the same inputs**:
   - `proactive-maintenance.ts:186` — `importance × log(1+retrievalFreq) × recencyDecay / log10(size)`
   - `feedback-valence.ts:111` — `combinedEligibilityScore = utility·0.7 + valence·0.3` (#614, used at `improve.ts:2856`)
   - `applyFeedbackToUtilityScore` / `getUtilityScoresByIds` — MemRL utility EMA (#386)
   - plus `negativeOnlyRatio` (legacy, `improve.ts:2846`), raw retrieval-count, the high-retrieval fallback, the signal-delta gate.

   "Did improvement help" (outcome / prediction-error, Gap 2) is computed **three
   disjoint ways**: the population kill-criterion (`akm-eval`), #612 gate
   calibration, and (planned) #613 reconsolidation pressure — none of which is
   the per-asset usefulness loop the doc names as the #1 fix.

2. **Each came with its own config knob, hash, loader, taxonomy.** Five new
   default-off knobs this round (`dedup`, `judgedCache`, `maxSessionsPerRun`,
   `symmetricValence`, `calibration`); 2+ divergent content-hash normalizations
   (`dedup.ts:106` lowercases+collapses; `consolidate.ts:1087` does not); two
   memory loaders (`dedup.ts:129` vs consolidate's); two lane taxonomies
   (`eligibilitySource` vs the new dangling `feedbackLane`).

3. **My earlier "reconciliation" made it worse by aiming to revert** — folding
   #617 away and leaning on the existing LLM `consolidate`, i.e. retreating to
   the exact state that already couldn't keep up with 2,589+ memories (the reason
   this work exists). That mistook *one weak patch* for *the goal*.

**Thesis:** the fix is not to delete the patches and not to add a sixth. It is to
**converge them onto two seams — one salience score, one outcome loop — plus one
consolidation pipeline**, so the *real* Gap-1/2/4/5/6 work (0.10+) extends a
single coherent thing. Governed by the one non-negotiable divergence
(doc §line 35/70): **never adopt lossy reconsolidation — keep raw assets, change
only through the gate.**

## Part II — Target architecture: five seams

| Seam | Brain stage / gap | Single coherent mechanism it should become |
|---|---|---|
| **S1 Salience** | 03b amygdala / Gap 1+3 | One per-asset `salience` score: seeded at encoding (`extract`), updated by retrieval + feedback-valence + outcome. Every selector READS it. |
| **S2 Outcome loop** | 07 + ⟳ / Gap 2 | One per-asset "was this retrieval useful" signal → the dominant salience update. Calibration + verdict are *views* of it. |
| **S3 Consolidation pipeline** | 04 NREM / Gap 4+6 | Tiered: cheap deterministic dedup → judged-cache-covered LLM merge → distill→lessons. One hash, one loader, shared index embeddings. |
| **S4 CHANGE gate** | (the non-negotiable) | One mutation gate: no-op/cosmetic suppression + auto-accept + recoverable archive; thresholds resolved in `makeGateConfig`. |
| **S5 Attribution / observability** | auditability divergence | One taxonomy (`eligibilitySource`); telemetry / pool-saturation / calibration are health *views*, not separate truths. |

## Part III — Inventory: every 0.9 improve change → its seam (nothing orphaned)

- **S1 Salience:** proactive selector + priority formula; `eligibilitySource` attribution; signal-delta gate + high-retrieval (P0-A) fallback; #614 valence (`combinedEligibilityScore`/`negativeOnlyRatio`/`feedbackLane`); utility EMA (#386); `getRetrievalCounts`; pool-saturation advisory (#603, observability of starvation).
- **S2 Outcome loop:** kill-criterion + `akm-eval` + `proactive-verdict`; #612 calibration + auto-tune; `proactive_selected`/`proactiveDueTotal`/`proactiveNeverReflected`.
- **S3 Consolidation:** `consolidate` LLM cluster+merge; #617 dedup; #581 judgedCache; `incrementalSince`/`neighborsPerChanged`/`limit` (beta.6); distill + `requirePlannedRefs`; memoryInference + `minPendingCount`; the content-hash variants. *Gap 6 forgetting/decay = NOT built — open hole.*
- **S4 CHANGE gate:** #580 empty-diff/cosmetic suppression; auto-accept gate + #577 gate-decisions + `failedByReason`; #612 threshold; #617 archive-before-delete.
- **S5 Attribution/observability:** `eligibilitySource`; `feedbackLane` (dangling); LLM telemetry (#576); pool-saturation (#603); skip-reason aggregation fix; the health-report overhaul (taskId join, slice filter, deltas, snapshot-summing fixes).
- **Supporting infra (correct, not a seam — leave as-is):** `extract.maxSessionsPerRun` (#2), `minContentChars`/`minNewSessions` (#595/#596/#554), extract active-profile gate (#593/#594), #607 per-process locks + non-blocking ensureIndex, journal sessionId (#599), consolidate event schema (#600), extract negative-examples (#601), config round-trip (#598).

## Part IV — Reconciliation work items

### WS-1 — Unify the SALIENCE model (S1) — the largest, do first
**Splinter:** 3+ attention formulas (above) over overlapping inputs, in 3 modules.
**Target:** a single `salience(ref)` function/seam (new `src/commands/improve/salience.ts`) that combines the existing inputs (type-importance, retrieval frequency, recency, feedback valence, utility EMA) into one score with one documented formula.
**Steps:**
1. Extract one `computeSalience(inputs)` — fold in `proactive-maintenance.ts:186`'s formula and `feedback-valence.ts`'s `combinedEligibilityScore` as the *same* function (valence + utility + retrieval + recency + importance are its inputs).
2. Proactive selection (`proactive-maintenance.ts`) and the eligibility sort (`improve.ts:2856`) both call `computeSalience` — delete the parallel formulas and the legacy `negativeOnlyRatio` branch (`improve.ts:2834-2846`); the symmetric-valence behavior becomes the only path (drop the `symmetricValence` toggle).
3. Keep `eligibilitySource` lanes (selection origin); fold `feedbackLane` into the salience inputs or remove it (no dangling field).
4. Leave a documented `outcomeTerm` input at 0 (wired by WS-2) so the seam is ready for Gap-2 without another refactor.
**Outcome:** one salience score; the proactive lane, eligibility sort, and valence stop disagreeing. Default behavior may shift (valence-on, unified) — that's intended; gate via the existing CHANGE gate + measure by coverage/accept-rate, not parity.

### WS-2 — Unify the OUTCOME loop (S2)
**Splinter:** verdict (population) + #612 calibration (gate) + #613 (planned), disjoint.
**Target:** one per-asset outcome signal seam (the doc's #1 fix) that WS-1's `salience.outcomeTerm` reads.
**Steps:**
1. Define the per-asset "retrieved-and-useful" event (even a coarse v1: retrieved + not-negatively-rated + led to an accepted change) and persist it (events/state.db).
2. WS-1's salience reads it as the dominant update term.
3. #612 calibration becomes a *consumer/view* of this loop (gate reliability), and stops mutating `options.autoAccept` at `improve.ts:1034` — thresholds resolve in `makeGateConfig` (S4).
4. The kill-criterion verdict stays as the population guardrail (one level up), not a competing per-asset signal.
**Note:** full Gap-2 (rich in-session usefulness capture) is 0.10+ roadmap; WS-2 here only establishes the seam + reroutes calibration so future work plugs into one place.

### WS-3 — Unify the CONSOLIDATION pipeline (S3)
**Splinter:** #617 (own hash/loader/embed), #581 judgedCache, consolidate (own hash/embed), `incrementalSince`/`neighborsPerChanged`/`limit`, divergent hashes.
**Target:** tiered pipeline, shared primitives.
**Steps:**
1. **One content-hash:** export `memoryContentHash()` (one normalization); replace `dedup.ts:106-120`, `consolidate.ts:1087`, and the pending-proposal hashes (`consolidate.ts:623/682`).
2. **One loader + shared embeddings:** dedup reuses consolidate's memory loader and reads embeddings from the **index** (`index.db`) instead of `embedBatch` recompute (`dedup.ts:405`, `consolidate.ts:537`). This kills #617's ~200s *and* consolidate's recompute — the actual perf bug.
3. **Tiers:** dedup = cheap deterministic tier (exact hash + index-embedding cosine) that prunes the pool → LLM `consolidate` merges the ambiguous remainder. #617 stays as the tier, fixed; it is *not* dropped.
4. **One coverage model:** `judgedCache` *replaces* `incrementalSince`/`neighborsPerChanged` narrowing (retire them; keep `limit` as a safety cap) — per #581's own title.
5. distill→lessons unchanged. **Flag Gap 6 (forgetting/decay) as the missing stage** — not built in 0.9; recommend a forward issue (decay retrieval priority + archive, never delete content).

### WS-4 — CHANGE-gate coherence (S4)
**Splinter:** threshold override (#612) bypasses `makeGateConfig`.
**Steps:** route all threshold resolution through `makeGateConfig` (per-phase); #580 suppression, auto-accept + #577 decisions + `failedByReason`, and #617's archive-before-delete all confirmed to flow through the one gate with recoverable archive. Mostly verification + the WS-2 reroute.

### WS-5 — Attribution/observability (S5)
**Steps:** `eligibilitySource` is the one taxonomy; `feedbackLane` folds into WS-1 or is removed; telemetry (#576), pool-saturation (#603), calibration health, skip-reason aggregation are confirmed as *views* of the unified S1/S2 model. Mostly cleanup once WS-1/2 land.

## Part V — Sequencing, constraints, scope

**Order:** WS-3 (consolidation: hash + index-embeddings + tiers + coverage — fixes the real perf bug and the dup pipeline) → WS-1 (salience unification) → WS-2 (outcome seam + calibration reroute) → WS-4/WS-5 (gate + observability cleanup, fall out of the above). WS-3 is independent of WS-1/2 and delivers the dedup the maintainer asked for, properly; do it first.

**Per step:** full `TEST_PARALLEL=1 bun run check`; new tests use sandbox helpers; rebuild `dist`. No agent-velocity pile-on — one seam at a time, reviewed.

**Non-negotiable (doc §35/70):** keep raw assets; change only through the gate; no lossy reconsolidation. Every WS preserves this.

**Out of scope here (forward roadmap, 0.10+ — the *real* Gap closures these seams enable):** full endogenous encoding-time salience (Gap 1, #608), rich per-asset outcome capture (Gap 2), REM recombination (Gap 4, #609), procedural compilation (Gap 5, #615), forgetting/decay (Gap 6 — needs a new issue). This plan makes those *extend one seam each* instead of adding a sixth competing signal.
