# `akm health` enhancement roadmap

> **Status (May 2026):** All three phases shipped on `release/0.8.0`.
> Phase 1 added the rich `ImproveHealthMetrics` shape sourced from
> `improve_runs.result_json`; Phase 2 added `--detail per-run`;
> Phase 3 added `--window-compare` / `--windows`. The bash analysis
> toolkit at `scripts/improve-stats/` that this work superseded has
> been removed. This doc is retained as historical context for the
> design decisions.

## Background

`akm health` was originally built around the `events` table
(`improve_completed` events with denormalized metadata fields). 0.8.0
introduced the `improve_runs` table as the authoritative store for run
envelopes. Phase 1 switched the health command to that source and added
fields the previous denormalization couldn't surface: distill outcome
splits, reflect outcome splits, memory-inference yield, consolidation
promoted/merged/deleted, graph entity/relation counts and cache rates,
and wall-time stats from `task_history`.

What Phase 1 doesn't add: per-run granularity, window comparisons.

## Phase 2 — `--detail per-run` (≈80 LOC)

### Goal

Make `akm health` capable of emitting per-run rows in addition to the
window aggregate, so external tools (CI dashboards, ad-hoc analysis,
the akm-improve runbook in the stash) don't need to query `state.db`
directly to get per-run breakdowns.

### Shape

```bash
akm health --since 24h --detail per-run --format json
akm health --since 24h --detail per-run --format md
```

### Result envelope

Add an optional `runs` field at the top level when `--detail per-run`
is set. Same window filter as today; one element per `improve_runs`
row.

```ts
interface AkmHealthResult {
  // ... existing fields ...
  runs?: ImproveRunSummary[];   // present only when --detail per-run
}

interface ImproveRunSummary {
  id: string;
  startedAt: string;
  completedAt: string;
  wallTimeMs: number;
  ok: boolean;
  // Same shape per-run as the aggregate per-stage rollup —
  // reflect/distill/consolidate/memoryInference/graphExtraction etc.
}
```

The shape mirrors what `scripts/improve-stats/runs-detail` produces in
TSV form, but as structured JSON.

### Implementation notes

- New helper alongside the Phase 1 aggregator. Same `improve_runs` query,
  no aggregation step — project each row directly.
- TSV/MD format renderers borrow from `runs-detail`'s output shape.
- `--detail` is enum-typed (`brief`, `per-run`, `verbose`) for future
  expansion. `brief` (default) preserves current behavior.

### Deprecation candidates

Once Phase 2 lands, `scripts/improve-stats/runs-detail` and `runs-list`
become thin shims that just call `akm health --detail per-run --format json`
and pipe through column formatting. They could either:

1. Stay as convenience wrappers (lowest risk)
2. Get deleted with a note pointing at `akm health --detail per-run`
3. Be retired in favor of native completions on the new flag

Recommend option 1 for now; revisit after a usage window.

## Phase 3 — window comparison (≈150 LOC)

### Goal

Native multi-window comparison so the A/B trend analysis I drove
manually for the gemma→qwen and PR-1-extension rollouts becomes one CLI
call instead of a bash + jq pipeline.

### Shape

Two argument forms — pick one or support both:

```bash
# Form A: shorthand for current vs prior window
akm health --window-compare 24h            # 24h vs the 24h before it

# Form B: explicit windows
akm health --windows 'name=baseline,since=2026-05-22T00:00:00Z,until=2026-05-23T16:30:00Z' \
           --windows 'name=post-fix,since=2026-05-24T15:00:00Z'
```

### Result envelope

```ts
interface AkmHealthResult {
  // ... existing fields when not in window-compare mode ...
  windows?: Array<{
    name: string;
    since: string;
    until?: string;
    metrics: HealthMetrics;
    improve: ImproveHealthMetrics;   // the Phase-1 rich shape
  }>;
  deltas?: {
    // Highlight metrics that moved meaningfully between window 0 and window N.
    // Keyed by dotted path: e.g. "improve.actions.reflect.failed"
    [path: string]: { from: number; to: number; pct: number };
  };
}
```

### Implementation notes

- Aggregator from Phase 1 already takes `since/until`; just call it N
  times with the user-supplied windows.
- `deltas` is computed by walking the metric tree once both windows are
  populated. Filter to "interesting" deltas — drop fields where both
  windows are 0 or where the change is < ε.
- Markdown rendering produces a side-by-side comparison table.

### Use cases this unlocks

- **Pre/post deploy verification**: `akm health --window-compare 1h`
  immediately after a deploy, looking for distill `llmFailed` rate
  changes.
- **Trend regression alerts**: cron-driven `akm health --window-compare 24h`
  that pipes through `jq` to detect when a stage's failure rate grows
  > X% between adjacent days.
- **Release notes**: capture the comparison output verbatim into release
  notes when an LLM/profile change ships.

### Deprecation candidates

Same as Phase 2 — the bash window-comparison pipeline I built in the
2026-05-24 incident becomes redundant.

## Out of scope (deliberately)

- **Real-time streaming metrics.** `akm health` stays a point-in-time
  snapshot. If a streaming dashboard ever becomes a need, build it as a
  separate command.
- **Custom aggregation expressions.** Don't ship a query DSL. The fields
  are fixed; if a consumer wants something custom, they query
  `improve_runs.result_json` directly.
- **Cross-machine aggregation.** All metrics are local to one stash /
  one state.db.

## Sequencing rationale

Phase 1 is the smallest unit that delivers value on its own — every
metric I needed for the 2026-05-24 incident analysis becomes one
command. Phase 2 is mostly mechanical and can land within a week.
Phase 3 is a nice-to-have for sustained trend analysis but the bash
form is fine for occasional ad-hoc work; defer until there's a
specific need (e.g., adding it to a runbook or a CI check).
