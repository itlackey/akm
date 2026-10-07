# Plan: `akm metrics`

Status: proposed · 2026-10-07

## Goal

One read-only command, `akm metrics`, that reports what akm has already recorded
locally: asset usage (search / show / curate), feedback, derived utility, LLM
token and latency usage, task runs, proposal flow, and workflow token spend. It
renders properly in every `--format`. `--format html` produces a self-contained
dashboard that carries the window's data, so the viewer can filter, sort, drill
into an asset, and export rows from the browser.

Non-goals: collecting new data, changing retention, or changing how any score is
computed. The gaps listed at the end are follow-ups. This command only reads.

## 1. What akm stores today

All files live under the data dir (`AKM_DATA_DIR` > `$XDG_DATA_HOME/akm` >
`~/.local/share/akm`; `src/core/paths.ts:223`).

### 1.1 Asset usage: `state.db` `usage_events`

Table created by migration 020 (`src/core/state/migrations.ts:964`). Writer:
`insertUsageEvent` (`src/indexer/usage/usage-events.ts:100`), wrapped in
`withStateDbTelemetry` (best-effort, 250 ms busy timeout).

| Column | Notes |
|---|---|
| `event_type` | `search`, `show`, `curate`, `feedback` |
| `query` | search/curate query text |
| `entry_id` / `entry_ref` | index.db id (unstable) / durable `bundle//conceptId` |
| `signal` | `positive` / `negative`. Set only on feedback rows |
| `metadata` | JSON. search summary row: `{resultCount, stashHitCount, registryHitCount, resolvedCount, mode}`. feedback: `{signal, reason?, tags?, contentHash?, fix?}` |
| `source` | `user` / `improve` / `task` / `audit` / `unknown`, from `AKM_EVENT_SOURCE` |
| `created_at` | `datetime('now')`, so the format is `YYYY-MM-DD HH:MM:SS` UTC, **not ISO** |

Row patterns:
- `akm search` writes one summary row with no ref, plus one row per stash hit (top 50) (`src/commands/read/search.ts:387,398`).
- `akm curate` writes one summary row plus one row per item (`curate.ts:173,183`).
- `akm show` and command execution each write one row (`src/indexer/usage/show-usage.ts:75`).
- Feedback writes one row (`src/commands/feedback-cli.ts:213`).

Retention is 90 days, purged on every `akm index` (`usage-events.ts:189-205`).

### 1.2 Feedback

`akm feedback <ref> --positive|--negative [--reason] [--tag]…` writes to several
places:
- a `usage_events` row (above);
- an `events` row of type `feedback` (`feedback-cli.ts:780`), which is what improve reads;
- an online `utility_scores` update;
- `improve_review_needed` when utility drops below 0.5;
- a `proposals` row when a fix is attached.

**Nothing lists or aggregates feedback today.**

### 1.3 Utility: `index.db` `utility_scores`

One row per entry: `utility`, `show_count`, `search_count`, `select_rate`,
`last_used_at` (`src/storage/repositories/index-schema.ts:311`).
- Recomputed on `akm index` from user-source `usage_events` (`src/indexer/indexer.ts:1789`).
- Nudged online by feedback (`src/indexer/feedback/utility-policy.ts`).
- Read only by improve (eligibility, salience). Search ranking does not read it.

The table lives in the regenerable index, so it is keyed by `entry_id` and needs
a join to `entries` to get refs.

### 1.4 `state.db` `events` (append-only stream)

`{id, event_type, ts (ISO), ref, metadata_json}`. There are about 50 event
types; the full list is in `src/core/events-types.ts`. The ones useful for
metrics:

| Type | Metric |
|---|---|
| `search` / `show` / `select` | `select` = a show within 60 s of a search that returned the ref, with `rankPosition`. This is the only click-through signal |
| `feedback` | duplicate of the usage row, with the durable ref |
| `llm_usage` | per-call `{stage, process, engine, model, outcome, durationMs, prompt/completion/total/reasoningTokens, finishReason, errorCode}` |
| `promoted` / `rejected` / `proposal_*` / `triage_*` | proposal flow |
| `improve_invoked` / `_completed` / `_skipped` / `_failed` | improve cadence |
| `workflow_*` | workflow lifecycle |

Retention is `improve.eventRetentionDays` (default 90), purged by improve maintenance.

### 1.5 Other `state.db` tables with metric value

| Table | What it gives |
|---|---|
| `task_history` | per-run status, start/end, `metadata_json.durationMs`, failure `detail.reason` |
| `improve_runs` | per-run `metrics_json` (planned / accepted / rejected / skipped / error counts), `result_json.usageReport` |
| `proposals` | status × source. Accept rate by source |
| `asset_outcome` | per-asset `retrieval_count`, `negative_feedback_count`, `accepted_change_count`, `outcome_score` |
| `asset_salience` | per-asset `rank_score` and its components |
| `workflow_run_units` / `_unit_attempts` | `tokens`, runner, engine, model, timing |
| `extract_sessions_seen` | extract outcomes per harness |

`logs.db` `task_logs` holds raw log lines, not metrics, so it is out of scope.

### 1.6 What already reports parts of this

| Command | Covers | Does not cover |
|---|---|---|
| `akm log` | raw `events` rows, filtered | any aggregation |
| `akm health` (+ `--report --format html`) | LLM usage aggregate, improve pipeline, task fail rate, accept rate; ECharts dashboard | usage, feedback, utility, per-asset anything |
| `akm improve report` | LLM usage by process × engine × model | everything else |
| `akm tasks history`, `akm workflow status`, `akm proposal list` | raw rows | aggregation |

**Gap this command fills:** `usage_events`, feedback, `utility_scores`,
`asset_outcome` and `asset_salience` are never aggregated or shown anywhere.
`akm metrics` is the asset-centric view. It **reuses** health's existing
readers for LLM usage, task runs and accept rate instead of re-deriving them, so
the two commands cannot disagree.

## 2. Command surface

```
akm metrics [--since 30d] [--until <ts>] [--bundle <id>]... [--ref <ref>]
            [--source user|all|<source>] [--top 20]
            [--format json|yaml|jsonl|text|md|html] [--detail brief|normal|full] [--output <path>]
```

- Leaf command, registered in `src/cli.ts` `main.subCommands`, implemented in `src/commands/metrics/` (`metrics-cli.ts`, `collect.ts`, `types.ts`, `renderers.ts`, `html-report.ts`).
- `--since` uses health's `parseHealthSince` grammar (`24h`, `7d`, ISO). The default `30d` sits inside the 90-day retention.
- `--source` defaults to `user`, matching what utility and retrieval counts already use. `all` disables the filter.
- `--bundle` filters on the `entry_ref` / `ref` prefix `<bundle>//`. `--ref` narrows every section to one asset; short refs are resolved the same way `show` resolves them.
- Read-only. It opens `state.db` and `index.db` with the existing openers and no writes. A missing `index.db` gives an empty `utility` section with a `notes[]` entry. A missing `state.db` gives an all-empty result and exit 0.

## 3. Result shape (`schemaVersion: 1`)

```ts
interface AkmMetricsResult {
  schemaVersion: 1;
  window: { since: string; until: string };   // ISO
  filters: { source: string; bundles: string[]; ref?: string };
  usage: {
    totals: { searches; shows; curates; selects; zeroResultSearches; distinctAssets; distinctQueries };
    selectRate: number | null;                 // selects / searches with ≥1 hit
    daily: Array<{ day: string; search; show; curate; feedback }>;
    topAssets: Array<{ ref; shows; searchHits; selects; lastUsedAt }>;
    topQueries: Array<{ query; count; avgResults }>;
    zeroResultQueries: Array<{ query; count; lastAt }>;
    bySource: Record<string, number>;
  };
  feedback: {
    totals: { positive; negative };
    byAsset: Array<{ ref; positive; negative; valence; lastAt }>;  // valence = computeValenceScore
    byTag: Record<string, { positive; negative }>;
    recentNegative: Array<{ ref; reason?; tags?; at }>;
  };
  utility: {
    count: number;
    histogram: Array<{ bucket: string; count: number }>;   // 10 buckets 0..1
    lowest: Array<{ ref; utility; showCount; searchCount; selectRate; lastUsedAt }>;
    highest: Array<…same…>;
    neverUsed: number;                       // entries with no utility row
  };
  outcomes: { lowestOutcome: Array<{ ref; outcomeScore; retrievalCount; negativeFeedbackCount; acceptedChangeCount }> };
  llm: LlmUsageAggregate;                     // readLlmUsageAggregate (health/llm-usage.ts), unchanged
  tasks: { runs; failed; failRate; byTask: Array<{ taskId; runs; failed; medianMs }> };
  proposals: { byStatus: Record<string, number>; acceptRateBySource: … };   // health/accept-rate.ts
  workflows: { runs; byStatus; tokens; byModel: Record<string, number> };
  rows?: { usage: UsageRow[]; feedback: FeedbackRow[]; llm: LlmUsageRow[] };   // raw window rows, see §5
  notes: string[];
}
```

Top-N lists are capped by `--top`. Rates are `null` when the denominator is 0,
never `NaN`.

## 4. Per-format rendering

All formats go through the existing `output("metrics", result)` path.

| Format | Rendering |
|---|---|
| `json` / `yaml` / `jsonl` | Serialization of the shaped envelope (free). The shaper drops `rows` unless `--detail full`. |
| `text` | Registered text formatter in `src/output/text/metrics.ts`: aligned sections (Usage, Feedback, Utility, LLM, Tasks, Proposals, Workflows), top-N tables, with lists cut to 5 at `brief` and to `--top` at `normal`. |
| `md` | `registerMdRenderer("metrics", …)`: one heading per section, GFM tables. |
| `html` | Bespoke dashboard (§5). |

## 5. HTML dashboard

### Wiring

- Template: `src/assets/templates/html/metrics.html`, using `%%TOKEN%%` substitution through `renderHtml`.
- Add it to `EMBEDDED_TEMPLATES` in `src/output/html-render.ts` so the compiled binary works.
- In `src/cli/shared.ts`, the `html` case gains `metrics` beside `health`. Update the "only command with a bespoke HTML report" comments there, in `html-render.ts` and in `health/renderers.ts`.

### Data delivery

- The dashboard needs the window's raw rows to be analyzable. A JSON island carries them: `<script type="application/json" id="akm-data">`.
- Serialize with `<` escaped as `<`, so a query or reason containing `</script>` cannot break out of the island.
- All rendering happens client-side from that island, so filters re-aggregate without a re-run.
- Charts use ECharts from the same pinned CDN tag health uses (`buildEchartsTag`). Everything else is inline: vanilla JS, no framework.
- Size: rows are bounded by the window and retention. At an expected few hundred to tens of thousands of rows the page stays in the low-MB range. If `rows.usage` exceeds 50k, keep the most recent 50k and add a note. This is a degrade-with-warning, not an abort, per the Defensive Code rules.

### Layout

- **Header:** window, filters, generated-at, akm version.
- **KPI tiles:** searches, shows, select rate, zero-result rate, feedback ± with net valence, LLM tokens and calls, task fail rate.
- **Filter bar:** date-range brush on the timeline, bundle multiselect, source multiselect, event type toggles, and a free-text ref/query search. Every panel below re-derives from the filtered rows.
- **Usage over time:** stacked area per day for search, show, curate and feedback, with a brush.
- **Top assets:** sortable table (shows, search hits, selects, select rate, feedback ±, utility). Clicking a row opens an asset drawer with its timeline, its queries, its feedback reasons, and utility/outcome values.
- **Queries:** top queries and zero-result queries, sortable. Zero-result queries are the content-gap list.
- **Feedback:** positive/negative per day, a by-tag bar, and a recent-negative table with reasons.
- **Utility:** histogram, lowest/highest tables, never-used count.
- **LLM usage:** tokens by stage, process and engine, plus a calls/latency timeline from `rows.llm`.
- **Tasks / proposals / workflows:** compact cards from the aggregates.
- **Export:** "Download CSV" for the current filtered view of each table, done client-side with a Blob.
- **Display:** light/dark via `prefers-color-scheme`, matching health's CSS variables. Times are shown local through `<time data-iso>`, as health does.

### Determinism

Like health, nothing in the HTML builder reads `Date.now()`. `generatedAt` comes
from `window.until`, so identical input gives byte-identical output, which the
tests rely on.

### Open decision: when `rows` is populated

The raw rows ride in the envelope, and the shaper drops them below
`--detail full`. Plain `akm metrics --format html` therefore needs the rows
without the user also typing `--detail full`. There are two options:

- **Recommended:** the command includes `rows` when `getOutputMode().format === "html"` or detail is `full`. This is one line in the command.
- **Alternative:** follow health's precedent with an explicit `--report` flag. It is more consistent with health but adds a flag users must remember.

## 6. Data access

Repositories hold the SQL; the command holds none.

- New `src/storage/repositories/metrics-repository.ts`, with read-only queries over `usage_events`, `events` (feedback only; LLM goes through health's reader), `asset_outcome` and workflow units.
  - **Time filtering must normalize `created_at`.** Compare `datetime(created_at)` against `datetime(?)` with the bound ISO value. A raw string compare against ISO is wrong, because a space sorts before `T`. That same bug exists in `purgeOldUsageEvents` (`usage-events.ts:199`), which purges up to a day early. Note it for a separate fix; it is not part of this change.
  - Day bucketing uses `substr(datetime(created_at),1,10)`.
- Utility goes in `index-utility-repository.ts`: a `listUtilityWithRefs(db)` that joins `entries` to get refs.
- Reuse, unchanged:
  - `readLlmUsageAggregate` (`health/llm-usage.ts`)
  - `queryTaskHistory` + `computeWallTimeStats` (`health/improve-metrics.ts`)
  - accept-rate (`health/accept-rate.ts`)
  - `computeValenceScore` (`improve/feedback-valence.ts`)
- Aggregation from rows to result is pure functions in `src/commands/metrics/collect.ts`, so it can be unit-tested without a DB.

## 7. Implementation steps

| # | Step | Verify |
|---|---|---|
| 1 | Repository queries plus pure aggregators | unit tests on fixtures (aggregators); integration test against a seeded `state.db`/`index.db` (repository) |
| 2 | `metrics-cli.ts` + register in `cli.ts` + shaper (drop `rows` below full) | `bun test` on a new `tests/integration/commands/metrics.test.ts`: empty DB, seeded DB, `--bundle`, `--ref`, `--source`, `--since` boundaries |
| 3 | text and md renderers | snapshot tests at each detail level |
| 4 | HTML template + builder + `shared.ts` wiring + embedded template | token-completeness test (as health), `</script>`-in-query escaping test, determinism test, node-compat/compiled-binary template test |
| 5 | Docs: `docs/reference/cli.md`, `docs/reference/data-and-telemetry.md` (point at `akm metrics`), `src/assets/hints/cli-hints-{short,full}.md`, CHANGELOG | — |
| 6 | Gate | `bunx biome check --write src/ tests/`, `bun run check` green |

Test placement follows AGENTS.md: anything that opens a real DB goes under
`tests/integration/`, and pure aggregation/rendering goes under `tests/`.

## 8. Known gaps in the stored data (surface, don't fix here)

The dashboard states these in `notes[]` / a footer so numbers are not over-read:

1. **LLM usage covers only part of the calls.** It is persisted only while `akm improve` or `akm proposal drain` installs the sink (`src/llm/usage-telemetry.ts:131`). Index-time memory inference, curate, etc. are not counted.
2. **Search and index timings are not persisted**, so there are no latency metrics for search.
3. **Usage on a fresh install can be lost.** `withStateDbTelemetry` skips writes until `state.db` exists.
4. **Old data is purged.** `usage_events` and `events` are purged after about 90 days, so longer windows silently truncate. The command warns when `--since` exceeds the retention.
5. **No cost data exists.** Tokens are reported; dollars are not.
6. **The usage purge boundary is off by up to a day** (`created_at` format; see §6).

Each of these is a candidate follow-up issue, independent of this command.
