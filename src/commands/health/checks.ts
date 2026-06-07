// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawnSync } from "node:child_process";
import { loadConfig } from "../../core/config";
import type { SemanticSearchStatus } from "../../indexer/semantic-status";
import type { AgentProfile } from "../../integrations/agent";
import { detectAgentCliProfiles, requireAgentProfile } from "../../integrations/agent";
import type { HealthCheckResult, ImproveHealthMetrics, SessionLogAdvisory } from "../health";

const ACTIVE_RUN_WARN_MS = 15 * 60 * 1000;

/**
 * Pre-computed inputs shared by the health-check registry. `akmHealth` runs the
 * (verbatim) probes/queries once, populates this context, then dispatches each
 * registered {@link HealthCheck} in declaration order. Keeping all probe state
 * here lets every check be a pure projection — no check re-runs IO — so the
 * emitted hardChecks/advisories arrays are byte-identical to the previous
 * inline implementation.
 */
export interface HealthCheckContext {
  stateDbPath: string;
  since: string;
  /** Sorted names of the state.db tables that exist among the required set. */
  tableNames: string[];
  /** Required tables absent from {@link tableNames}. */
  missingTables: string[];
  /** Result of the append/read round-trip probe. */
  probe: { ok: boolean; durationMs: number | null; error?: string };
  /** Total task_history rows read in the window. */
  taskRowCount: number;
  /** task_history rows whose log_path is non-null. */
  taskRowsWithLogsCount: number;
  /** Subset of {@link taskRowsWithLogsCount} whose log_path resolves on disk. */
  existingLogRowsCount: number;
  logBackingRate: number;
  /** Active runs older than the stale threshold. */
  stuckActiveRuns: number;
  semanticStatus: SemanticSearchStatus | undefined;
  sessionLogEntries: SessionLogAdvisory[];
  sessionExtraction: ImproveHealthMetrics["sessionExtraction"];
  autoAccept: ImproveHealthMetrics["autoAccept"];
}

/** Which array a check's result is collected into. */
export type HealthCheckChannel = "hard" | "advisory";

/**
 * A single health check: a named probe that projects pre-computed context into
 * one {@link HealthCheckResult}. The `channel` decides whether the result lands
 * in `hardChecks` (can gate overall status) or `advisories`.
 */
export interface HealthCheck {
  name: string;
  channel: HealthCheckChannel;
  run(ctx: HealthCheckContext): HealthCheckResult;
}

/**
 * Probe the configured agent profile. Self-contained (reads config + PATH); the
 * only check that performs IO at dispatch time, preserving the original inline
 * `runAgentProbe()` call site behaviour exactly.
 */
export function runAgentProbe(): HealthCheckResult {
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

/**
 * The ordered health-check registry. ORDER IS LOAD-BEARING: `akmHealth`
 * iterates this array and appends to hardChecks/advisories in sequence, so the
 * declaration order below is exactly the emission order (hard checks first in
 * their array, advisories in theirs). Each `run` is a verbatim copy of the
 * corresponding former inline block.
 */
export const HEALTH_CHECKS: readonly HealthCheck[] = [
  {
    name: "state-db-schema",
    channel: "hard",
    run: (ctx) => ({
      name: "state-db-schema",
      kind: "deterministic",
      status: ctx.missingTables.length === 0 ? "pass" : "fail",
      confidence: "high",
      message:
        ctx.missingTables.length === 0
          ? "state.db opened and required tables are present."
          : `state.db is missing required tables: ${ctx.missingTables.join(", ")}`,
      evidence: { path: ctx.stateDbPath, tables: ctx.tableNames },
    }),
  },
  {
    name: "state-db-round-trip",
    channel: "hard",
    run: (ctx) => ({
      name: "state-db-round-trip",
      kind: "deterministic",
      status: ctx.probe.ok ? "pass" : "fail",
      confidence: "high",
      message: ctx.probe.ok
        ? "state.db append/read round-trip succeeded."
        : `state.db round-trip failed: ${ctx.probe.error}`,
      evidence: { path: ctx.stateDbPath, durationMs: ctx.probe.durationMs },
    }),
  },
  {
    name: "task-history-read",
    channel: "hard",
    run: (ctx) => ({
      name: "task-history-read",
      kind: "deterministic",
      status: "pass",
      confidence: "high",
      message: `Read ${ctx.taskRowCount} task-history row(s) since ${ctx.since}.`,
      evidence: { rows: ctx.taskRowCount, since: ctx.since },
    }),
  },
  {
    name: "task-log-backing",
    channel: "hard",
    run: (ctx) => ({
      name: "task-log-backing",
      kind: "deterministic",
      status: ctx.logBackingRate === 1 ? "pass" : "fail",
      confidence: "high",
      message:
        ctx.logBackingRate === 1
          ? "Every task_history log_path resolved on disk."
          : `${ctx.taskRowsWithLogsCount - ctx.existingLogRowsCount} task log(s) referenced in task_history are missing.`,
      evidence: { totalWithLogs: ctx.taskRowsWithLogsCount, existingLogs: ctx.existingLogRowsCount },
    }),
  },
  {
    name: "active-runs",
    channel: "hard",
    run: (ctx) => ({
      name: "active-runs",
      kind: "deterministic",
      status: ctx.stuckActiveRuns === 0 ? "pass" : "warn",
      confidence: "high",
      message:
        ctx.stuckActiveRuns === 0
          ? "No active task runs exceeded the stale threshold."
          : `${ctx.stuckActiveRuns} active task run(s) are older than ${Math.round(ACTIVE_RUN_WARN_MS / 60000)} minutes.`,
      evidence: { stuckActiveRuns: ctx.stuckActiveRuns },
    }),
  },
  {
    name: "agent-profile",
    channel: "hard",
    run: () => runAgentProbe(),
  },
  {
    name: "semantic-search-runtime",
    channel: "advisory",
    run: (ctx) => ({
      name: "semantic-search-runtime",
      kind: "deterministic",
      status:
        !ctx.semanticStatus ||
        ctx.semanticStatus.status === "pending" ||
        ctx.semanticStatus.status === "ready-js" ||
        ctx.semanticStatus.status === "ready-vec"
          ? "pass"
          : "warn",
      confidence: "medium",
      message: ctx.semanticStatus
        ? `Semantic search status: ${ctx.semanticStatus.status}`
        : "No semantic-search runtime status recorded yet.",
      evidence: ctx.semanticStatus ? { ...ctx.semanticStatus } : undefined,
    }),
  },
  {
    // session-log-failures: demoted to informational — the ERROR_PATTERNS regex
    // scans pre-LLM session text and produces false positives on diagnostic
    // conversation. It does not gate the real extraction pipeline (akmExtract).
    // Never triggers warn; kept for backward-compat visibility only.
    name: "session-log-failures",
    channel: "advisory",
    run: (ctx) => ({
      name: "session-log-failures",
      kind: "heuristic",
      status: "pass",
      confidence: "low",
      message:
        ctx.sessionLogEntries.length === 0
          ? "No repeated external session-log failure patterns were detected."
          : `${ctx.sessionLogEntries.length} raw session-log keyword match(es) detected (pre-LLM, informational only).`,
      evidence: { candidates: ctx.sessionLogEntries.slice(0, 5) },
    }),
  },
  {
    name: "session-extraction",
    channel: "advisory",
    run: (ctx) => {
      const sx = ctx.sessionExtraction;
      const sxWarnReasons: string[] = [];
      if (sx.warnings > 0) sxWarnReasons.push(`${sx.warnings} harness error(s)`);
      if (sx.ran && sx.sessionsScanned >= 5 && sx.proposalsCreated === 0)
        sxWarnReasons.push("no proposals generated across scanned sessions");
      return {
        name: "session-extraction",
        kind: "heuristic",
        status: sxWarnReasons.length > 0 ? "warn" : "pass",
        confidence: sx.ran ? "medium" : "low",
        message: sx.ran
          ? sxWarnReasons.length > 0
            ? `Session extraction degraded: ${sxWarnReasons.join("; ")}.`
            : `Session extraction healthy: ${sx.sessionsScanned} scanned, ${sx.sessionsExtracted} extracted, ${sx.proposalsCreated} proposal(s) created.`
          : "Session extraction not active (feature disabled or no harness available).",
        evidence: {
          ran: sx.ran,
          sessionsScanned: sx.sessionsScanned,
          sessionsExtracted: sx.sessionsExtracted,
          sessionsSkipped: sx.sessionsSkipped,
          proposalsCreated: sx.proposalsCreated,
          warnings: sx.warnings,
          durationMs: sx.durationMs,
        },
      };
    },
  },
  {
    name: "auto-accept-validation",
    channel: "advisory",
    run: (ctx) => {
      const aa = ctx.autoAccept;
      return {
        name: "auto-accept-validation",
        kind: "heuristic",
        status: aa.validationFailed > 0 ? "warn" : "pass",
        confidence: aa.promoted + aa.validationFailed > 0 ? "high" : "low",
        message:
          aa.validationFailed > 0
            ? `${aa.validationFailed} proposal(s) passed confidence threshold but failed auto-accept validation (truncated description, invalid frontmatter, etc.) — they remain in the queue for manual review.`
            : aa.promoted > 0
              ? `Auto-accept healthy: ${aa.promoted} proposal(s) promoted, 0 validation failures.`
              : "Auto-accept gate did not run (disabled or no proposals above threshold).",
        evidence: { promoted: aa.promoted, validationFailed: aa.validationFailed },
      };
    },
  },
];
