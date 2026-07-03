# Meta-review shared context

Every agent spawned by `run-review.workflow.mjs` Reads this file. It holds the ground rules
and the binding decisions carried across reviews. **Keep it current:** when a review is
adjudicated, append its decisions under *Carry forward* so later reviews inherit them.

(This file is auto-injected into every review agent. Do NOT put an owner's sealed prediction
here — that must never reach an agent.)

## Ground rules (methodology)

- **READ-ONLY on live data.** Inspect `~/.local/share/akm`, `~/.config/akm/config.json`, and
  cron logs freely — but NEVER run `akm improve`/`recombine`/`extract`/`consolidate`. Open
  sqlite `mode=ro` only.
- **Verify EFFECTIVE config** (what the cron actually loads), not code defaults.
- **Prefer subtraction:** a fix that deletes machinery beats one that adds a guard/flag/wrapper.
- **No deletions.** Output *dispositions* (keep/update/merge/archive/delete); the owner approves
  any delete per-path, by name.
- **Never print secret VALUES** — reference env/secret assets by name only.
- **Metrics caveat:** improve accept/reject rows before `0.9.0-beta.50` are polluted (gated skips
  counted as rejected); discriminate with `skippedCount IS NOT NULL`.
- **Findings are local-only / gitignored** and may contain sensitive facts — never commit them.

## Carry forward (binding decisions from completed reviews)

From **01 goal-orientation** and **05 metrics-and-evals** (adjudicated + shipped):

- akm is **BOTH pillars**: a pack-consumption channel AND a learning engine; the automation
  platform (tasks/env/secrets) is a ratified 1.0 pillar.
- Metrics are settled: **UCE** (useful context events/week) is the primary north star; **GRR**
  (per-lane 30-day external read-back rate of improve-promoted refs) is the governing number;
  minting lanes stay off below 5% GRR.
- Generation is gated on usage/feedback; proactive lanes are repointed at **ENRICHMENT**
  (metadata, graph relations), not new-content minting.
- The improve pipeline already had a **subtraction round** — PR #695 (shipped 0.9.0-beta.54)
  deleted the #691 outcome-penalty term and added event-provenance filters, two-tailed monitors,
  and an enrichment-minting rollup. **R1** (outcome weight w_o=0.15) and **R2** (salience→search
  boost) are LIVE since beta.53. Account for what's already gone; don't recommend re-deleting it.
- Security: the env comment-leak is fixed and the index rebuilt; the previously-leaked
  credentials were fake test values — no rotation needed.

<!-- Append 02/03/04/06 … decisions here as they adjudicate. -->
