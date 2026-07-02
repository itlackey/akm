# 04 — Stash self-model audit: is akm modeling who the owner was, or is?

> Adapts **"Self-model audit"** from `wiki:articles/raw/blog-prompts-to-run-when-fable-comes-back`.
> The blog audits what a harness believes about its user. akm's version of that belief is the stash: memories, lessons, and salience weights that shape what every future session gets told about the owner and their projects.

## Prompt

```text
Audit what the akm stash believes about its owner against current reality.

1. Inventory the self-model: every memory, lesson, and knowledge asset that encodes
   owner preferences, project state, workflows, or decisions ("the owner wants X",
   "project Y is at state Z", "always do W"). Use akm search --type memory /
   --type lesson plus direct reads; include the .derived twins.

2. Establish current reality independently: recent git history across the owner's
   active repos, recent session logs, the live cron/config setup, and what the owner
   has actually been working on in the last 30 days.

3. Flag every divergence, classed as:
   - STALE: was true, no longer is (finished projects, reversed decisions,
     superseded tools). These actively mislead future sessions.
   - ASPIRATIONAL: describes intent that behavior never confirmed.
   - DUPLICATED: .derived twins and near-copies that dilute recall ranking.
   - TELEMETRY NOISE: session-checkpoint-style memories that model nothing.
   - CONTRADICTED: two live assets that can't both be true — prime candidates for
     the bi-temporal invalidation mechanism; note whether that mechanism would have
     caught each one.

4. For each flagged asset, propose a disposition (update / invalidate / merge /
   archive / delete) routed through the proposal queue — do NOT modify or delete
   stash assets directly. Estimate the recall-quality effect of applying the batch.

5. Answer the meta-question: does akm have any mechanism that would have PREVENTED
   this drift (contradiction detection, decay on unconfirmed memories, freshness
   checks at recall time), and if not, which single mechanism is worth adding —
   or which write path is worth removing so the drift never accumulates?

6. Output: findings/04-stash-self-model.md — divergence table with dispositions,
   the drift-prevention verdict, and the proposal-queue batch ready for owner review.

Guardrails: read-only on live data; all changes flow through proposals; no direct
edits or deletions of stash assets.

ultracode
```

## Refs

Stash:

- `akm search --type memory "<owner/project terms>"` and `akm search --type lesson` — the inventory source itself.
- `memory:improve-self-learning-wiring-branch.derived` — example of a project-state memory to freshness-check against git history.
- `memory:akm-cli-version-stability-roadmap.derived` — example of a roadmap belief to verify against the actual roadmap.
- `akm show meta` — the stash's own orientation doc, if present.

Repo:

- `docs/design/improve-bitemporal-invalidation-design.md` — the contradiction-invalidation design; this review is its acceptance test.
- `docs/design/improve-beta50-monitoring.md` — what improve currently writes about its own runs (telemetry-noise candidates).
- `docs/technical/proposal-storage.md` — how to route dispositions through the queue correctly.

Live (read-only): `~/.local/share/akm/index.db` (memory/lesson rows and their recall stats), recent session logs under the agent CLI's data dir, `crontab -l`.
