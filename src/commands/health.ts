// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { daysToMs, resolveStashDir } from "../core/common";
import { loadConfig } from "../core/config/config";
import { ConfigError, rethrowIfTestIsolationError, UsageError } from "../core/errors";
import { classifyPathAccess, describeInaccessiblePath } from "../core/path-access";
import { getConfigPath, getDataDir, getDbPath, getStateDbPathInDataDir } from "../core/paths";
import {
  listExistingTableNames,
  listPendingStateMigrations,
  openStateDatabaseWithReport,
  withStateDb,
} from "../core/state-db";
import { DURATION_UNITS, parseDuration, parseSinceToIso } from "../core/time";
import { probeLlmEndpoint } from "../llm/client";
import type { Database } from "../storage/database";
import { insertEvent } from "../storage/repositories/events-repository";
import { getExtractOutcomeCountsSince } from "../storage/repositories/extract-sessions-repository";
import { countImproveRunsSince } from "../storage/repositories/improve-runs-repository";
import { closeDatabase, openReadonlyExistingDatabase } from "../storage/repositories/index-connection";
import { getAllEntries } from "../storage/repositories/index-entries-repository";
import { queryTaskHistory } from "../storage/repositories/task-history-repository";
import { getStateDbFreelistInfo, runStateDbQuickCheck } from "../storage/state-db-integrity";
import { pkgVersion } from "../version";
import {
  HEALTH_CHECKS,
  type HealthCheckContext,
  probeActiveImproveStrategy,
  runHealthEngineProbes,
  runPendingStateMigrationsCheck,
  SESSION_EXTRACTION_LEDGER_WINDOW_DAYS,
} from "./health/checks";
import { collectConfigSkewAdvisory } from "./health/config-skew";
import { collectDataDirUsageAdvisory } from "./health/data-dir-usage";
import { collectEgressAdvisory, type EgressConfigView } from "./health/egress";
import { engineLastUsedSince, readLastEngineUsage } from "./health/engine-usage";
import { emptyImproveMetrics, roundRate } from "./health/improve-metrics";
import { emptyLlmUsageAggregate, readLlmUsageAggregate } from "./health/llm-usage";
import { collectPluginStalenessAdvisories } from "./health/plugin-staleness";
import { collectSchedulerBinaryAdvisory } from "./health/scheduler-binary";
import { collectStashExposureAdvisory, type GitRunner } from "./health/stash-exposure";
import { buildTypeDirectoryAdvisory } from "./health/type-directory-check";
import {
  type AkmHealthResult,
  type DeltaEntry,
  type HealthCheckResult,
  type HealthMetrics,
  type ImproveRunSummary,
  MIN_ROWS_FOR_WORST_TASK_FAIL_RATE,
  type WindowResult,
  type WindowSpec,
} from "./health/types";
import { collectVersionDriftAdvisory } from "./health/version-drift";
import {
  buildImproveWindowSummary,
  buildWindowMetrics,
  computeDeltas,
  computeTaskWindowRates,
  resolveWindowCompare,
} from "./health/windows";

export interface AkmHealthOptions {
  since?: string;
  /** Row grouping. `run` emits one row per improve_runs entry (was `--detail per-run`). */
  groupBy?: "run";
  windowCompare?: string;
  windows?: WindowSpec[];
  /**
   * Clock seam for the health read path. Defaults to `Date.now`. Tests may pin
   * this to a fixed epoch so staleness/window math is deterministic. Purely
   * additive — when omitted, behaviour is identical to calling `Date.now()`.
   */
  now?: () => number;
  /**
   * C2 (#499): explicit state.db path override. Defaults to
   * `getStateDbPathInDataDir()` (the `XDG_DATA_HOME`-derived path). Tests pass a
   * path from their isolated storage root so the entire health read is pinned to
   * one file and never re-reads `process.env` — immune to a parallel test file
   * mutating `XDG_DATA_HOME` across an await boundary and redirecting this read
   * to a foreign/just-deleted DB. Purely additive: omitted ⇒ identical to before.
   */
  stateDbPath?: string;
  /** Stash dir for the `stash-git-exposure` advisory. Defaults to `resolveStashDir()`. */
  stashDir?: string;
  /**
   * Injectable git seam for the `stash-git-exposure` advisory. When omitted, the
   * advisory only runs (via a real `git` subprocess) if the stash is actually a
   * git repo, so the health hot path — including unit tests with non-git sandbox
   * stashes — never spawns. Tests pass a fake to exercise the advisory directly.
   */
  stashExposureGit?: GitRunner;
  /**
   * Probe LLM engine reachability in the engine checks (#914). Off by default
   * so library callers and tests stay offline; the CLI turns it on unless
   * `--no-probe` is given.
   */
  probe?: boolean;
}

const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;

export function parseHealthSince(since?: string): string {
  if (since === undefined || since.trim() === "") {
    return new Date(Date.now() - DEFAULT_SINCE_MS).toISOString();
  }
  const trimmed = since.trim();
  // Unit grammar is the CLI-wide canonical map: `m` = minutes, `M` = months.
  // (Historically `--since 5m` meant 5 months here; it now means 5 minutes,
  // with `5M` for months — unified with consolidate / `--window-compare`.)
  // Not lower-cased: case distinguishes `m` (minutes) from `M` (months).
  const durationMs = parseDuration(trimmed, DURATION_UNITS);
  if (durationMs !== null) {
    return new Date(Date.now() - durationMs).toISOString();
  }
  return parseSinceToIso(trimmed);
}

function validateAkmHealthOptions(options: AkmHealthOptions): void {
  if (options.groupBy !== undefined && options.groupBy !== "run") {
    throw new UsageError(`Invalid value for --group-by: ${options.groupBy}. Expected: run`, "INVALID_FLAG_VALUE");
  }
  if (options.windowCompare !== undefined && options.windows !== undefined && options.windows.length > 0) {
    throw new UsageError("--window-compare and --windows are mutually exclusive.", "INVALID_FLAG_VALUE");
  }
  if (options.windows) {
    if (options.windows.length > 4) {
      throw new UsageError("--windows accepts at most 4 entries.", "INVALID_FLAG_VALUE");
    }
    const seen = new Set<string>();
    for (const spec of options.windows) {
      if (seen.has(spec.name)) {
        throw new UsageError(`--windows has duplicate name: ${spec.name}`, "INVALID_FLAG_VALUE");
      }
      seen.add(spec.name);
    }
  }
}

// ── akmHealth phase helpers (chunk-9 WI-9.5b; file-level decompose following
// the function's natural gather/advise/check/assemble phases) ───────────────

/** Event type appended + read back by the state.db round-trip probe. */
const HEALTH_PROBE_EVENT = "health_probe";

/** Synthetic sentinel ref (ref-grammar decision D-R3): a colon-free
 * `<subsystem>/_<marker>` label. `health` has no asset stash-subdir, so
 * `health/_probe` names the subsystem. */
const HEALTH_PROBE_REF = "health/_probe";

/**
 * Verify state.db can accept a write and read it back — WITHOUT leaving any
 * permanent trace (R-030). Earlier versions appended a `health_probe` event
 * on every `akm health` invocation and never removed it: a read-only health
 * check ran on a cron would grow state.db without bound (the only purge is
 * `improve`'s retention pass, which a health-only user never runs). The probe
 * row inserted here is deleted again inside the SAME connection once the
 * round trip is confirmed, so the net effect on the `events` table is always
 * zero rows — the round trip still genuinely exercises append + read against
 * the real table, it just doesn't accumulate.
 */
export function probeStateDbRoundTrip(stateDbPath: string): { ok: boolean; durationMs: number | null; error?: string } {
  const started = Date.now();
  try {
    return withStateDb(
      (db) => {
        const ts = new Date().toISOString();
        const insertedId = insertEvent(db, {
          eventType: HEALTH_PROBE_EVENT,
          ts,
          ref: HEALTH_PROBE_REF,
          metadata: { source: "akm health" },
        });
        const durationMs = Date.now() - started;
        if (insertedId === undefined) {
          return { ok: false, durationMs, error: "probe event insert did not return a row id" };
        }
        // The round-trip matches on the exact (id, eventType, ref) triple
        // written above, then removes the row regardless of outcome — a
        // failed round trip must not leak a row any more than a successful
        // one should.
        let roundTripOk = false;
        try {
          const row = db
            .prepare("SELECT 1 AS present FROM events WHERE id = ? AND event_type = ? AND ref = ?")
            .get(insertedId, HEALTH_PROBE_EVENT, HEALTH_PROBE_REF) as { present: number } | undefined;
          roundTripOk = row !== undefined;
        } finally {
          db.prepare("DELETE FROM events WHERE id = ?").run(insertedId);
        }
        if (!roundTripOk) {
          return { ok: false, durationMs, error: "probe event was not readable after append" };
        }
        return { ok: true, durationMs };
      },
      { path: stateDbPath },
    );
  } catch (err) {
    rethrowIfTestIsolationError(err);
    return { ok: false, durationMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

interface TaskHistoryPhase {
  tableNames: string[];
  missingTables: string[];
  probe: ReturnType<typeof probeStateDbRoundTrip>;
  stateDbIntegrity: ReturnType<typeof runStateDbQuickCheck>;
  stateDbFreelist: ReturnType<typeof getStateDbFreelistInfo>;
  taskRowCount: number;
  stuckActiveRuns: number;
  stuckActiveTasks: { taskId: string; ageMs: number }[];
  taskFailRate: number;
  worstTaskFailRate: { taskId: string; rate: number; rows: number } | null;
  agentFailureRate: number;
  agentFailureReasonCounts: Record<string, number>;
}

/**
 * Item 7: dedupe stuck-active rows by task_id (keeping the oldest/largest age
 * per id) so the `active-runs` check can name WHICH tasks are stuck instead of
 * just a count. No pid/liveness probing — purely a projection of the rows
 * already read.
 */
function dedupeStuckActiveTasks(
  rows: { task_id: string; started_at: string }[],
  now: () => number,
): { taskId: string; ageMs: number }[] {
  const byTask = new Map<string, number>();
  for (const row of rows) {
    const ageMs = now() - new Date(row.started_at).getTime();
    const existing = byTask.get(row.task_id);
    if (existing === undefined || ageMs > existing) byTask.set(row.task_id, ageMs);
  }
  return [...byTask.entries()].map(([taskId, ageMs]) => ({ taskId, ageMs }));
}

/**
 * Item 6: group task_history rows by task_id and return the one with the
 * highest fail rate among tasks with at least MIN_ROWS_FOR_WORST_TASK_FAIL_RATE
 * rows in the window — surfaces a consistently-failing task that a large,
 * mostly-healthy population would otherwise hide behind the aggregate rate.
 * `null` when no task_id meets the row-count floor. Ties break toward the
 * task with more rows (a stronger signal), then by task_id for determinism.
 */
function computeWorstTaskFailRate(
  rows: { task_id: string; status: string }[],
): { taskId: string; rate: number; rows: number } | null {
  const byTask = new Map<string, { total: number; failed: number }>();
  for (const row of rows) {
    const entry = byTask.get(row.task_id) ?? { total: 0, failed: 0 };
    entry.total += 1;
    if (row.status === "failed") entry.failed += 1;
    byTask.set(row.task_id, entry);
  }
  let worst: { taskId: string; rate: number; rows: number } | null = null;
  for (const [taskId, { total, failed }] of byTask) {
    if (total < MIN_ROWS_FOR_WORST_TASK_FAIL_RATE) continue;
    const rate = failed / total;
    if (
      worst === null ||
      rate > worst.rate ||
      (rate === worst.rate && (total > worst.rows || (total === worst.rows && taskId < worst.taskId)))
    ) {
      worst = { taskId, rate, rows: total };
    }
  }
  return worst;
}

/** Table presence, the state.db round-trip probe, and task_history-derived rates. */
function gatherTaskHistoryPhase(db: Database, since: string, stateDbPath: string, now: () => number): TaskHistoryPhase {
  const tables = listExistingTableNames(db, ["events", "task_history", "proposals", "schema_migrations"]);
  const tableNames = tables.map((row) => row.name).sort();
  const requiredTables = ["events", "proposals", "schema_migrations", "task_history"];
  const missingTables = requiredTables.filter((name) => !tableNames.includes(name));

  const probe = probeStateDbRoundTrip(stateDbPath);
  // R0: read-only, independent of the round-trip probe above — quick_check
  // catches corruption a successful append/read cannot (out-of-order rowids,
  // bad index entry counts), and the freelist reading is purely informational.
  const stateDbIntegrity = runStateDbQuickCheck(stateDbPath);
  const stateDbFreelist = getStateDbFreelistInfo(stateDbPath);

  // D8 (spec §5.3): a marked "command" row or a legacy (unmarked) "prompt"
  // row is the agent/LLM arm; an unmarked "command" row is the legacy
  // native shell/script arm and must not be counted here (see
  // isAgentTaskHistoryRow's header comment, referenced from
  // computeTaskWindowRates, for the full mapping).
  const taskRows = queryTaskHistory(db, { since });
  const rates = computeTaskWindowRates(taskRows, now);

  return {
    tableNames,
    missingTables,
    probe,
    stateDbIntegrity,
    stateDbFreelist,
    taskRowCount: taskRows.length,
    stuckActiveRuns: rates.stuckActiveRuns,
    stuckActiveTasks: dedupeStuckActiveTasks(rates.stuckActiveRows, now),
    taskFailRate: rates.taskFailRate,
    worstTaskFailRate: computeWorstTaskFailRate(taskRows),
    agentFailureRate: rates.agentFailureRate,
    agentFailureReasonCounts: rates.agentFailureReasonCounts,
  };
}

interface EgressConfigPhase {
  egressConfigView: EgressConfigView | undefined;
  /** #949: configured `kind: "llm"` engine names with `enableThinking: false`. */
  thinkingOffEngines: string[];
}

/**
 * Config fields the surfaces advisory and (#949) the `thinking-control`
 * check need. Best-effort: an unloadable config leaves both fields at their
 * empty fallback and the callers degrade to their generic/unknown states.
 */
function gatherEgressConfigPhase(): EgressConfigPhase {
  let egressConfigView: EgressConfigView | undefined;
  let thinkingOffEngines: string[] = [];
  try {
    const config = loadConfig();
    egressConfigView = config as EgressConfigView;
    thinkingOffEngines = Object.entries(config.engines ?? {})
      .filter(([, engine]) => engine.kind === "llm" && engine.enableThinking === false)
      .map(([name]) => name);
  } catch {
    // fall through with undefined/empty
  }
  return { egressConfigView, thinkingOffEngines };
}

/** Extract-ledger outcome counts for the `session-extraction` check's window, independent of `--since`. */
function gatherSessionExtractionLedgerPhase(
  db: Database,
  now: () => number,
): HealthCheckContext["sessionExtractionLedger"] {
  const since = new Date(now() - daysToMs(SESSION_EXTRACTION_LEDGER_WINDOW_DAYS)).toISOString();
  return { since, rows: getExtractOutcomeCountsSince(db, since) };
}

/**
 * The best-effort advisory groups beyond the health-check registry: the
 * `stash-git-exposure` probe, the 08 surfaces group (binary-config-skew,
 * egress-endpoints), `type-directory-disagreement` (#831), `data-dir-usage`
 * (#896), and `plugin-version` (itlackey/akm#832). Order matches emission
 * order in the returned array. A probe/filesystem failure in any try/catch
 * must not abort the health report — each group degrades to "no advisory"
 * independently.
 */
function gatherAncillaryAdvisories(
  db: Database,
  options: AkmHealthOptions,
  egressConfigView: EgressConfigView | undefined,
): HealthCheckResult[] {
  const advisories: HealthCheckResult[] = [];

  const indexStateMismatch = detectIndexStateGenerationMismatch(db);
  if (indexStateMismatch) advisories.push(indexStateMismatch);

  // 08-F1: surface a `stash-git-exposure` advisory when env/secret assets are
  // git-tracked AND a remote is configured (the leak moment). Best-effort.
  // Cheap guard: only shell out to git when the stash has its OWN `.git` (or a
  // test injected a fake seam), so the hot path never spawns for a non-git
  // stash — the common unit-test case. Trade-off: a stash manually pointed at a
  // bare subdirectory of a parent git repo (no `.git` of its own) is not
  // checked. akm-init always creates `.git` at the stash root, so any
  // akm-initialised stash is covered; this only skips hand-pointed nested ones.
  try {
    const exposureStashDir = options.stashDir ?? resolveStashDir();
    if (options.stashExposureGit || fs.existsSync(path.join(exposureStashDir, ".git"))) {
      const stashExposure = collectStashExposureAdvisory(exposureStashDir, options.stashExposureGit);
      if (stashExposure) advisories.push(stashExposure);
    }
  } catch {
    // Non-fatal — a git/probe failure must not abort the health report.
  }

  // 08 surfaces: the remaining read-only advisory group (binary-config-skew,
  // egress-endpoints). Best-effort — a filesystem probe failure must not abort
  // the health report.
  try {
    const configSkew = collectConfigSkewAdvisory(getConfigPath());
    if (configSkew) advisories.push(configSkew);
    const egress = collectEgressAdvisory(egressConfigView);
    if (egress) advisories.push(egress);
  } catch {
    // Non-fatal.
  }

  // #831: flag indexed assets whose resolved type disagrees with the type
  // their containing directory declares (see health/type-directory-check.ts).
  // Best-effort — an unreadable index must not abort the health report.
  try {
    const typeDirMismatch = detectTypeDirectoryDisagreements(options.stashDir ?? resolveStashDir());
    if (typeDirMismatch) advisories.push(typeDirMismatch);
  } catch {
    // Non-fatal.
  }

  // #896: report the data dir's total size and its largest top-level
  // subdirectory, so a disk-usage blowup (e.g. unpruned migration snapshot
  // backups, #897) is self-diagnosing instead of requiring `du` archaeology.
  // Best-effort — an unreadable/missing data dir must not abort the health
  // report.
  try {
    const dataDirUsage = collectDataDirUsageAdvisory(getDataDir());
    if (dataDirUsage) advisories.push(dataDirUsage);
  } catch {
    // Non-fatal.
  }

  // itlackey/akm#832: report installed Claude Code harness plugin version(s)
  // and warn when stale or when the plugin's own akm-cli version range no
  // longer admits this CLI. Best-effort — no plugin installed, an unreadable
  // manifest, or a network failure while checking the newest tag must not
  // abort the health report.
  try {
    advisories.push(...collectPluginStalenessAdvisories({ cliVersion: pkgVersion }));
  } catch {
    // Non-fatal.
  }

  return advisories;
}

/**
 * Open index.db read-only, project every entry to `{ filePath, type }`, and
 * build the `type-directory-disagreement` advisory. `stashRoot` is used only
 * to shorten displayed paths (relative to the stash) when it's an ancestor of
 * the entry's path; falls back to the absolute path otherwise. Returns
 * `undefined` when the index is absent/unreadable or nothing disagrees —
 * mirrors {@link detectIndexStateGenerationMismatch}'s best-effort shape.
 */
function detectTypeDirectoryDisagreements(stashRoot: string): HealthCheckResult | undefined {
  let indexDb: ReturnType<typeof openReadonlyExistingDatabase>;
  try {
    indexDb = openReadonlyExistingDatabase(getDbPath());
    if (!indexDb) return undefined;
    const entries = getAllEntries(indexDb).map((entry) => ({ filePath: entry.filePath, type: entry.type }));
    return buildTypeDirectoryAdvisory(entries, undefined, (absPath) =>
      absPath.startsWith(stashRoot) ? path.relative(stashRoot, absPath) : absPath,
    );
  } catch {
    return undefined;
  } finally {
    if (indexDb) {
      try {
        closeDatabase(indexDb);
      } catch {
        // Best-effort advisory: a close failure must not abort health.
      }
    }
  }
}

/**
 * Detect the durable signature of an interrupted cross-database update.
 *
 * `usage_events.entry_ref` is the stable identity while `entry_id` names the
 * current, regenerable index row. A linked event whose id is absent or resolves
 * to a different ref means index.db and state.db describe adjacent generations.
 * Legacy/bare refs and deliberately detached rows are excluded. The scan is
 * streaming and keeps only a bounded evidence sample so health cannot mirror
 * either database into the JS heap.
 *
 * Best-effort by design: an absent/unreadable/incompatible index has its own
 * diagnostics and must not make the state health path throw.
 */
function detectIndexStateGenerationMismatch(stateDb: Database): HealthCheckResult | undefined {
  let indexDb: Database | undefined;
  try {
    indexDb = openReadonlyExistingDatabase(getDbPath());
    if (!indexDb) return undefined;

    const byId = indexDb.prepare<{ item_ref: string | null }>("SELECT item_ref FROM entries WHERE id = ?");
    const rows = stateDb
      .prepare<{ entry_id: number; entry_ref: string }>(
        "SELECT DISTINCT entry_id, entry_ref FROM usage_events " +
          "WHERE entry_id IS NOT NULL AND entry_ref IS NOT NULL AND instr(entry_ref, '//') > 0",
      )
      .iterate();
    let mismatches = 0;
    const sample: Array<{ entryId: number; entryRef: string; indexedRef: string | null }> = [];
    for (const row of rows) {
      const indexedRef = byId.get(row.entry_id)?.item_ref ?? null;
      if (indexedRef === row.entry_ref) continue;
      mismatches += 1;
      if (sample.length < 5) sample.push({ entryId: row.entry_id, entryRef: row.entry_ref, indexedRef });
    }
    if (mismatches === 0) return undefined;
    return {
      name: "index-state-generation",
      kind: "deterministic",
      status: "warn",
      confidence: "high",
      message:
        `${mismatches} durable usage link(s) disagree with the current searchable index generation. ` +
        "Stop concurrent writers and run 'akm index --full' to relink state to the current index.",
      evidence: { mismatches, sample },
    };
  } catch {
    return undefined;
  } finally {
    if (indexDb) {
      try {
        closeDatabase(indexDb);
      } catch {
        // Best-effort advisory: a close failure must not abort health.
      }
    }
  }
}

interface WindowComparePhaseResult {
  windowResults: WindowResult[] | undefined;
  deltas: Record<string, DeltaEntry> | undefined;
}

/**
 * Phase 3 — window-compare mode. Resolves `--window-compare`/`--windows` into
 * per-window bundles and computes deltas between the earliest and latest
 * window. Top-level metrics retain the primary `--since` query.
 */
function resolveWindowComparePhase(
  options: AkmHealthOptions,
  db: Database,
  stateDbPath: string,
  now: () => number,
): WindowComparePhaseResult {
  let windowSpecs: WindowSpec[] | undefined;
  if (options.windowCompare) {
    windowSpecs = resolveWindowCompare(options.windowCompare, now);
  } else if (options.windows && options.windows.length > 0) {
    windowSpecs = options.windows;
  }

  let windowResults: WindowResult[] | undefined;
  let deltas: Record<string, DeltaEntry> | undefined;

  if (windowSpecs) {
    windowResults = windowSpecs.map((spec) => {
      const winSince = parseHealthSince(spec.since);
      const winUntil = spec.until ? parseHealthSince(spec.until) : new Date(now()).toISOString();
      const bundle = buildWindowMetrics(db, stateDbPath, winSince, winUntil, now);
      return {
        name: spec.name,
        since: winSince,
        until: winUntil,
        runs: bundle.runs,
        improve: bundle.improve,
        metrics: bundle.metrics,
      };
    });
    if (windowResults.length >= 2) {
      // Deltas always read chronologically: `from` = earliest window,
      // `to` = latest. Positive pctChange on a failure metric (e.g.
      // distill.llmFailed) means things got WORSE going forward in
      // time; negative means improvement. Window 0 in the output
      // array is whatever the user specified first (typically
      // `current` for --window-compare), but the delta direction is
      // independent of that array order.
      const sorted = [...windowResults].sort((a, b) => new Date(a.since).getTime() - new Date(b.since).getTime());
      deltas = computeDeltas(sorted[0]!, sorted[sorted.length - 1]!);
    }
  }

  return { windowResults, deltas };
}

/**
 * The health report for a state.db the open cannot reach at all: either the
 * file is not readable (#791), or — the same shape, a different cause — the
 * open failed while applying a pending migration, which is left pending.
 *
 * `akm health` is what an operator (or a bundler's boot check) runs when
 * something else is misbehaving, so it must survive either problem long
 * enough to NAME it rather than exit 78 before any check could report.
 *
 * Reported as a single hard-channel `fail` check — the run genuinely could
 * not open state.db, so every check that depends on it is skipped rather than
 * attempted — and it still exits non-zero, just through health's normal
 * `fail` path instead of a thrown config-error exit.
 */
function degradedStateDbReport(hardCheck: HealthCheckResult, options: AkmHealthOptions): AkmHealthResult {
  return {
    schemaVersion: 3,
    ok: false,
    status: "fail",
    since: parseHealthSince(options.since),
    hardChecks: [hardCheck],
    advisories: [],
    metrics: {
      taskFailRate: 0,
      agentFailureRate: 0,
      agentFailureReasonCounts: {},
      stuckActiveRuns: 0,
      llmUsage: emptyLlmUsageAggregate(),
    },
    improve: emptyImproveMetrics(),
  };
}

function unreadableStateDbCheck(detail: string): HealthCheckResult {
  return {
    name: "state-db-readable",
    kind: "deterministic",
    status: "fail",
    confidence: "high",
    message:
      `state.db exists but is not readable: ${detail}. Every other health check is skipped because ` +
      "none of them can read it. Check the owner and mode of the data directory, or point " +
      "AKM_DATA_DIR / XDG_DATA_HOME at a location this user owns.",
    evidence: { detail },
  };
}

export async function akmHealth(options: AkmHealthOptions = {}): Promise<AkmHealthResult> {
  validateAkmHealthOptions(options);
  const now = options.now ?? (() => Date.now());
  const since = parseHealthSince(options.since);
  const stateDbPath = options.stateDbPath ?? getStateDbPathInDataDir();
  const hardChecks: HealthCheckResult[] = [];
  const advisories: HealthCheckResult[] = [];

  // #791: an UNREADABLE state.db, or one whose pending migration failed to
  // apply, are the two failures `akm health` most needs to be able to report,
  // because this is the command an operator (or a bundler's boot check) runs
  // to find out why everything else is behaving oddly. Report it as a finding
  // instead of dying before any check runs. The open itself applies every
  // pending migration; `state-db-migrations` reports what it applied.
  let opened: ReturnType<typeof openStateDatabaseWithReport>;
  try {
    opened = openStateDatabaseWithReport(stateDbPath);
  } catch (error) {
    const { access, code } = classifyPathAccess(stateDbPath);
    if (access === "inaccessible") {
      return degradedStateDbReport(unreadableStateDbCheck(describeInaccessiblePath(stateDbPath, code)), options);
    }
    // A migration that failed to apply rolled back and is still pending:
    // name it from a read-only listing (which never applies anything) rather
    // than pattern-matching the error text. A ledger too broken to enumerate
    // throws here too and falls through to the generic config error below.
    let pendingMigrationsCheck: HealthCheckResult | undefined;
    try {
      pendingMigrationsCheck = runPendingStateMigrationsCheck(stateDbPath, { listPendingStateMigrations });
    } catch {
      pendingMigrationsCheck = undefined;
    }
    if (pendingMigrationsCheck?.status === "fail") {
      return degradedStateDbReport(pendingMigrationsCheck, options);
    }
    throw new ConfigError(
      `Unable to open state.db: ${error instanceof Error ? error.message : String(error)}`,
      "INVALID_CONFIG_FILE",
    );
  }
  const { db } = opened;

  try {
    // Network probes overlap the local database phases below; awaited where consumed.
    const engineProbesPromise = runHealthEngineProbes({ probeReachable: options.probe ? probeLlmEndpoint : undefined });
    engineProbesPromise.catch(() => undefined);
    // #950: same best-effort, --probe-gated discipline as engineProbesPromise
    // above — started here, alongside it, and awaited later.
    const versionDriftPromise = collectVersionDriftAdvisory(Boolean(options.probe), { cliVersion: pkgVersion });
    versionDriftPromise.catch(() => undefined);
    // #953: same --probe-gated, best-effort discipline as versionDriftPromise
    // above.
    const schedulerBinaryDriftPromise = collectSchedulerBinaryAdvisory(Boolean(options.probe), {
      cliVersion: pkgVersion,
    });
    schedulerBinaryDriftPromise.catch(() => undefined);
    const taskHistory = gatherTaskHistoryPhase(db, since, stateDbPath, now);
    const { tableNames, missingTables, probe } = taskHistory;

    const { egressConfigView, thinkingOffEngines } = gatherEgressConfigPhase();

    // Same window bundle `--window-compare` builds per-window (windows.ts) —
    // reused here for the main `--since` window's improve summary and for
    // `--group-by run`, so neither re-reads `improve_runs`.
    const until = new Date(now()).toISOString();
    const { improve: improveSummary, perRunSummaries } = buildImproveWindowSummary(db, stateDbPath, since, until);

    advisories.push(...gatherAncillaryAdvisories(db, options, egressConfigView));

    const sessionExtractionLedger = gatherSessionExtractionLedgerPhase(db, now);

    // #950: computed once (no IO beyond config/env, same as gatherEgressConfigPhase)
    // so `active-improve-strategy` and `engine-last-used` project the same
    // process→engine map instead of each resolving the strategy independently.
    const { check: activeImproveStrategy, processEngines: activeImproveStrategyEngines } = probeActiveImproveStrategy();

    // #950: `engine-last-used` reads a fixed lookback window independent of
    // `--since` (mirrors sessionExtractionLedger's independent window above).
    const engineLastUsedSinceIso = engineLastUsedSince(now);
    const engineLastUsed = readLastEngineUsage(stateDbPath, now);
    const improveRunsInLookbackWindow = countImproveRunsSince(db, engineLastUsedSinceIso);

    const engineProbes = await engineProbesPromise;
    const versionDrift = await versionDriftPromise;
    const schedulerBinaryDrift = await schedulerBinaryDriftPromise;

    // Read once, shared by the `thinking-control` check (#949) and the
    // `metrics.llmUsage` report field below — same window, same aggregate.
    const llmUsage = readLlmUsageAggregate(stateDbPath, since);

    // Run the ordered health-check registry. Each check projects the shared
    // context computed above into one HealthCheckResult; `channel` routes it to
    // hardChecks or advisories. Declaration order in HEALTH_CHECKS is the
    // emission order — see src/commands/health/checks.ts.
    const checkContext: HealthCheckContext = {
      stateDbPath,
      since,
      tableNames,
      missingTables,
      probe,
      stateDbIntegrity: taskHistory.stateDbIntegrity,
      stateDbFreelist: taskHistory.stateDbFreelist,
      stateDbMigrations: { applied: opened.applied, ...(opened.backupPath ? { backupPath: opened.backupPath } : {}) },
      taskRowCount: taskHistory.taskRowCount,
      taskFailRate: taskHistory.taskFailRate,
      stuckActiveRuns: taskHistory.stuckActiveRuns,
      stuckActiveTasks: taskHistory.stuckActiveTasks,
      worstTaskFailRate: taskHistory.worstTaskFailRate,
      agentFailureReasonCounts: taskHistory.agentFailureReasonCounts,
      sessionExtractionLedger,
      autoAccept: improveSummary.autoAccept,
      engineProbes,
      thinkingOffEngines,
      llmUsage,
      versionDrift,
      activeImproveStrategy,
      activeImproveStrategyEngines,
      engineLastUsed,
      improveRunsInLookbackWindow,
      schedulerBinaryDrift,
    };
    for (const check of HEALTH_CHECKS) {
      const result = check.run(checkContext);
      if (check.channel === "hard") hardChecks.push(result);
      else advisories.push(result);
    }

    const metrics: HealthMetrics = {
      taskFailRate: roundRate(taskHistory.taskFailRate),
      agentFailureRate: roundRate(taskHistory.agentFailureRate),
      agentFailureReasonCounts: taskHistory.agentFailureReasonCounts,
      stuckActiveRuns: taskHistory.stuckActiveRuns,
      llmUsage,
    };

    const hardFailure = hardChecks.some((check) => check.status === "fail");
    const deterministicWarnings = [...hardChecks, ...advisories].some(
      (check) => check.status === "warn" && check.kind === "deterministic",
    );
    const status: AkmHealthResult["status"] = hardFailure ? "fail" : deterministicWarnings ? "warn" : "pass";

    // ── Window-compare mode (Phase 3) ─────────────────────────────────────
    const { windowResults, deltas } = resolveWindowComparePhase(options, db, stateDbPath, now);

    // ── Per-run mode (Phase 2) ────────────────────────────────────────────
    const runs: ImproveRunSummary[] | undefined = options.groupBy === "run" ? perRunSummaries : undefined;

    return {
      schemaVersion: 3,
      ok: !hardFailure,
      status,
      since,
      hardChecks,
      advisories,
      metrics,
      improve: improveSummary,
      ...(runs ? { runs } : {}),
      ...(windowResults ? { windows: windowResults } : {}),
      ...(deltas ? { deltas } : {}),
    };
  } finally {
    db.close();
  }
}

// Markdown renderers (renderRunsDetailMd / renderWindowCompareMd) live in
// health/md-report.ts, mirroring the HTML extraction in health/html-report.ts.
