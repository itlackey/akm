# Improve Pipeline — 0.9.0-beta.50 Change Summary, Baseline & Monitoring

**Date:** 2026-06-29. **Released:** `akm-cli@0.9.0-beta.50` (npm `next`), tag `v0.9.0-beta.50`.
**Deployed to cron:** yes — global install upgraded to beta.50 on 2026-06-29 ~20:38 UTC.

> All timestamps below are **UTC** (the `improve_runs` / log timestamps are UTC; the config-file mtime is local CDT = UTC−5). Mixing the two is what produced an earlier false "6-hour lag" claim — see §5.

---

## 1. What changed

**Config (live since the restore; affects the cron regardless of binary):**
- Restored `profiles.improve.reflect-distill.processes.proactiveMaintenance` (`enabled, dueDays:30, maxPerRun:15`) — the sustaining lane the 0.9.0 config-audit had stripped.

**Code (shipped in beta.50, now deployed to the cron):**
- `default` profile ships `proactiveMaintenance` ON (fresh-install sustaining lane).
- **Telemetry exclusion** — session-checkpoint memories (~20% of pool) excluded from consolidate, the high-salience candidate set, and graph extraction; raw file/dir-path entities dropped.
- **Extract triage gate** on default/frequent (heuristic, no LLM) — gates ~90% no-candidate sessions before the extract + summary calls.
- **Recombine promoted-skip** — no LLM call for already-promoted clusters.
- **Metrics fix (#1)** — gated skips are now bucketed `skipped`, not `rejected`; `skippedCount` added. This is the prerequisite that makes accept-rate meaningful.
- **lowValueFilter read-path fix** — now resolves from the active profile (default OFF, by decision).
- **Transaction-race fix** — phantom `BEGIN IMMEDIATE` retried before `fn()` runs (eliminated the `cannot commit - no transaction is active` flake).

---

## 2. The "before" (the regression we started from)

The 0.9.0 config-audit removed `proactiveMaintenance` on **Jun 28 ~16:40 UTC**. On a mature stash `reflect` is signal-delta-gated to ~0 actionable, so the hourly proactive cron collapsed and stayed collapsed ~22 h. Measured from the `:40` (frequent / reflect-distill) cron run:

| Phase (UTC) | planned/run | accepted/run | auto-acc |
|---|---|---|---|
| **Baseline (healthy)** — Jun 28 13:40–15:40 | **15** | **14–15** | 13 |
| **Regression** — Jun 28 16:40 → Jun 29 14:29 | **0–2** | **~1** | 0 |
| **Recovered** — Jun 29 14:40 onward | **15–20** | **11–16** | 10–12 |

Recovery began on the **first cron tick after the config restore** (restore 14:29 UTC → next `:40` tick 14:40 UTC). Output is back to the healthy baseline.

---

## 3. The baseline to track going forward

- **Proactive cron throughput:** ~15 planned / ~13 accepted per `:40` run.
- **Reflect alone ≈ 0 actionable** on this stash (≈226 / 13,200 blocked by signal-delta). Proactive *is* the output engine — if a run logs no `proactive maintenance selected` line, the lane is off.
- **Metrics now meaningful (beta.50):** judge health by `acceptedCount ÷ plannedCount`, **not** volume. Pre-beta.50 `rejectedCount` ≈ 13,200 was the *polluted* number (gated skips); going forward that number moves into `skippedCount` and `rejectedCount` becomes a small, real value-rejection count.

---

## 4. What to monitor

**Proactive lane stays alive (primary health signal):**
```sql
SELECT substr(started_at,1,16) run,
  json_extract(metrics_json,'$.plannedCount')      planned,
  json_extract(metrics_json,'$.acceptedCount')     accepted,
  json_extract(metrics_json,'$.skippedCount')      skipped,   -- beta.50+: appears once deployed
  json_extract(metrics_json,'$.rejectedCount')     rejected   -- should now be SMALL, not ~13k
FROM improve_runs WHERE dry_run=0 AND substr(started_at,15,2)='40'
ORDER BY started_at DESC LIMIT 24;
```
- `skippedCount` present + `rejectedCount` small ⇒ beta.50 is running. `rejectedCount` still ~13k ⇒ still on the old binary.
- planned ~15, accepted ~11–16 ⇒ proactive healthy.

**Cost / noise reductions (compare a week of beta.50 vs the pre-Jun-28 baseline):**
- LLM calls per run trending **down** (extract triage, recombine promoted-skip, telemetry excluded from consolidate).
- consolidate pool size **down** (~20% telemetry removed); graph junk/path-entity counts **down**; recombine accept-rate.
- Zero `cannot commit - no transaction is active` errors.

**Decision gate for #10/#11 (salience selection):** only 17 / 4,350 `asset_salience` rows are content-scored. Wiring salience into proactive selection (#10) is premature until content-scoring coverage grows. Re-read this number after a week of beta.50; if it climbs, revisit #10/#11 — otherwise leave them parked.

---

## 5. Investigation: config-propagation lag — NOT a real issue

Initial read suggested a ~6 h gap between the config restore and the cron honoring it. **That was a timezone-comparison error** (local config mtime `09:29 -0500` compared against UTC run timestamps). Corrected:

- Config restored **14:29 UTC** (09:29 CDT).
- First `proactive maintenance selected` log line: **14:40 UTC** tick (~11 min later — the next hourly cron tick).
- `loadConfig` caches on `(path, mtimeMs, size)` and invalidates when any of those change (`config.ts:143-146`); each cron tick is a **fresh process**, so there is no stale-config window.
- `~/.cache/akm/config-backups/config.latest.json` is a **write-only backup snapshot**, not a read source — its staleness is irrelevant to the cron.

**Conclusion:** live config edits are honored on the next cron tick. No fix needed. (If future confidence is wanted, log the effective `proactiveMaintenance.enabled` + config mtime at run start — cheap, makes this self-evident.)
