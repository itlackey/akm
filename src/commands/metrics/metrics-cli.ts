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
import { defineJsonCommand, output } from "../../cli/shared";
import { parseBundleRef } from "../../core/asset/asset-ref";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { readEvents } from "../../core/events";
import { getDbPath } from "../../core/paths";
import { getStateDbPath, listPendingStateMigrations } from "../../core/state-db";
import { lookupBundleRefsReadonly } from "../../indexer/indexer";
import { USAGE_EVENT_RETENTION_DAYS } from "../../indexer/usage/usage-events";
import { LLM_USAGE_EVENT } from "../../llm/usage-persist";
import { getOutputMode, type OutputMode } from "../../output/context";
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
  summarizeWorkflowRuns,
} from "../../storage/repositories/metrics-repository";
import { queryTaskHistory } from "../../storage/repositories/task-history-repository";
import { applyReadonlyPragmas } from "../../storage/sqlite-pragmas";
import { parseHealthSince } from "../health";
import { computeAcceptRateBySource } from "../health/accept-rate";
import { emptyLlmUsageAggregate, summarizeLlmUsage } from "../health/llm-usage";
import {
  buildMetricsResult,
  DEFAULT_EVENT_RETENTION_DAYS,
  indexRunsFromEvents,
  llmRowsFromEvents,
  type MetricsInput,
  retentionNotes,
} from "./collect";
import type { AkmMetricsResult } from "./types";

const DEFAULT_SINCE = "30d";
/** Cap on every ranked list. */
const TOP = 20;
/** Usage rows from people; improve, task and audit rows are akm's own reads. */
const SOURCE = "user";

export interface AkmMetricsOptions {
  /** Window start: `24h` / `7d` / ISO / epoch ms. Default `30d`. */
  since?: string;
  /** Attach the raw window rows (`--format html` and `--detail full`). */
  includeRows?: boolean;
  now?: () => number;
}

/**
 * Whether the report carries the raw window rows: the HTML dashboard
 * re-aggregates from them client-side, so `--format html` always includes
 * them, and `--detail full` includes them for any other format.
 */
export function metricsIncludeRows(mode: Pick<OutputMode, "format" | "detail">): boolean {
  return mode.format === "html" || mode.detail === "full";
}

/**
 * `select` events keyed on the durable ref. The events stream stores the ref
 * as typed (`knowledge/x` for the default bundle), while `usage_events` stores
 * `bundle//conceptId`; resolving here keeps one asset from showing as two rows.
 * A ref that does not resolve (registry results, removed assets) is kept as is.
 */
async function durableSelects(
  selects: Array<{ ts: string; ref: string }>,
): Promise<Array<{ ts: string; ref: string }>> {
  const unqualified: Array<{ ref: string; parsed: ReturnType<typeof parseBundleRef> }> = [];
  for (const ref of new Set(selects.map((select) => select.ref))) {
    try {
      const parsed = parseBundleRef(ref);
      if (!parsed.bundle) unqualified.push({ ref, parsed });
    } catch {
      // Not a local bundle ref: keep the ref as recorded.
    }
  }
  const entries = await lookupBundleRefsReadonly(unqualified.map(({ parsed }) => parsed));
  const resolved = new Map(unqualified.map(({ ref }, i) => [ref, entries[i]?.itemRef ?? ref]));
  return selects.map((select) => ({ ts: select.ts, ref: resolved.get(select.ref) ?? select.ref }));
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

/** Read every store and build the report. */
export async function akmMetrics(options: AkmMetricsOptions = {}): Promise<AkmMetricsResult> {
  const nowMs = (options.now ?? Date.now)();
  const sinceIso = parseHealthSince(options.since ?? DEFAULT_SINCE);
  const untilIso = new Date(nowMs).toISOString();
  if (Date.parse(sinceIso) >= Date.parse(untilIso)) {
    throw new UsageError(`--since (${sinceIso}) must be earlier than now (${untilIso}).`, "INVALID_FLAG_VALUE");
  }
  const notes: string[] = [];

  const config = readEventRetention();
  if (config.note) notes.push(config.note);
  notes.push(
    ...retentionNotes({
      sinceIso,
      nowMs,
      usageRetentionDays: USAGE_EVENT_RETENTION_DAYS,
      eventRetentionDays: config.eventRetentionDays,
    }),
  );

  const index = readUtility();
  if (index.note) notes.push(index.note);
  const filter: MetricsQueryFilter = { sinceIso, untilIso, source: SOURCE };
  notes.push("Selects come from the events stream, which records no source, so they are counted for every source.");

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

  const stateDbPath = getStateDbPath();
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
  let selects: Array<{ ts: string; ref: string }> = [];
  try {
    applyReadonlyPragmas(stateDb);
    input.usage = listUsageEventRows(stateDb, filter);
    selects = listSelectEvents(stateDb, sinceIso, untilIso);
    input.outcomes = listLowestOutcomeAssets(stateDb, TOP);
    input.indexRuns = indexRunsFromEvents(listIndexCompletedEvents(stateDb, sinceIso, untilIso));
    input.tasks = queryTaskHistory(stateDb, { since: sinceIso, until: untilIso });
    input.proposals = {
      byStatus: countProposalsByStatus(stateDb, sinceIso, untilIso),
      acceptRateBySource: readAcceptRate(stateDb, notes),
    };
    input.workflows = summarizeWorkflowRuns(stateDb, sinceIso, untilIso);
    const untilMs = Date.parse(untilIso);
    const llmEvents = readEvents({ since: sinceIso, type: LLM_USAGE_EVENT }, { db: stateDb, readOnly: true }).events;
    const inWindow = llmEvents.filter((event) => Date.parse(event.ts) < untilMs);
    input.llm = summarizeLlmUsage(inWindow);
    if (input.includeRows) input.llmRows = llmRowsFromEvents(inWindow);
  } finally {
    stateDb.close();
  }
  input.selects = await durableSelects(selects);
  return buildMetricsResult(input);
}

export const metricsCommand = defineJsonCommand({
  meta: {
    name: "metrics",
    description:
      "Experimental: report asset usage, feedback, utility, LLM usage, tasks, proposals and workflow spend from local records. Read-only. --format html writes a self-contained dashboard.",
  },
  args: {
    since: {
      type: "string",
      description: `Window start: ISO, date, epoch ms, or 24h / 7d / 30d (default ${DEFAULT_SINCE})`,
    },
  },
  async run({ args }) {
    output(
      "metrics",
      await akmMetrics({
        since: args.since,
        includeRows: metricsIncludeRows(getOutputMode()),
      }),
    );
  },
});
