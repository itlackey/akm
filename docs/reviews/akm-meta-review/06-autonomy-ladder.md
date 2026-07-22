# 06 — The autonomy ladder: what improve does unsupervised vs. what queues

> Adapts **"The autonomy ladder"** from `wiki:articles/raw/blog-prompts-to-run-when-fable-comes-back`.
> akm's trust boundary is concrete: cron-driven improve lanes write salience, auto-accept some lessons, and generate proposals, while other changes wait in a queue the owner must drain. This review asks whether each action sits on the right rung.

## Prompt

```text
Map and recalibrate akm's autonomy ladder.

1. Inventory every action akm takes AUTONOMOUSLY (cron improve lanes: distill,
   recombine, consolidate, proactive-maintenance; salience/rank_score writes;
   auto-accept of recombine-confirmed lessons; watermark advancement; index writes;
   memory candidate capture) and every action that is OWNER-GATED (proposal
   accept/reject, config changes, asset deletion). For each: file:line of the
   decision point, and what gate (judge, schema, wo opt-out, cooldown) sits in front
   of it. Verify against the EFFECTIVE live config + cron profiles, not code
   defaults — a gate that config disables is not a gate.

2. Score each action on blast radius (what it can corrupt: live stash content,
   ranking, telemetry), reversibility (is there an undo/history?), and leverage
   (what it saves the owner). Flag the two failure directions:
   - OVER-GRANTED: silent writes that can degrade recall quality or stash content
     with no owner-visible trace. Test the auto-accept path hardest.
   - UNDER-GRANTED: gates that cost more than they protect. The proposal queue has
     a standing backlog — measure its drain rate vs. arrival rate and the age of
     the oldest pending item. A queue nobody drains is a dead letter box, not a
     safety mechanism.

3. Redesign the ladder: for each action, the rung it should be on (autonomous /
   autonomous-with-audit-trail / batched-review / per-item approval) and the change
   required to move it. Prefer removing an action entirely over adding a new gate
   around it.

4. Output: findings/06-autonomy-ladder.md — the action inventory with scores, the
   miscalibration list, and the target ladder with migration steps.

Guardrails: read-only on live data — inspect the proposal queue and run history,
never trigger runs or accept/reject proposals yourself. Verify effective config.

ultracode
```

## Refs

Stash:

- `knowledge:akm-improve-pipeline-architecture` — where each lane's write/gate points live.
- `knowledge:config-system-architecture` — how config controls the gates (and where defaults vs. live values diverge).
- `memory:improve-self-learning-wiring-branch.derived` — current gate defaults (judge+schema default-on, outcome cap, wo opt-out).

Repo:

- `docs/technical/improve-workflow.md` — the intended human-in-the-loop flow.
- `docs/configuration.md`, `docs/configuration-agent-profiles.md` — profile system the cron actually loads.

Live (read-only): `akm proposal list` / pending-proposal count, `crontab -l` + cron profile flags, `~/.config/akm/config.json`, improve run history in `state.db`.
