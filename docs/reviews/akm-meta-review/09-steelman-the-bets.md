# 09 — Where akm is most wrong: steelman the case against its biggest bets

> Adapts **"Where am I most wrong"** from `wiki:articles/raw/blog-prompts-to-run-when-fable-comes-back`.
> The blog turns the model on the user's biggest bets. Here it turns on akm's founding assumptions — the beliefs the whole architecture rests on that have never been stress-tested.

## Prompt

```text
Turn on akm. Steelman the case that its largest bets are WRONG. Do not hedge —
argue each against-case as strongly as it can be argued, then say what evidence
would settle it.

1. Surface akm's load-bearing bets — the assumptions the architecture can't survive
   being wrong about. Candidates to test (add any you find):
   - That an autonomous improve pipeline generates net-positive knowledge rather
     than churn the owner must police. (Prior data: churn problems, polluted
     accept/reject metrics, a proposal backlog nobody drains.)
   - That a local SQLite stash + hybrid search is the right substrate, vs. this
     becoming a thin layer over a model with a long context window and native
     retrieval.
   - That salience/decay formulas modeled on neuroscience earn their complexity vs.
     a flat recency+feedback score.
   - That extract-from-transcripts captures durable knowledge vs. mostly session
     telemetry.
   - That the CLI + plugin distribution model is how this reaches users.

2. For each bet: the steelman AGAINST it (the strongest version of "this is wrong"),
   the load-bearing sub-beliefs it rests on that were never actually checked, the
   evidence that would change the verdict, and — critically — whether the current
   telemetry would even let the owner NOTICE if the bet were failing, or whether
   it's structurally invisible.

3. Rank the bets by (probability-wrong × cost-if-wrong). For the top one, propose
   the cheapest decisive experiment that would confirm or kill it — the 4-minute
   yes/no test, not a multi-week rebuild.

4. Output: findings/09-steelman-the-bets.md — the bet list with steelmans, the
   never-checked sub-beliefs, the notice-ability verdict per bet, and the ranked
   experiments.

Guardrails: read-only; the "experiments" are proposals for the owner, not runs to
execute against live data. Be adversarial about akm's own value — the point is to
find the wrong bet before it costs another year, per the subtract-don't-accrete rule.

ultracode
```

## Refs

Stash:

- `knowledge:projects/akm/improve-pipeline-quality-audit` — the hardest existing evidence for/against the improve bet.
- `knowledge:projects/akm/consolidation-future-vision` — the long-term vision to attack.
- `knowledge:projects/akm/test-harness-redesign` and the `asset-writers-investigation` position papers (`01-position-schema-first`, `02-position-builder-pattern`, `03-position-devils-advocate`) — models for structured for/against argument; reuse the devil's-advocate framing.
- `memory:akm-improve-success-metric` (see MEMORY.md) — the coverage-not-churn metric that several bets hinge on.

Repo:

- `docs/roadmap.md` and `docs/technical/v1-architecture-spec.md` — the bets baked into the roadmap.
- `docs/concepts.md` — the substrate bet (local SQLite + hybrid search) stated plainly.
