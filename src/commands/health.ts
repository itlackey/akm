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
    reflect: number;
    distill: number;
    distillSkipped: number;
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
    durationMs: number;
  };
  memoryInference: {
    ran: boolean;
    writes: number;
    durationMs: number;
  };
  graphExtraction: {
    ran: boolean;
    extractedFiles: number;
    durationMs: number;
  };
}

export interface SessionLogAdvisory {
  topic: string;
  frequency: number;
  source: string;
  isFailurePattern: boolean;
}

export interface AkmHealthResult {
  schemaVersion: 1;
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
      reflect: 0,
      distill: 0,
      distillSkipped: 0,
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
    consolidation: { ran: false, processed: 0, durationMs: 0 },
    memoryInference: { ran: false, writes: 0, durationMs: 0 },
    graphExtraction: { ran: false, extractedFiles: 0, durationMs: 0 },
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

function summarizeImproveCompleted(events: ReturnType<typeof readEvents>["events"]): ImproveHealthMetrics {
  const metrics = createUnknownImproveMetrics();
  metrics.completed = events.length;
  for (const event of events) {
    const meta = event.metadata ?? {};
    metrics.plannedRefs += toFiniteNumber(meta.plannedRefs);
    metrics.actions.reflect += toFiniteNumber(meta.reflectActions);
    metrics.actions.distill += toFiniteNumber(meta.distillActions);
    metrics.actions.distillSkipped += toFiniteNumber(meta.distillSkippedActions);
    metrics.actions.memoryPrune += toFiniteNumber(meta.memoryPruneActions);
    metrics.actions.memoryInference += toFiniteNumber(meta.memoryInferenceActions);
    metrics.actions.graphExtraction += toFiniteNumber(meta.graphExtractionActions);
    metrics.actions.error += toFiniteNumber(meta.errorActions);
    metrics.reflectsWithErrorContext += toFiniteNumber(meta.reflectsWithErrorContext);
    metrics.coverageGapCount += toFiniteNumber(meta.coverageGapCount);
    metrics.executionLogCandidateCount += toFiniteNumber(meta.executionLogCandidateCount);
    metrics.evalCasesWritten += toFiniteNumber(meta.evalCasesWritten);
    metrics.deadUrlCount += toFiniteNumber(meta.deadUrlCount);
    metrics.memorySummary.eligible += toFiniteNumber(meta.memoryEligible);
    metrics.memorySummary.derived += toFiniteNumber(meta.memoryDerived);
    metrics.memoryCleanup.pruneCandidates += toFiniteNumber(meta.memoryCleanupPruneCandidates);
    metrics.memoryCleanup.contradictionCandidates += toFiniteNumber(meta.memoryCleanupContradictionCandidates);
    metrics.memoryCleanup.beliefStateTransitions += toFiniteNumber(meta.memoryCleanupBeliefStateTransitions);
    metrics.memoryCleanup.consolidationCandidates += toFiniteNumber(meta.memoryCleanupConsolidationCandidates);
    metrics.memoryCleanup.archived += toFiniteNumber(meta.memoryCleanupArchived);
    metrics.memoryCleanup.warnings += toFiniteNumber(meta.memoryCleanupWarnings);
    metrics.consolidation.processed += toFiniteNumber(meta.consolidationProcessed);
    metrics.consolidation.durationMs += toFiniteNumber(meta.consolidationDurationMs);
    metrics.memoryInference.writes += toFiniteNumber(meta.memoryInferenceWrites);
    metrics.memoryInference.durationMs += toFiniteNumber(meta.memoryInferenceDurationMs);
    metrics.graphExtraction.extractedFiles += toFiniteNumber(meta.graphExtractionExtractedFiles);
    metrics.graphExtraction.durationMs += toFiniteNumber(meta.graphExtractionDurationMs);
  }
  metrics.consolidation.ran = metrics.consolidation.processed > 0 || metrics.consolidation.durationMs > 0;
  metrics.memoryInference.ran = metrics.memoryInference.writes > 0 || metrics.memoryInference.durationMs > 0;
  metrics.graphExtraction.ran = metrics.graphExtraction.extractedFiles > 0 || metrics.graphExtraction.durationMs > 0;
  return metrics;
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
  if (!config.agent) {
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
    profile = requireAgentProfile(config.agent);
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

  const detections = detectAgentCliProfiles(config.agent);
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
    const improveSummary = summarizeImproveCompleted(improveCompletedEvents);
    improveSummary.invoked = improveInvoked;
    const skipSummary = buildImproveSkipSummary(improveSkippedEvents);
    improveSummary.skipped = skipSummary.skipped;
    improveSummary.skipReasons = skipSummary.skipReasons;

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
      schemaVersion: 1,
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
