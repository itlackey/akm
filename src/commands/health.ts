// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { loadConfig } from "../core/config";
import { ConfigError, UsageError } from "../core/errors";
import { appendEvent, readEvents } from "../core/events";
import { getStateDbPathInDataDir } from "../core/paths";
import { openStateDatabase, queryTaskHistory, type TaskHistoryRow } from "../core/state-db";
import { parseSinceToIso } from "../core/time";
import { readSemanticStatus } from "../indexer/semantic-status";
import type { AgentProfile } from "../integrations/agent";
import { detectAgentCliProfiles, requireAgentProfile } from "../integrations/agent";
import type { SessionLogEntry } from "../integrations/session-logs";
import { getExecutionLogCandidates } from "../integrations/session-logs";

export interface HealthCheckResult {
  name: string;
  kind: "deterministic" | "heuristic";
  status: "pass" | "warn" | "fail" | "unknown";
  message: string;
  confidence: "high" | "medium" | "low";
  evidence?: Record<string, unknown>;
}

export interface HealthMetrics {
  taskFailRate: number;
  agentFailureRate: number;
  stuckActiveRuns: number;
  logBackingRate: number;
  probeRoundTripMs: number | null;
}

export interface ImproveHealthMetrics {
  invoked: number;
  completed: number;
  skipped: number;
  skipReasons: Record<string, number>;
  plannedRefs: number;
  actions: {
    /**
     * Reflect action outcomes split by mode. Sourced from improve_runs.result_json
     * rather than the lossy events.metadata projection.
     */
    reflect: {
      ok: number;
      failed: number;
      cooldown: number;
      skipped: number;
    };
    /**
     * Distill outcomes split by `AkmDistillResult.outcome`. `skipped` here is
     * the distill-skipped action mode (cooldown), not the same as
     * `outcome: "skipped"` inside a successful distill envelope.
     */
    distill: {
      queued: number;
      llmFailed: number;
      qualityRejected: number;
      configDisabled: number;
      skipped: number;
    };
    memoryPrune: number;
    memoryInference: number;
    graphExtraction: number;
    error: number;
  };
  reflectsWithErrorContext: number;
  coverageGapCount: number;
  executionLogCandidateCount: number;
  evalCasesWritten: number;
  deadUrlCount: number;
  memorySummary: {
    eligible: number;
    derived: number;
  };
  memoryCleanup: {
    pruneCandidates: number;
    contradictionCandidates: number;
    beliefStateTransitions: number;
    consolidationCandidates: number;
    archived: number;
    warnings: number;
  };
  consolidation: {
    ran: boolean;
    processed: number;
    promoted: number;
    merged: number;
    deleted: number;
    contradicted: number;
    durationMs: number;
  };
  memoryInference: {
    ran: boolean;
    considered: number;
    splitParents: number;
    written: number;
    skippedNoFacts: number;
    /** written / considered, 4dp; 0 when considered=0. */
    yieldRate: number;
    durationMs: number;
    /** @deprecated use `written` — kept as a soft-compat alias through 0.8.0. */
    writes: number;
  };
  graphExtraction: {
    ran: boolean;
    extractedFiles: number;
    entities: number;
    relations: number;
    cacheHits: number;
    cacheMisses: number;
    /** hits / (hits + misses), 4dp; 0 when both are 0. */
    cacheHitRate: number;
    truncations: number;
    failures: number;
    durationMs: number;
  };
  wallTime: {
    count: number;
    medianMs: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
  };
}

export interface SessionLogAdvisory {
  topic: string;
  frequency: number;
  source: string;
  isFailurePattern: boolean;
}

export interface AkmHealthResult {
  schemaVersion: 2;
  ok: boolean;
  status: "pass" | "warn" | "fail";
  since: string;
  hardChecks: HealthCheckResult[];
  advisories: HealthCheckResult[];
  metrics: HealthMetrics;
  improve: ImproveHealthMetrics;
  sessionLogAdvisories: SessionLogAdvisory[];
}

export interface AkmHealthOptions {
  since?: string;
  getExecutionLogCandidatesFn?: (sinceDays?: number) => SessionLogEntry[];
}

const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;
const IMPROVE_COMPLETED_EVENT = "improve_completed";
const HEALTH_PROBE_EVENT = "health_probe";
const ACTIVE_RUN_WARN_MS = 15 * 60 * 1000;

export function parseHealthSince(since?: string): string {
  if (since === undefined || since.trim() === "") {
    return new Date(Date.now() - DEFAULT_SINCE_MS).toISOString();
  }
  const trimmed = since.trim();
  const durationMatch = trimmed.match(/^(\d+)([dhm])$/i);
  if (durationMatch) {
    const amount = Number.parseInt(durationMatch[1] ?? "0", 10);
    const unit = (durationMatch[2] ?? "d").toLowerCase();
    if (!Number.isFinite(amount) || amount < 0) {
      throw new UsageError("--since must be a non-negative duration or timestamp.", "INVALID_FLAG_VALUE");
    }
    const multiplier = unit === "h" ? 60 * 60 * 1000 : unit === "m" ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    return new Date(Date.now() - amount * multiplier).toISOString();
  }
  return parseSinceToIso(trimmed);
}

function roundRate(value: number): number {
  return Number(value.toFixed(4));
}

function parseTaskMetadata(row: TaskHistoryRow): {
  durationMs?: number;
  detail?: Record<string, unknown>;
  profile?: string;
} {
  try {
    return JSON.parse(row.metadata_json) as { durationMs?: number; detail?: Record<string, unknown>; profile?: string };
  } catch {
    return {};
  }
}

function createUnknownImproveMetrics(): ImproveHealthMetrics {
  return {
    invoked: 0,
    completed: 0,
    skipped: 0,
    skipReasons: {},
    plannedRefs: 0,
    actions: {
      reflect: { ok: 0, failed: 0, cooldown: 0, skipped: 0 },
      distill: { queued: 0, llmFailed: 0, qualityRejected: 0, configDisabled: 0, skipped: 0 },
      memoryPrune: 0,
      memoryInference: 0,
      graphExtraction: 0,
      error: 0,
    },
    reflectsWithErrorContext: 0,
    coverageGapCount: 0,
    executionLogCandidateCount: 0,
    evalCasesWritten: 0,
    deadUrlCount: 0,
    memorySummary: { eligible: 0, derived: 0 },
    memoryCleanup: {
      pruneCandidates: 0,
      contradictionCandidates: 0,
      beliefStateTransitions: 0,
      consolidationCandidates: 0,
      archived: 0,
      warnings: 0,
    },
    consolidation: { ran: false, processed: 0, promoted: 0, merged: 0, deleted: 0, contradicted: 0, durationMs: 0 },
    memoryInference: {
      ran: false,
      considered: 0,
      splitParents: 0,
      written: 0,
      skippedNoFacts: 0,
      yieldRate: 0,
      durationMs: 0,
      writes: 0,
    },
    graphExtraction: {
      ran: false,
      extractedFiles: 0,
      entities: 0,
      relations: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheHitRate: 0,
      truncations: 0,
      failures: 0,
      durationMs: 0,
    },
    wallTime: { count: 0, medianMs: 0, p95Ms: 0, minMs: 0, maxMs: 0 },
  };
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * Event-derived metrics. Only `completed` and skipReasons/invoked are sourced
 * from events in v2 — the richer fields come from {@link summarizeImproveRuns}.
 * The function still receives `improve_completed` events so that the completed
 * count reflects the canonical event stream (it lines up 1:1 with improve_runs
 * rows in practice, but the events table remains the system-of-record for the
 * existence of a run).
 */
function summarizeImproveCompleted(events: ReturnType<typeof readEvents>["events"]): ImproveHealthMetrics {
  const metrics = createUnknownImproveMetrics();
  metrics.completed = events.length;
  return metrics;
}

function summarizeImproveRuns(db: Database, since: string): { metrics: ImproveHealthMetrics; runCount: number } {
  const metrics = createUnknownImproveMetrics();
  const rows = db
    .prepare("SELECT result_json FROM improve_runs WHERE started_at >= ? AND dry_run = 0")
    .all(since) as Array<{ result_json: string }>;

  for (const row of rows) {
    let result: Record<string, unknown>;
    try {
      result = JSON.parse(row.result_json) as Record<string, unknown>;
    } catch {
      continue;
    }

    // plannedRefs (array of {ref, reason})
    const plannedRefs = result.plannedRefs;
    if (Array.isArray(plannedRefs)) metrics.plannedRefs += plannedRefs.length;

    // actions: split reflect / distill by outcome, count others.
    const actions = result.actions;
    if (Array.isArray(actions)) {
      for (const action of actions as Array<Record<string, unknown>>) {
        const mode = typeof action.mode === "string" ? action.mode : "";
        switch (mode) {
          case "reflect":
            metrics.actions.reflect.ok += 1;
            break;
          case "reflect-failed":
            metrics.actions.reflect.failed += 1;
            break;
          case "reflect-cooldown":
            metrics.actions.reflect.cooldown += 1;
            break;
          case "reflect-skipped":
            metrics.actions.reflect.skipped += 1;
            break;
          case "distill": {
            const r = action.result as Record<string, unknown> | undefined;
            const outcome = typeof r?.outcome === "string" ? r.outcome : "";
            switch (outcome) {
              case "queued":
                metrics.actions.distill.queued += 1;
                break;
              case "llm_failed":
                metrics.actions.distill.llmFailed += 1;
                break;
              case "quality_rejected":
              case "review_needed":
              case "validation_failed":
                metrics.actions.distill.qualityRejected += 1;
                break;
              case "config_disabled":
                metrics.actions.distill.configDisabled += 1;
                break;
              default:
                // outcome==="skipped" or unknown — fall through; "skipped" here
                // is distinct from the distill-skipped action mode (cooldown).
                break;
            }
            break;
          }
          case "distill-skipped":
            metrics.actions.distill.skipped += 1;
            break;
          case "memory-prune":
            metrics.actions.memoryPrune += 1;
            break;
          case "memory-inference":
            metrics.actions.memoryInference += 1;
            break;
          case "graph-extraction":
            metrics.actions.graphExtraction += 1;
            break;
          case "error":
            metrics.actions.error += 1;
            break;
        }
      }
    }

    metrics.reflectsWithErrorContext += toFiniteNumber(result.reflectsWithErrorContext);
    if (Array.isArray(result.coverageGaps)) metrics.coverageGapCount += result.coverageGaps.length;
    if (Array.isArray(result.executionLogCandidates))
      metrics.executionLogCandidateCount += result.executionLogCandidates.length;
    metrics.evalCasesWritten += toFiniteNumber(result.evalCasesWritten);
    if (Array.isArray(result.deadUrls)) metrics.deadUrlCount += result.deadUrls.length;

    const memorySummary = result.memorySummary as Record<string, unknown> | undefined;
    if (memorySummary) {
      metrics.memorySummary.eligible += toFiniteNumber(memorySummary.eligible);
      metrics.memorySummary.derived += toFiniteNumber(memorySummary.derived);
    }

    const memoryCleanup = result.memoryCleanup as Record<string, unknown> | undefined;
    if (memoryCleanup) {
      if (Array.isArray(memoryCleanup.pruneCandidates))
        metrics.memoryCleanup.pruneCandidates += memoryCleanup.pruneCandidates.length;
      if (Array.isArray(memoryCleanup.contradictionCandidates))
        metrics.memoryCleanup.contradictionCandidates += memoryCleanup.contradictionCandidates.length;
      if (Array.isArray(memoryCleanup.beliefStateTransitions))
        metrics.memoryCleanup.beliefStateTransitions += memoryCleanup.beliefStateTransitions.length;
      if (Array.isArray(memoryCleanup.consolidationCandidates))
        metrics.memoryCleanup.consolidationCandidates += memoryCleanup.consolidationCandidates.length;
      if (Array.isArray(memoryCleanup.archived)) metrics.memoryCleanup.archived += memoryCleanup.archived.length;
      if (Array.isArray(memoryCleanup.warnings)) metrics.memoryCleanup.warnings += memoryCleanup.warnings.length;
    }

    const consolidation = result.consolidation as Record<string, unknown> | undefined;
    if (consolidation) {
      metrics.consolidation.processed += toFiniteNumber(consolidation.processed);
      metrics.consolidation.merged += toFiniteNumber(consolidation.merged);
      metrics.consolidation.deleted += toFiniteNumber(consolidation.deleted);
      metrics.consolidation.contradicted += toFiniteNumber(consolidation.contradicted);
      if (Array.isArray(consolidation.promoted)) metrics.consolidation.promoted += consolidation.promoted.length;
      metrics.consolidation.durationMs += toFiniteNumber(consolidation.durationMs);
    }

    const memoryInference = result.memoryInference as Record<string, unknown> | undefined;
    if (memoryInference) {
      metrics.memoryInference.considered += toFiniteNumber(memoryInference.considered);
      metrics.memoryInference.splitParents += toFiniteNumber(memoryInference.splitParents);
      metrics.memoryInference.written += toFiniteNumber(memoryInference.writtenFacts);
      metrics.memoryInference.skippedNoFacts += toFiniteNumber(memoryInference.skippedNoFacts);
      // memory-inference durationMs is not on MemoryInferenceResult directly;
      // it's recorded on the post-loop envelope as memoryInferenceDurationMs.
    }
    metrics.memoryInference.durationMs += toFiniteNumber(result.memoryInferenceDurationMs);

    const graphExtraction = result.graphExtraction as Record<string, unknown> | undefined;
    if (graphExtraction) {
      const quality = graphExtraction.quality as Record<string, unknown> | undefined;
      if (quality) metrics.graphExtraction.extractedFiles += toFiniteNumber(quality.extractedFiles);
      metrics.graphExtraction.entities += toFiniteNumber(graphExtraction.totalEntities);
      metrics.graphExtraction.relations += toFiniteNumber(graphExtraction.totalRelations);
      const telemetry = graphExtraction.telemetry as Record<string, unknown> | undefined;
      if (telemetry) {
        metrics.graphExtraction.cacheHits += toFiniteNumber(telemetry.cacheHits);
        metrics.graphExtraction.cacheMisses += toFiniteNumber(telemetry.cacheMisses);
        metrics.graphExtraction.truncations += toFiniteNumber(telemetry.truncationCount);
        metrics.graphExtraction.failures += toFiniteNumber(telemetry.failureCount);
      }
    }
    metrics.graphExtraction.durationMs += toFiniteNumber(result.graphExtractionDurationMs);
  }

  // Derived flags / rates.
  metrics.consolidation.ran =
    metrics.consolidation.processed > 0 ||
    metrics.consolidation.durationMs > 0 ||
    metrics.consolidation.promoted > 0 ||
    metrics.consolidation.merged > 0 ||
    metrics.consolidation.deleted > 0 ||
    metrics.consolidation.contradicted > 0;
  metrics.memoryInference.ran =
    metrics.memoryInference.considered > 0 ||
    metrics.memoryInference.written > 0 ||
    metrics.memoryInference.durationMs > 0;
  metrics.memoryInference.writes = metrics.memoryInference.written;
  metrics.memoryInference.yieldRate =
    metrics.memoryInference.considered > 0
      ? roundRate(metrics.memoryInference.written / metrics.memoryInference.considered)
      : 0;
  metrics.graphExtraction.ran =
    metrics.graphExtraction.extractedFiles > 0 ||
    metrics.graphExtraction.entities > 0 ||
    metrics.graphExtraction.durationMs > 0;
  const cacheTotal = metrics.graphExtraction.cacheHits + metrics.graphExtraction.cacheMisses;
  metrics.graphExtraction.cacheHitRate = cacheTotal > 0 ? roundRate(metrics.graphExtraction.cacheHits / cacheTotal) : 0;

  return { metrics, runCount: rows.length };
}

function computeWallTimeStats(durationsMs: number[]): ImproveHealthMetrics["wallTime"] {
  if (durationsMs.length === 0) return { count: 0, medianMs: 0, p95Ms: 0, minMs: 0, maxMs: 0 };
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    count: sorted.length,
    medianMs: pick(0.5),
    p95Ms: pick(0.95),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

function collectImproveWallTimes(db: Database, since: string): number[] {
  const rows = db
    .prepare(
      "SELECT started_at, completed_at FROM task_history WHERE task_id = 'akm-improve' AND started_at >= ? AND completed_at IS NOT NULL",
    )
    .all(since) as Array<{ started_at: string; completed_at: string }>;
  const out: number[] = [];
  for (const row of rows) {
    const startMs = new Date(row.started_at).getTime();
    const endMs = new Date(row.completed_at).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
      out.push(endMs - startMs);
    }
  }
  return out;
}

function buildImproveSkipSummary(events: ReturnType<typeof readEvents>["events"]): {
  skipped: number;
  skipReasons: Record<string, number>;
} {
  const skipReasons: Record<string, number> = {};
  for (const event of events) {
    const reason =
      typeof event.metadata?.reason === "string" && event.metadata.reason.trim() ? event.metadata.reason : "unknown";
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
  }
  return { skipped: events.length, skipReasons };
}

function probeStateDbRoundTrip(stateDbPath: string): { ok: boolean; durationMs: number | null; error?: string } {
  const before = readEvents({}, { dbPath: stateDbPath }).nextOffset;
  const started = Date.now();
  appendEvent(
    { eventType: HEALTH_PROBE_EVENT, ref: "health:probe", metadata: { source: "akm health" } },
    { dbPath: stateDbPath },
  );
  const after = readEvents(
    { sinceOffset: before, type: HEALTH_PROBE_EVENT, ref: "health:probe" },
    { dbPath: stateDbPath },
  );
  const durationMs = Date.now() - started;
  if (after.events.length === 0 || after.nextOffset <= before) {
    return { ok: false, durationMs, error: "probe event was not readable after append" };
  }
  return { ok: true, durationMs };
}

function runAgentProbe(): HealthCheckResult {
  const config = loadConfig();

  // v2: check profiles.agent first
  if (config.profiles?.agent) {
    const defaultName = config.defaults?.agent;
    const profileCount = Object.keys(config.profiles.agent).length;
    if (profileCount === 0) {
      return {
        name: "agent-profile",
        kind: "deterministic",
        status: "unknown",
        confidence: "high",
        message: "No agent profiles configured in profiles.agent.",
      };
    }
    const profileName = defaultName ?? Object.keys(config.profiles.agent)[0];
    const profile = config.profiles.agent[profileName];
    return {
      name: "agent-profile",
      kind: "deterministic",
      status: "pass",
      confidence: "high",
      message: `v2 agent profile "${profileName}" configured (platform: ${profile?.platform ?? "unknown"}).`,
      evidence: { profile: profileName, platform: profile?.platform, profileCount },
    };
  }

  if (!config.profiles?.agent && !config.defaults?.agent) {
    return {
      name: "agent-profile",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: "No agent config present.",
    };
  }

  let profile: AgentProfile;
  try {
    profile = requireAgentProfile(config);
  } catch (error) {
    return {
      name: "agent-profile",
      kind: "deterministic",
      status: "warn",
      confidence: "high",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (profile.sdkMode === true) {
    return {
      name: "agent-profile",
      kind: "deterministic",
      status: profile.model ? "pass" : "warn",
      confidence: "high",
      message: profile.model
        ? `SDK mode profile "${profile.name}" is configured.`
        : `SDK mode profile "${profile.name}" has no explicit model.`,
      evidence: { profile: profile.name, sdkMode: true, model: profile.model ?? null },
    };
  }

  const detections = detectAgentCliProfiles(config);
  const detection = detections.find((entry) => entry.name === profile.name);
  if (!detection?.available) {
    return {
      name: "agent-profile",
      kind: "deterministic",
      status: "fail",
      confidence: "high",
      message: `Default agent profile "${profile.name}" is not available on PATH.`,
      evidence: { profile: profile.name, bin: profile.bin },
    };
  }

  const version = spawnSync(profile.bin, ["--version"], { encoding: "utf8", timeout: 5_000 });
  if ((version.status ?? 1) !== 0) {
    return {
      name: "agent-profile",
      kind: "deterministic",
      status: "warn",
      confidence: "medium",
      message: `Agent binary "${profile.bin}" was found but \`--version\` failed.`,
      evidence: {
        profile: profile.name,
        bin: profile.bin,
        exitCode: version.status ?? null,
        stderr: (version.stderr ?? "").trim(),
      },
    };
  }

  return {
    name: "agent-profile",
    kind: "deterministic",
    status: "pass",
    confidence: "high",
    message: `Agent profile "${profile.name}" is available.`,
    evidence: { profile: profile.name, bin: profile.bin, version: (version.stdout ?? "").trim() },
  };
}

export function akmHealth(options: AkmHealthOptions = {}): AkmHealthResult {
  const since = parseHealthSince(options.since);
  const stateDbPath = getStateDbPathInDataDir();
  const hardChecks: HealthCheckResult[] = [];
  const advisories: HealthCheckResult[] = [];
  const getExecutionLogCandidatesFn = options.getExecutionLogCandidatesFn ?? getExecutionLogCandidates;

  let db: ReturnType<typeof openStateDatabase> | undefined;
  try {
    db = openStateDatabase(stateDbPath);
  } catch (error) {
    throw new ConfigError(
      `Unable to open state.db: ${error instanceof Error ? error.message : String(error)}`,
      "INVALID_CONFIG_FILE",
    );
  }

  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('events', 'task_history', 'proposals', 'schema_migrations') ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((row) => row.name).sort();
    const requiredTables = ["events", "proposals", "schema_migrations", "task_history"];
    const missingTables = requiredTables.filter((name) => !tableNames.includes(name));
    hardChecks.push({
      name: "state-db-schema",
      kind: "deterministic",
      status: missingTables.length === 0 ? "pass" : "fail",
      confidence: "high",
      message:
        missingTables.length === 0
          ? "state.db opened and required tables are present."
          : `state.db is missing required tables: ${missingTables.join(", ")}`,
      evidence: { path: stateDbPath, tables: tableNames },
    });

    const probe = probeStateDbRoundTrip(stateDbPath);
    hardChecks.push({
      name: "state-db-round-trip",
      kind: "deterministic",
      status: probe.ok ? "pass" : "fail",
      confidence: "high",
      message: probe.ok ? "state.db append/read round-trip succeeded." : `state.db round-trip failed: ${probe.error}`,
      evidence: { path: stateDbPath, durationMs: probe.durationMs },
    });

    const taskRows = queryTaskHistory(db, { since });
    const taskRowsWithLogs = taskRows.filter((row) => row.log_path !== null);
    const existingLogRows = taskRowsWithLogs.filter((row) => row.log_path && fs.existsSync(row.log_path));
    const failedTaskRows = taskRows.filter((row) => row.status === "failed");
    const activeRows = taskRows.filter((row) => row.status === "active");
    const stuckActiveRuns = activeRows.filter(
      (row) => Date.now() - new Date(row.started_at).getTime() > ACTIVE_RUN_WARN_MS,
    ).length;
    const promptRows = taskRows.filter((row) => row.target_kind === "prompt");
    const promptFailures = promptRows.filter((row) => {
      const detail = parseTaskMetadata(row).detail;
      return typeof detail?.reason === "string" && detail.reason.length > 0;
    });
    const logBackingRate = taskRowsWithLogs.length === 0 ? 1 : existingLogRows.length / taskRowsWithLogs.length;
    const taskFailRate = taskRows.length === 0 ? 0 : failedTaskRows.length / taskRows.length;
    const agentFailureRate = promptRows.length === 0 ? 0 : promptFailures.length / promptRows.length;

    hardChecks.push({
      name: "task-history-read",
      kind: "deterministic",
      status: "pass",
      confidence: "high",
      message: `Read ${taskRows.length} task-history row(s) since ${since}.`,
      evidence: { rows: taskRows.length, since },
    });
    hardChecks.push({
      name: "task-log-backing",
      kind: "deterministic",
      status: logBackingRate === 1 ? "pass" : "fail",
      confidence: "high",
      message:
        logBackingRate === 1
          ? "Every task_history log_path resolved on disk."
          : `${taskRowsWithLogs.length - existingLogRows.length} task log(s) referenced in task_history are missing.`,
      evidence: { totalWithLogs: taskRowsWithLogs.length, existingLogs: existingLogRows.length },
    });
    hardChecks.push({
      name: "active-runs",
      kind: "deterministic",
      status: stuckActiveRuns === 0 ? "pass" : "warn",
      confidence: "high",
      message:
        stuckActiveRuns === 0
          ? "No active task runs exceeded the stale threshold."
          : `${stuckActiveRuns} active task run(s) are older than ${Math.round(ACTIVE_RUN_WARN_MS / 60000)} minutes.`,
      evidence: { stuckActiveRuns },
    });

    hardChecks.push(runAgentProbe());

    const semanticStatus = readSemanticStatus();
    advisories.push({
      name: "semantic-search-runtime",
      kind: "deterministic",
      status:
        !semanticStatus ||
        semanticStatus.status === "pending" ||
        semanticStatus.status === "ready-js" ||
        semanticStatus.status === "ready-vec"
          ? "pass"
          : "warn",
      confidence: "medium",
      message: semanticStatus
        ? `Semantic search status: ${semanticStatus.status}`
        : "No semantic-search runtime status recorded yet.",
      evidence: semanticStatus ? { ...semanticStatus } : undefined,
    });

    const improveInvoked = readEvents({ since, type: "improve_invoked" }, { dbPath: stateDbPath }).events.length;
    const improveCompletedEvents = readEvents({ since, type: IMPROVE_COMPLETED_EVENT }, { dbPath: stateDbPath }).events;
    const improveSkippedEvents = readEvents({ since, type: "improve_skipped" }, { dbPath: stateDbPath }).events;
    const eventsMetrics = summarizeImproveCompleted(improveCompletedEvents);
    const { metrics: improveSummary } = summarizeImproveRuns(db, since);
    improveSummary.invoked = improveInvoked;
    improveSummary.completed = eventsMetrics.completed;
    const skipSummary = buildImproveSkipSummary(improveSkippedEvents);
    improveSummary.skipped = skipSummary.skipped;
    improveSummary.skipReasons = skipSummary.skipReasons;
    improveSummary.wallTime = computeWallTimeStats(collectImproveWallTimes(db, since));

    let sessionLogEntries: SessionLogAdvisory[] = [];
    try {
      const sinceDays = Math.max(0, Math.ceil((Date.now() - new Date(since).getTime()) / (24 * 60 * 60 * 1000)));
      sessionLogEntries = getExecutionLogCandidatesFn(sinceDays).map((entry) => ({
        topic: entry.topic,
        frequency: entry.frequency,
        source: entry.source,
        isFailurePattern: entry.isFailurePattern,
      }));
    } catch {
      sessionLogEntries = [];
    }

    advisories.push({
      name: "session-log-failures",
      kind: "heuristic",
      status: sessionLogEntries.length === 0 ? "pass" : "warn",
      confidence: sessionLogEntries.length === 0 ? "low" : "medium",
      message:
        sessionLogEntries.length === 0
          ? "No repeated external session-log failure patterns were detected."
          : `${sessionLogEntries.length} repeated external session-log failure pattern(s) detected.`,
      evidence: { candidates: sessionLogEntries.slice(0, 5) },
    });

    const metrics: HealthMetrics = {
      taskFailRate: roundRate(taskFailRate),
      agentFailureRate: roundRate(agentFailureRate),
      stuckActiveRuns,
      logBackingRate: roundRate(logBackingRate),
      probeRoundTripMs: probe.durationMs,
    };

    const hardFailure = hardChecks.some((check) => check.status === "fail");
    const deterministicWarnings = [...hardChecks, ...advisories].some(
      (check) => check.status === "warn" && check.kind === "deterministic",
    );
    const status: AkmHealthResult["status"] = hardFailure ? "fail" : deterministicWarnings ? "warn" : "pass";

    return {
      schemaVersion: 2,
      ok: !hardFailure,
      status,
      since,
      hardChecks,
      advisories,
      metrics,
      improve: improveSummary,
      sessionLogAdvisories: sessionLogEntries,
    };
  } finally {
    db.close();
  }
}
