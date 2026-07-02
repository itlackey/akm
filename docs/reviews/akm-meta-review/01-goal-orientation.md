# 01 — Goal orientation: what is akm for, and what fights it?

> Adapts **"Goal orientation"** from `wiki:articles/raw/blog-prompts-to-run-when-fable-comes-back`.
> The blog asks this of a whole harness; here the "harness" is akm — its subsystems either compound toward one goal or quietly optimize for something else.

## Prompt

```text
Review the akm project (this repo + the live install) for goal cohesion.

1. Characterize what akm is ultimately trying to accomplish. Derive it from three
   independent sources and note where they disagree:
   a. What the docs claim (README, concepts, roadmap, core principles).
   b. What the code invests in (where the LOC, complexity, and recent commits actually go).
   c. What the owner actually uses (which commands appear in cron, hooks, and session
      logs; which asset types get read back).

2. Audit every subsystem against that goal: extract, search/curate (hybrid ranking,
   rank_score), the improve pipeline (distill, recombine, consolidate,
   proactive-maintenance lanes), salience, the proposal queue, hooks/plugins
   (Claude Code + opencode), wikis, registry, env/secret assets. For each, give a
   verdict: PULLS TOWARD the goal, NEUTRAL, or PULLS AGAINST — with the specific
   evidence (a metric, a code path, a usage fact), not vibes. Known tension to test:
   the improve pipeline has historically been rewarded for churn/promotion volume
   rather than coverage and accepted-change-rate.

3. If no crisp goal statement exists anywhere, draft a one-paragraph candidate and
   list the interview questions the owner must answer to pin it down.

4. Output: findings to docs/reviews/akm-meta-review/findings/01-goal-orientation.md —
   the goal statement, the per-subsystem alignment table, and the top 5 misalignments
   ranked by how much they cost, each with a concrete fix. Prefer fixes that DELETE
   or narrow a subsystem over fixes that add coordination machinery.

Guardrails: read-only on live data (~/.local/share/akm, ~/.config/akm/config.json,
cron logs) — never trigger improve/extract/recombine runs. No deletions; output
dispositions only. Verify effective config, not code defaults.

ultracode
```

## Refs

Stash (pull with `akm show <ref>`):

- `wiki:articles/raw/blog-prompts-to-run-when-fable-comes-back` — the source prompt being adapted.
- `knowledge:akm-improve-pipeline-architecture` — how the improve pipeline is meant to fit together.
- `knowledge:projects/akm/improve-pipeline-quality-audit` — prior audit of whether improve output is worth anything.
- `memory:improve-self-learning-wiring-branch.derived` — most recent self-learning wiring state (what shipped, what was deferred).
- `akm show meta` — the working stash's own statement of purpose, if present.

Repo:

- `docs/README.md`, `docs/concepts.md`, `docs/roadmap.md` — the claimed goal.
- `docs/technical/akm-core-principles.md` — the stated principles to test the code against.
- `docs/technical/architecture.md` — subsystem map.
- `docs/design/improve-salience-working-reference.md` — end-to-end improve/salience reference; read before judging that subsystem.

Live (read-only): `akm stats`, `akm health`, `crontab -l` for what actually runs.
