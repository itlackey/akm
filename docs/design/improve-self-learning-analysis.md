# AKM `improve` as a Self-Learning System — Canonical Analysis

> **Status:** Canonical (2026-07-01). Supersedes `improve-vs-brain-analysis.md` and
> `improve-pipeline-deep-tuning-analysis.md` as the reference analysis. The code map
> `improve-self-learning-file-map.md` and mental-model doc
> `improve-salience-working-reference.md` remain valid as navigation aids.
>
> **Method.** Every code claim was re-verified against `main` @ `0.9.0-beta.52` by parallel
> source reads (findings archived in `.plans/improve-self-learning-review/code-01…05.md`),
> cross-checked against prior analysis docs (`docs-06-prior-claims.md`), grounded in
> read-only queries against the live `~/.local/share/akm/{state.db,index.db}`
> (`live-09-metrics.md`), and validated against published neuroscience
> (`research-07-neuroscience.md`) and agent-memory research (`research-08-agent-memory-systems.md`).
> Citations to those files use the form `[code-04 §3]`; external citations are in
> [References](#references).

---

## Implementation status (2026-07-02)

Branch `feat/improve-self-learning-wiring` implements R1, R2, R3, R4, G2, and G4-partial from
§5, plus the cheap correctness fixes, against the state this document describes:

- **R1/G2 — outcome loop closed.** `outcome_score` is now capped at `OUTCOME_SCORE_MAX = 1.5`
  (`outcome-loop.ts`). The WS-2 weights (`we=0.25, wo=0.15, wr=0.60`) are now the **default**
  (previously required `improve.salience.outcomeWeightEnabled=true`); setting that flag to
  `false` now restores the old parity weights (`we=0.30, wr=0.70, wo=0`) as an opt-out.
- **R2 — salience composed into user-facing ranking.** `search`/`curate` now read
  `asset_salience.rank_score` from `state.db` and apply it as a bounded multiplicative boost
  (`1 + rank_score × 0.2`, capped 1.2×), fail-open when `state.db` is unavailable
  (`applyRankingRules`' `salienceRankScores` option). The two learning systems (§1 finding 2)
  are no longer fully parallel.
- **R3/G4 (partial) — acquisition quality gated.** The distill `lesson_quality_gate` judge now
  defaults ON (opt out via `profiles.improve.default.processes.distill.qualityGate.enabled:
  false`). Extract gained a new schema-similarity intake gate, also default ON (opt out via
  `processes.extract.schemaSimilarity.enabled: false`). Distill outputs (lessons/knowledge) are
  now content-scored into `asset_salience` at creation (`encoding_source='content'`), closing
  part of the G4 encoding-salience-is-stubs gap for the primary distillation output. Judge
  verdicts now carry `judgeConfidence` on queued distill events.
- **R4 — homeostatic pass deleted, folded into recency decay.** `runHomeostaticDemotion()`,
  `DemotionConfig`, its consolidate call site, and the `homeostaticDemotion` config key are all
  removed (old configs tolerated via passthrough). `computeSalience`'s recency decay is now
  `max(0.01, 0.1·0.5^(days/180) + 0.5^(days/21))` — the floor itself halves every 180 days, so
  stale assets keep drifting down instead of parking at 0.1 forever.
- **Cheap fixes:** the lane-precedence docstring in `improve-types.ts` now matches code order
  (scope > signal-delta > high-retrieval > proactive > high-salience); the high-salience lane
  takes its top-N candidates by encoding-salience score (was scan order) and derives its cap
  from the resolved reflect limit; the consolidate judged-cache hash now covers body + sorted
  tags, so metadata drift re-enters the judge.
- **Verified unnecessary:** the suggested "decrement `acceptedChangeCount` on revert" fix (§5,
  Cheap correctness fixes; §6.5 row) was checked against the code and found not needed —
  `acceptedChangeCount` is recomputed each run from `status='accepted'` rows, and revert flips
  status to `'reverted'`, so it already falls out of the count on the next run.
- **R8 verified already implemented** (not new work): distill injects `sources:` and recombine
  writes `source_refs`.
- **Deferred** (not in this branch): R5 (collapse/churn canary detector), R6 (procedural
  recurrence gate — the lane stays off per #634), R7 (bi-temporal contradiction invalidation),
  R9 (result_json retention — needs owner sign-off, planned post-0.9.0-GA).

The rest of this document is left as the point-in-time analysis it was written as; treat the
"default false" / "off by default" statements below about outcome weight, the distill judge,
and homeostatic demotion as describing the **pre-branch** state unless a line explicitly says
otherwise (§6.6 below has been corrected in place).

---

## 1. Executive summary

`akm improve` is a scheduled, offline batch pipeline that turns agent-session transcripts
and user feedback into ranked, durable knowledge assets (memory → lesson → knowledge tiers),
while continuously re-scoring existing assets. Structurally it is one of the most
neuroscience-faithful and field-current designs of its kind: the extract→distill→consolidate
tiering is a genuine Complementary Learning Systems analog [research-07 §1], the offline cron
cadence mirrors sleep-dependent consolidation [research-07 §2], and its
recency+importance+outcome salience blend is nearly identical in shape to Stanford's
Generative Agents memory stream [research-08 §7]. The design's deliberate *refusals* — no
retrieval-triggered rewrite, additive distillation, recoverable archives — are the
scientifically correct divergences from biology, not gaps [research-07 §3, §8].

**The headline finding is a consistent pattern, confirmed in code AND in the live database:
the sophisticated learning machinery is built but not wired into the loop it is supposed to
close.** Three independent instances:

1. **The outcome/feedback loop is inert by default.** The prediction-error-shaped outcome
   score — AKM's dopaminergic-RPE analog and the mechanism that would let *usage outcomes*
   reshape ranking — is computed and stored every cycle but contributes **zero weight** to
   `rank_score` unless an operator sets `improve.salience.outcomeWeightEnabled` (default
   weights `we=0.30, wo=0, wr=0.70`) [code-04 §1c]. The live config does not set it
   [live-09]. So the system's "learning from whether an asset helped" is calculated and
   discarded.

2. **`rank_score` never reaches the user.** The entire encoding/outcome/retrieval salience
   system drives only improve's *internal* maintenance/consolidation selection. User-facing
   `search`/`curate` ranking uses a **separate** substrate (BM25 + vector + a `utility_scores`
   EMA in `index.db`) that never reads `asset_salience` [code-04 §1]. "Better assets surface
   more" is real, but it runs through the utility EMA, not the salience core. The two learning
   systems are parallel, not composed.

3. **Encoding salience is almost entirely stubs.** Of 5,289 scored assets in the live
   `asset_salience` table, only **30 (0.6%)** carry a real content-derived encoding score;
   the rest are per-type constants [live-09]. Lessons — the primary distillation output — are
   structurally excluded from content scoring (`DISTILL_REFUSED_INPUT_TYPES = {lesson}`) and
   pinned to the type-stub weight forever [code-02].

The practical consequence: what makes the stash improve today is high-throughput LLM
generation gated by a size/source drain policy and refreshed by *retrieval recency* — not the
outcome-driven reinforcement the architecture was designed around. Accept rates are high
(~73–80%) and mostly auto-accepted (~85%), with the distill **quality judge off in
production** [live-09]. This is exactly the "is it improving or churning?" risk profile, and
the field has now measured its failure modes (consolidation collapse; unbounded-memory
accuracy loss) [research-08 §10]. AKM has strong safety scaffolding against it (dedup,
cooldowns, multi-run confirmation, recoverable archives) but **no longitudinal quality signal
wired in to detect it if it happens.**

The rest of this document maps each mechanism to research, catalogs the code-verified gaps
ranked by leverage, gives subtraction-biased recommendations with citations, and provides a
verify/tune runbook with concrete queries and thresholds.

---

## 2. How the system works as a whole (the loop, brain-model framing)

One `improve` cycle, and where each stage sits in the memory-systems picture:

| Stage | Code | Brain / field analog | Cadence in prod |
|---|---|---|---|
| **Preparation / eligibility** | `eligibility.ts`, `preparation.ts` | Attention/salience gating — which traces get processed | every run |
| **Extract** | `extract.ts` | Hippocampal fast episodic encoding (single-session) [r7 §1] | session-end hook |
| **Reflect** | `reflect.ts` | Reconsolidation-as-reconsideration (edit existing asset, gated) [r7 §3] | default, quick |
| **Distill** | `distill.ts` | Semanticization: episodic→gist, memory→lesson/knowledge [r7 §8] | default, reflect-distill |
| **Consolidate** | `consolidate.ts` | Systems consolidation: merge/dedup duplicates [r7 §1] | default |
| **Recombine** | `recombine.ts` | Schema formation via clustered generalization, multi-run gated [r7 §6] | recombine-only (~weekly) |
| **Procedural** | `procedural.ts` | SOAR chunking / Voyager skill compilation [r8 §6, §9] | **off** (#634) |
| **Salience / outcome / homeostatic** | `salience.ts`, `outcome-loop.ts`, `homeostatic.ts` | Encoding tag + dopaminergic RPE + synaptic homeostasis [r7 §4, §5] | scored every run; **outcome+homeostatic inert by default** |
| **Proposal gate / drain** | `drain.ts`, `improve-auto-accept.ts` | Consolidation admission control | every run |
| **Sync** | `improve.ts` | Commit to durable (git) store | clean-finish only |

The design intent is a closed loop: usage + feedback → salience/outcome scores → what gets
maintained and how it ranks → what surfaces → more usage. **In the shipped configuration the
loop is open at two joints** (outcome weight = 0; salience not read by user retrieval), so the
effective live loop is narrower: *sessions → extract/distill generate → drain gate admits →
retrieval-recency ranks internal maintenance → sync*. Feedback still enters, but through the
separate `index.db` utility EMA, not the salience core [code-04 §1, code-05 Q3, live-09].

### Live behavior (read-only, 2026-07-01, 2,993 runs since 2026-05-19)

- Cron fires every ~20–30 min. Profile mix (7d): **default 530 runs**, quick 38,
  reflect-distill 16, consolidate 4, recombine-only 1 [live-09].
- Clean post-fix aggregates (default profile, ~3 days): 802 planned, **471 accepted / 118
  rejected (80% accept)**, of which **391 auto-accepted (83% of accepts)**. reflect-distill:
  73% accept, 88% auto. ~54% of default runs produce any proposal at all [live-09].
- **~12–13k refs are re-scored and skipped every run** — the salience sweep. This is the
  dominant compute/write cost and the mechanism behind the 3.95 GB `result_json` bloat in
  `state.db` [live-09; memory `akm-result-json-blob-cleanup-after-090`].
- `consolidate` and `recombine-only` produced **0 planned actions** in the window — the
  synthesis lanes are effectively idle in production [live-09].
- Feedback signal is real but sparse: 3,477 `feedback` events all-time; in `index.db`,
  feedback=553 vs. curate=9,411 / show=7,942 / search=8,403 — explicit valence is ~2% of
  retrieval interactions [live-09].

---

## 3. Alignment map — where AKM matches the science

These are the places AKM is *right*, with citations, so they are defended in future edits
rather than "refactored away."

1. **Tiered extract→distill→consolidate = Complementary Learning Systems.** Fast per-episode
   capture (hippocampal) vs. slow cross-episode generalization (neocortical) is a genuine
   structural match, and — because assets are addressable text units, not a shared weight
   vector — AKM correctly does **not** need literal interleaved replay to avoid catastrophic
   interference [research-07 §1; McClelland 1995; Kumaran 2016]. The right abstraction to
   preserve is *two timescales*, which AKM has via extract-vs-distill cadence + recombine's
   multi-run confirmation.

2. **Offline cron = sleep-dependent consolidation.** The single strongest biological match in
   the system: consolidation is offline, decoupled from "waking" foreground sessions, low-
   stakes-if-wrong, on a cadence [research-07 §2; Diekelmann & Born 2010].

3. **No retrieval-triggered rewrite = correct refusal of biological reconsolidation.** Literal
   reconsolidation (retrieval makes a memory labile/editable) would import compounding LLM-
   rewrite drift; AKM's additive distill + no-op gate + recoverable archive is the safe
   abstraction and should be *reinforced* [research-07 §3; Nader 2000; Lee 2009]. AKM's own
   prior data (54% regression after iterated LLM rewriting) is the software-specific proof.

4. **Recency-decay salience resets on *access*, not creation.** `retrieval_salience =
   ln(1+freq)·(0.1 + 0.5^(ageDays/21))` uses `getLastUseMsByRef` [code-04 §retrieval]. This
   matches the Generative Agents design where retrieval refreshes the recency clock, keeping
   useful-but-old assets warm [research-08 §7; Park 2023]. (It resolves an open question the
   research raised: AKM uses single-exponential-from-last-use, *not* ACT-R's frequency-fused
   power-law sum — a reasonable simplification; see gap G7.)

5. **Two genuinely separated salience channels.** Encoding-time novelty/magnitude/prediction-
   error (`encoding-salience.ts`) and retrieval-driven RPE (`outcome-loop.ts`) map cleanly to
   the distinct biological channels (novelty/STC tagging vs. dopaminergic RPE) — biology keeps
   them separate for good reason [research-07 §5; Schultz 1997; Frey & Morris 1997].

6. **Multi-run confirmation before recombine promotion ≈ gradual semanticization
   (direction right, mechanism is an engineering construct).** Gating generalization on
   repeated evidence matches that semanticization is driven by *repeated* recollection, not
   one-shot summarization [research-07 §8]. Caveat: biological replay-driven generalization is
   *graded and probabilistic*, not a discrete confirmation counter — the 2-count
   `force:true` gate has no direct biological analog and is a reasonable engineering
   simplification, not a faithful copy [improve-neuroscience-alignment-survey.md]. Keep the
   *direction* (evidence-gated, gradual); don't defend the specific threshold as
   biologically grounded. See G9.

7. **Contradiction-detection + belief-state = schema-violation handling.** Flag/demote
   confidence on contradiction (fast, reversible) while deferring content rewrite to the
   gated pipeline is the correct synthesis of schema theory + reconsolidation [research-07 §6,
   cross-cutting note; Tse 2007].

8. **curate-golden benchmark = a private retrieval-quality harness.** Deterministic embedder,
   frozen corpus, nDCG/MRR, CI-gated — structurally equivalent to a LongMemEval/LoCoMo-style
   gate for the retrieval half [research-08 §11; memory `akm-curate-eval-golden-benchmark`].

---

## 4. Gaps & defects (code-verified, ranked by leverage)

Ranked by impact on whether the system actually learns. Each is grounded in code and, where
possible, live data.

### G1 — The outcome/RPE loop is built but zero-weighted (highest leverage)
`computeSalience` ships with `wo=0` unless `improve.salience.outcomeWeightEnabled=true`
[code-04 §1c]; the live config never sets it [live-09]. The entire prediction-error outcome
formula in `outcome-loop.ts` affects only observability, not ranking. In dopamine biology RPE
is *the* primary teaching signal, not an optional side-channel [research-07 §5; Schultz 1997].
**This is the difference between a self-learning system and a generate-and-gate system.** It is
the top recommendation (R1), gated on fixing G2.

### G2 — `outcome_score` is unbounded above
Floor −1.0, **no ceiling**; live max = 3.13 [code-04 §2; live-09]. Biological RPE saturates and
habituates — a fully predicted reward produces *zero* response, not an ever-growing one
[research-07 §5]. Long-lived popular assets accrue unbounded outcome mass, which would dominate
ranking the moment `wo>0`. Must be capped/re-baselined *before* R1. Also: negative scores are
clipped to a 0.1 floor downstream, so "severely bad" and "merely neutral" are indistinguishable
in rank [code-04 §6].

### G3 — Homeostatic demotion is default-off and self-undoing
`runHomeostaticDemotion` writes a decayed `retrieval_salience`/`rank_score`, but the next
`upsertAssetSalience` unconditionally overwrites it on the following recompute — no provenance
guard analogous to the `encoding_source` guard [code-04 §3; self-acknowledged at
`homeostatic.ts:158`]. SHY requires downscaling to *persist until the next real learning event*
[research-07 §4; Tononi & Cirelli 2014]. AKM's version doesn't persist to the next scoring pass.
The fix is subtraction: fold decay into the always-live recency term instead of a separate,
easily-clobbered pass (R4).

### G4 — Encoding salience is ~0.6% real, lessons permanently stubbed
Only 30/5,289 assets have `encoding_source='content'` [live-09]. `DISTILL_REFUSED_INPUT_TYPES =
{lesson}` plus the upsert being called only on the distill *source* (not output) means lessons —
the main acquisition product — never get a content-derived encoding score and sit at the
type-stub weight forever [code-02]. Additionally `predictionError` is effectively a dead
constant 1.0 because `revisionCount:0` is hardcoded at the only call site [code-02], and
`novelty` is measured against ref/tag *names*, not asset bodies, so two near-duplicate lessons
with different names both read as maximally novel [code-04 §6; research-07 §5]. The "encoding
salience at creation time" story is largely aspirational in practice.

### G5 — Distill quality judge is OFF in production; extract has no judge at all
`runLessonQualityJudge` (novelty/actionability/non-redundancy, 1–5, ≥3.5 pass) exists but is
default-off and fails open; the live config never enables it [code-02; live-09]. Extract — the
least-supervised path and the one actually firing via the session hook (30,006 invocations/30d)
— has no judge whatsoever [code-02, live-09]. Combined with 80% accept / 85% auto-accept, most
of what enters the stash is LLM-generated and admitted on size/source rules alone. Judge
verdicts that *do* run are a dead end: written once to `proposal.confidence` and discarded,
never feeding outcome or accuracy tracking [code-02].

### G6 — Rejection and reversal carry ~zero learning signal
Accept feeds back narrowly (`acceptedChangeCount` depresses the outcome penalty term), but
**reject feeds back nowhere** — no salience/eligibility/trust code reads `status='rejected'`
[code-05 Q3]. The WS-4 threshold auto-tuner explicitly *excludes* deferred decisions, so it
never learns from what humans decide about gate-deferred items — it only self-audits its own
accept→validation-failure rate [code-05; `calibration.ts`]. And **reverting a proposal does not
decrement the `acceptedChangeCount` it already added** — a proven-bad change keeps counting as a
positive outcome signal indefinitely [code-05]. Reflexion's whole point is a *closed* loop:
reflect → retry → measure improvement → validate [research-08 §5; Shinn 2023]. AKM's is open.

### G7 — No consolidation-collapse / churn detector (the measured field failure mode)
The field has *measured* that repeated LLM merge passes can collapse a store to a single entry
in ~10 passes, and that unbounded accumulation drops task accuracy (2,400 records→13% vs. 248→
39%) [research-08 §10]. AKM has strong preventive scaffolding but **no longitudinal signal** to
detect collapse if it occurs: no fixed canary-query set re-run across consolidation cycles, no
store-size/entropy trend. The known "recombine bland" symptom is exactly this signature and is
currently only visible post-hoc via accepted-change-rate [research-08 §10; memory
`akm-recombine-procedural-noise`]. Consolidate's judged-cache keys on a *body-only* hash, so
tag/salience/feedback drift never re-enters the judge — metadata drift is invisible [code-03].

### G8 — No bi-temporal fact invalidation (contradiction handling is lossy-or-silent)
Zep/Graphiti's load-bearing mechanism is *invalidate-and-keep-history*: a contradicted fact gets
its `t_invalid` set, not deleted, so "what did we believe as of X" stays answerable and retracted
facts can't silently reappear when a stale transcript is re-extracted [research-08 §3; Rasmussen
2025]. AKM's consolidate merges/archives; contradiction detection writes `contradictedBy[]` edges
but has **no explicit resolution API**, and mutual 2-cycles oddly cancel both sides back to active
[code-03]. Re-extraction of an old session can re-assert a retracted fact.

### G9 — Recombine can promote un-grounded generalizations past human review
The recombine prompt requires no causal linkage, the parser accepts any non-empty output, and
just **2 confirmations** `force:true`-promote a lesson past human review [code-03]. Entity
clustering structurally starves tag clusters (`RESERVED_TAG_SLOTS=3`), and orphaned hypotheses
accumulate forever (no `DELETE` path; >30% Jaccard drift spawns a fresh row and abandons the old
one) [code-03; live: 5 pending/orphan vs 15 promoted — small now, unbounded by design].

### G10 — Unbounded growth vectors (operational, not learning)
`improve_runs.result_json` ≈ 3.95 GB of a 4.6 GB `state.db` [live-09; memory pointer]. Separately,
**archived proposal rows have no purge path** — accepted/rejected proposal blobs accumulate
forever (20,290 accepted + 1,796 rejected live) [code-05]. Both are retention-policy gaps, not
correctness bugs, but they dominate DB size and re-scoring cost.

### Latent traps (low urgency, real)
- **Lane precedence docstring is inverted vs. code** (`improve-types.ts:54-56` says high-salience
  > proactive; code does proactive > high-salience). Dormant only because pools are disjoint by
  construction [code-01].
- **High-salience lane cap uses scan order, not score order** — a higher-salience candidate found
  later loses its slot; and on unbounded whole-stash runs the cap collapses to exactly 1 ref/run
  [code-01].
- **proactiveMaintenance is enabled only in `reflect-distill`/`proactive-maintenance` config
  profiles, not `default`** (93% of runs) [live-09]. Consistent with the design that reflect-
  distill is the maintenance cron, but the staleness-rescue lane is dormant on the dominant lane —
  the same failure *class* as the prior config-audit regression [code-01; memory
  `akm-config-audit-stripped-proactivemaintenance-regression`].
- **High-retrieval lane never re-arms on retrieval growth** — once a ref gets one reflect
  proposal, only genuine feedback re-admits it even if retrieval grows 100× [code-01].

---

## 5. Recommendations (prioritized, subtraction-biased, cited)

Ordered by leverage-to-effort. Each names the gap it closes and the research grounding.

### R1 — Close the outcome loop: cap `outcome_score`, then turn on `wo` (G1, G2)
The single highest-value change. **Sequence matters:** first bound/​re-baseline `outcome_score`
(G2) so a saturation analog exists — biological RPE goes to zero on fully-predicted reward
[research-07 §5]; mirror that with a ceiling or EMA re-baselining. *Then* enable the existing
WS-2 target weights (already coded: `we=0.25, wo=0.15, wr=0.60`, applied when
`improve.salience.outcomeWeightEnabled=true`) and A/B against the curate-golden benchmark before
committing them as the default [code-04 §1c; `salience.ts:335-345`]. Without the cap, enabling `wo` lets long-lived assets with unbounded scores dominate.
This is the difference between the architecture on paper and in effect [research-07 §5; Schultz
1997].

### R2 — Decide the salience/utility relationship deliberately (G1, structural)
Today `asset_salience.rank_score` and the user-facing `utility_scores` EMA are two parallel
learning systems that never compose [code-04 §1]. Either (a) feed `rank_score` into the user-
facing ranker as one contributor (compose the loops), or (b) explicitly document that salience is
*internal maintenance prioritization only* and utility is the user-facing learner — and then stop
implying otherwise in the design docs. Right now the ambiguity is itself a defect: the "self-
learning improves what you retrieve" story is told about a table users never see. Recommend (a),
blended, so the outcome loop reaches retrieval — this is what makes the field's systems close
[research-08 §7 Park; §5 Reflexion].

### R3 — Gate acquisition quality where volume actually enters (G5)
Extract (hook-driven, no judge) is the real intake path; distill's judge is off. Rather than add
machinery, **turn the existing distill judge on** and add a *cheap* extract-side check (the same
novelty/non-redundancy rubric, or even embedding-dedup against existing bodies) — the field shows
even a cheap incremental check captures most of the value [research-08 §2 Mem0]. Stop discarding
judge verdicts; route them into `asset_outcome` so accuracy is trackable [code-02; research-08
§11]. Mem0's explicit ADD/UPDATE/DELETE/NOOP per-fact primitive is a clean, auditable target
shape for consolidation decisions [research-08 §2].

### R4 — Fold homeostatic decay into the live recency term; delete the separate pass (G3)
Subtraction. The standalone demotion pass is default-off and self-undoing [code-04 §3]. SHY's real
idea is *continuous, population-relative* downscaling that persists [research-07 §4]. Extend the
always-live `recencyDecay` in `computeSalience` to cover the "unreviewed forever" case and remove
the separate `homeostatic.ts` corrective pass — one always-applied continuous decay instead of a
bolt-on that gets clobbered.

### R5 — Add a longitudinal collapse/churn detector (G7)
The one place adding a small mechanism is justified, because the failure it catches is *measured*
and currently invisible [research-08 §10]. Add: (a) a fixed canary-query set re-run after each
consolidation/recombine cycle, tracking Recall@K/NDCG@K trend on the live stash; (b) store-size /
distinct-content-entropy per cycle. If answers to canary queries stop changing while content
churns, that's wasted churn; if entropy trends down cycle-over-cycle, that's collapse [research-08
§10, §11]. Reuse the curate-golden harness machinery. Also add a hard floor: don't let an asset be
re-merged/re-generalized more than N times, and require merges to strictly increase information
(provenance count/specificity), not just shorten [research-08 §10].

### R6 — Require recurrence-across-contexts before procedural/skill promotion (G7, procedural)
The procedural lane over-fits because it captures on first success (exact `JSON.stringify` step
match) [code-03]. Both Voyager (verify-before-commit) and SOAR (chunk only a *generalizable*
subgoal result) require demonstrated recurrence [research-08 §6, §9]. Gate promotion on the same
class of sequence recurring across ≥2 distinct sessions/projects — the concrete fix that could
take the lane off the permanent-off list, or the justification to delete it outright.

### R7 — Make contradiction handling invalidate-with-history, not merge-or-silence (G8)
Adopt the Zep bi-temporal pattern for the narrow contradiction case: when consolidate/recombine
finds a temporally-overlapping contradiction, mark the superseded asset invalidated (retain,
timestamp) rather than merging it into agreement or leaving a dangling `contradictedBy` edge
[research-08 §3]. Keep dedup (merge *agreeing* facts) and invalidation (retire *disagreeing* ones)
as distinct operations under distinct thresholds — AKM currently risks conflating them [research-08
§3]. This also blocks re-assertion of retracted facts on re-extraction.

### R8 — Preserve provenance pointers from distilled/recombined assets to sources (G6, G8)
Park's reflections cite the exact memories they synthesize from; this enables "why does the stash
believe X" and safe un-distillation if a source is later invalidated [research-08 §7]. Verify AKM
distill/recombine write explicit source-ref pointers; if not, add them — it's the precondition for
R7 and for auditable rollback.

### R9 — Operational hygiene (G10)
Post-GA, apply the planned `result_json` retention policy (keep 30–90d, null older, keep
`metrics_json`) via `purgeOldImproveRuns`, and add a symmetric purge path for archived proposal
rows [live-09; code-05; memory `akm-result-json-blob-cleanup-after-090`]. Get sign-off before any
deletion.

### Cheap correctness fixes (low risk)
Fix the inverted lane-precedence docstring; sort the high-salience cap by score not scan order and
derive the cap from the resolved reflect limit rather than the hardcoded `?? 10`; decrement
`acceptedChangeCount` on revert (G6); re-key the consolidate judged-cache to include metadata so
drift re-enters the judge (G7) [code-01, code-03, code-05].

---

## 6. Verify & tune runbook

How to check the loop is working, and what to change when it isn't. All queries are read-only
against `~/.local/share/akm/{state.db,index.db}`.

### 6.1 Is the loop actually closed? (the first thing to check)
```sql
-- Is the outcome loop weighted into ranking? If empty/false, G1 is live: the loop is OPEN.
-- (config check, not SQL): grep improve.salience.outcomeWeightEnabled in ~/.config/akm/config.json
-- Is encoding salience real or stubbed?
SELECT encoding_source, COUNT(*) FROM asset_salience GROUP BY encoding_source;
-- Healthy: a growing 'content' share. Live 2026-07-01: content=30 of 5289 (0.6%) → G4 live.
-- Is outcome_score bounded?
SELECT MIN(outcome_score), AVG(outcome_score), MAX(outcome_score) FROM asset_outcome;
-- Healthy: MAX bounded (e.g. ≤ ~1.5). Live: MAX=3.13 → G2 live.
```

### 6.2 Is it improving or churning? (the core question)
```sql
-- Accept / auto-accept / reject rates, POST-FIX rows only (skippedCount populated).
SELECT COALESCE(profile,'(default)') p,
  SUM(json_extract(metrics_json,'$.plannedCount'))  planned,
  SUM(json_extract(metrics_json,'$.acceptedCount'))  accepted,
  SUM(json_extract(metrics_json,'$.autoAcceptedCount')) autoAcc,
  SUM(json_extract(metrics_json,'$.rejectedCount')) rejected
FROM improve_runs
WHERE started_at > date('now','-7 days')
  AND json_extract(metrics_json,'$.skippedCount') IS NOT NULL
GROUP BY p;
```
- **Read `skippedCount IS NOT NULL` always** — older rows counted gated skips as rejects (fixed
  beta.50) and will pollute any average [live-09; memory `akm-improve-metrics-skips-counted-as-rejected`].
- **Interpreting accept rate:** 73–80% accept with ~85% auto is *high*. High accept is only healthy
  if the judge is on and quality is sampled. With the judge off (G5), high accept ≈ high throughput,
  not high quality. **Manually sample 15–20 recently accepted proposals** and read the diffs — this
  is the ground truth no metric replaces [research-08 §11; knowledge
  `projects/akm/improve-pipeline-quality-audit`].
- **Success metric is coverage + accepted-change-rate, NOT promotion volume** [memory
  `akm-improve-success-metric`; research-08 §10, the 248-records/39% vs 2,400/13% result].

### 6.3 Longitudinal collapse/churn (build this — R5)
Until R5 lands, approximate it:
```sql
-- Are the synthesis lanes doing anything, or idle?
SELECT COALESCE(profile,'(default)'), SUM(json_extract(metrics_json,'$.plannedCount'))
FROM improve_runs WHERE started_at>date('now','-7 days')
  AND profile IN ('consolidate','recombine-only') GROUP BY 1;
-- Live: both 0 → synthesis idle. Not necessarily bad (small stash), but verify recombine isn't
-- silently starved (G9 entity-vs-tag) or blocked.
SELECT CASE WHEN promoted_at IS NULL THEN 'pending/orphan' ELSE 'promoted' END, COUNT(*)
FROM recombine_hypotheses GROUP BY 1;   -- watch pending/orphan growth over time (G9 no-DELETE)
```
The real detector is a fixed canary-query set re-run after each cycle (Recall@K/NDCG@K trend) —
reuse curate-golden [research-08 §11]. If canary answers stop changing while content churns → churn;
if store entropy trends down cycle-over-cycle → collapse [research-08 §10].

### 6.4 Is there enough signal to learn from?
```sql
SELECT event_type, COUNT(*) FROM events WHERE ts>date('now','-30 days')
  AND event_type IN ('feedback','curate','search','show') GROUP BY event_type;
```
Live: feedback is ~2% of retrieval interactions [live-09]. Sparse feedback is the *reason* the
outcome loop matters more, not less — with little explicit valence, retrieval-outcome inference
(R1) is the main signal available. If feedback stays this thin, weight retrieval-*use* (did the
agent act on the asset) over raw retrieval-count, per the testing-effect finding that *effortful*
retrieval, not passive display, is what should strengthen a trace [research-07 §7].

### 6.5 Tuning cheatsheet (symptom → lever)
| Symptom | Likely cause | Lever |
|---|---|---|
| Stash grows but retrieval quality flat | loop open (G1); judge off (G5) | R1 (cap+`wo`), R3 (judge on) |
| "recombine bland" / generic lessons | consolidation collapse (G7) | R5 floor + canary; R6 recurrence bar |
| Good assets decay while still used | recency not resetting / demotion clobber (G3) | verify `getLastUseMsByRef`; R4 |
| Stale assets never demoted | proactiveMaintenance off on default lane; G3 self-undoing | enable on default profile; R4 |
| Retracted facts reappear | no invalidation (G8) | R7 bi-temporal invalidate |
| Proven-bad change keeps positive signal | revert doesn't unwind `acceptedChangeCount` (G6) | decrement on revert |
| `state.db` huge / slow runs | `result_json` + proposal-row bloat (G10) | R9 retention (post-GA, with sign-off) |
| Auto-tuner never adapts to human decisions | deferred excluded from calibration (G6) | include human decisions on deferred in calibration |

### 6.6 Config reality check (do this first, every time)
Config profiles under `profiles.improve.<name>` **override** the builtin `src/assets/profiles/*.json`
— so a code default change is inert if the live config pins the old value [memory
`feedback-verify-effective-config-not-just-code`]. Before concluding a feature is live, grep the
live config for the exact keys:
- outcome loop: `improve.salience.outcomeWeightEnabled` — **as of `feat/improve-self-learning-wiring`
  the default is now TRUE ⇒ `we=0.25, wo=0.15, wr=0.60`**; set to `false` explicitly to opt back
  into the old parity weights (`we=0.30, wr=0.70, wo=0`).
- distill judge: `profiles.improve.default.processes.distill.qualityGate.enabled` — **default is
  now TRUE (fail-open)**; set to `false` to opt out.
- extract schema-similarity gate (new): `processes.extract.schemaSimilarity.enabled` — **default
  TRUE**; set to `false` to opt out.
- homeostatic demotion: **the config key and the pass itself are removed** (R4); old configs that
  still set `homeostaticDemotion` are tolerated via passthrough but have no effect — decay is now
  folded into `computeSalience`'s always-live recency term.
- exploration / calibration: absent ⇒ code defaults (off), unchanged by this branch.
- proactive maintenance: only under `reflect-distill`/`proactive-maintenance` profiles, not `default`
  — unchanged by this branch.

Live 2026-07-01 (pre-branch baseline, now stale for outcome/judge/homeostatic): **all absent →
all at code defaults** (outcome off, judge off, homeostatic off, proactive only on
reflect-distill) [live-09]. Re-verify against the live config after this branch ships, since the
code defaults it measured against have changed.

---

## 7. What NOT to do (defending correct refusals)

To prevent well-meaning "biological fidelity" changes that would harm an auditable knowledge base:

- **Do not add retrieval-triggered content rewrite** ("reconsolidation"). Keep mutation gated
  through explicit distill/consolidate with the no-op gate [research-07 §3].
- **Do not make distillation lossy** (delete the episodic source on promotion). Semanticization is
  lossy in biology by necessity; AKM must stay additive [research-07 §8].
- **Do not add interleaved-replay machinery.** AKM has no shared weight vector to protect from
  catastrophic interference; replay would be machinery for its own sake [research-07 §1, §2].
- **Do not collapse novelty/magnitude/PE into one scalar and treat it as done** — keep the channels
  separable downstream even if a single rank is exposed [research-07 §5].
- **Do not weaken contradiction detection to speed up schema-consistent merges** — it is the
  required safety valve against confirmation-bias/stale-schema reinforcement [research-07 §6].

---

## 8. References

**Neuroscience** (full citations in `.plans/improve-self-learning-review/research-07-neuroscience.md`):
McClelland, McNaughton & O'Reilly 1995 (*Psych Review*); Kumaran, Hassabis & McClelland 2016 (*TiCS*);
Diekelmann & Born 2010 (*Nat Rev Neuro*); Wilson & McNaughton 1994 (*Science*); Nader, Schafe & LeDoux
2000 (*Nature*); Lee 2009 (*TiNS*); Tononi & Cirelli 2014 (*Neuron*); Richards & Frankland 2017
(*Neuron*); Schultz, Dayan & Montague 1997 (*Science*); Frey & Morris 1997 (*Nature*); Ballarini et
al. 2009 (*PNAS*); Tse et al. 2007 (*Science*); Roediger & Karpicke 2006 (*PPS*); Cepeda et al. 2006
(*Psych Bulletin*); Moscovitch et al. 2016 (*Annu Rev Psychol*).

**Agent-memory systems** (full citations in `research-08-agent-memory-systems.md`):
MemGPT/Letta (Packer 2023, arXiv:2310.08560); Mem0 (Chhikara 2025, arXiv:2504.19413); Zep/Graphiti
(Rasmussen 2025, arXiv:2501.13956); HippoRAG 1&2 (Gutiérrez 2024/2025, arXiv:2405.14831,
arXiv:2502.14802); Reflexion (Shinn 2023, arXiv:2303.11366); Voyager (Wang 2023, arXiv:2305.16291);
Generative Agents (Park 2023, arXiv:2304.03442); A-MEM (Xu 2025, arXiv:2502.12110); ACT-R base-level
(Petrov 2006); SOAR (Laird 2022, arXiv:2205.03854); consolidation-collapse & unbounded-memory harm
(Vectorize Hindsight 2026; TianPan 2026); LongMemEval (Wu 2024, arXiv:2410.10813); LoCoMo; foundation-
agent memory survey (arXiv:2602.06052).

**Internal evidence** (`.plans/improve-self-learning-review/`): `code-01…05` (source analyses),
`docs-06-prior-claims` (prior-doc ledger), `live-09-metrics` (read-only live-data validation).
