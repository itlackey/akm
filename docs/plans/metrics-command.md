# Plan: `akm metrics`

Status: implemented on `feature/metric-report` · 2026-10-08

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

The authoritative shape is `AkmMetricsResult` in `src/commands/metrics/types.ts`.
Its sections are: `window`, `filters`, `usage` (totals, select rate, search
median ms, daily series, top assets, top and zero-result queries, by source),
`feedback` (totals, by asset with valence, by tag, recent negatives), `utility`
(histogram, lowest/highest, never used), `outcomes`, `llm` (the health
`LlmUsageAggregate` plus `cost[]`), `index` (runs and median time), `tasks`,
`proposals`, `workflows`, optional `rows` (raw usage and LLM rows), and
`notes[]`.

Top-N lists are capped by `--top`. Rates are `null` when the denominator is 0,
never `NaN`.

## 4. Per-format rendering

All formats go through the existing `output("metrics", result)` path.

| Format | Rendering |
|---|---|
| `json` / `yaml` / `jsonl` | Serialization of the envelope (free). `rows` is present only under `--detail full` (see §5). |
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

### When `rows` is populated (decided)

The command includes `rows` whenever `getOutputMode().format === "html"` or
`--detail full`. Plain `akm metrics --format html --output metrics.html` gives
the full analyzable dashboard, and there is no extra flag. The shaper is a
passthrough: it never drops `rows` that the command chose to include.

## 6. Data access

Repositories hold the SQL; the command holds none.

- Result types are fixed in `src/commands/metrics/types.ts` (committed before the work items start).
- New `src/storage/repositories/metrics-repository.ts`, with read-only queries over `usage_events`, `events` (feedback only; LLM goes through health's reader), `asset_outcome` and workflow units.
  - **Time filtering must normalize `created_at`.** Compare `datetime(created_at)` against `datetime(?)` with the bound ISO value. A raw string compare against ISO is wrong, because a space sorts before `T`. The same bug in `purgeOldUsageEvents` is fixed by G6.
  - Day bucketing uses `substr(datetime(created_at),1,10)`.
- Utility goes in `index-utility-repository.ts`: a `listUtilityWithRefs(db)` that joins `entries` to get refs.
- Reuse, unchanged:
  - `readLlmUsageAggregate` (`health/llm-usage.ts`)
  - `queryTaskHistory` + `computeWallTimeStats` (`health/improve-metrics.ts`)
  - accept-rate (`health/accept-rate.ts`)
  - `computeValenceScore` (`improve/feedback-valence.ts`)
- Aggregation from rows to result is pure functions in `src/commands/metrics/collect.ts`, so it can be unit-tested without a DB.

## 7. Gaps in the stored data, and their fixes

Each gap was checked against the code. Fix items are listed in §8.

### G1. LLM usage covers only part of the calls

**Cause.** `emitLlmUsage` drops the record when no sink is installed
(`src/llm/usage-telemetry.ts:131`). Only `akm improve` (`improve.ts:249`) and
`akm proposal drain` (`proposal-cli.ts:549`) install one. Calls from `akm index`
memory inference, curate, workflow and agent dispatch, and `akm command run`
are never stored.

**Fix (item `llm-sink`).**
- `runCli` (`src/cli.ts:1055`) installs `installLlmUsagePersistenceIfAbsent()` once per process and disposes it in a `finally`.
- `installLlmUsagePersistence` saves the sink that was installed before it and **restores** it on dispose, instead of clearing. Improve's per-run sink (shared handle plus the `onRecord` heartbeat) therefore still wins inside a run, and the process-wide sink resumes afterwards.
- Add `getLlmUsageSink()` beside `setLlmUsageSink` for that.

No new event type and no schema change. Volume is one `events` row per LLM call, already purged by `improve.eventRetentionDays`.

### G2. Search and index timings are not persisted

**Cause.** `timing` exists only in the command output (`search.ts:177-287`,
`indexer.ts:802`).

**Fix (item `timing`).**
- Search: add `totalMs` (plus `rankMs` and `embedMs` when present) to the existing search **summary** `usage_events` row's metadata (`search.ts:398`). No new row, no new table. The total covers the whole search, and the usage write happens after the result is computed, so pass the timing into `logSearchEvent`.
- Index: append one `index_completed` event (`{mode, totalMs, walkMs, llmMs, embedMs, ftsMs, finalizeMs}`) when an index run finishes (`indexer.ts`, beside the returned `timing`), and add the type to the `events.ts` union.

### G3. Usage lost on a fresh install: **not a real gap, no change**

`withStateDbTelemetry` skips when `state.db` is missing, but every caller first
calls `appendEvent` (`search.ts:370`, `curate.ts:154`, `show-usage.ts:45`, and
via `appendShowTrace` for `recordIndexedShowUsage`). `appendEvent` opens
`state.db` through `withStateDb`, which creates and migrates it. By the time the
usage write runs, the file exists. The only remaining skip is a read-only data
dir, where nothing can be written anyway.

### G4. The retention window silently truncates long `--since` windows

**Cause.** `usage_events` is kept for 90 days (`USAGE_EVENT_RETENTION_DAYS`) and
`events` for `improve.eventRetentionDays` (default 90). A 180-day window shows
only 90 days with no indication.

**Fix (in item `metrics-core`).** When `since` is older than `now − retention`
for either store, push a `notes[]` entry naming the store, its retention, and
the effective start. No retention change.

### G5. No cost data

**Cause.** Nothing in config or the records carries a price.

**Fix (in item `metrics-core`).**
- Optional `engines.<name>.pricing: { inputPerMillion: number, outputPerMillion: number, currency?: string }` (non-negative finite, currency defaults to `"USD"`) on both LLM and agent engine schemas (`src/core/config/schema/engines.ts`). Add a doc line in `docs/reference/configuration.md`. Regenerate `schemas/` with `bun scripts/gen-config-schema.ts`.
- `akm metrics` computes `llm.cost[]` at report time from `llm.byEngine` × pricing: completion tokens are charged at the output rate and reasoning tokens are not charged separately (they are part of completion).
- Nothing is persisted, so changing a price re-prices history.
- Engines without pricing are omitted, not shown as zero.

### G6. The usage purge boundary is off by up to a day

**Cause.** `purgeOldUsageEvents` (`src/indexer/usage/usage-events.ts:199`) runs
`created_at < <ISO cutoff>`. `created_at` is `YYYY-MM-DD HH:MM:SS`, and a space
sorts before `T`, so every row on the cutoff's date compares as older and is
deleted, up to 24 h early.

**Fix (item `purge-fix`).** `WHERE datetime(created_at) < datetime(?)`. Add a
test with a row 1 h newer than the cutoff on the same date: it must survive.

## 8. Work items

The items are built to be independent. Each one owns its files, and all of them
build on the types in §3 / `src/commands/metrics/types.ts`. CHANGELOG bullets
may conflict at merge; the integrator keeps every one of them.

| Key | Title | Owns |
|---|---|---|
| `llm-sink` | Persist LLM usage for every command (G1) | `src/llm/usage-persist.ts`, `src/llm/usage-telemetry.ts`, `src/cli.ts` (`runCli` only), `tests/integration/llm/llm-usage-persist.test.ts` |
| `timing` | Persist search and index timings (G2) | `src/commands/read/search.ts` (usage summary row only), `src/indexer/indexer.ts`, `src/core/events.ts` (type union), tests |
| `purge-fix` | Fix the usage purge boundary (G6) | `src/indexer/usage/usage-events.ts`, test |
| `metrics-core` | `akm metrics` command, data collection, JSON/YAML, G4 notes, G5 pricing | `src/commands/metrics/{metrics-cli,collect}.ts`, `src/storage/repositories/metrics-repository.ts`, `index-utility-repository.ts` (one new reader), engine schema + `schemas/`, `src/cli.ts` `subCommands` + output registry passthrough shaper, `docs/reference/{cli,configuration,data-and-telemetry}.md`, hints, tests |
| `metrics-text-md` | text and md renderers | `src/output/text/metrics.ts` + its registration, `src/commands/metrics/md-report.ts` + `registerMdRenderer`, tests on fixture `AkmMetricsResult`s |
| `metrics-html` | HTML dashboard (§5) | `src/assets/templates/html/metrics.html`, `src/commands/metrics/html-report.ts` (`renderMetricsHtml`), `src/output/html-render.ts` (embedded template), `src/cli/shared.ts` html case, tests on fixture results |

Item notes:
- `metrics-text-md` and `metrics-html` render from fixture `AkmMetricsResult` objects in their tests and do not depend on `metrics-core` code. Wiring them into `output()` uses the command name `"metrics"`, which `metrics-core` registers. If the name registry rejects an unknown name before integration, add the registration line in your item as well; the integrator dedupes it.
- `metrics-core` reuses `readLlmUsageAggregate`, `computeAcceptRateBySource`, `queryTaskHistory`, `computeValenceScore` and `parseHealthSince`. It does not copy them.
- `metrics-html`: there are no external scripts except the ECharts tag from `buildEchartsTag` (export it from `health/html-report.ts` instead of copying the URL). The JSON island escapes `<` as `\u003c`. The builder never reads the clock. Rows over 50,000 are cut to the most recent 50,000, with a note.

Test placement follows AGENTS.md: anything that opens a real DB goes under
`tests/integration/`, and pure aggregation/rendering goes under `tests/`.

## 9. Found while verifying end to end

Running the command against a real data dir turned up three defects, each
fixed with a test or a browser check:

- `select` events store the ref as typed (often bundle-less), while
  `usage_events` stores `bundle//conceptId`, so one asset appeared as two rows
  and `--bundle` dropped its selects. Selects are now resolved to the durable
  ref the way `--ref` is, then filtered.
- `usage_events.created_at` has one-second resolution, so a row written during
  the window end's own second (`--until` defaults to now) was excluded. The
  exclusive bound is rounded up to the next whole second.
- The dashboard timeline drew nothing for a one-day window: a stacked area
  with hidden symbols has no visible mark for a single point. One day now
  renders as a stacked bar.
