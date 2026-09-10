// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #944 Layer 2 — `akm improve report`. Reads one (or several, `--since`)
 * `improve_runs` rows and returns the same `usageReport` shape
 * `finalizeImproveResult` persists on a live run (`improve-usage-report.ts`),
 * so the command and the end-of-run stderr table stay byte-identical in
 * structure. A row with no persisted `usageReport` degrades rather than
 * errors, per AGENTS.md's "reader must tolerate data older releases wrote":
 * its cross-tab is recomputed from the run's own `llm_usage` events and a
 * `notes` entry explains why — either the row predates #944, or (per
 * `recordTerminatedImproveRun` in improve-result-file.ts) the run was
 * terminated before it ever reached `finalizeImproveResult`. The `noCalls`
 * half is never fabricated for either case.
 */

import { NotFoundError, UsageError } from "../../core/errors";
import { type EventsContext, readEvents } from "../../core/events";
import { decodeImproveResult } from "../../core/improve-result";
import { withStateDb } from "../../core/state-db";
import { LLM_USAGE_EVENT } from "../../llm/usage-persist";
import {
  getImproveRunById,
  getLatestImproveRun,
  queryImproveRuns,
} from "../../storage/repositories/improve-runs-repository";
import { parseHealthSince } from "../health";
import { summarizeLlmUsageCrossTab } from "../health/llm-usage";
import type { LlmUsageCrossTabRow } from "../health/types";
import type { UsageReportNoCallRow } from "./improve-usage-report";

const PRE_USAGE_REPORT_NOTE = "eligibility reasons unavailable for runs recorded before 0.9.15";
const TERMINATED_RUN_NOTE = "run terminated before completion; no usage report was recorded";

export interface ImproveReportUsage {
  byProcessEngineModel: LlmUsageCrossTabRow[];
  noCalls: UsageReportNoCallRow[];
}

export interface ImproveReportResult {
  mode: "run" | "since";
  runId?: string;
  runIds?: string[];
  since?: string;
  strategy?: string;
  usageReport: ImproveReportUsage;
  notes?: string[];
}

/**
 * Recompute the cross-tab from this run's own `llm_usage` events (a pre-#944
 * row has no persisted one). `eventsCtx` threads the state.db connection
 * `runImproveReportQuery` already holds via `withStateDb`, so a `--since`
 * window with several pre-0.9.15 or undecodable rows reads through that one
 * open connection instead of each row opening and closing its own.
 */
function crossTabFromEvents(
  startedAt: string,
  completedAt: string | null,
  eventsCtx?: EventsContext,
): LlmUsageCrossTabRow[] {
  const until = completedAt ?? new Date().toISOString();
  const events = readEvents({ since: startedAt, type: LLM_USAGE_EVENT }, eventsCtx).events.filter(
    (event) => new Date(event.ts ?? startedAt).getTime() < new Date(until).getTime(),
  );
  return summarizeLlmUsageCrossTab(events);
}

/** Minimal row shape `usageReportForRow` needs — satisfied by both `ImproveRunRow` and `ImproveRunSummaryRow`. */
interface ReportableRunRow {
  started_at: string;
  completed_at: string | null;
  result_json: string;
}

/** One row's usage report — persisted (common case) or recomputed (pre-#944 row / terminated run / undecodable row). */
function usageReportForRow(
  row: ReportableRunRow,
  eventsCtx?: EventsContext,
): {
  usageReport: ImproveReportUsage;
  strategy?: string;
  note?: string;
} {
  try {
    const decoded = decodeImproveResult(row.result_json);
    if (decoded.envelope.usageReport) {
      return {
        usageReport: {
          byProcessEngineModel: [...decoded.envelope.usageReport.byProcessEngineModel] as LlmUsageCrossTabRow[],
          noCalls: [...decoded.envelope.usageReport.noCalls] as UsageReportNoCallRow[],
        },
        strategy: decoded.strategy,
      };
    }
    return {
      usageReport: {
        byProcessEngineModel: crossTabFromEvents(row.started_at, row.completed_at, eventsCtx),
        noCalls: [],
      },
      strategy: decoded.strategy,
      note: decoded.envelope.terminated ? TERMINATED_RUN_NOTE : PRE_USAGE_REPORT_NOTE,
    };
  } catch {
    // A row whose result_json this build cannot decode still has real
    // llm_usage events on state.db — degrade to the recomputed cross-tab
    // rather than excluding the run entirely.
    return {
      usageReport: {
        byProcessEngineModel: crossTabFromEvents(row.started_at, row.completed_at, eventsCtx),
        noCalls: [],
      },
      note: PRE_USAGE_REPORT_NOTE,
    };
  }
}

function mergeCrossTabRow(merged: Map<string, LlmUsageCrossTabRow>, row: LlmUsageCrossTabRow): void {
  const key = `${row.process}:${row.engine}:${row.model}`;
  const acc = merged.get(key);
  if (!acc) {
    merged.set(key, { ...row });
    return;
  }
  acc.calls += row.calls;
  acc.failures += row.failures;
  acc.promptTokens += row.promptTokens;
  acc.completionTokens += row.completionTokens;
  acc.totalTokens += row.totalTokens;
  acc.reasoningTokens += row.reasoningTokens;
  acc.totalDurationMs += row.totalDurationMs;
}

/**
 * Resolve `akm improve report`'s target run(s) and build its `usageReport`.
 * `runId` and `since` are mutually exclusive; neither given selects the most
 * recent non-dry-run.
 */
export function runImproveReportQuery(options: { runId?: string; since?: string }): ImproveReportResult {
  if (options.runId !== undefined && options.since !== undefined) {
    throw new UsageError("akm improve report: --run and --since are mutually exclusive.", "INVALID_FLAG_VALUE");
  }
  return withStateDb((db) => {
    // Thread this already-open connection into every reader below, so a
    // `--since` window with several pre-0.9.15 or undecodable rows reads
    // through it instead of each row opening and closing its own.
    const eventsCtx: EventsContext = { db };
    if (options.since !== undefined) {
      const sinceIso = parseHealthSince(options.since);
      const rows = queryImproveRuns(db, sinceIso);
      const merged = new Map<string, LlmUsageCrossTabRow>();
      const calledEverByProcess = new Set<string>();
      const lastReasonByProcess = new Map<string, { engine?: string; reason: string }>();
      const notes = new Set<string>();
      for (const row of rows) {
        const { usageReport, note } = usageReportForRow(row, eventsCtx);
        for (const crossTabRow of usageReport.byProcessEngineModel) {
          mergeCrossTabRow(merged, crossTabRow);
          if (crossTabRow.calls > 0) calledEverByProcess.add(crossTabRow.process);
        }
        for (const noCallRow of usageReport.noCalls) {
          // `rows` is newest-first (ORDER BY started_at DESC): keep only the
          // first (most recent) reason seen per process, never overwrite it
          // with an older run's reason.
          if (!lastReasonByProcess.has(noCallRow.process)) {
            lastReasonByProcess.set(noCallRow.process, { engine: noCallRow.engine, reason: noCallRow.reason });
          }
        }
        if (note) notes.add(note);
      }
      const noCalls: UsageReportNoCallRow[] = [...lastReasonByProcess.entries()]
        .filter(([process]) => !calledEverByProcess.has(process))
        .map(([process, { engine, reason }]) => ({ process, ...(engine ? { engine } : {}), reason }));
      return {
        mode: "since",
        since: sinceIso,
        runIds: rows.map((r) => r.id),
        usageReport: { byProcessEngineModel: [...merged.values()], noCalls },
        ...(notes.size > 0 ? { notes: [...notes] } : {}),
      };
    }

    const row = options.runId !== undefined ? getImproveRunById(db, options.runId) : getLatestImproveRun(db);
    if (!row) {
      throw new NotFoundError(
        options.runId !== undefined
          ? `akm improve report: no improve run found with id "${options.runId}".`
          : "akm improve report: no improve runs recorded yet.",
        "IMPROVE_RUN_NOT_FOUND",
      );
    }
    const { usageReport, strategy, note } = usageReportForRow(row, eventsCtx);
    return {
      mode: "run",
      runId: row.id,
      ...(strategy !== undefined ? { strategy } : {}),
      usageReport,
      ...(note ? { notes: [note] } : {}),
    };
  });
}
