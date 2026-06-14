## AKM Improve Pipeline — Definitive Optimization Report
*Synthesized from 7-agent analysis — 2026-06-12*

---

## 1. ROOT CAUSE ANALYSIS

### Issue 1: Session Extraction Collapse (Jun 12: 10 sessions scanned vs 4382 Jun 11)

**Root cause: Triple compounding effect — not a pipeline failure.**

The `sessionsScanned` metric is a `SUM` across all runs in the window, not a unique-session count. Three simultaneous factors collapsed the sum:

1. **Cadence reduction (5.3x):** Extract shifted from `8,28,48` (72 runs/day) to `:07` (24 runs/day). Fewer runs means lower aggregate SUM even with identical per-run output.

2. **Journal session ID inflation on Jun 11 (now resolved):** All 166 `journal.jsonl` workflow files shared a single `sessionId='journal'`. Jun 11's 58 extract runs each re-processed all 166 as "unseen" because the `extract_sessions_seen` entry wasn't written until Jun 12 23:07. This inflated Jun 11's count by ~166 × 58 = 9,628 phantom session events. Jun 12 correctly deduplicates them with a single lookup.

3. **Pool saturation:** `extract_sessions_seen` grew from ~1,831 to 2,615 entries against 4,249 total JSONL files. By Jun 12, only ~97 genuinely new sessions existed in the 24h window. The `no_candidates` count per run jumped as the seen table covered the available pool.

**Verdict:** Jun 12's `sessionsScanned=10` is *correct behavior* at the new cadence. The health alert was a false alarm caused by metric semantics (`SUM` vs `MAX`) and comparison against an anomalously inflated Jun 11 baseline.

---

### Issue 2: Consolidation Explosion (Jun 12: 21,383 processed vs 925 Jun 10)

**Root cause: Burst-window amplification via graph neighbor expansion, not a runaway full sweep.**

The 21,383 total is 35+ incremental passes of 530–692 memories each, not a single full sweep. The sequence:

1. **04:07 UTC:** Extract cron promoted ~27 new memory files. Combined with prior overnight promotions, ~100+ non-derived memory files had `mtime` newer than the 4h cutoff (01:02 UTC).

2. **05:02 UTC:** `narrowToIncrementalCandidates` found 100 changed files. With `NEIGHBORS_PER_CHANGED=5` hardcoded, this expanded to 600–692 candidates — essentially the full eligible pool of 646 non-derived memories.

3. **05:30–14:08 UTC (plateau):** Each subsequent 15-min pass re-processed the same ~600–692 memories because they remained within the 4h sliding window. The window required 9h to drain (04:07 + 4h window × 16 passes).

4. **14:19 UTC (sharp drop):** The last burst-window memories aged past the 4h cutoff simultaneously, dropping candidates from 530 to 25 in one pass.

**Key factors:** `incrementalSince=4h` + `NEIGHBORS_PER_CHANGED=5` + burst of 100 simultaneous promotions = each individual pass is "correct" but 16 consecutive passes against the same pool is pure waste.

---

### Issue 3: AutoAccept Validation Failures (0 → 44 → 58, still growing)

**Root cause: Two separate failure sources with different severities.**

**Source A — Persistent stale proposal (high severity, immediate fix needed):**
Proposal `0a836a40-b001-448f-93b1-610bd4be0aac` (`lesson:invalid-api-key-persistence`) has a description starting with "When", which permanently fails `descriptionQualityValidator`. It is re-attempted every run and never cleaned up. This single proposal accounts for roughly 1 validation failure per run across quick, daily, and extract tasks — a phantom that inflates the failure counter indefinitely.

**Source B — Extract LLM prompt structural defect (medium severity):**
The extract prompt template generates `description` fields starting with "When", ending with truncation indicators (`:`, `;`, `,`), or using heading-fragment text. The steady rate of ~4 failures/hour on Jun 12 (after the stale proposal is accounted for) shows a systematic upstream defect. The `descriptionQualityValidator` rules in `proposal-quality-validators.js` are not reflected in the prompt.

**Source C — Corrupt config (contributing factor):**
`config.json` has `triage.applyMode='auto'` on both `thorough` and `quick-shredder` profiles (valid values: `queue` | `promote`). This caused `INVALID_CONFIG_FILE` errors on ~1 extract run/day and 3 improve runs, contributing to the failure count via aborted runs rather than proposal failures.

---

### Issue 4: Reflect + Distill Running Only Once/Day

**Root cause: Architectural misconfiguration — the quick-shredder profile explicitly disables reflect.**

`quick-shredder` has `reflect.enabled=false` despite its task description claiming "reflect signal-delta". The former `akm-improve-frequent` task (every 6h, `memory-focus` profile with reflect+distill) was disabled. The `akm-improve` task (every 30min, full pipeline) was also disabled. Result: reflect and distill have been silently absent from all daytime runs since these tasks were disabled.

This creates a **22h+ latency gap** between session extraction and insight synthesis. Sessions extracted at 03:00 are not reflected on until 02:00 the next day — effectively a 23h lag. The `distill` process compounds this: its candidate-set loop does not gate on `plannedRefs` from reflect outputs, generating ~689 `distill-skipped` actions per run even when it does fire.

---

### Issue 5: Wall-Time P95 at 844s (Jun 12) — Timeout Risk

**Root cause: Consolidation full-pool plateau + reflect/distill only in nightly run → two processes competing for the same global lock during the 2am window.**

The daily run duration grew from 197s (Jun 9) to 1,083s (Jun 11) — 5.5x regression. Three compounding factors:

1. **Consolidation chunk growth:** 23 chunks (Jun 10) → 26 chunks (Jun 11–12) as the stash grows.
2. **Embed queue backlog:** 9,990 embeddings logged as "entry deleted between queue and write" on Jun 11 — large transient churn competing with consolidation writes.
3. **Single global lock:** The improve process uses one lock for all processes (consolidate, reflect, distill, memoryInference, graphExtraction). A long consolidation pass during the 2am window blocks reflect and distill from starting. Quick-shredder passes fire every 15 min and collide with the daily run, causing `database is locked` failures that extend overall job duration.

The quick-shredder `improve_failed` cluster (01:17, 04:17, 04:32, 04:47, 05:17 on Jun 12) shows the 900s timeout is already being hit. The Jun 11 07:00 UTC run at 1,083s exceeded the timeout ceiling entirely.

---

## 2. IMMEDIATE FIXES

### Fix 1: Delete the stale proposal (do this right now)

```bash
akm proposal reject 0a836a40-b001-448f-93b1-610bd4be0aac
# or directly:
akm proposal delete 0a836a40-b001-448f-93b1-610bd4be0aac
```

This eliminates 1 validation failure per 15-min run across all profiles. Every run currently burns time attempting to promote this proposal and failing.

### Fix 2: Repair the corrupt config (do this right now)

```bash
# Edit ~/.config/akm/config.json
# Change both occurrences of:
#   "applyMode": "auto"
# To:
#   "applyMode": "promote"
# in profiles.improve.thorough.processes.triage
# and profiles.improve.quick-shredder.processes.triage
```

Verify with:
```bash
akm config validate
```

This stops the `INVALID_CONFIG_FILE` startup failure that silently drops ~1 extract run/day and prevents the cascade of `discord-wiki-articles-ingest` errors.

### Fix 3: Fix the broken catchup cron

The `akm-improve-catchup` task has schedule `0 4 1 1` which fires on January 1 only. Either:
- Fix to `0 4 * * 1` (every Monday 4am), or  
- Disable it entirely (it is currently dead weight)

**Recommended: Disable.** The new reflect-distill task (Fix 5) covers its intent.

### Fix 4: Reduce `incrementalSince` from 4h to 1h

In `~/.config/akm/config.json`, update the `quick-shredder` profile:

```json
"consolidate": {
  "enabled": true,
  "incrementalSince": "1h",
  "maxChunkSize": 35,
  "minPoolSize": 10
}
```

A 1h window limits each promotion to 4 consecutive passes (vs 16 with 4h). With `NEIGHBORS_PER_CHANGED=5` and ~40 promotions per extract hour, a 1h window yields ~240 candidates max vs ~600 today — a 4x reduction in plateau duration and total daily consolidation work.

### Fix 5: Revert extract cadence to 20-min

Update the `akm-extract` cron task schedule from `7 * * * *` to `8,28,48 * * * *`. The 20-min cadence was the correct operating point (per `project_akm_extract_cadence_20min.md`). The hourly reversion to reduce Shredder load is counterproductive — it collapses proposal throughput, starves triage, and inflates session-to-reflect latency.

### Fix 6: Add `minPoolSize: 10` guard to quick-shredder consolidate

Without a minimum pool guard, quick-shredder runs consolidation even when 0–1 memories were modified. On Jun 12, ~60% of runs had `processed < 5`. The `minPoolSize: 10` guard skips the Shredder LLM call entirely when the incremental pool is below threshold, reducing lock hold time and GPU load on quiet passes.

---

## 3. OPTIMAL PROFILE CONFIGURATIONS

### Profile: `quick-shredder` (every 15 min)

**Purpose:** Fast consolidation + memory inference + triage drain. No reflect/distill (handled by dedicated reflect-distill passes).

```json
"quick-shredder": {
  "processes": {
    "extract": {
      "enabled": false
    },
    "consolidate": {
      "enabled": true,
      "mode": "llm",
      "profile": "qwen-9b-shredder",
      "incrementalSince": "1h",
      "maxChunkSize": 35,
      "minPoolSize": 10,
      "neighborsPerChanged": 3
    },
    "memoryInference": {
      "enabled": true,
      "mode": "llm",
      "profile": "qwen-9b-shredder",
      "minPendingCount": 5
    },
    "reflect": {
      "enabled": false
    },
    "distill": {
      "enabled": false
    },
    "triage": {
      "enabled": true,
      "applyMode": "promote",
      "policy": "personal-stash",
      "maxAcceptsPerRun": 20,
      "judgment": {
        "mode": "llm",
        "profile": "qwen-9b-shredder"
      }
    },
    "graphExtraction": {
      "enabled": false
    }
  },
  "sync": {
    "enabled": false
  }
}
```

**Key changes from current:**
- `incrementalSince: "1h"` (was `"4h"`) — 4x fewer redundant passes per promotion event
- `maxChunkSize: 35` (was `25`) — 28% fewer LLM calls per pass, within qwen-9b 131k context
- `minPoolSize: 10` (new) — skip Shredder call on quiet passes
- `neighborsPerChanged: 3` (was `5` hardcoded) — 40% candidate reduction per burst
- `memoryInference.minPendingCount: 5` (new) — skip LLM call when <5 truly pending (currently ~26 pending, so this rarely fires but prevents pure no-op lock acquisition)
- `triage.applyMode: "promote"` (was `"auto"` — invalid) — fixes config corruption
- `reflect: disabled`, `distill: disabled` — these belong in the reflect-distill profile

---

### Profile: `reflect-distill` (new — 4x/day)

**Purpose:** Daytime reflect + distill passes. Fills the 22h gap. No consolidation (handled by quick-shredder).

```json
"reflect-distill": {
  "processes": {
    "extract": {
      "enabled": false
    },
    "consolidate": {
      "enabled": false
    },
    "memoryInference": {
      "enabled": true,
      "mode": "llm",
      "profile": "qwen-9b-shredder"
    },
    "reflect": {
      "enabled": true,
      "mode": "llm",
      "profile": "qwen-9b-shredder",
      "allowedTypes": ["agent", "command", "knowledge", "lesson", "memory", "skill", "wiki", "workflow"],
      "limit": 25
    },
    "distill": {
      "enabled": true,
      "mode": "llm",
      "profile": "qwen-9b-shredder",
      "allowedTypes": ["memory"],
      "requirePlannedRefs": true
    },
    "triage": {
      "enabled": true,
      "applyMode": "promote",
      "policy": "personal-stash",
      "maxAcceptsPerRun": 15,
      "judgment": {
        "mode": "llm",
        "profile": "qwen-9b-shredder"
      }
    },
    "graphExtraction": {
      "enabled": false
    }
  },
  "sync": {
    "enabled": false
  }
}
```

**Key design decisions:**
- `reflect.limit: 25` — bounds LLM cost per run (~25 × 45s = ~19 min max). Prevents a backlog from causing a single pass to run 2h.
- `distill.requirePlannedRefs: true` — **critical fix for the 689 distill-skipped issue**. Distill should only run when reflect has produced `plannedRefs`. If this config key doesn't exist yet, implement it (see Section 5). Until then, set `distill.enabled: false` in this profile to avoid burning GPU on 98%+ skip-rate passes.
- `consolidate: disabled` — no competition with quick-shredder's 15-min consolidation cadence
- `graphExtraction: disabled` — nightly only
- `memoryInference: enabled` — reflect often produces candidates that should immediately feed inference; running it here avoids a 15-min lag

---

### Profile: `default` (nightly 2am)

**Purpose:** Full-corpus sweep — graph refresh, full consolidation, any overflow from daytime passes.

```json
"default": {
  "processes": {
    "extract": {
      "enabled": false
    },
    "consolidate": {
      "enabled": true,
      "mode": "llm",
      "profile": "qwen-9b-shredder",
      "incrementalSince": null,
      "maxChunkSize": 35,
      "limit": 500
    },
    "memoryInference": {
      "enabled": true,
      "mode": "llm",
      "profile": "qwen-9b-shredder"
    },
    "reflect": {
      "enabled": true,
      "mode": "llm",
      "profile": "qwen-9b-shredder",
      "allowedTypes": ["agent", "command", "knowledge", "lesson", "memory", "skill", "wiki", "workflow"],
      "limit": 100
    },
    "distill": {
      "enabled": true,
      "mode": "llm",
      "profile": "qwen-9b-shredder",
      "allowedTypes": ["memory"],
      "requirePlannedRefs": true
    },
    "triage": {
      "enabled": true,
      "applyMode": "promote",
      "policy": "personal-stash",
      "maxAcceptsPerRun": 50,
      "judgment": {
        "mode": "llm",
        "profile": "qwen-9b-shredder"
      }
    },
    "graphExtraction": {
      "enabled": true,
      "mode": "llm",
      "profile": "qwen-9b-shredder"
    }
  },
  "sync": {
    "enabled": false
  }
}
```

**Key changes from current:**
- `extract: disabled` — akm-extract runs at 01:57 (new schedule), so nightly improve starts with a pre-populated proposal queue. Disabling internal extract prevents double-extraction at 2am.
- `consolidate.limit: 500` — bounds the nightly full sweep. With 4x daytime reflect+distill passes draining the reflect backlog, the nightly sweep's consolidation load will be substantially smaller. The `limit: 500` prevents the 1,083s Jun 11 spike from recurring.
- `reflect.limit: 100` — the daytime passes handle most reflect work; nightly catches overflow
- `triage.maxAcceptsPerRun: 50` — nightly can afford aggressive triage since it runs uncontested
- **No `incrementalSince`** — nightly does a proper full-pool sweep for contradiction/merge detection that incremental passes miss

---

### Profile: `thorough` (manual/catchup use only)

```json
"thorough": {
  "processes": {
    "extract": { "enabled": true, "lookbackDays": 7 },
    "consolidate": {
      "enabled": true,
      "mode": "llm",
      "profile": "qwen-9b-shredder",
      "incrementalSince": null,
      "maxChunkSize": 35
    },
    "memoryInference": { "enabled": true, "mode": "llm", "profile": "qwen-9b-shredder" },
    "reflect": {
      "enabled": true,
      "mode": "llm",
      "profile": "qwen-9b-shredder",
      "allowedTypes": ["agent", "command", "knowledge", "lesson", "memory", "skill", "wiki", "workflow"]
    },
    "distill": {
      "enabled": true,
      "mode": "llm",
      "profile": "qwen-9b-shredder",
      "allowedTypes": ["memory", "lesson", "knowledge"]
    },
    "triage": {
      "enabled": true,
      "applyMode": "promote",
      "policy": "personal-stash",
      "maxAcceptsPerRun": 100,
      "judgment": { "mode": "llm", "profile": "qwen-9b-shredder" }
    },
    "graphExtraction": { "enabled": true, "mode": "llm", "profile": "qwen-9b-shredder" }
  }
}
```

**Fix applied:** `triage.applyMode: "promote"` (was `"auto"` — invalid enum, caused `INVALID_CONFIG_FILE`).

---

## 4. OPTIMAL CRON SCHEDULE

### Full Replacement Schedule

| Task | Old Schedule | New Schedule | Profile | Change |
|------|-------------|--------------|---------|--------|
| `akm-extract` | `7 * * * *` | `8,28,48 * * * *` | — | Revert to 20-min cadence |
| `akm-improve-quick` | `2,17,32,47 * * * *` | `4,19,34,49 * * * *` | `quick-shredder` | Shift +2 min for extract gap |
| `akm-improve-frequent` | DISABLED (`45 */6`) | `45 */4 * * *` | `reflect-distill` | RE-ENABLE, new profile, 4h cadence |
| `akm-improve-daily` | `15 2 * * *` | `15 2 * * *` | `default` | Keep; updated profile above |
| `akm-improve-consolidate` | DISABLED (`30 */4`) | DISABLED | — | Keep disabled; quick-shredder handles this |
| `akm-improve-catchup` | BROKEN (`0 4 1 1`) | DISABLED | — | Remove; broken cron expression |
| `akm-graph-refresh-weekly` | `0 3 * * 0` | `0 3 * * 0` | — | Keep; nightly default now avoids Sunday overlap |
| `akm-health-report` | `0 * * * *` | `3 * * * *` | — | Shift +3 min to avoid :00 collision |

### Schedule Timeline (per hour, visual)

```
:03  → akm-health-report       (fast, no Shredder)
:04  → akm-improve-quick       (consolidate+memInfer+triage, ~15-60s)
:08  → akm-extract             (session extraction, ~7-200s)
:19  → akm-improve-quick
:28  → akm-extract
:34  → akm-improve-quick
:45  → akm-improve-frequent    (reflect+distill, 4h cadence only — at :45 on hours 0,4,8,12,16,20)
:48  → akm-extract
:49  → akm-improve-quick
```

**2am window (nightly):**
```
01:57 → akm-extract            (pre-populate proposal queue before nightly improve)
02:15 → akm-improve-daily      (full-corpus sweep; extract disabled in profile)
03:00 → akm-graph-refresh-weekly (Sunday only)
```

### Overlap and Conflict Analysis

**Extract → Quick gap:** New schedule gives a 4-min gap between `akm-extract` completing (at :08, :28, :48) and the next `akm-improve-quick` starting (at :19, :34, :04 next). Extract median is ~50s, p95 ~200s — the 11-min gap is adequate. The +2-min shift from `:17/:32/:47/:02` to `:19/:34/:49/:04` is the key change.

**Reflect-distill vs quick-shredder:** The `reflect-distill` task fires at `:45` on every 4th hour. A `quick-shredder` run at `:49` could collide if `reflect-distill` runs long (p95 unknown but `reflect.limit=25` bounds it). Use `--skip-if-locked` on quick-shredder. The reflect-distill profile should use a **60-min stale lock threshold** (vs 20-min for quick-shredder) since a legitimate `reflect.limit=25` pass can run 20+ min.

**Nightly window:** Extract at 01:57 ensures fresh proposals are indexed by 02:10 when the daily improve starts at 02:15. The 18-min gap is generous. `extract: disabled` in the `default` profile prevents the prior double-extraction pattern.

**Sunday overlap:** `akm-improve-daily` ends by ~02:55 (conservatively; 843s = 14 min from 02:15). `akm-graph-refresh-weekly` starts at 03:00. 5-min gap is tight. If the daily run runs long, add `--skip-if-locked` to the graph refresh, or shift graph refresh to `3:30 * * 0`.

### Expected Shredder GPU Load

| Time window | Source | Approx LLM time/hr |
|-------------|--------|-------------------|
| Off-peak (most hours) | 4× quick-shredder/hr + 3× extract/hr | 2–8 min/hr active |
| Every 4h at :45 | reflect-distill pass (25 items × 45s) | +19 min active |
| 02:15–02:55 nightly | Full default profile | 40 min contiguous |

Total estimated Shredder utilization: ~15–25% on average, 85–95% during nightly window. GPU is not saturated; the nightly window is the only sustained load period. This is a healthy utilization profile for a background pipeline.

---

## 5. ARCHITECTURAL RECOMMENDATIONS

### Near-term (1–2 weeks)

**A. Fix the distill `requirePlannedRefs` gate (highest ROI code change)**

The distill process generates ~689 `distill-skipped` per run because its candidate loop does not gate on `plannedRefs` produced by the reflect phase. Before enabling distill in the reflect-distill profile, add this guard in `src/commands/improve.ts` distill phase:

```typescript
// Before distill candidate loop:
if (config.distill.requirePlannedRefs && plannedRefs.length === 0) {
  log.debug('[distill] skipping — no plannedRefs from reflect phase');
  return { distillSkipped: 0, distillCompleted: 0 };
}
```

This eliminates the GPU waste on 98%+ skip-rate passes and makes distill meaningful when it runs.

**B. Make `NEIGHBORS_PER_CHANGED` configurable**

The hardcoded `5` in `narrowToIncrementalCandidates` is the primary amplification factor. Surface it as `consolidate.neighborsPerChanged` in the profile config with `default: 5`. Set `quick-shredder` to `3`, keep `default` profile at `5`. This is a single-line config change with a 40% candidate reduction for quick passes.

**C. Fix the `journal.jsonl` session ID collision**

All 166 `journal.jsonl` subagent workflow files map to `sessionId='journal'`. Options in priority order:
1. Exclude files named `journal.jsonl` at the path-scan stage before they reach the LLM (saves ~166 LLM calls per run)
2. Assign unique IDs using the parent workflow ID: `sessionId = 'journal-' + workflowId`

Option 1 is a 5-line change in the extract harness path scanner.

**D. Expand `consolidate_completed` event schema**

The event currently only stores `{processed, merged}`. Add: `{processed, merged, deleted, contradicted, failedChunks, durationMs}`. Without these fields, the Jun 12 contradiction spike (253 reported) cannot be verified from the DB, and per-run contradiction cascade detection is impossible. This is a critical observability gap that makes future debugging substantially harder.

**E. Fix the extract prompt `description` field instructions**

Add explicit negative examples to the extract LLM prompt template:

```
DESCRIPTION FIELD RULES:
- Write as a complete sentence in active voice
- Do NOT start with "When", "If", "How", "Use", "Avoid"
- Do NOT end with ":", ";", or ","
- Do NOT use single-word or heading-fragment text ("Summary", "Overview", "Key finding:")
- Minimum 10 words, maximum 150 words
```

The `descriptionQualityValidator` reject rules in `proposal-quality-validators.js` should be the canonical reference; mirror them in the prompt.

---

### Medium-term (1–2 months)

**F. Replace timestamp-based `incrementalSince` with content-hash session ledger**

The current `incrementalSince` logic is clock-dependent and brittle (demonstrated by the Jun 11–12 double-extraction and over-throttle incident). Replace with a content-hash ledger: hash each session's content at extract time, store the hash alongside the `session_id` in `extract_sessions_seen`. On subsequent runs, compare hashes rather than timestamps. This makes extraction idempotent across config changes, restarts, and clock skew. The `shouldSkipAlreadyExtractedSession` function becomes `sessionContentUnchangedSince(hash)`.

**G. Add pool-saturation advisory to `akm health`**

Track `(total_unseen / total_sessions)` as a separate metric. Surface an informational advisory when `< 10%` (steady-state, expected) vs a warning advisory when `< 2%` (potential pool exhaustion from a bug). The current alert on raw `sessionsScanned` count is misleading — it fires on normal cadence changes and post-burst normalization.

**H. Implement hot-probation buffer before long-term promotion**

Based on the SEDM/MemTier pattern: new extracted facts spend one consolidation cycle in a `captureMode: hot-probation` state before being promoted to the main stash. During probation, a second pass checks for near-duplicates and quality. This prevents noisy extractions from polluting long-term storage and would have caught the `lesson:invalid-api-key-persistence` phantom before it entered the queue.

**I. Decompose the global improve lock (highest long-term ROI)**

The single lock on `primaryStashDir` forces consolidate, reflect, distill, memoryInference, and graphExtraction to be mutually exclusive. Consolidate is disk-bound (DB write locks, ~15–16s), while reflect is GPU-bound (Shredder LLM calls, 60–300s). They access different resources and could run concurrently.

Proposed fine-grained lock decomposition:
- **`consolidate.lock`** — held during index.db write operations only
- **`reflect-distill.lock`** — held during proposal queue reads + LLM calls
- **`triage.lock`** — held during proposal promotion writes

This allows a quick-shredder consolidate pass to proceed even when a long reflect-distill run is in flight, eliminating the primary source of the current run duration spikes and timeout risk.

---

### Long-term (3–6 months)

**J. Tiered memory architecture (L1–L5)**

Organize the AKM stash into 5 semantic levels following the TiMem pattern:
- L1–L2: Raw session extractions and immediate facts
- L3–L4: Distilled patterns, recurring insights, project-specific knowledge
- L5: High-level user preferences and persistent behaviors

Quick-shredder passes query L3–L5 for triage relevance. Deep consolidation descends to L1–L2. Expected benefit: 40–60% reduction in per-pass retrieval token cost as most quick passes only need the high-abstraction layers.

**K. Event-driven extract triggering**

Replace the time-based `8,28,48` extract cron with filesystem event triggers (inotify on `~/.claude/projects/`). When a new session JSONL is written (conversation completed), trigger extract within 60s rather than waiting up to 20 min. Retain the `8,28,48` cron as a fallback for missed events (system downtime, etc.). This reduces session-to-extract latency from ~20 min to ~1 min and eliminates the feast/famine dynamic entirely.

---

## 6. MONITORING SIGNALS

### Green/Yellow/Red Thresholds

| Metric | Green | Yellow | Red | Action if Red |
|--------|-------|--------|-----|---------------|
| `consolidate.processedPerPass` | < 200 | 200–450 | > 450 | Increase `minPoolSize`; check `incrementalSince` |
| `consolidate.totalDailyProcessed` | < 3,000 | 3,000–8,000 | > 8,000 | Check for burst-window amplification |
| `validationFailed` per day | 0 | 1–5 | > 5 | Audit extract prompt; check for stale proposals |
| `improveQuick.failureRate` | < 2% | 2–5% | > 5% | Check Shredder load; DB lock contention |
| `improveQuick.p95Duration` | < 300s | 300–600s | > 600s | Timeout risk; reduce `maxChunkSize` or `minPoolSize` |
| `improveDaily.duration` | < 600s | 600–900s | > 900s | Consolidate `limit` needed; check reflect backlog |
| `reflectActionsPerDay` | > 50 | 20–50 | < 20 | Check reflect-distill task; check proposal queue |
| `distillActionsPerDay` | > 10 | 5–10 | < 5 | Check `requirePlannedRefs` gate; check reflect output |
| `sessionsScanned` per run (MAX) | > 10 | 5–10 | < 5 | Check extract cadence; check pool saturation |
| `unseen pool` (total_sessions − seen) | > 500 | 200–500 | < 200 | Pool saturation advisory; verify new sessions |
| `proposalQueueDepth` | < 50 | 50–150 | > 150 | Increase `maxAcceptsPerRun`; check judgment runner |
| `plannedRefs` per daily run | > 30 | 10–30 | < 10 | Check extract pipeline health |
| `contradictedBy` entries | < 10% of pool | 10–15% | > 15% | Audit contradiction cascade; check A-contradicts-B-and-B-contradicts-A pairs |
| `improveFailed` DB lock errors | 0 | 1–2/day | > 2/day | Check busy_timeout in cli.js; check lock preemption |

### Key Metric Semantics (avoid past mistakes)

**`sessionsScanned`** — Use `MAX(per-run)` for alerting, not `SUM`. The SUM is cadence-sensitive and will alarm on any schedule change.

**`consolidationProcessed`** — Emit as a per-run event field, not just a daily aggregate. Track `last/max` value, never `SUM` (it's a whole-stash recount).

**`validationFailed`** — Count unique proposal IDs that fail per day, not raw failure events. The stale `0a836a40` proposal inflates event count without representing new failures.

**`reflectActionsPerDay`** — This is the single most important leading indicator for pipeline health. A drop below 20/day means insights are not being synthesized regardless of whether consolidation looks healthy. Watch this number first.

### Post-Change Verification Checklist

After applying the fixes in Section 2 and the new schedule in Section 4, verify within 24 hours:

1. `lesson:invalid-api-key-persistence` proposal is gone from queue: `akm proposals list | grep 0a836a40` returns empty
2. No `INVALID_CONFIG_FILE` in any task log: `grep -r INVALID_CONFIG /path/to/task/logs`
3. Extract runs 3x/hr (not 1x): check akm-extract log for entries at :08, :28, :48
4. Quick-shredder `consolidate.processedPerPass` drops to 50–240 range (from 530–692)
5. Reflect-distill task fires at :45 on even 4h boundaries and shows `reflectActionsCompleted > 0`
6. `validationFailed` count drops to 0–2/day within 48h of stale proposal deletion
7. Daily improve run duration < 700s within 3 days of reflect backlog clearing

### Regression Alert: Watch for the `633ece41` Pattern

If `consolidate.mergesPerDay` drops from current baseline (check `akm health --window-compare`) to below 50% in a 3-day window, this indicates the `incrementalSince: 1h` change is too aggressive and incremental-only is collapsing recall (the June 5 over-throttle incident pattern). If this occurs, either:
- Raise `incrementalSince` to `2h`, or
- Re-enable `akm-improve-consolidate` as a weekly full-sweep task (not every 4h)

The nightly `default` profile with `incrementalSince: null` is the safety net that prevents total recall collapse, but `mergesPerDay` is the canary.