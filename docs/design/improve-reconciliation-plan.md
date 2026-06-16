# `akm improve` — 0.9 reconciliation plan

> Companion to `improve-vs-brain-analysis.md` (the master map) and
> `improve-proactive-maintenance.md`. Written 2026-06-15 after the 0.9
> improve-tuning round splintered; **revised twice on 2026-06-15** — first to fold
> in the three-reviewer critical review (`improve-reconciliation-plan-review.md`),
> then to fold in three domain-expert reviews (self-improving-agent design,
> performance architecture, computational neuroscience). This plan converges that
> round's scattered work onto a coherent architecture **without** abandoning the
> goal or reverting to the pre-0.9 state that already wasn't working.
>
> Revision markers: `[rev]` = correction from the critical review; `[exp]` = change
> from the expert reviews. The single biggest `[exp]` change: **S1 is now a
> salience *vector* (three independently-stored sub-scores), not one scalar** —
> all three experts independently said the single scalar was the wrong
> abstraction. `[signoff 2026-06-15]` = maintainer decisions after confirming
> stashes are git-backed: file deletion in the stash and derived-layer in-place
> replacement are now **adopted** (git history is the recovery backstop), retiring
> the old archive/TTL machinery.

## Implementation status

| Work-stream | Status | Commits | Review | Escalation | Notes |
|---|---|---|---|---|---|
| WS-0 extract-capture (#619) | done | 6904606f, a36142d1 | pass / confirmed-green | none | Prompt fix closes non-schema-LLM gap; types, schema, parser, persistence were already correct. |
| WS-3a consolidation pipeline (#619) | done | 68467d56 | pass / confirmed-green | none | Fixed Zod schema rejection (cosineCandidateLimit + p90ChunkSecondsDefault) and added behavioral cache-wiring tests; curate-command baseline changes folded in (hygiene smell, non-blocking). |
| WS-1 salience vector (#618) | done | c7db502a, a182f037, bc99cc57, 03652977, d4bef793, ddcb1957, 09f63cba, 5b522737, d3733862, 12bf2ec7, 889dda29, a316697b, 98c74a34 (13 commits) | pass / confirmed-green | 2 rounds / clean | All 8 plan steps implemented; 3 review-blocker fixes landed (stash-wide rank comparison, first-run marker, retrieval coverage for feedback-bearing refs); 5900 tests 0 fail. Non-blocking notes: orphaned `getRankScoresByRefs` export, step-7 cutover comparison absent (data constraint, not a gap), plasticity dampener correctly wired to the reflect/distill eligibility sort (where no-ops originate) — `akmConsolidate`'s pool is independently bounded by WS-3b homeostatic demotion (resolved, see WS-1 step 8 disambiguation). T0 measurement deferred to WS-2 per plan language. |
| WS-2 outcome loop (#613) | done | 48db9fec, 208b81b6, 74a3d56f, 178e6ae4, e9a9091e, f9f24a32, a88452c2, 24c66c43, 4d66e42f, 24c11485, 0134a8b5 (11 commits) | pass / confirmed-green | none | `asset_outcome` table (Migration 010) + differential prediction-error outcome signal; `outcomeSalience` wired into salience vector; `review_pressure` column persisted+indexed; `computeProxyAdequacy` health surfacing. `outcomeWeightEnabled` flag is **default-off** (Part-V gate) — `w_o` activates only when enabled in config. Stale W_OUTCOME=0.0 and WS-2-HOOK markers removed. 5995 tests, 0 failures. Non-blocking: docstring inversion in `computeProxyAdequacy` prose (threshold logic is correct); `outcomeWeightEnabled` ships WS-1 parity weights by default (more conservative than literal plan, correct call); `review_pressure` admission wiring deferred to §Part-VI follow-on (data capture is in place). |
| WS-3b intake+homeostatic (#604) | done | 79ffc63a, 25bd69ba, 183e06cc | pass / confirmed-green | none | Hot-probation gated behind `processes.extract.hotProbation.enabled` (default-off). **Manual testing found the 0b schema-similarity gate was built but never wired** — fixed: `isSchemaConsistent` is now invoked at extract intake via `applySchemaSimilarityPenalty` (homeostatic.ts), default-off, with 7 direct unit tests of the penalty effect. Lever = candidate `confidence` (no `encodingSalience` exists at the candidate stage — see step-0b disambiguation). |
| WS-4 CHANGE-gate coherence | done | 48c34741 | pass / confirmed-green | none | Per-phase calibration isolation fix: `maybeAutoTuneThreshold` now filters by `gate === improve:${phase}` before computing calibration summary; regression test added (per-phase calibration isolation). Steps 3/6 (dedup archival route + archive TTL removal) are genuine WS-4 remainder coupled to WS-3 archive machinery — not in scope of this fix, not yet done. |
| WS-5 attribution/observability | done | fde3c3f4 | pass / confirmed-green | none | Scoped coverage.acceptedProposals to health window via since/until filter on computeDenominatorFixedCoverage (post-fetch, matching oracle pattern); both call sites updated; new window-exclusion test added. Minor gap: upper-bound branch (updatedAt >= until) has no direct test — not a correctness defect. |

### Branch scope — `feat/improve-reconciliation` (as of 2026-06-15)

**True scope:** 26 commits, **36 files**, +4546/−577 lines vs `main`. This branch carries WS-0, WS-3a, and WS-1 together — it is **not a WS-1-only branch**.

**Co-mingled work-streams:**
- **WS-0** (extract-capture, #619): commits 6904606f, a36142d1 — `extract.ts`, `extract-prompt.ts`, `src/assets/prompts/extract-session.md`, extract tests.
- **WS-3a** (consolidation core, #619): commit 68467d56 + prior fix-ups — `consolidate.ts`, `dedup.ts`, `embedder.ts`, `local.ts`, `state-db.ts`, body-embedding cache tests.
- **WS-1** (salience vector, #618): 14 commits (c7db502a … 4c40a303) — `salience.ts`, `improve.ts`, `proactive-maintenance.ts`, `feedback-valence.ts`, salience tests.

**Consequence:** a reviewer who sees "12 files / WS-1" in an earlier status report should treat that as stale. The actual diff is 36 files spanning three work-streams. WS-1 commits cannot be cherry-picked or merged in isolation without also bringing WS-0/WS-3a, because `salience.ts` depends on state-db migrations and embedder batching that WS-3a introduced, and `improve.ts` integrates across all three seams.

**Promotion strategy — merge as a unit:**
This branch will be merged to `main` as one unit (all three work-streams together) after WS-1 review passes. Rationale: the three work-streams are semantically independent (each addresses a different seam) but **share runtime dependencies** introduced on this branch (body-embedding cache table, batched local embedder, `computeSalience` reading from the same state-db the WS-3a migration adds). Splitting them onto separate branches would require either duplicating the shared infrastructure commits or creating a stacked-branch dependency chain that is harder to review than a single coherent merge. The merge PR description must list all three work-streams, their commits, and the 36-file / +4546/−577 scope so reviewers have the full picture.

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
   - `proactive-maintenance.ts:186` — `importance × log(1+retrievalFreq) × recencyDecay / log10(size)` (note: `recencyDecay` is currently **dead** — the caller at `improve.ts:2700` never passes `lastUseMs`, so the term is pinned to its floor)
   - `feedback-valence.ts:111` — `combinedEligibilityScore = utility·0.7 + valence·0.3` (#614, used at `improve.ts:2855`)
   - `applyFeedbackToUtilityScore` / `getUtilityScoresByIds` — MemRL utility EMA (#386)
   - plus `negativeOnlyRatio` (legacy, `improve.ts:2846`), raw retrieval-count, the high-retrieval fallback, the signal-delta gate.

   "Did improvement help" (outcome / prediction-error, Gap 2) is computed **three
   disjoint ways**: the population kill-criterion (`akm-eval`), #612 gate
   calibration, and (planned) #613 reconsolidation pressure — none of which is
   the per-asset usefulness loop the doc names as the #1 fix.

2. **Each came with its own config knob, hash, loader.** Four new
   default-off knobs this round (`dedup`, `judgedCache`, `symmetricValence`,
   `calibration`); **two** divergent content-hash *purposes* (`dedup.ts:106-117`
   lowercases+collapses for case-insensitive twin detection;
   `consolidate.ts:1087` and the pending-proposal hashes at `623/682` are
   case-/whitespace-preserving for change-detection); two memory loaders
   (`loadDedupMemories` at `dedup.ts:129` includes `.derived`; consolidate's
   `loadMemoriesForSource` at `consolidate.ts:2708` excludes them). Separately,
   `eligibilitySource` (selection-origin lane) and the **dangling** `feedbackLane`
   (set at `improve.ts:2842`, never read) are *orthogonal* fields, not competing
   taxonomies — but `feedbackLane` does nothing today.
   `[rev]` (`extract.maxSessionsPerRun` is **not** a new default-off knob — it is
   default-on at 25; it is supporting infra, see Part III.)

3. **My earlier "reconciliation" made it worse by aiming to revert** — folding
   #617 away and leaning on the existing LLM `consolidate`, i.e. retreating to
   the exact state that already couldn't keep up with 2,589+ memories (the reason
   this work exists). That mistook *one weak patch* for *the goal*.

**Thesis:** the fix is not to delete the patches and not to add a sixth. It is to
**converge them onto two seams — one salience *model*, one outcome loop — plus one
consolidation pipeline**, so the *real* Gap-1/2/4/5/6 work (0.10+) extends a
single coherent thing.

**`[signoff 2026-06-15]` Recovery model — git is the backstop.** Stashes are now
assumed **git-backed**, and the maintainer has explicitly signed off on (a)
deleting files in the stash and (b) the derived-layer in-place-replacement
relaxation below. This changes the old non-negotiable: the brain doc's "no lossy
reconsolidation — keep raw, never delete" was *both* a quality rule *and* a
data-safety rule. **The data-safety half is now satisfied by git history** — any
deletion or in-place rewrite is recoverable and diffable from commits, so the
elaborate archive/trash/TTL machinery is unnecessary (just delete + commit). What
**survives** is the *quality* principle, now a design guideline rather than a hard
constraint: **don't let iterated LLM rewriting silently degrade content** (the
~54% degradation the brain doc cites) — route every change through the CHANGE gate
so it's auditable, and lean on git diff/restore rather than bespoke archives. Raw
vs. derived remains a *fidelity* distinction (the raw episodic layer is the
high-trust source), not a deletion taboo.

`[exp]` **Note on "one salience score":** all three expert reviews independently
found that collapsing the inputs into a single scalar is the wrong abstraction —
the brain runs *parallel salience systems at different timescales* (amygdala
encoding-time tagging vs. dopaminergic outcome vs. retrieval strengthening), and
a self-improving system needs the *dimensions* (not just the magnitude) to detect
its own feedback loops. So "one salience model" below means **one coherent
3-sub-score vector**, projected to a scalar only for ranking — not one number.

## Part II — Target architecture: five seams

`[rev]` Each gap maps to a seam **or** is explicitly deferred — no gap silently
omitted. `[exp]` Gap 6 is **partially promoted** out of "deferred" (see S3).

| Seam | Brain stage / gap | Single coherent mechanism it should become |
|---|---|---|
| **S1 Salience** | 03b amygdala / Gap 1 | `[exp]` A per-asset salience **vector** of three independently-stored, independently-decayable sub-scores: `encodingSalience` (set at `extract`, Gap-1 seeding), `outcomeSalience` (WS-2/Gap-2), `retrievalSalience` (frequency × recency). One documented projection → a scalar for ranking. Every selector READS the vector. |
| **S2 Outcome loop** | 07 + ⟳ / Gap 2 | One per-asset "was this retrieval useful" signal — `[exp]` **differential (prediction-error-style), not raw count**, with an eligibility-trace decay window → updates `outcomeSalience`. Calibration + verdict are *views* of it. |
| **S3 Consolidation pipeline** | 04 NREM / Gap 4 + **Gap 6 (partial)** | `[exp]` Step 0 = a lightweight **homeostatic pass** (demote `retrievalSalience` for stale/low-value assets — demotion, not deletion, is the mechanism: re-promotable on re-retrieval) to bound a high-SNR merge pool; then tiered: cheap deterministic dedup → judged-cache-covered LLM merge → distill→lessons. One strip primitive, one loader, a shared body-embedding cache. |
| **S4 CHANGE gate** | (the quality gate) | One mutation gate: no-op/cosmetic suppression + per-phase auto-accept; every change is a git commit (the recovery mechanism). `[exp]` Adds an exploration budget + generation/fidelity guards; `[signoff]` may replace derived assets in place. |
| **S5 Attribution / observability** | auditability (correct divergence, not a gap) | One taxonomy (`eligibilitySource`); telemetry / pool-saturation / calibration / `[exp]` degradation + perf metrics are health *views*. |

**Gaps without a full seam home — deferred (not omitted):**
- **Gap 1 encoding-time seeding** — `extract` persists an intrinsic importance/novelty score at capture into `encodingSalience`. `[exp]` Partially promotable now via the schema-similarity gate (S3 step 0b). Full version 0.10+ (#608).
- **Gap 3 schema-primed extraction** — full schema-primed prompting in `extract` is 0.10+. `[exp]` The cheap **schema-similarity gate** (down-prioritize schema-redundant extract candidates via one embedding lookup) is promoted into WS-3 step 0b because it relieves dedup pressure at the source.
- **Gap 4 REM recombination** — divergent cross-cluster association. 0.10+ (#609). `[exp]` Must be a **two-pass** design (generate `type: hypothesis` → later runs confirm → promote to `type: lesson`), not direct injection — documented now so the future build doesn't take the shortcut.
- **Gap 5 procedural compilation** — recurring action sequences → skills/workflows. New stage feeding S3/S4. 0.10+ (#615).
- **Gap 6 forgetting/decay** — `[exp]` **partially promoted** into WS-3 step 0 (retrieval-priority demotion). `[signoff]` With git-backed recovery, full Gap-6 may also *delete* truly-dead assets (git restores), but demotion stays the default mechanism (a demoted asset is re-promotable on re-retrieval; deletion is for genuine garbage). Remainder 0.10+.

## Part III — Inventory: every 0.9 improve change → its seam (nothing orphaned)

- **S1 Salience:** proactive selector + priority formula; `eligibilitySource` attribution; signal-delta gate + high-retrieval (P0-A) fallback; #614 valence (`combinedEligibilityScore`/`negativeOnlyRatio`/the dangling `feedbackLane`); utility EMA (#386); `getRetrievalCounts`; pool-saturation advisory (#603).
- **S2 Outcome loop:** kill-criterion + `akm-eval` + `proactive-verdict`; #612 calibration + auto-tune; #613 reconsolidation pressure (subsumed by the WS-2 seam; do not build separately); `proactive_selected`/`proactiveDueTotal`/`proactiveNeverReflected`.
- **S3 Consolidation:** `consolidate` LLM cluster+merge; #617 dedup; #581 judgedCache; #604 hot-probation intake buffer (write-path dedup — now **WS-3 step 0c**, the intake tier of this pipeline); `incrementalSince`/`neighborsPerChanged`/`limit` (beta.6); distill + `requirePlannedRefs`; memoryInference + `minPendingCount`; the content-hash variants.
- **S4 CHANGE gate:** #580 empty-diff/cosmetic suppression; auto-accept gate + #577 gate-decisions + `failedByReason`; #612 threshold; #617 archive-before-delete (`[signoff]` archive machinery retired — git is the recovery path).
- **S5 Attribution/observability:** `eligibilitySource`; LLM telemetry (#576); pool-saturation (#603); skip-reason aggregation fix; the health-report overhaul (taskId join, slice filter, deltas, snapshot-summing fixes).
- **Supporting infra (correct, not a seam — leave as-is):** `extract.maxSessionsPerRun` (#2, **default-on at 25**); `minContentChars`/`minNewSessions` (#595/#596/#554); extract active-profile gate (#593/#594); #607 per-process locks + non-blocking ensureIndex; journal sessionId (#599); consolidate event schema (#600); extract negative-examples (#601); config round-trip (#598).

## Part IV — Reconciliation work items

> **Every behavior-changing WS is gated on the Measurement protocol in Part V.**
> "Full `bun run check`" is necessary but not sufficient.

### WS-1 — Unify the SALIENCE model into a vector (S1)
**Splinter:** 3+ attention formulas over overlapping inputs, in 3 modules.
**Target `[exp]`:** one `salience.ts` seam exposing a **vector**, not a scalar.

**`[exp]` The salience vector — three sub-scores, stored separately in `state.db`:**
- `encodingSalience` — intrinsic importance/novelty, set **once at `extract`** (Gap 1). v1 may seed from type-importance until the extract-time estimator lands (0.10+).
- `outcomeSalience` — the WS-2 differential outcome signal (0 until WS-2; warm-started — see WS-2).
- `retrievalSalience` — `f(retrieval frequency, recency)`. **Decayable independently** (this is what the WS-3 homeostatic pass demotes).
- **Projection for ranking:** one documented function `rankScore = w_e·encoding + w_o·outcome + w_r·retrieval`, then `× sizePenalty (1/log10(size))`, normalized to `[0,1]`. Weights named in the file; tuned via Part V, not guessed blind.
- **`[exp]` Transient correctness (WS-1 ships before WS-2):** `outcomeSalience` is 0 until WS-2 lands, so for the interim set `w_o = 0` and renormalize `w_e + w_r = 1` — the ranking must be *correct on its own terms* the moment WS-1 ships, not silently dependent on an unfilled component. Re-introduce `w_o` (and re-tune via Part V) when WS-2 makes the term non-zero.
- **Why a vector (all three experts):** a scalar makes "frequently-used-but-broken" (high retrieval, low outcome) indistinguishable from "rarely-used-but-excellent" (low retrieval, high encoding); the gate and telemetry need the dimensions to set per-dimension thresholds and to *detect the rich-get-richer loop* (high retrieval → high rank → more consolidation → higher retrieval). Cost: 3 REAL columns vs. 1.

**Steps:**
1. Add `salience.ts` with `computeSalience(inputs) → {encoding, outcome, retrieval, rankScore}`; persist the three sub-scores (migration). Fold in `proactive-maintenance.ts:186` and `combinedEligibilityScore`.
2. **Dead-input resolution `[rev]` — recency is now MANDATORY, not either/or:** `retrievalSalience`'s recency depends on `lastUseMs`, **never wired** today. It **must be wired** (specify the last-retrieval-timestamp source — `asset_outcome.last_retrieved_at` from WS-2, or the index): the WS-3 step-0 homeostatic demotion needs a genuinely *decayable* `retrievalSalience`; without recency it degenerates to a non-decaying frequency count and the SHY downscaling has nothing to act on. Do not ship the vector with a pinned-to-floor recency term.
3. Proactive selection and the eligibility sort (`improve.ts:2855`) both read `rankScore`. Delete the parallel formulas + the legacy `negativeOnlyRatio` branch (`improve.ts:2834-2846`); symmetric-valence becomes the only path.
4. **Lane preservation `[rev]`:** the three selection lanes (signal-delta, high-retrieval/P0-A, proactive) survive as **`eligibilitySource` labels over one ranking** (don't collapse into an anonymous list — breaks S5).
5. **Remove the dangling `feedbackLane`** (never read). Lane-aware reflect/distill routing is filed as 0.10+, not silently folded.
6. **Migration + versioning `[rev]`:** removing `symmetricValence` changes default behavior. Warn if present, CHANGELOG migration line, regen `schemas/akm-config.json` via `bun scripts/gen-config-schema.ts`, update round-trip tests. Ship behind 0.10, not a patch.
7. **`[exp]` One-time forgetting-safety migration:** before the new ranking becomes default, emit a **rank-change distribution** report; assets in the old top-200 that fall below ~position 500 are flagged "potential forgetting candidates" and get one consolidation pass before cutover (prevents silent catastrophic forgetting from the formula change).
8. **`[exp]` Plasticity:** track `consecutive_no_ops` per asset; assets no-op'd N consecutive cycles get a selection dampener — **intentionally NOT applied to `rankScore`**, so a stable asset stays fully retrievable while it stops consuming repeated expensive LLM attempts. (One INTEGER column; cost trivial — in WS-1.)
   **Disambiguation (resolved during implementation):** "consolidation-selection" here means the **reflect/distill eligibility ordering** (which assets are chosen for the per-asset improvement LLM pass) — that is where the no-op signal *originates* (no-change reflect / quality-rejected distill) and where the expensive work is gated (`improve.ts` `effectiveScore`). It is deliberately **not** wired to `akmConsolidate` (the cluster-merge/dedup phase): the no-op counter is the wrong signal for dedup, and that phase's pool is independently bounded by the WS-3b Step-0a homeostatic `retrievalSalience` demotion (`consolidate.ts:1386`). So the two selection points each use their semantically-correct signal — nothing is left unhandled.

### WS-2 — Unify the OUTCOME loop (S2) — differential, not raw
**Splinter:** verdict (population) + #612 calibration + #613, disjoint.
**Target:** one per-asset outcome seam feeding `salience.outcomeSalience`.

**`[exp]` Scope for 0.9 — establish the seam with a *differential* coarse signal:**
- **Persist to existing `state.db`** (new migration). Table `asset_outcome`:
  `asset_ref TEXT PK`, `last_retrieved_at INTEGER`, `retrieval_count INTEGER`,
  `expected_retrieval_rate REAL` (rolling mean over prior N runs),
  `negative_feedback_count INTEGER`, `accepted_change_count INTEGER`,
  `outcome_score REAL`, `updated_at INTEGER`.
- **v1 signal — differential `[exp]` (not raw count):**
  `outcome_score = (retrieval_delta − expected_retrieval_delta) − penalty·(retrieval_delta · (1 − accepted_change_rate)) + valence`.
  The differential term makes it prediction-error-shaped; the penalty stops a
  retrieved-but-never-improved (possibly entrenched-wrong) asset from scoring high;
  all terms are computable from data captured today (`getRetrievalCounts` + feedback + proposal history).
- **`[exp]` Eligibility-trace decay:** only retrievals within the last K improve
  cycles contribute; older retrievals decay out (so an asset popular 18 months ago
  doesn't permanently occupy high rank). This is the same mechanism as Gap-6
  homeostasis at a different timescale.
- **`[exp]` Warm start:** seed `outcome_score` from the existing utility EMA (#386,
  normalized) at table creation, so `outcomeSalience` is non-zero at launch for
  assets with history (avoids recreating the starvation problem). Real signal
  progressively replaces seeds. **Units guard:** the live signal is *differential*
  (can go negative), so clip the warm-start seed to the non-negative range of a
  first differential update — don't seed a `[0,1]` utility value that the first
  negative delta then inverts, causing a spurious rank flip on assets retrieved
  below their historical mean.
- **`[exp]` Diversity floor:** cap the max rank uplift from retrieval-alone so rare-but-correct assets can't be permanently outcompeted.
- **`[exp]` Proxy-adequacy tripwire:** monitor `corr(outcome_score, accepted_change_rate)`; if it goes negative (popular assets are also the ones most needing fixes), the proxy is inverted and the 0.10+ rich signal is no longer deferrable. Surface in the health report.
- **Documented validity gap:** "led to an accepted change" is not a clean usefulness proxy (a confirming asset is useful yet yields no change). Rich in-session retrieve→act→outcome trace is **0.10+** (Gap 2 proper).
**Steps:** (1) add table + writer; (2) `salience.outcomeSalience` reads `outcome_score`; (3) calibration reroute lives in WS-4 (avoids the circular dep); (4) kill-criterion verdict stays the population guardrail.

### WS-3 — Unify the CONSOLIDATION pipeline (S3)
**Splinter:** #617 (own hash/loader/embed), #581 judgedCache, consolidate (own hash/embed), incremental knobs, divergent hashes.
**Target:** intake + homeostatic step 0 (incl. #604 hot-probation) → tiered pipeline, shared primitives, bounded time.

**Step 0 — intake + homeostatic tier `[exp]` (homeostatic demotion + schema-similarity gate + hot-probation buffer; Gap 6 partial + Gap 3 partial + #604):**
- **0a Homeostatic demotion:** before any LLM merge, demote `retrievalSalience`
  (state.db update only — file untouched, content preserved) for stale/low-value
  assets, so the merge pool is bounded and high-SNR. Neuroscience rationale (SHY):
  consolidating a growing corpus without downscaling first means the LLM merges on
  an ever-noisier substrate — the likely reason 0.9 consolidate underperforms as
  the stash grows. Re-promotable on re-retrieval (the vector keeps `encodingSalience` intact).
- **0b Schema-hash gate:** at `extract` (or intake), if a new candidate's body
  embedding is within ε of an existing derived-layer lesson/knowledge node, mark it
  `schema-consistent` and lower its priority; only schema-inconsistent/contradicting
  candidates get full `encodingSalience`. One embedding lookup; relieves dedup
  pressure *before* it accumulates.
  **Lever disambiguation (resolved during implementation):** at the *extract
  candidate* stage there is **no `encodingSalience` to reduce** — encodingSalience
  is keyed by asset_ref in state.db and only exists once the asset is persisted, so
  the available per-candidate lever is the candidate's **`confidence`** (which flows
  into the auto-accept gate). The wired gate (`applySchemaSimilarityPenalty`,
  `homeostatic.ts`) therefore multiplies a schema-consistent candidate's
  `confidence` by `confidencePenalty` (default 0.5), routing redundant candidates
  toward deferral — the practical realization of "lower priority" at intake.
  Default-off (`schemaSimilarity.enabled`); strictly parity-preserving when off.
- **0c Hot-probation intake buffer (#604):** new system-generated extractions
  enter a `captureMode: hot-probation` state and spend **one consolidation cycle**
  in probation before promotion to the main stash; during that cycle the dedup +
  quality second-pass (steps 1–4 below) runs against them. This stops noisy
  extractions (e.g. the `lesson:invalid-api-key-persistence` phantom) from
  polluting the stash at the source. It is the **write-path tier** of this same
  pipeline — the deterministic dedup/quality pass applied at *intake* rather than
  to the whole corpus, so 0b (schema-similarity) and 0c (probation) together are
  the "catch it before it lands" front end, and steps 1–4 are the "clean up what's
  already landed" back end — one mechanism, two entry points, **not** a separate
  dedup implementation. `captureMode: hot` already exists (user-explicit) in
  `src/indexer/passes/metadata.ts`; 0c adds the automatic `hot-probation` mode.
  Reuses the shared `dedupHash` + body-embedding cache (steps 1–2), so probation
  costs ~one extra cheap pass over the new-extraction delta, not a full re-embed.
  Default-off behind a flag (per #604's medium-risk note: it touches the write path).

**Steps:**
1. **One strip primitive, two hash wrappers `[rev]`:** export `stripFrontmatterBody()`; build `dedupHash()` (lowercase+collapse, twins) and `cacheHash()` (case/ws-preserving, change-detection) on it. A single hash cannot serve both. Replace `dedup.ts:106-117` → `dedupHash`; `consolidate.ts:1087` + `623/682` → `cacheHash`.
2. **One loader + a body-embedding cache `[rev/exp]`:** unify on consolidate's loader with `includeDerived?: boolean` (dedup needs `.derived`; consolidate excludes). **Do NOT reuse index vectors** — the index embeds `buildSearchText` (`search-fields.ts:77` = name+description+tags+hints+**TOC-headings**, lowercased), not bodies. `[exp]` Add a **`cacheHash`-keyed body-embedding cache** in `state.db`:
   `body_embeddings(content_hash TEXT PK, embedding BLOB /*Float32, 384×4=1536B*/, model_id TEXT, created_at INTEGER)`.
   Per run: compute all `cacheHash` (pure/fast) → one bulk `WHERE content_hash IN (…)` → embed only misses in **one** `embedBatch` → upsert in one transaction. `model_id` mandatory (drop-all on mismatch — stale vectors in the wrong metric space else). Size: ~4 MB @ 2.6k, ~20 MB @ 13k. Lazy purge of orphan rows off the hot path. **Canonical embedding input `[exp]`:** the cache stores the embedding of the **case-preserving stripped body** (`cacheHash` domain); dedup's cosine path must embed that *same* body, NOT its lowercased `dedupHash` body, or dedup and consolidate key different cache entries and never share. `dedupHash` stays the exact-twin key; cosine runs on the shared case-preserving embedding.
3. **`[exp]` Batch the local embedder:** `embedBatch`'s local path is **one-at-a-time** (`embedder.ts:111`) — pass the array to the transformers pipeline (or chunks of 32). 10–50× on the cold minority; likely most of #617's 200s on its own.
4. **Bound the O(n²) compare `[rev/exp]`:** keep the O(n) exact-hash bucket; run cosine twins only on the judged-cache-miss pool capped by a new `dedup.cosineCandidateLimit` config field (~500 → 125K cmp ≈ 0.12s; adding it to `DedupConfig` needs `bun scripts/gen-config-schema.ts` + round-trip test, same as the WS-1 knob migration). At pools >~1k, use **sqlite-vec KNN** over `body_embeddings` (tier C, 0.10+ unless stashes force it sooner). Breakeven note: O(n²) is ~3s @2.6k, ~85s @13k, ~21min @50k.
5. **`[exp]` Wall-clock budget — graceful drain:** `akmConsolidate` (`improve.ts:1969`) and `runDeterministicDedup` **do not receive `budgetSignal`** today → they SIGTERM mid-LLM-call leaving partial writes. Add `signal?: AbortSignal` to `AkmConsolidateOptions` and to `runDeterministicDedup`'s signature, thread the caller's `budgetSignal` down the chain (`improve → akmConsolidate → runDeterministicDedup → embedBatch`, which already accepts it), check before each LLM chunk, break with a `partial_timeout` outcome (commit work done, gate + report on partials).
6. **`[exp]` Cold-start budget estimation:** empty judgedCache → full sweep can be 7× the 900s window. Estimate `ceil(pool/chunkSize) × p90_chunk_s` (where `p90_chunk_s` comes from the step-5/Part-V wall-clock telemetry, falling back to a `consolidate.p90ChunkSecondsDefault` config value — e.g. 30s — on the first run when no history exists); if > ~60% of remaining budget, auto-reduce the pool and `log()` the reduction. (Don't silently truncate.)
7. **Coverage model `[rev]`:** `judgedCache` and incremental narrowing **compose, not replace**. Keep `incrementalSince`/`neighborsPerChanged` as the candidate-*selection* layer (it pulls embedding-similar **neighbours** of changed memories — context `judgedCache` lacks); `judgedCache` then *skips already-judged unchanged* within that pool. `limit` stays as the safety cap. Document the cold-start full-sweep.
8. **`[exp]` Anti-collapse guards on the merge:** (a) **generation counter** in frontmatter — the merge writer sets `merged.generation = max(source generations) + 1` (without this the guard never accumulates across runs); refuse to merge two assets both above generation N (default 2); merges must cite source refs; (b) **lexical-diversity check** on an embedding-selected cluster — low n-gram diversity ⇒ likely correlated-extraction artifact ⇒ raise the merge threshold; (c) occasional **random-sample (non-similar) cluster** in the pool so the pipeline isn't purely similarity-driven.
9. **`[exp]` Derived-layer interleaving (CLS):** `distill`/`memoryInference` prompts must include a sample of existing **semantically-adjacent** lessons/knowledge (embedding-retrieved), not just new episodes — prevents the derived layer overwriting prior generalizations (catastrophic interference). One-line prompt change, no schema impact.
10. **`[exp]` Distill→source fidelity:** after a distill proposal, check it against its cited source memories; a contradiction flag forces human review (not auto-accept). Surface lessons with broken/empty `source_refs` as a degradation signal.
11. distill→lessons otherwise unchanged. Gap 4 (recombination) future (two-pass, Part II). **`[exp]` Pipeline-order check:** brain order is consolidate(merge)→distill, but the pipeline runs `reflect→distill→consolidate`, so distill processes un-deduped near-duplicates (inflates LLM cost + spawns near-duplicate lessons). **Decision item (not open-ended "evaluate"):** during WS-3, either reorder to `extract → consolidate → distill → memoryInference → graphExtraction`, OR record the concrete `reflect`/`distill` dependency that blocks the reorder in this doc — one of the two outcomes is a WS-3 completion criterion, so it can't be silently skipped.

> **WS-4 remainder (from WS-4 implementation):** Steps 3 (route dedup archival through the gate) and 6 (remove `consolidate.ts:2267-2290` archive/TTL machinery) are not yet done — both are coupled to WS-3 archive machinery and must be completed before WS-4 is fully closed.

### WS-4 — CHANGE-gate coherence (S4) + calibration reroute
`[rev]` **Real work, not "mostly verification."**
**Steps:**
1. **Per-phase thresholds:** `maybeAutoTuneThreshold` (`improve.ts:1034`) mutates a single global `options.autoAccept` shared by all phases (it does *not* "bypass" `makeGateConfig` — the value is passed in and may be clamped by `minimumThreshold`; the defect is the lack of per-phase resolution). Resolve thresholds per-phase in `makeGateConfig`.
2. **Tuned-threshold home:** persist the auto-tuned threshold (state.db, keyed by phase); `makeGateConfig` reads it. Calibration (#612) becomes a reader of WS-2's outcome loop + this store.
3. **Route dedup archival through the gate:** #617's `onArchive` callback is currently a direct callback, not a gate decision — route it through the one gate or document it as an intentionally separate, audited path.
4. **`[exp]` Exploration budget:** a fixed fraction (~5%) of proposals per run accepted regardless of confidence, logged `eligibilitySource = "exploration"`, **not** subject to auto-tune; the auto-tune ceiling is bounded (~0.85). Prevents the gate converging to pure exploitation (which would shut down Gap-3/Gap-4 novelty and recreate the throughput collapse this work exists to fix).
5. **Confirm** #580 suppression, auto-accept + #577 decisions + `failedByReason` flow through the one gate. Every gate-applied mutation is a git commit (the recovery mechanism).
6. **`[signoff]` Archive machinery — simplify to git.** Stashes are git-backed, so the `consolidate.ts:2267-2290` TTL machinery (`fs.unlinkSync`, `.akm-backup` dirs, `archiveRetentionDays`) can be **removed**, not replaced with trash/never-TTL: dedup/consolidate may delete or overwrite files directly, and `git show`/`git restore` is the recovery path. Keep a one-line "changed N files this run — recover via git if needed" note in the run report. (Net code *reduction* — the elaborate archive paths existed only to satisfy the old irrecoverability constraint.)

> **`[signoff 2026-06-15]` Derived-layer in-place replacement — ADOPTED.**
> The neuroscience review argued the no-lossy rule is right for **raw** assets but
> too strong for the **derived** layer (lessons / distill / memoryInference output ≈
> neocortical semantic memory, which the brain adaptively overwrites under
> contradiction); additive-only there accumulates contradicting lessons that all
> survive and degrade retrieval precision. With git-backed recovery the maintainer
> has **signed this off**: when `distill`/`memoryInference` produces a derived asset
> that contradicts an existing one, the gate may **replace it in place** (the prior
> version is recoverable via git, no bespoke provenance archive needed). The raw
> episodic layer stays the high-fidelity source and is not gratuitously rewritten,
> but it is no longer *prohibited* from change — git is the backstop. The WS-3
> step-10 distill→source fidelity check still applies: a replacement that
> contradicts its own cited *raw* sources still routes to human review.

### WS-5 — Attribution/observability (S5)
**Steps:** `eligibilitySource` is the one taxonomy; `feedbackLane` removed in WS-1; telemetry (#576), pool-saturation (#603), calibration health, skip-reason aggregation are *views* of the unified S1/S2 model. `[exp]` Add the perf + degradation telemetry from Part V as health views.

## Part V — Sequencing, measurement, constraints, scope

**Order `[rev]`:** WS-3 (consolidation: homeostatic step 0 + strip/hashes + body-embedding cache + batch embedder + budget-signal + bounded tiers + composed coverage) → WS-1 (salience vector + forgetting-safety migration + knob migration) → WS-2 (outcome seam + differential signal) → WS-4 (gate coherence + calibration reroute, depends on WS-2's store) → WS-5 (observability cleanup). WS-3 is independent and delivers the dedup the maintainer asked for, properly + fast; do it first. WS-2 is the brain doc's #1 priority but its *live* signal is 0.10+; the 0.9 deliverable is the seam + differential proxy, valueless until WS-1's vector reads it.

**`[rev/exp]` Measurement protocol (gates every behavior-changing WS — WS-1, WS-2, WS-4):**
1. **Baseline (T0):** before WS-1, snapshot via `scripts/akm-eval` + the health report.
2. **Throughput/quality gate (existing):** proactive accept ≥ 0.9× reactive, reversion ≤ 0.15, retrieval-delta ≥ 0, coverage/accept-rate not regressed vs T0.
3. **`[exp]` Coverage is denominator-fixed:** `coverage = accepted_proposals / total_assets` (NOT ÷ the moving eligible set — else WS-1's more-inclusive ranking inflates coverage spuriously). Report `eligible_fraction = eligible / total` separately.
4. **`[exp]` Degradation metrics (catch slow rot a throughput gate misses):**
   (a) **inter-run corpus diversity** — cosine distance between the centroids of top-N retrieved assets across consecutive runs; a >10% drop ⇒ entrenchment, block ship;
   (b) **merge fidelity** — cheap LLM check "does the merge contradict any source ref?"; block if contradiction rate exceeds threshold (start permissive);
   (c) **generation distribution** — a healthy corpus is not accumulating high-generation descendants at the expense of generation-0 originals;
   (d) **oracle spot-check** — sample ~5 accepted proposals/run into the health report for human eyeballing.
   **`[exp]` These run PER-RUN, not per-release:** the degradation metrics are computed every run and recorded, so slow entrenchment is caught as it accumulates rather than only at ship time. (a) is the population-level guard; the WS-3 step-8b in-pipeline lexical-diversity check is the per-cluster guard that prevents a single bad merge — they are complementary, not redundant.
5. **`[exp]` Perf telemetry (early-warning before SIGTERM):** per-stage wall-clock; `embedMs`; `embedCacheHits/Misses` (healthy incremental run >95% hits); `dedupPoolSize`/`llmPoolSize`; `judgedCacheSkipped`; `estimatedBudgetFractionUsed` (>1.0 ⇒ over budget). Emit regardless of the WS gate.
6. **Timeout-sizing check:** any WS that changes how many assets a run selects re-verifies `reflect.limit ≤ (timeoutMs/1000)/100` (the beta.9 SIGTERM lesson).
7. **Rollback:** a WS that fails any gate reverts its *behavior* change (keep the structural refactor) and re-tunes before re-shipping.

**Per step:** full `TEST_PARALLEL=1 bun run check`; new tests use sandbox helpers; schema regen for any config change; rebuild `dist`. One seam at a time, reviewed — no agent-velocity pile-on.

**`[signoff]` Recovery principle (replaces the old non-negotiable):** every mutation goes through the CHANGE gate and lands as a git commit — **git history is the recovery mechanism**, so files may be deleted or replaced in place. The principle that survives is *quality*, not *preservation*: don't let iterated LLM rewriting silently degrade content (gate every change; the raw episodic layer stays the high-fidelity source by default). Derived-layer in-place replacement is **adopted** (WS-4). No bespoke archive/TTL machinery.

**`[exp]` Intentional non-analogs (do NOT "fix" these — recorded here, not just in the brain doc):**
- **Emotional de-arousal** — the brain strips affective charge from memories during REM. There is no useful analog; **do not implement valence decay** — akm's valence (feedback signal) must be *retained*, not decayed. (Storing valence as a separate field rather than in the content is the correct accidental analog.)
- **Lossy reconsolidation** — `[signoff]` the data-safety reason to forbid it is gone (git recovers); the *quality* reason remains a guideline. Raw is the high-trust source by default but no longer prohibited from gated change.

**`[exp]` Cadence note (0.10+):** consider a **second, longer cron tier** (e.g. monthly) for the slow schema-formation components (`memoryInference`, `graphExtraction`, Gap-4 recombination), separate from the nightly consolidation tier — mirrors the brain's distinct fast/slow/very-slow timescales and ensures schema work runs on an already-consolidated corpus.

**Out of scope here (forward roadmap, 0.10+):** Gap 1 full encoding-time estimator at `extract` (#608); Gap 2 rich in-session outcome capture; Gap 3 full schema-primed extraction; Gap 4 two-pass REM recombination (#609); Gap 5 procedural compilation (#615); Gap 6 full forgetting beyond the step-0 demotion. `[exp]` Also document in the brain-analysis doc the two intentional non-analogs: emotional de-arousal (no useful analog — do **not** implement valence decay) and lossy reconsolidation. This plan makes each gap **extend one seam (or one documented deferral)** instead of adding a sixth competing signal.

## Part VI — 0.10.0 milestone: pull-forward analysis

The open 0.10.0 improve issues are #608, #609, #610, #611, #613, #615, #616. The
question for each: pull it (or a slice of it) into the 0.9 reconciliation now, or
leave it a clean follow-up? The deciding lens is **retrofit cost**, not feature
value — pull forward only the *schema / data-capture / architecture hooks that are
expensive or impossible to add later*; defer the *algorithms and features that
bolt cleanly onto a well-shaped seam*. Building the seam wrong now (or capturing
no data) is what forces a rewrite; a deferred feature on a good seam is just work.

| Issue | Gap/seam | Decision | Why (retrofit / perf / functional-gap / rewrite-if-deferred) |
|---|---|---|---|
| **#608** automatic salience scoring | Gap 1 → S1 | **Pull forward the STORAGE decision + write-point; defer the scoring algorithm** | WS-1 already creates the salience vector with an `encodingSalience` slot. **#608 says "persist `salience` + `salienceInputs` in frontmatter"; WS-1 stores the vector in `state.db`.** If we don't reconcile *now*, #608 later stands up a *second* salience store in frontmatter — the exact splintering this whole plan exists to kill — and WS-1 gets rewritten. **Rewrite-if-deferred: HIGH.** So decide the canonical store in WS-1 (recommend: `state.db` canonical to avoid git-churn from high-frequency updates; optional frontmatter mirror of the stable `encodingSalience` for portability), and define `encodingSalience` as the field #608 later fills. The novelty/surprise/prediction-error *algorithm* itself defers cheaply (v1 stub = type-importance). |
| **#613** reconsolidation review pressure | Gap 2 → S2 | **Pull forward into WS-2 (it IS the negative branch of the outcome loop)** | #613 = "repeated low-satisfaction retrievals → a review-pressure counter → a salience input → admit for human review, never mutate content." That is WS-2's outcome loop pointed at negative outcomes, and its "never mutate directly, route through review" matches our gate exactly. WS-2's `asset_outcome` already has `negative_feedback_count`; add a `review_pressure` column there now. **Functional-gap-if-deferred:** negative retrieval signal wouldn't feed salience at all. **Rewrite-if-deferred: MEDIUM** (a separate outcome store). Cost to include the column now: trivial. The admission *policy* (when pressure crosses threshold → enqueue) can be a thin follow-up. |
| **#615** procedural compilation | Gap 5 → new stage | **Pull forward the EXTRACT-TIME data capture; defer detection/compilation** | The one genuine *data-loss* case. #615 needs "ordered action + outcome data preserved during extraction." The source transcripts `extract` reads are **external (agent-host logs), not akm-controlled** — so re-extraction later is **not guaranteed**; sessions extracted during 0.9→0.10 could permanently lose their ordered-action structure. **Deferral cost: irreversible data loss, not just rework.** So make `extract` preserve ordered action/outcome in the episode it already writes now (cheap additive field) even though the *detection/compilation feature* (recurrence threshold → `workflow:`/`skill:` proposal) defers. Capturing costs little; not capturing is unrecoverable. |
| **#616** bounded multi-cycle phasing | budget/timeout machinery | **Pull forward the budget-interface design (make it cycle-aware); defer the loop** | WS-3 builds the AbortSignal + cold-start budget estimation + graceful-drain machinery *now*. #616 wraps the generative passes in an N-cycle loop that must "respect the existing timeout watchdog and budget machinery." If WS-3's accounting assumes a single pass, #616 reworks it to spread one run's budget across N cycles. **Rewrite-if-deferred: MEDIUM.** Cheap fix: design the budget interface as "remaining-budget-aware across an arbitrary number of passes" rather than per-pass. The cycle loop itself defers cleanly (`maxCycles: 1` = current behavior). |
| **#611** hierarchical abstraction (lesson clusters → `knowledge:` schema) | S3 distill | **Defer the feature; pull forward only a design constraint on WS-3's distill rework** | WS-3 restructures the distill/consolidate path. #611 adds a "*distinct* second-order path" and must "not reintroduce the doubled-`-lesson` regression." If WS-3 rewrites distill without leaving room for a second-order path + preserving the first-order recursion guard, #611 becomes a *second* distill refactor. **Rewrite-if-deferred: LOW–MEDIUM** — avoided entirely by keeping the door open. The feature itself is clean follow-up. |
| **#610** bounded replay budget | S1 selection | **Defer (cheap, default `0` = current); just expose what it needs from WS-1** | #610 revisits top-salience refs without new feedback and "skips replays already converged to `no_change`." That needs (a) the salience ranking (WS-1) and (b) the consecutive-no-ops/plasticity signal — **WS-1 already adds the plasticity column.** Once both exist, #610 is a thin selection layer with no schema change. **Rewrite-if-deferred: NONE** provided WS-1 exposes salience rank + no-op count (it does). Defer. |
| **#609** cross-episodic recombination (REM, Gap 4) | new `synthesize` stage | **Defer cleanly — already guarded** | A whole new opt-in process; "cluster by relatedness, not similarity" uses tag/graph data that exists. No schema or data-capture retrofit. The plan's Part II two-pass guard (`type: hypothesis` → confirm → `type: lesson`) already prevents the one shortcut a future build might take. **Rewrite-if-deferred: NONE.** Defer. |

**Net effect on the 0.9 work — four cheap hooks land inside the existing WS, no new workstream:**
1. **WS-1** picks the canonical salience store and defines `encodingSalience` as #608's future write-target (kills the frontmatter-vs-state.db split before it happens); it already exposes salience rank + no-op count, so #610 needs no retrofit.
2. **WS-2** adds a `review_pressure` column to `asset_outcome` (absorbs #613's data model).
3. **WS-3** designs the budget interface as multi-pass-aware (so #616 doesn't rework it) and keeps the distill rework from precluding #611's second-order path.
4. **`extract`** preserves ordered action/outcome data now (the only irreversible-if-deferred item, #615) — feature deferred, data captured.

**Everything else is a true follow-up:** #608's scoring algorithm, #609, #610, #611, #616's cycle loop, and #613's admission policy all bolt onto seams the 0.9 work shapes correctly. None requires a rewrite once the four hooks above are in. The guiding result: **pull forward decisions you can't cheaply reverse (storage shape, data capture, budget interface); defer the code that sits cleanly on top.**
