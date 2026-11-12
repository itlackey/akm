// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm metrics` — one read-only report over what akm has already recorded:
 * asset usage, feedback, utility, LLM usage, task runs, proposals and
 * workflow spend. This module reads the stores and hands the rows to the pure
 * aggregation in `collect.ts`; the shape is `AkmMetricsResult` (`types.ts`).
 *
 * Nothing is written, and nothing is migrated: `state.db` is opened read-only,
 * and one with migrations pending is skipped with a note. A missing `state.db`
 * gives an empty report and a missing `index.db` an empty utility section, each
 * with a note, never an error.
 */

import fs from "node:fs";
import { parseBundleRef } from "../../core/asset/asset-ref";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { readEvents } from "../../core/events";
import { emptyHistogram, histogramCount, mergeHistogram } from "../../core/metrics-histogram";
import { getDbPath } from "../../core/paths";
import { getStateDbPath, listPendingStateMigrations } from "../../core/state-db";
import { lookupBundleRefsReadonly } from "../../indexer/indexer";
import { indexRunsFromEvents, llmRowsFromEvents, toUsageRow } from "../../indexer/metrics/rows";
import { USAGE_EVENT_RETENTION_DAYS } from "../../indexer/usage/usage-events";
import { LLM_USAGE_EVENT } from "../../llm/usage-persist";
import type { OutputMode } from "../../output/context";
import { type Database, openDatabase } from "../../storage/database";
import { closeDatabase, openReadonlyExistingDatabase } from "../../storage/repositories/index-connection";
import { listUtilityWithRefs, type UtilityWithRef } from "../../storage/repositories/index-utility-repository";
import {
  countProposalsByStatus,
  listIndexCompletedEvents,
  listLowestOutcomeAssets,
  listSelectEvents,
  listUsageEventRows,
  type MetricsQueryFilter,
  type SelectEventRow,
  summarizeWorkflowRuns,
} from "../../storage/repositories/metrics-repository";
import {
  firstFoldedDay,
  metricsDbPathBeside,
  readLatencyHistograms,
  readLlmDaily,
  readQueryDaily,
  readSelectDaily,
  readTagDaily,
  readUsageDaily,
  rollupDayRange,
  withMetricsHistory,
} from "../../storage/repositories/metrics-rollup-repository";
import { queryTaskHistory } from "../../storage/repositories/task-history-repository";
import { applyReadonlyPragmas } from "../../storage/sqlite-pragmas";
import { parseHealthSince } from "../health";
import { computeAcceptRateBySource } from "../health/accept-rate";
import { addLlmRows, emptyLlmUsageAggregate, oldestTs, summarizeLlmUsage } from "../health/llm-usage";
import {
  buildMetricsResult,
  DEFAULT_EVENT_RETENTION_DAYS,
  type MetricsInput,
  type MetricsRollup,
  retentionNotes,
} from "./collect";
import type { AkmMetricsResult, MetricsLlmRow, MetricsUsageRow } from "./types";

export const DEFAULT_SINCE = "30d";
/** Cap on every ranked list. */
const TOP = 20;
/** Usage rows from people; improve, task and audit rows are akm's own reads. */
const SOURCE = "user";

export interface AkmMetricsOptions {
  /** Window start: `24h` / `7d` / ISO / epoch ms. Default `30d`. */
  since?: string;
  /** Attach the raw window rows (`--detail full`). */
  includeRows?: boolean;
  now?: () => number;
  /**
   * Resolve refs through a disposable copy of index.db (default) or, when false, a plain read-only open of it.
   * The workspace passes false: the copy retries for seconds while another process writes the index, and a plain
   * read-only open is enough for a page that only reads.
   */
  indexSnapshot?: boolean;
}

/** Whether the report carries the raw window rows: `--detail full` includes them. */
export function metricsIncludeRows(mode: Pick<OutputMode, "detail">): boolean {
  return mode.detail === "full";
}

/**
 * `select` events keyed on the durable ref. The events stream stores the ref
 * as typed (`knowledge/x` for the default bundle), while `usage_events` stores
 * `bundle//conceptId`; resolving here keeps one asset from showing as two rows.
 * A ref that does not resolve (registry results, removed assets) is kept as is.
 */
async function resolveSelectRefs(refs: Iterable<string>, indexSnapshot = true): Promise<Map<string, string>> {
  const unqualified: Array<{ ref: string; parsed: ReturnType<typeof parseBundleRef> }> = [];
  for (const ref of new Set(refs)) {
    try {
      const parsed = parseBundleRef(ref);
      if (!parsed.bundle) unqualified.push({ ref, parsed });
    } catch {
      // Not a local bundle ref: keep the ref as recorded.
    }
  }
  const entries = await lookupBundleRefsReadonly(
    unqualified.map(({ parsed }) => parsed),
    { isolatedSnapshot: indexSnapshot },
  );
  return new Map(unqualified.map(({ ref }, i) => [ref, entries[i]?.itemRef ?? ref]));
}

async function durableSelects(selects: SelectEventRow[], indexSnapshot = true): Promise<SelectEventRow[]> {
  const resolved = await resolveSelectRefs(
    selects.map((select) => select.ref),
    indexSnapshot,
  );
  return selects.map((select) => ({ ...select, ref: resolved.get(select.ref) ?? select.ref }));
}

/** `index.db` utility rows, or a note saying why there are none. */
function readUtility(): { utility?: UtilityWithRef[]; note?: string } {
  let db: Database | undefined;
  try {
    db = openReadonlyExistingDatabase(getDbPath());
    if (!db) return { note: "index.db was not found, so the utility section is empty. Run 'akm index' to build it." };
    return { utility: listUtilityWithRefs(db) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { note: `index.db could not be read (${message}), so the utility section is empty.` };
  } finally {
    if (db) closeDatabase(db);
  }
}

function readEventRetention(): { eventRetentionDays: number; note?: string } {
  try {
    const days = loadConfig().improve?.eventRetentionDays;
    return { eventRetentionDays: typeof days === "number" ? days : DEFAULT_EVENT_RETENTION_DAYS };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      eventRetentionDays: DEFAULT_EVENT_RETENTION_DAYS,
      note: `The config could not be loaded (${message}), so event retention assumes ${DEFAULT_EVENT_RETENTION_DAYS} days.`,
    };
  }
}

function readAcceptRate(stateDb: Database, notes: string[]): AkmMetricsResult["proposals"]["acceptRateBySource"] {
  try {
    return computeAcceptRateBySource(undefined, { db: stateDb });
  } catch (error) {
    notes.push(`Proposal accept rate is unavailable (${error instanceof Error ? error.message : String(error)}).`);
    return [];
  }
}

/** The report window for `since`, ending now; refuses a start that is not earlier. */
export function metricsWindow(since: string, nowMs: number = Date.now()): { since: string; until: string } {
  const sinceIso = parseHealthSince(since);
  const untilIso = new Date(nowMs).toISOString();
  if (Date.parse(sinceIso) >= Date.parse(untilIso)) {
    throw new UsageError(`--since (${sinceIso}) must be earlier than now (${untilIso}).`, "INVALID_FLAG_VALUE");
  }
  return { since: sinceIso, until: untilIso };
}

function llmEventsIn(db: Database, window: { since: string; until: string }) {
  const untilMs = Date.parse(window.until);
  return readEvents({ since: window.since, type: LLM_USAGE_EVENT }, { db, readOnly: true }).events.filter(
    (event) => Date.parse(event.ts) < untilMs,
  );
}

/**
 * The window's usage rows as the report carries them (`rows.usage`), for a caller that needs no report: people's rows,
 * or every source's with `allSources`.
 */
export function readUsageRows(
  db: Database,
  window: { since: string; until: string },
  options: { allSources?: boolean; newest?: number } = {},
): MetricsUsageRow[] {
  return listUsageEventRows(db, {
    sinceIso: window.since,
    untilIso: window.until,
    ...(options.allSources ? {} : { source: SOURCE }),
    ...(options.newest === undefined ? {} : { newest: options.newest }),
  }).map(toUsageRow);
}

/** The window's LLM usage rows as the report carries them (`rows.llm`). */
export function readLlmRows(db: Database, window: { since: string; until: string }): MetricsLlmRow[] {
  const events = llmEventsIn(db, window);
  const range = rollupDayRange(window.since, window.until, oldestTs(events));
  const older = range ? (withMetricsHistory(db, undefined, (metrics) => readLlmDaily(metrics, range)) ?? []) : [];
  return [...older, ...llmRowsFromEvents(events)];
}

/**
 * The days of the window that state.db no longer holds, read from metrics.db's rollups. Each kind of row has
 * its own days (see `rollupDayRange`): the ones before the oldest raw row of that kind in the window.
 */
async function readRollup(
  stateDbPath: string,
  window: { since: string; until: string },
  oldest: { usage?: string; selects?: string; llm?: string; index?: string },
  indexSnapshot: boolean,
): Promise<{ rollup?: MetricsRollup; notes: string[] }> {
  const usageDays = rollupDayRange(window.since, window.until, oldest.usage);
  const selectDays = rollupDayRange(window.since, window.until, oldest.selects);
  const llmDays = rollupDayRange(window.since, window.until, oldest.llm);
  const indexDays = rollupDayRange(window.since, window.until, oldest.index);
  if (!usageDays && !selectDays && !llmDays && !indexDays) return { notes: [] };

  const read = withMetricsHistory(undefined, stateDbPath, (metrics) => {
    const searchHist = emptyHistogram();
    for (const hist of usageDays ? readLatencyHistograms(metrics, usageDays, "search", SOURCE) : [])
      mergeHistogram(searchHist, hist);
    const indexHist = emptyHistogram();
    for (const hist of indexDays ? readLatencyHistograms(metrics, indexDays, "index", "") : [])
      mergeHistogram(indexHist, hist);
    return {
      usage: usageDays ? readUsageDaily(metrics, usageDays, SOURCE) : [],
      queries: usageDays ? readQueryDaily(metrics, usageDays, SOURCE) : [],
      tags: usageDays ? readTagDaily(metrics, usageDays, SOURCE) : [],
      selects: selectDays ? readSelectDaily(metrics, selectDays, SOURCE) : [],
      searchHist,
      llm: llmDays ? readLlmDaily(metrics, llmDays) : [],
      indexRuns: histogramCount(indexHist),
      indexHist,
      first: firstFoldedDay(metrics),
    };
  });
  if (!read) return { notes: [] };

  // Selects are stored as typed: resolve them to the durable ref the usage rows carry, then merge.
  const resolved = await resolveSelectRefs(
    read.selects.map((select) => select.ref),
    indexSnapshot,
  );
  const selects = new Map<string, { ref: string; n: number; lastAt: string }>();
  for (const select of read.selects) {
    const ref = resolved.get(select.ref) ?? select.ref;
    const entry = selects.get(ref) ?? { ref, n: 0, lastAt: select.last_at };
    entry.n += select.n;
    if (select.last_at > entry.lastAt) entry.lastAt = select.last_at;
    selects.set(ref, entry);
  }
  const rollup: MetricsRollup = {
    usage: read.usage,
    queries: read.queries,
    tags: read.tags,
    selects: [...selects.values()],
    searchHist: read.searchHist,
    llm: read.llm,
    indexRuns: read.indexRuns,
    indexHist: read.indexHist,
  };
  const from = [usageDays, selectDays, llmDays, indexDays].flatMap((d) => (d ? [d.from] : [])).sort()[0];
  const notes: string[] = [];
  if (from && read.first !== undefined && from < read.first) {
    notes.push(
      `The window starts earlier than the history akm holds: nothing was folded into metrics.db before ${read.first}.`,
    );
  }
  const used =
    rollup.usage.length + rollup.queries.length + rollup.selects.length + rollup.llm.length + rollup.indexRuns > 0;
  if (used) {
    notes.push(
      "Days older than state.db's raw rows come from metrics.db's daily rollups, which count whole UTC days (a day belongs to the window that contains its midnight). Search and index medians over those days are estimated from duration histograms; negative-feedback reasons and the rows of --detail full cover the raw window only.",
    );
  }
  return { rollup, notes };
}

/** Read every store and build the report. */
export async function akmMetrics(options: AkmMetricsOptions = {}): Promise<AkmMetricsResult> {
  const nowMs = (options.now ?? Date.now)();
  const { since: sinceIso, until: untilIso } = metricsWindow(options.since ?? DEFAULT_SINCE, nowMs);
  const notes: string[] = [];

  const config = readEventRetention();
  if (config.note) notes.push(config.note);
  // With a metrics.db beside state.db, history older than the raw retention is read from it: the retention notes
  // say what it cannot (below), not that the data ends at the retention edge.
  const stateDbPath = getStateDbPath();
  if (!fs.existsSync(metricsDbPathBeside(stateDbPath))) {
    notes.push(
      ...retentionNotes({
        sinceIso,
        nowMs,
        usageRetentionDays: USAGE_EVENT_RETENTION_DAYS,
        eventRetentionDays: config.eventRetentionDays,
      }),
    );
  }

  const index = readUtility();
  if (index.note) notes.push(index.note);
  const filter: MetricsQueryFilter = { sinceIso, untilIso, source: SOURCE };
  notes.push(
    "Selects come from the events stream. Only selects recorded before they carried a source are counted for every source, so selects per search is a ratio, not a conversion rate.",
  );

  const input: MetricsInput = {
    window: { since: sinceIso, until: untilIso },
    source: SOURCE,
    top: TOP,
    includeRows: options.includeRows === true,
    usage: [],
    selects: [],
    utility: index.utility,
    outcomes: [],
    llm: emptyLlmUsageAggregate(),
    llmRows: [],
    indexRuns: [],
    tasks: [],
    proposals: { byStatus: {}, acceptRateBySource: [] },
    workflows: { runs: 0, byStatus: {}, tokens: 0, byModel: {} },
    notes,
  };

  if (!fs.existsSync(stateDbPath)) {
    notes.push("state.db was not found, so every section except utility is empty.");
    return buildMetricsResult(input);
  }
  let pending: string[];
  try {
    pending = listPendingStateMigrations(stateDbPath);
  } catch (error) {
    notes.push(
      `state.db could not be read (${error instanceof Error ? error.message : String(error)}), so every section except utility is empty.`,
    );
    return buildMetricsResult(input);
  }
  if (pending.length > 0) {
    notes.push(
      `state.db has ${pending.length} pending migration${pending.length === 1 ? "" : "s"}; 'akm metrics' never migrates, so every section except utility is empty. Run 'akm migrate apply'.`,
    );
    return buildMetricsResult(input);
  }
  const stateDb = openDatabase(stateDbPath, { readonly: true, create: false });
  let selects: SelectEventRow[] = [];
  // The oldest raw row of each kind in the window: the days before it are served from metrics.db.
  const oldest: { usage?: string; selects?: string; llm?: string; index?: string } = {};
  try {
    applyReadonlyPragmas(stateDb);
    input.usage = listUsageEventRows(stateDb, filter);
    oldest.usage = input.usage[0]?.created_at;
    selects = listSelectEvents(stateDb, sinceIso, untilIso);
    oldest.selects = oldestTs(selects);
    input.outcomes = listLowestOutcomeAssets(stateDb, TOP);
    const indexEvents = listIndexCompletedEvents(stateDb, sinceIso, untilIso);
    oldest.index = oldestTs(indexEvents);
    input.indexRuns = indexRunsFromEvents(indexEvents);
    input.tasks = queryTaskHistory(stateDb, { since: sinceIso, until: untilIso });
    input.proposals = {
      byStatus: countProposalsByStatus(stateDb, sinceIso, untilIso),
      acceptRateBySource: readAcceptRate(stateDb, notes),
    };
    input.workflows = summarizeWorkflowRuns(stateDb, sinceIso, untilIso);
    const inWindow = llmEventsIn(stateDb, { since: sinceIso, until: untilIso });
    oldest.llm = oldestTs(inWindow);
    input.llm = summarizeLlmUsage(inWindow);
    if (input.includeRows) input.llmRows = llmRowsFromEvents(inWindow);
  } finally {
    stateDb.close();
  }
  input.selects = await durableSelects(selects, options.indexSnapshot ?? true);
  const history = await readRollup(
    stateDbPath,
    { since: sinceIso, until: untilIso },
    oldest,
    options.indexSnapshot ?? true,
  );
  if (history.rollup) {
    input.rollup = history.rollup;
    addLlmRows(input.llm, history.rollup.llm);
  }
  notes.push(...history.notes);
  return buildMetricsResult(input);
}
