# 02 — Bitter Lesson audit: which heuristics will better models obsolete?

> Adapts **"Bitter lesson optimization"** from `wiki:articles/raw/blog-prompts-to-run-when-fable-comes-back`.
> akm is dense with hand-engineered judgment — salience formulas, rank blending, gates, clustering, cooldowns. Sutton's essay says hand-coded knowledge loses to general methods that scale with compute. The review: sort akm's machinery into "compensating for model weakness" (will die) vs. "structure the model can't provide" (will live).

## Prompt

```text
Deeply study Richard Sutton's "The Bitter Lesson"
(http://www.incompleteideas.net/IncIdeas/BitterLesson.html) as it applies to AI
harness/tooling over-engineering. Then audit akm:

1. Inventory every hand-engineered judgment heuristic in the codebase. At minimum:
   salience encoding/decay/outcome formulas and their weights, rank_score blending
   into search, the judge + schema gates on improve actions, entity/tag clustering in
   recombine, lane orchestration and cooldowns, dedup and classification heuristics,
   the LLM-reranker prompt scaffolding in curate, and extraction watermark/ledger
   logic. For each: file:line, what model weakness or cost constraint it compensates
   for, and what breaks if it's deleted today.

2. Classify each as:
   - DIES: exists only because current models are weak/expensive at X — a better
     model with the raw data does this without the heuristic.
   - LIVES: provides determinism, auditability, cost control, safety, or data the
     model cannot conjure (provenance, timestamps, owner intent).
   - SEAM: should survive as an interface but with the hand-tuned internals
     replaceable by model judgment.

3. Produce the upgrade plan: what to delete now, what to put behind a seam, and how
   to keep akm flexible as models improve (e.g., can the salience formula be swapped
   for model-scored relevance without a schema migration?). Include the eval that
   would prove each swap is safe (see the curate golden benchmark for the pattern).

4. Counterweight — do NOT over-correct into "no abstractions": the failure mode on
   both sides is real. A heuristic that encodes owner intent or makes behavior
   reproducible is not Bitter Lesson debt. Argue each KEEP verdict as strongly as
   each KILL.

5. Output: findings/02-bitter-lesson.md — the inventory table with verdicts, the
   deletion list (net-LOC estimate), the seam designs, and the migration order.

Guardrails: read-only on live data; no deletions without per-path owner approval;
recommendations should be net-negative LOC wherever honestly possible.

ultracode
```

## Refs

Stash:

- `knowledge:akm-improve-pipeline-architecture` — the pipeline whose heuristics are under review.
- `knowledge:akm-improve-salience-initial-reconstruction` and `knowledge:ws-1-salience-vector-pipeline` — how the salience machinery was built and why.
- `knowledge:curate-golden-benchmark` — the deterministic eval pattern to reuse for proving heuristic→model swaps safe.
- `memory:akm-improve-salience-working-reference.derived` — pointer to the working reference.

Repo:

- `docs/design/improve-salience-working-reference.md` — salience formulas, proposal lifecycle, footgun list. The primary map.
- `docs/design/improve-pipeline-deep-tuning-analysis.md` — where the tuning knobs are and what they were set to compensate for.
- `docs/design/improve-optimal-default-config.md` — the current hand-tuned defaults.
- `docs/technical/v1-architecture-spec.md` — the intended 1.0 shape these heuristics must fit (or be cut from).
- `docs/technical/search.md` / `docs/technical/indexing.md` — the ranking/indexing heuristics on the read path.
