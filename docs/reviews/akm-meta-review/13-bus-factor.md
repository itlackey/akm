# 13 — Bus-factor audit: what only works because it's in the owner's head or on one machine?

> Adapts **"The bus-factor audit"** from `wiki:articles/raw/blog-prompts-to-run-when-fable-comes-back`.
> If the owner vanished for 30 days — or just switched machines — what about akm silently breaks? This finds the undocumented dependencies and the this-one-host magic that never made it into the system.

## Prompt

```text
Run a bus-factor audit on akm. If the owner disappeared for 30 days or moved to a
fresh machine, what breaks — and what only keeps running because it lives in the
owner's head or on this one host?

1. ENVIRONMENTAL / SINGLE-HOST dependencies: what about the current setup is load-
   bearing and undocumented? The cron running the real dist, the specific dist build
   vs. the npm package (a prior incident: cron ran a stale local dist), local config
   pinning values that differ from code defaults, the deterministic-embedder env var,
   AKM_*_DIR / HOME / XDG assumptions, the agent-CLI (opencode) configuration. For
   each: is it reproducible from a doc/script, or is it tribal knowledge?

2. OPERATIONAL knowledge only the owner holds: how to tell if improve is actually
   healthy, which profiles have sync disabled, how to distinguish a real regression
   from a host-state flake, when to use --force, how to verify a feature is live
   against the RIGHT database. Much of this is scattered across MEMORY.md entries and
   design docs — inventory what's captured vs. what's still only in-head.

3. FRAGILE-IF-UNTENDED processes: what degrades on its own without owner attention?
   The proposal backlog growing unbounded, state.db blob growth (~3.95GB of
   result_json), telemetry accumulation, cron failures that surface only in Discord.
   What has no alarm and no auto-recovery?

4. For each finding: the durable artifact that removes the you-shaped hole — a
   runbook, a script, a health check, a doc, or (better) a code change that makes the
   dependency self-evident or unnecessary. Prefer making the dependency disappear
   (e.g., cron builds its own dist) over documenting the manual step.

5. Output: findings/13-bus-factor.md — the three dependency inventories, each item
   marked captured / partially-captured / in-head-only, and the durability plan
   ordered by (breakage-likelihood × recovery-difficulty).

Guardrails: read-only on live data; document and propose, don't reconfigure the live
host this pass. Note any single-host assumption that would also bite a new user
installing akm fresh — that overlaps with real product bugs.

ultracode
```

## Refs

Stash:

- `memory:akm-improve-sync-only-on-clean-finish` and `memory:akm-improve-delta-only-throughput-collapse` (see MEMORY.md) — operational knowledge currently living in memory, not a runbook.
- `memory:akm-dev-prod-isolation-already-solved` and `memory:isolate-config-in-init-repros` (see MEMORY.md) — host-isolation knowledge to check for durability.
- `memory:akm-result-json-blob-cleanup-after-090` (see MEMORY.md) — the unattended state.db growth process with a pending owner decision.
- `memory:akm-lore-writer-high-salience-followup` (see MEMORY.md) — an open operational follow-up that depends on a specific dist build (stale-dist hazard).

Repo:

- `docs/getting-started.md` and `docs/local-development.md` — what a fresh setup documents vs. what it assumes.
- `docs/technical/storage-locations.md` — the AKM_*_DIR / HOME / XDG assumptions.
- `docs/technical/manual-testing-checklist.md` — operational verification steps that may only be in the owner's head.
- `docs/technical/incidents/` — prior incidents that reveal single-host fragility.
- `docs/data-and-telemetry.md` — the accumulation processes with no alarm.
