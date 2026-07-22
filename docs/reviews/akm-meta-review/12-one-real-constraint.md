# 12 — The one real constraint: akm's single binding bottleneck

> Adapts **"The one real constraint"** from `wiki:articles/raw/blog-prompts-to-run-when-fable-comes-back`.
> Theory-of-constraints applied to akm's value delivery. Not the loudest bug or the most-discussed subsystem — the single thing that, if relieved, unlocks the most; and where effort is being poured into non-constraints.

## Prompt

```text
Find akm's single binding constraint — the one bottleneck that actually caps its
value to the owner — and prove it's the constraint, not just the loudest problem.

1. Trace the value chain end to end: capture → store → rank → resurface → the moment
   a session is measurably better because akm existed. Find the stage where value
   actually leaks — where the chain is only as strong as its weakest link. Candidates
   to weigh (don't assume): capture coverage (sessions never extracted), retrieval
   precision (curate surfaces the wrong asset), trust (owner doesn't act on improve
   output), throughput (proposal backlog), or adoption (the owner reaches for it or
   doesn't). Use live evidence — recall stats, feedback, backlog age, session logs.

2. Distinguish the constraint from the noise: list where recent effort has gone
   (commits, docs, the tuning/salience investment) and show whether that effort was
   spent ON the constraint or on a non-constraint that felt urgent. The recurring
   akm failure mode is stacking machinery on a small non-root problem — name any
   instance of that here.

3. Name the ONE move that relieves the constraint, and what becomes possible once
   it's gone (the second-order effects — what downstream stages unlock). Then name
   the NEW constraint that surfaces after this one is relieved, so the owner sees the
   next link.

4. Output: findings/12-one-real-constraint.md — the value-chain trace with the leak
   located, the effort-vs-constraint audit, the single relieving move, and the
   next-constraint prediction. Prefer a move that removes a stage over one that adds
   a stage.

Guardrails: read-only on live data; the "move" is a recommendation for the owner,
not an action to execute. One constraint — resist listing five; commit to the
binding one and defend it.

ultracode
```

## Refs

Stash:

- `knowledge:projects/akm/improve-pipeline-quality-audit` — evidence on where improve value leaks.
- `memory:akm-improve-success-metric` (see MEMORY.md) — the metric that defines "value delivered", needed to locate the leak.
- `lesson:akm-stats-architecture-inversion` — what the stats surface can and can't reveal about the chain.
- `memory:improve-self-learning-wiring-branch.derived` — what was recently invested in (effort-vs-constraint input).

Repo:

- `docs/roadmap.md` — where planned effort is about to go (aim it at the constraint or not).

Live (read-only): `akm stats`, feedback/recall counts in `index.db`, proposal backlog age, session logs.
