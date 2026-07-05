# Optimal Default Improve Configuration for a Fresh Install

**Goal:** what should ship *in code* (`src/assets/profiles/*.json` + `IMPROVE_PROCESS_DEFAULTS`) so that `akm` performs well on a fresh install with **zero** config changes — including after the stash matures.

**Author:** review of production data (`~/.local/share/akm/state.db`, 30-day window) + 12 tuning memories.
**Date:** 2026-06-29.
**Status (2026-07-05, meta-review 14):** 06-M5 (delete the builtin `default.json` `proactiveMaintenance:{enabled:true}` block) is **ratified but unexecuted** — held per review 11 §3.2. This doc matches today's shipped code; when 06-M5 executes, the proactiveMaintenance guidance below flips to SUPERSEDED.

> Method note: hard recommendations below are tied to **directly-verified data** (proposal outcomes, the proactiveMaintenance-removal regression of 2026-06-28) and the **shipped code I read** (`default.json`, `IMPROVE_PROCESS_DEFAULTS`). Tuning *rationale* drawn from memories is attributed and marked "verify file:line before coding" — memories are point-in-time.

---

## 0. TL;DR — the one change that matters most

On a fresh install the only scheduled improve task that ships is the nightly `improve.yml` → **`default` profile**. That profile leaves **`proactiveMaintenance` OFF**. On a *mature* stash, `reflect` is signal-delta-gated to ~0 actionable refs per run (verified in production logs: `279 of 13197 indexed refs blocked by reflect signal-delta … 0 actionable`). **`proactiveMaintenance` is the only lane that keeps producing once the stash is no longer new.** With it off, a fresh install does useful work for the first week, then goes silent — exactly the failure observed on this machine on 2026-06-28.

**Primary recommendation:** ship `proactiveMaintenance: { enabled: true, dueDays: 30, maxPerRun: 15 }` in the `default` profile. Its value is being validated *before 0.9.0* on the maintainer's local stash using the `scripts/akm-eval/` verdict instrument (see §4) — that local evaluation, plus the production evidence above, is the basis for shipping it on. The verdict kill-switch itself is a **dev/testing tool and is intentionally NOT shipped** in the release.

---

## 1. The success metric (how "optimal" is judged)

Do **not** optimize promotion *volume* — that rewards churn and was the root of a 54%-task-regression "faulty memory" episode. Optimize:

- **Coverage** — % of eligible assets reflected within `dueDays`.
- **Accepted-change rate vs. a do-nothing baseline** — net improvement, not raw count.
- **Low reversion / no lossy reconsolidation** — additive distill, no-op gate, raw assets + git history preserved.

*(memory: `akm-improve-success-metric`, `akm-improve-vs-brain-model`)*

A useful structural model: **LOOK** (liberal selection: proactiveMaintenance, high-retrieval, high-salience) feeds **CHANGE** (the signal-delta-gated reflect/distill). Keep these separate — collapsing them caused a "96% of assets never revisited" pathology. The signal-delta gate is load-bearing; do not remove it, and do not re-gate the liberal selectors behind it.

---

## 2. Per-lane recommended defaults

Legend: **current** = today's code default; **recommend** = proposed ship default for the `default` profile.

| Lane | Current | Recommend | 30-day prod accept | Rationale |
|---|---|---|---|---|
| **reflect** | ON | **ON**, `limit: 25` | 98.0% (3884/3962) | Core change-gate. High yield. Size `limit` to timeout (see §3). |
| **extract** | ON | **ON** | 99.9% (4801/4806) | Highest-volume, highest-yield lane. Content-hash ledger makes unchanged sessions free. |
| **consolidate** | ON | **ON**, `minPoolSize: 500` | 99.3% (8096/8153) | High yield. Exclude session-checkpoint telemetry from pools (~20% noise). |
| **memoryInference** | ON | **ON** | — | Core; cheap; derives facts post-cycle. |
| **graphExtraction** | ON | **ON** | — | Core; powers entity clustering used by recombine/curate. |
| **proactiveMaintenance** | **OFF** | **★ ON**, `dueDays: 30`, `maxPerRun: 15` | (feeds reflect) | **The sustaining lane.** Without it a mature stash → 0 actionable. `maxPerRun:15` is the proven value from this machine's working config. Value validated pre-release via the local `scripts/akm-eval/` verdict (not a shipped gate). |
| **triage** | OFF | **OFF** (default), ON in `thorough` | — | The shipped nightly cmd already uses `--auto-accept safe`, so the pending backlog stays small; triage is redundant in `default`. Keep it as the `thorough` differentiator. |
| **distill** | ON | **ON but cap cost** — `requirePlannedRefs: true` | **13.9% (5/36)** | Highest-noise lane here: 86% rejected, mostly local-model validation failures (truncated/unbalanced descriptions). Keep on (it produces the only *content* salience scores) but cap with `requirePlannedRefs` so it rides reflect's selection instead of scanning the full backlog. |
| **recombine** | OFF | **OFF in `default`; ON only in `synthesize`** | **36.8% (14/38)** | Data still shows it noisy. The entity-clustering fix (`relatednessSource:"both"`, session-telemetry exclusion, #632/beta.44) is recent and not yet proven in prod accept-rate. Keep opt-in via the `synthesize` profile; revisit default-on once a post-fix window shows ≥60% accept. |
| **procedural** | OFF | **OFF** | **0% (0/5)** | Confirmed over-fit of one-off single-project sequences (#634). Needs cross-project scoping + identifier-stripping before re-enabling. |

### Notes that change the numbers
- The near-100% accept on consolidate/extract/reflect partly reflects `--auto-accept safe` passing the *safety* gate, not proof of *value* — read these as "low-noise," and rely on the §1 coverage/reversion metric for value. The low rates (distill 14%, recombine 37%, procedural 0%) are an unambiguous **noise** signal: those lanes burn LLM calls on proposals that fail validation/judgment.

---

## 3. Caps, thresholds & footguns to bake into defaults

- **Reflect timeout budget (hard constraint).** Each reflect costs ~85s under LLM contention. `reflect.limit + proactiveMaintenance.maxPerRun` must fit the task `timeoutMs` or the run SIGTERMs mid-cycle. Rule of thumb: `limit ≤ (timeoutMs/1000)/100`. For the recommended nightly (25 + 15 = 40 reflects ≈ 57 min), ensure the nightly task `timeoutMs ≥ ~75 min` or lower `maxPerRun`. *(verify against `proactive-maintenance.ts` / `preparation.ts` before coding.)*
- **proactiveMaintenance code defaults** are `dueDays=30`, `maxPerRun=25` (`proactive-maintenance.ts:37,40`). Recommend overriding to **15** per-run in the shipped profile (proven safe here; 25 risks the timeout above).
- **Post-lock re-filter** (`filterProactiveDue`) must run so overlapping cron ticks don't re-reflect the same refs (#638 cooldown leak).
- **`archiveRetentionDays: 0` disables proposal expiry** → unbounded pending queue. Ship a sane default (90 days). *(verify key name in `config-schema.ts`.)*
- **Extract discovery window** floor = `max(last-extract-run, 48h)` — closes the intermittently-online data-loss gap. *(memory: `akm-extract-safety-cost-model`.)*
- **Sync:** all shipped profiles should keep `sync.enabled:true, push:true` (#680 fixed `quick`/`memory-focus` shipping with sync off). Commits happen between cycles, at end-of-run, and in the catch handler, so an interrupted run loses at most the in-flight cycle. Push is a no-op without a writable remote, so it's safe to default on.

---

## 4. Proposed `default.json` (the fresh-install nightly profile)

```jsonc
{
  "description": "Standard improve pass — all sub-processes + sustaining proactive lane.",
  "processes": {
    "reflect":          { "enabled": true, "limit": 25,
      "allowedTypes": ["agent","command","knowledge","lesson","memory","skill","wiki","workflow"] },
    "distill":          { "enabled": true, "allowedTypes": ["memory"], "requirePlannedRefs": true },
    "consolidate":      { "enabled": true, "allowedTypes": ["memory"], "minPoolSize": 500 },
    "memoryInference":  { "enabled": true },
    "graphExtraction":  { "enabled": true },
    "extract":          { "enabled": true },
    "proactiveMaintenance": { "enabled": true, "dueDays": 30, "maxPerRun": 15 },  // ★ the change
    "triage":           { "enabled": false, "applyMode": "queue", "policy": "personal-stash" },
    "recombine":        { "enabled": false },
    "procedural":       { "enabled": false }
  },
  "sync": { "enabled": true, "push": true }
}
```

`IMPROVE_PROCESS_DEFAULTS` (the fallback for profiles that don't mention a lane) can stay as-is — the change above is profile-level, which is the right altitude (a code-default flip to `proactiveMaintenance:true` would silently turn it on for *every* profile including `quick`/`graph-refresh`, which is not wanted).

**Pre-release validation (NOT a shipped gate):** the value of the proactive lane is verified on the maintainer's local stash with the `scripts/akm-eval/` verdict instrument (`scripts/akm-eval/bin/akm-eval-proactive-verdict`): PASS requires proactive-accept ≥ 0.9× reactive-accept, reversion ≤ 0.15, retrieval-delta ≥ 0; FAIL → the lane is reconsidered before 0.9.0. This runner — and the local `akm-improve-proactive-verdict-monthly` cron that drives it on this dev machine — is a **dev/testing instrument and is deliberately excluded from the release**. The decision to ship `proactiveMaintenance` on rests on that local validation plus the production evidence above, not on a shipped auto-disable mechanism. Do **not** add the verdict task to `src/assets/tasks/`.

---

## 5. Where I disagree with the raw memory synthesis

- The memories say "proactiveMaintenance disabled in all shipped profiles as of beta.44" — that reflects a *cautious rollout state*, not the optimal end-state. The production data (this very regression) shows the lane is **required** for a mature stash to keep improving. Ship it on; its value is being validated pre-release via the local `scripts/akm-eval/` verdict, which is itself excluded from the release.
- The memory synthesis suggested `recombine` default-on in `default`. The live accept rate (37%) doesn't support that yet; keep it in `synthesize` until a post-#632 window proves it.

---

## 6. Open items to verify before coding the change
1. Confirm the nightly task `timeoutMs` has headroom for `reflect.limit 25 + proactive maxPerRun 15` (or trim one).
2. Re-verify `proactive-maintenance.ts` selection still honors `maxPerRun`/`dueDays` from profile config (it did as of beta.44).
3. Confirm `archiveRetentionDays` key name/location in `config-schema.ts` and pick the shipped value.
4. Add a guard: a built-in-profile audit that flags removing a `processes.*` key whose code default is `false` (this regression's root cause — a load-bearing key pruned as "dead"). See memory `akm-config-audit-stripped-proactivemaintenance-regression`.
