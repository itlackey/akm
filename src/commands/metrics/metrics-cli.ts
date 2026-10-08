// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm metrics` — one read-only report over what akm has already recorded:
 * asset usage, feedback, utility, LLM usage and cost, task runs, proposals and
 * workflow spend. This module reads the stores and hands the rows to the pure
 * aggregation in `collect.ts`; the shape is `AkmMetricsResult` (`types.ts`).
 *
 * Nothing is written. A missing `state.db` gives an empty report and a missing
 * `index.db` an empty utility section, each with a note, never an error.
 */

import fs from "node:fs";
import { parsePositiveIntFlag } from "../../cli/parse-args";
import { defineJsonCommand, output, parseAllFlagValues } from "../../cli/shared";
import { makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { loadConfig } from "../../core/config/config";
import { NotFoundError, UsageError } from "../../core/errors";
import { readEvents } from "../../core/events";
import { getDbPath } from "../../core/paths";
import { getStateDbPath, openStateDatabase } from "../../core/state-db";
import { USAGE_EVENT_RETENTION_DAYS } from "../../indexer/usage/usage-events";
import { LLM_USAGE_EVENT } from "../../llm/usage-persist";
import { getOutputMode, type OutputMode } from "../../output/context";
import type { Database } from "../../storage/database";
import { closeDatabase, openReadonlyExistingDatabase } from "../../storage/repositories/index-connection";
import { findEntryIdByRef, getItemRefById } from "../../storage/repositories/index-entries-repository";
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
import { parseHealthSince } from "../health";
import { computeAcceptRateBySource } from "../health/accept-rate";
import { emptyLlmUsageAggregate, readLlmUsageAggregate } from "../health/llm-usage";
import {
  buildMetricsResult,
  DEFAULT_EVENT_RETENTION_DAYS,
  type EnginePricing,
  indexRunsFromEvents,
  llmRowsFromEvents,
  type MetricsInput,
  retentionNotes,
} from "./collect";
import type { AkmMetricsResult } from "./types";

const DEFAULT_SINCE = "30d";
const DEFAULT_TOP = 20;
const DEFAULT_SOURCE = "user";
const ALL_SOURCES = "all";

export interface AkmMetricsOptions {
  /** Window start: `24h` / `7d` / ISO / epoch ms. Default `30d`. */
  since?: string;
  /** Window end (exclusive), same grammar. Default now. */
  until?: string;
  bundles?: string[];
  ref?: string;
  /** `user` (default), `all`, or one source name. */
  source?: string;
  /** Cap on every ranked list. Default 20. */
  top?: number;
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

/** A `--ref` as the durable `bundle//conceptId` the stores key on. */
function resolveRefFilter(input: string, indexDb: Database | undefined): string {
  const parsed = parseBundleRef(input);
  const ref = makeBundleRef(parsed.bundle, parsed.conceptId);
  if (parsed.bundle) return ref;
  const id = indexDb ? findEntryIdByRef(indexDb, ref) : undefined;
  const durable = id === undefined || !indexDb ? null : getItemRefById(indexDb, id);
  if (!durable) {
    throw new NotFoundError(
      `Ref "${input}" is not in the index. Qualify it as <bundle>//<conceptId>, or run 'akm index' if it was recently added.`,
      "ASSET_NOT_FOUND",
    );
  }
  return durable;
}

/** `index.db` utility rows, or a note saying why there are none. */
function readUtility(): { utility?: UtilityWithRef[]; db?: Database; note?: string } {
  let db: Database | undefined;
  try {
    db = openReadonlyExistingDatabase(getDbPath());
    if (!db) return { note: "index.db was not found, so the utility section is empty. Run 'akm index' to build it." };
    return { utility: listUtilityWithRefs(db), db };
  } catch (error) {
    if (db) closeDatabase(db);
    const message = error instanceof Error ? error.message : String(error);
    return { note: `index.db could not be read (${message}), so the utility section is empty.` };
  }
}

function readPricing(): { pricing: Record<string, EnginePricing>; eventRetentionDays: number; note?: string } {
  try {
    const config = loadConfig();
    const pricing: Record<string, EnginePricing> = {};
    for (const [name, engine] of Object.entries(config.engines ?? {})) {
      const price = (engine as { pricing?: EnginePricing }).pricing;
      if (price) pricing[name] = price;
    }
    const days = config.improve?.eventRetentionDays;
    return { pricing, eventRetentionDays: typeof days === "number" ? days : DEFAULT_EVENT_RETENTION_DAYS };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      pricing: {},
      eventRetentionDays: DEFAULT_EVENT_RETENTION_DAYS,
      note: `The config could not be loaded (${message}), so llm.cost is empty and event retention assumes ${DEFAULT_EVENT_RETENTION_DAYS} days.`,
    };
  }
}

function readAcceptRate(notes: string[]): AkmMetricsResult["proposals"]["acceptRateBySource"] {
  try {
    return computeAcceptRateBySource();
  } catch (error) {
    notes.push(`Proposal accept rate is unavailable (${error instanceof Error ? error.message : String(error)}).`);
    return [];
  }
}

/** Read every store and build the report. */
export function akmMetrics(options: AkmMetricsOptions = {}): AkmMetricsResult {
  const nowMs = (options.now ?? Date.now)();
  const sinceIso = parseHealthSince(options.since ?? DEFAULT_SINCE);
  const untilIso = options.until === undefined ? new Date(nowMs).toISOString() : parseHealthSince(options.until);
  if (Date.parse(sinceIso) >= Date.parse(untilIso)) {
    throw new UsageError(`--since (${sinceIso}) must be earlier than --until (${untilIso}).`, "INVALID_FLAG_VALUE");
  }
  const source = options.source?.trim() || DEFAULT_SOURCE;
  const bundles = options.bundles ?? [];
  const top = options.top ?? DEFAULT_TOP;
  const notes: string[] = [];

  const config = readPricing();
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
  try {
    const ref = options.ref === undefined ? undefined : resolveRefFilter(options.ref, index.db);
    const filter: MetricsQueryFilter = {
      sinceIso,
      untilIso,
      ...(source === ALL_SOURCES ? {} : { source }),
      bundles,
      ...(ref !== undefined ? { ref } : {}),
    };
    if (bundles.length > 0 || ref !== undefined) {
      notes.push(
        "Usage, feedback, utility and outcomes are limited to the matching assets, and searches counts the searches that returned one; llm, index, tasks, proposals (accept rate) and workflows cover everything.",
      );
    }
    if (source !== ALL_SOURCES) {
      notes.push("Selects come from the events stream, which records no source, so they are counted for every source.");
    }

    const input: MetricsInput = {
      window: { since: sinceIso, until: untilIso },
      filters: { source, bundles, ...(ref !== undefined ? { ref } : {}) },
      top,
      includeRows: options.includeRows === true,
      usage: [],
      selects: [],
      utility: index.utility,
      outcomes: [],
      llm: emptyLlmUsageAggregate(),
      llmRows: [],
      pricing: config.pricing,
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
    const stateDb = openStateDatabase(stateDbPath);
    try {
      input.usage = listUsageEventRows(stateDb, filter);
      input.selects = listSelectEvents(stateDb, filter);
      input.outcomes = listLowestOutcomeAssets(stateDb, filter, top);
      input.indexRuns = indexRunsFromEvents(listIndexCompletedEvents(stateDb, sinceIso, untilIso));
      input.tasks = queryTaskHistory(stateDb, { since: sinceIso, until: untilIso });
      input.proposals = {
        byStatus: countProposalsByStatus(stateDb, sinceIso, untilIso, filter),
        acceptRateBySource: readAcceptRate(notes),
      };
      input.workflows = summarizeWorkflowRuns(stateDb, sinceIso, untilIso);
    } finally {
      stateDb.close();
    }
    input.llm = readLlmUsageAggregate(stateDbPath, sinceIso, untilIso);
    if (input.includeRows) {
      const untilMs = Date.parse(untilIso);
      const events = readEvents({ since: sinceIso, type: LLM_USAGE_EVENT }, { dbPath: stateDbPath }).events;
      input.llmRows = llmRowsFromEvents(events.filter((event) => Date.parse(event.ts) < untilMs));
    }
    return buildMetricsResult(input);
  } finally {
    if (index.db) closeDatabase(index.db);
  }
}

export const metricsCommand = defineJsonCommand({
  meta: {
    name: "metrics",
    description:
      "Report asset usage, feedback, utility, LLM usage and cost, tasks, proposals and workflow spend from local records. Read-only. --format html writes a self-contained dashboard.",
  },
  args: {
    since: {
      type: "string",
      description: `Window start: ISO, date, epoch ms, or 24h / 7d / 30d (default ${DEFAULT_SINCE})`,
    },
    until: { type: "string", description: "Window end (exclusive), same forms as --since (default now)" },
    bundle: { type: "string", description: "Only assets in this bundle (repeatable)" },
    ref: { type: "string", description: "Only this asset ([bundle//]conceptId)" },
    source: {
      type: "string",
      description: `Usage source: user (default), all, or one of improve / task / audit / unknown`,
    },
    top: { type: "string", description: `Cap on every ranked list (default ${DEFAULT_TOP})` },
  },
  run({ args }) {
    output(
      "metrics",
      akmMetrics({
        since: args.since,
        until: args.until,
        bundles: parseAllFlagValues("--bundle"),
        ref: args.ref,
        source: args.source,
        top: parsePositiveIntFlag(args.top, "--top"),
        includeRows: metricsIncludeRows(getOutputMode()),
      }),
    );
  },
});
