> **ARCHIVED 2026-07-05 (meta-review 14).** Superseded by name by `docs/design/improve-self-learning-analysis.md` (canonical 2026-07-01); per review 09 the neuroscience framing is inspiration, not justification.
> See `docs/design/improve-neuroscience-alignment-survey.md` for the graded comparison. Git history is the recovery path.

# `akm improve` vs. the brain's perception→knowledge workflow

> Analysis (2026-06-14) of how akm's self-improvement pipeline aligns with the
> cognitive-neuroscience model in `brainworkflow.html`, where it diverges, and
> whether each divergence is intentional+beneficial or a gap to address.
> Companion to `docs/design/improve-proactive-maintenance.md`.

## Stage-by-stage mapping

| Brain stage | akm analog | Verdict |
|---|---|---|
| 01 Sensory perception / buffer (firehose, most discarded) | Raw agent session logs (JSONL); `extract` reads + dedups (`extract_sessions_seen`) | **Aligned** |
| 02 Attention gate + working memory (~4 items, prefrontal selection) | `curate`/`search` top-K into the agent's context window | **Aligned** |
| 03a Hippocampal encoding (bind episode; fragile trace) | `extract` → candidate memory in the **proposal queue** (pending, expirable) | **Aligned** |
| 03b Amygdala salience tagging (automatic, real-time "keep this") | `feedback` events + retrieval count + utility score | **Partial — see Gap 1** |
| 04 Sleep — offline consolidation | **Scheduled `akm improve` cron** | **Strong align** |
| · NREM replay → hippocampus→neocortex transfer | `consolidate` (merge/dedup) + `distill` (memory→lesson/knowledge = episodic→semantic) | **Aligned** |
| · REM free-association across distant traces | `graphExtraction` + `memoryInference` (weakly) | **Gap 4** |
| · Glymphatic clearance (flush waste) | memory cleanup / recoverable archive / expiration / orphan purge | **Aligned but under-powered (Gap 6)** |
| 05a Declarative storage (episodic + semantic, reconstructive) | Stash: memories (episodic), knowledge/lessons (semantic); retrieval reassembles | **Aligned** |
| 05b Procedural/implicit (skills compiled by repetition, bypass hippocampus) | Authored skills/commands/workflows | **Gap 5** |
| 06 Pattern recognition / schema; slow update under contradiction | `distill` (compress episodes→lessons) + `consolidate` contradiction detection + `beliefState` | **Aligned** |
| 07 Functional knowledge = **active predictive model**, prediction-error learning | Passive retrieval; no predictive model | **Gap 2 (biggest)** |
| ⟳ Closed loop: retrieval reconsolidates; output primes attention; prediction errors drive learning | usage→proactive eligibility (new); otherwise open | **Gap 2 & 3** |

## What akm gets RIGHT (keep)

1. **Sleep = scheduled offline improve.** The single best structural match: heavy integration runs in the background on a cadence, not in the hot path. Correct.
2. **Episodic→semantic transfer = distill.** Turning concrete memories into generalized lessons/knowledge is exactly the NREM hippocampus→neocortex move.
3. **Slow, contradiction-gated schema update.** `consolidate` contradiction detection + belief states mirror "schemas update slowly under repeated contradiction" rather than flipping on one counter-example.
4. **Retrieval-as-salience (added this session).** The proactive lane scoring assets by retrieval frequency ≈ the brain strengthening frequently-reactivated traces. This is a genuine, correct step toward the brain model.

## What akm INTENTIONALLY and CORRECTLY does differently (do NOT "fix")

1. **No lossy reconsolidation.** The brain *rewrites* memories on recall (confabulation, drift). akm deliberately preserves raw assets + additive distill + the #580 no-op gate + recoverable archive. The "Useful Memories Become Faulty…" result (54% regression after iterated LLM rewriting) proves lossy reconsolidation **degrades** a knowledge corpus. The brain's reconsolidation is a *bug* for a system that must stay truthful. The **LOOK/CHANGE separation** we built operationalizes the correct divergence: look liberally, change conservatively, never destroy the source. **Keep this.**
2. **Auditability/determinism.** akm has provenance, an event ledger, `eligibilitySource`. The brain has none. Beneficial divergence — it's what makes the kill-criterion possible.

## Real GAPS (where the brain does something useful that akm doesn't)

**Gap 1 — Salience is exogenous & sparse, not endogenous & automatic.**
The amygdala tags importance *at encoding*, in real time, from novelty/reward/emotion — no external input needed. akm's salience waits for rare human `feedback` or accumulated retrieval. This is the *root* of the steady-state starvation we treated symptomatically with the proactive lane: a brain never starves for salience because salience is intrinsic. **Fix:** have `extract` assign an intrinsic importance/novelty score to each candidate at capture time (cf. Generative Agents' 1–10 importance), feeding consolidation priority independent of later feedback.

**Gap 2 — No prediction / prediction-error loop (the biggest conceptual gap).**
The brain's end state is an *active predictive model* that learns from prediction errors and feeds them back to attention. akm's knowledge is passive retrieval; nothing predicts "asset X will help task Y," observes the outcome, and updates. The kill-criterion/verdict we built is a crude **population-level** prediction-error (did improvement lift retrieval?), but there's no **per-asset** outcome loop. **Fix:** capture whether a retrieved asset was actually *used / led to a good outcome* in-session, and feed that back as the dominant utility/salience update — true reconsolidation-by-usefulness. Highest-leverage alignment.

**Gap 3 — The loop isn't closed at the top: knowledge doesn't prime extraction.**
"We perceive through the lens of what we already know"; the brain prioritizes prediction-*violating* input. akm `extract` is purely bottom-up — it doesn't use the current schema set to preferentially harvest novel/contradicting signal or skip redundant restatement. **Fix:** prime `extract` with existing schemas so it focuses on novelty/contradiction (also cuts downstream dedup load).

**Gap 4 — Weak REM-style divergent recombination.**
REM free-associates across *distant* traces to discover new connections. akm `consolidate` only merges *near-duplicates* (high similarity); `graphExtraction` links but doesn't hypothesize. Compression ≠ creation. **Fix:** a low-frequency "REM pass" that samples *distant* asset clusters and asks "is there a novel higher-order lesson connecting these?" — generative, gated through the CHANGE gate to control noise.

**Gap 5 — No procedural/implicit learning.**
The brain compiles *repeated* action sequences into automatic skills (basal ganglia), bypassing the declarative path. akm has skills/workflows but never auto-compiles recurring multi-step agent action patterns from session logs into reusable procedural assets. **Fix:** detect recurring action sequences across sessions and propose them as skills/workflows ("the agent learned to do X by doing it many times").

**Gap 6 — Under-forgetting.**
The brain aggressively discards (sensory buffer, decay, glymphatic). akm hoards (~13K assets, growing pool; archive exists but weak). Forgetting is a *feature* — it keeps retrieval sharp and cuts consolidation cost. **Fix:** decay/evict never-retrieved, never-improved, low-utility assets (LRU/decay on the stash). Resolve the tension with "preserve raw" by decaying retrieval *priority* and *archiving* (recoverable), not deleting content.

## How this session's work maps

The proactive lane + retrieval-as-salience + the LOOK/CHANGE separation + the kill-criterion are all brain-aligned moves. But they are *symptomatic* fixes for Gaps 1–2: we gave the system an endogenous-ish salience (retrieval) and a population-level error signal (verdict) because the deep mechanisms (encoding-time importance, per-asset outcome feedback) are absent. The next architectural step is to close the loop at encoding (Gap 1/3) and at outcome (Gap 2).

## Prioritized recommendations

1. **Per-asset outcome feedback (Gap 2)** — capture "was this retrieved asset used/helpful in-session" and feed it to utility/salience. Closes the loop; subsumes much of the manual-feedback dependence.
2. **Encoding-time importance/novelty score in `extract` (Gap 1/3)** — intrinsic salience so the pipeline never starves and dedup shrinks.
3. **Forgetting/decay pass (Gap 6)** — bound the corpus; sharpen retrieval; cheaper consolidation.
4. **REM-style divergent recombination pass (Gap 4)** — source of genuinely new knowledge, gated for noise.
5. **Procedural compilation from session logs (Gap 5)** — auto-propose skills/workflows from repeated action sequences.

Each must respect the one *non-negotiable correct divergence*: never adopt the brain's lossy reconsolidation — keep raw assets, change through the gate.
