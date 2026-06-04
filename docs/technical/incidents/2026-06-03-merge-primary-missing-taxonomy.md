# Incident + Reference: `merge_primary_missing` Taxonomy and Investigation Guide

**Documented:** 2026-06-03  
**AKM version:** 0.8.0-rc.13 (`release/0.8.0` @ a853de4)  
**Severity:** Medium — inflated skip metrics, wasted LLM secondary charges, misleading health dashboards

---

## Background

`merge_primary_missing` is emitted by Phase B of `akmConsolidate` when the
execution loop encounters a merge op whose primary ref is absent from
`memoryByRef`. This single skip reason historically covered three distinct
failure modes, making it impossible to distinguish a latent bug from normal
behavior in health metrics. As of `a853de4` all three modes have either been
fixed or given their own observable signal.

---

## Three Root Causes — History and Status

### 1. Stale DB Entries (fixed — commit `d34bc1a`)

**What happened:** A prior improve run deleted files (merge + delete ops) but
`akmConsolidate` did not call `akm index` before returning. The DB retained
entries for files that no longer existed on disk. On the next run,
`loadMemoriesForSource()` returned those ghost entries. The LLM saw them in
chunk prompts and generated merge plans against refs that had no file. Phase B
hit `!memoryByRef.has(primary)` and fired `merge_primary_missing`.

**Fix:** Pre-flight filter at line ~1049 of `consolidate.ts`:
```typescript
memories = memories.filter((m) => fs.existsSync(m.filePath));
```
Run before chunking; stale DB entries never reach the LLM.

**How to confirm this was the cause:** Check the pre-flight warning in the run
log:
```
Pre-flight: filtered N stale DB entr(y|ies) (file absent on disk) from memory pool before chunking.
```
If `N > 0` and `merge_primary_missing` appears in the same run, the filter
did not catch all stale entries (possible race) — investigate `loadMemoriesForSource`.

**Steady-state:** `merge_primary_missing` from this path should be **0**.
Any non-zero count is a regression signal.

---

### 2. LLM Hallucinated Primary Ref (fixed — commit `a853de4`)

**What happened:** The LLM generated a merge plan whose primary ref did not
exist in the loaded memory pool — a hallucinated ref (e.g., blending a
`session` prefix with a checkpoint timestamp to produce a ref like
`memory:opencode-session-20260529T214550-ses_18a4` that has no corresponding
file or DB entry). Because `mergePlans()` did not validate refs against the
loaded pool, the op flowed to Phase B unchanged. There, `!memoryByRef.has(primary)`
fired, and `emitMergeFailureSkips` charged every real secondary in the op with
`merge_primary_missing` — typically 4–8 refs per hallucinated primary.

**Why it looked like stale-DB:** The skip reason was identical. Without the
pre-flight warning (which only fires for genuine stale DB entries), there was
no signal to distinguish the two paths.

**Fix:** `mergePlans()` now accepts `knownRefs: Set<string>` (built from the
already-filtered `memories` array). In the first pass:
- If `op.primary` is not in `knownRefs` → op is dropped with a warning, secondaries freed
- If a secondary is not in `knownRefs` → filtered from the op, real secondaries kept

The call site passes `new Set(memories.map(m => \`memory:${m.name}\`))`.

**How to confirm this was the cause:** Search the run log for:
```
mergePlans: primary <ref> not in loaded memory pool (LLM hallucination) — dropping op before execution.
```
The absence of a pre-flight stale-DB warning alongside a `merge_primary_missing`
count was the prior tell. Post-fix, hallucinated primaries never reach Phase B,
so `merge_primary_missing` cannot be inflated by this path.

**Steady-state:** `mergePlans` warnings appear at ~0–1/run when session
checkpoint clusters are in the same chunk window. Not a regression; just noise
from the LLM occasionally inventing a canonical session ref from nearby checkpoint
refs.

---

### 3. Intra-Run Cross-Chunk Race (residual — mitigated by Fix-A in `d34bc1a`)

**What happens:** An earlier op in the same run consumed a ref as a secondary
and successfully merged it. Fix-A (`memoryByRef.delete(secRef)`) pruned it from
`memoryByRef`. A later op in the same run's plan had independently listed that
same ref as its *primary*. Phase B finds `!memoryByRef.has(primary)` and fires
`merge_primary_missing`.

**Why it happens:** `mergePlans()` deduplication (second pass) handles
`secondary-also-a-primary` (removes from secondary list) but not
`primary-also-a-secondary-of-another-op` in all orderings. If the secondary-op
comes first in execution order, Fix-A prunes the ref, and the primary-op then
misses.

**Current status:** This is expected behavior when it fires at ≤2/run. It
means the LLM independently planned two ops that both needed the same ref in
different roles — the first op won. The ref was genuinely processed; the second
op's plan was simply redundant.

**How to identify vs. regression:** The Phase B comment now reads:
```
// fired when a prior op consumed this ref as a secondary and Fix-A pruned it
// from memoryByRef — NOT a hallucination (those are dropped by mergePlans)
```
Look for the warning:
```
Merge: primary <ref> not found in loaded memories (pruned by prior op this run) — skipping.
```
If you see this warning and `merge_primary_missing = N`, confirm N ≤ 2/run and
the refs are real memories (not hallucinated).

**Steady-state:** 0–2/run. Values above 2 warrant investigation of chunk plan
ordering.

---

## Metric Interpretation Guide

| Observation | Likely cause | Action |
|-------------|--------------|--------|
| `merge_primary_missing` suddenly spikes (>5/run) after a code change | Stale-DB filter regression — check pre-flight warning count | Read `consolidate.ts` pre-flight block; verify `fs.existsSync` filter is still applied before `chunking` |
| `merge_primary_missing` = 3–6 in one run, 0 in others | LLM hallucination (pre-fix) or intra-run race | Check log for `mergePlans: primary ... LLM hallucination` (new) or `pruned by prior op` (race) |
| Pre-flight warning: `filtered N stale DB entries` | Stale DB entries reached pre-flight — `d34bc1a` path working | Normal if N is small; investigate `loadMemoriesForSource` if N > 20 |
| `mergePlans` warning: `LLM hallucination — dropping op` | LLM invented a ref; `a853de4` filter working | Normal noise; if frequency grows, review chunk prompt quality |
| `merge_primary_file_gone` appears | Defense-in-depth fired: file deleted between pre-flight and Phase B execution | Race with external process or concurrent run; check for lock contention |

---

## Investigation Commands

```bash
# Find merge_primary_missing in a specific run
grep "merge_primary_missing\|not found in loaded\|LLM hallucination\|pruned by prior" \
  ~/.cache/akm/tasks/logs/akm-improve/<run-id>.log

# Check pre-flight stale filter output
grep "Pre-flight: filtered" \
  ~/.cache/akm/tasks/logs/akm-improve/<run-id>.log

# Query skip reason counts from DB for last 4h
# (use akm health --since=4h and read consolidation.skipReasons)
akm health --since=4h | jq '.improve.consolidation.skipReasons'

# Find which run(s) had merge_primary_missing this window
# (query improve_runs table, parse result_json.consolidation.skipReasons)
sqlite3 ~/.local/share/akm/state.db \
  "SELECT id, result_json FROM improve_runs WHERE started_at > datetime('now','-4 hours') AND dry_run=0;" \
  | python3 -c "
import json, sys
for line in sys.stdin:
    if '|' in line:
        rid, rjson = line.split('|', 1)
        res = json.loads(rjson)
        sr = res.get('consolidation',{}).get('skipReasons',[])
        hits = [s for s in sr if isinstance(s,dict) and s.get('reason')=='merge_primary_missing']
        if hits:
            print(rid, len(hits), 'hits:', [h.get('ref') for h in hits])
"
```

---

## Related

- `memory:akm-consolidation-failure-modes` — full skip reason taxonomy
- `memory:merge-missing-description-is-guard-ordering-bug` — the guard ordering fix
- `memory:akm-consolidate-stale-db-pattern` — stale DB pattern (commit `d34bc1a`)
- Commits: `d34bc1a` (stale-DB filter), `208fe06` (hot-guard ordering), `a853de4` (hallucination filter)
