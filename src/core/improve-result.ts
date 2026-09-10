// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { cloneExecutionJsonObject } from "../execution/json";
import { isRecord } from "./common";
import { IMPROVE_PROCESS_ENGINE_CAPABILITIES } from "./config/engine-semantics";
import type { AkmImproveResult } from "./improve-types";

export type ImproveResultEnvelope = AkmImproveResult;

export interface DecodedImproveResult {
  envelope: ImproveResultEnvelope;
  strategy: string;
}

const COMMON_FIELDS = [
  "schemaVersion",
  "ok",
  "scope",
  "dryRun",
  "notices",
  "skipped",
  "guidance",
  "memorySummary",
  "memoryCleanup",
  "cyclesRun",
  "plannedRefs",
  "plan",
  "actions",
  "skippedProcesses",
  "distillSkipped",
  "validationFailures",
  "schemaRepairs",
  "consolidation",
  "extract",
  "lintSummary",
  "memoryIndexHealth",
  "coverageGaps",
  "evalCasesWritten",
  "deadUrls",
  "deadUrlCoverage",
  "reflectsWithErrorContext",
  "memoryInference",
  "graphExtraction",
  "memoryInferenceDurationMs",
  "graphExtractionDurationMs",
  "orphansPurged",
  "proposalsExpired",
  "reflectCooldownActions",
  "reflectSkippedActions",
  "reflectGuardRejectedActions",
  "gateAutoAcceptedCount",
  "gateAutoAcceptFailedCount",
  "triage",
  "proactiveMaintenance",
  "cycleMetrics",
  "runId",
  "sync",
  "writtenPaths",
  "terminated",
  "usageReport",
] as const;

const V2_FIELDS = new Set<string>([...COMMON_FIELDS, "strategy", "strategyFilteredRefs"]);

function fail(message: string): never {
  throw new Error(`invalid improve-result envelope: ${message}`);
}

function requireExactFields(value: Record<string, unknown>, allowed: Set<string>): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(`unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.sort().join(", ")}`);
}

function requireNumber(value: Record<string, unknown>, field: string, path: string): void {
  if (typeof value[field] !== "number" || !Number.isFinite(value[field])) fail(`${path}.${field} must be a number`);
}

function requireCount(value: Record<string, unknown>, field: string, path: string): void {
  requireNumber(value, field, path);
  if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
    fail(`${path}.${field} must be a non-negative integer`);
  }
}

function validateLoweringNotices(value: unknown): void {
  if (!Array.isArray(value)) fail("notices must be an array");
  for (let index = 0; index < value.length; index += 1) {
    const notice = value[index];
    if (!isRecord(notice)) fail(`notices[${index}] must be an object`);
    requireExactFields(notice, new Set(["code", "severity", "adapter", "field", "message", "details"]));
    for (const field of ["code", "adapter", "message"] as const) {
      if (typeof notice[field] !== "string") fail(`notices[${index}].${field} must be a string`);
    }
    if (notice.severity !== "info" && notice.severity !== "warning") {
      fail(`notices[${index}].severity is invalid`);
    }
    if (notice.field !== undefined && notice.field !== null && typeof notice.field !== "string") {
      fail(`notices[${index}].field must be a string or null`);
    }
    if (notice.details !== undefined && notice.details !== null) {
      try {
        cloneExecutionJsonObject(notice.details, `notices[${index}].details`);
      } catch {
        fail(`notices[${index}].details must be a JSON object or null`);
      }
    }
  }
}

function validateConsolidationPlan(value: unknown): void {
  if (!isRecord(value)) fail("plan.consolidation must be an object");
  requireExactFields(
    value,
    new Set([
      "configured",
      "effective",
      "poolSize",
      "candidatePoolSize",
      "gates",
      "wouldRun",
      "reason",
      "estimatedChunks",
    ]),
  );
  if (!isRecord(value.configured)) fail("plan.consolidation.configured must be an object");
  requireExactFields(
    value.configured,
    new Set(["enabled", "minPoolSize", "limit", "maxChunkSize", "incrementalSince"]),
  );
  if (value.configured.enabled !== undefined && typeof value.configured.enabled !== "boolean") {
    fail("plan.consolidation.configured.enabled must be a boolean");
  }
  for (const field of ["minPoolSize", "limit", "maxChunkSize"] as const) {
    if (value.configured[field] !== undefined && typeof value.configured[field] !== "number") {
      fail(`plan.consolidation.configured.${field} must be a number`);
    }
  }
  if (value.configured.incrementalSince !== undefined && typeof value.configured.incrementalSince !== "string") {
    fail("plan.consolidation.configured.incrementalSince must be a string");
  }
  if (!isRecord(value.effective)) fail("plan.consolidation.effective must be an object");
  requireExactFields(value.effective, new Set(["enabled", "minPoolSize", "limit", "chunkSize"]));
  if (typeof value.effective.enabled !== "boolean") fail("plan.consolidation.effective.enabled must be a boolean");
  requireCount(value.effective, "minPoolSize", "plan.consolidation.effective");
  requireCount(value.effective, "chunkSize", "plan.consolidation.effective");
  if (value.effective.limit !== undefined && typeof value.effective.limit !== "number") {
    fail("plan.consolidation.effective.limit must be a number");
  }
  requireCount(value, "poolSize", "plan.consolidation");
  requireCount(value, "candidatePoolSize", "plan.consolidation");
  requireCount(value, "estimatedChunks", "plan.consolidation");
  if (typeof value.wouldRun !== "boolean") fail("plan.consolidation.wouldRun must be a boolean");
  if (typeof value.reason !== "string") fail("plan.consolidation.reason must be a string");
  if (!isRecord(value.gates)) fail("plan.consolidation.gates must be an object");
  requireExactFields(value.gates, new Set(["profile", "minimumPool", "delta"]));
  for (const gateName of ["profile", "minimumPool", "delta"] as const) {
    const gate = value.gates[gateName];
    if (!isRecord(gate)) fail(`plan.consolidation.gates.${gateName} must be an object`);
    requireExactFields(gate, new Set(["passed", "reason"]));
    if (typeof gate.passed !== "boolean" || typeof gate.reason !== "string") {
      fail(`plan.consolidation.gates.${gateName} must contain boolean passed and string reason`);
    }
  }
}

function validateProactivePlan(value: unknown): void {
  if (!isRecord(value)) fail("plan.proactive must be an object");
  requireExactFields(
    value,
    new Set(["configured", "effective", "candidatePool", "dueTotal", "neverReflected", "selected", "selectedRefs"]),
  );
  if (!isRecord(value.configured)) fail("plan.proactive.configured must be an object");
  requireExactFields(value.configured, new Set(["dueDays", "maxPerRun", "limit"]));
  for (const field of ["dueDays", "maxPerRun", "limit"] as const) {
    if (value.configured[field] !== undefined && typeof value.configured[field] !== "number") {
      fail(`plan.proactive.configured.${field} must be a number`);
    }
  }
  if (!isRecord(value.effective)) fail("plan.proactive.effective must be an object");
  requireExactFields(value.effective, new Set(["dueDays", "maxPerRun"]));
  requireNumber(value.effective, "dueDays", "plan.proactive.effective");
  requireNumber(value.effective, "maxPerRun", "plan.proactive.effective");
  for (const field of ["candidatePool", "dueTotal", "neverReflected", "selected"] as const) {
    requireCount(value, field, "plan.proactive");
  }
  if (!Array.isArray(value.selectedRefs) || value.selectedRefs.some((ref) => typeof ref !== "string")) {
    fail("plan.proactive.selectedRefs must be an array of strings");
  }
  if (value.selected !== value.selectedRefs.length) {
    fail("plan.proactive.selected must equal plan.proactive.selectedRefs.length");
  }
}

/** #947 — plan.processes: one row per IMPROVE_PROCESS_ENGINE_CAPABILITIES name, plus an optional "triage.judgment" row. */
function validateProcessRoutingRows(value: unknown): void {
  if (!Array.isArray(value)) fail("plan.processes must be an array");
  const canonicalNames = Object.keys(IMPROVE_PROCESS_ENGINE_CAPABILITIES);
  const engineKinds = new Set(["llm", "agent", "sdk"]);
  const seen = new Set<string>();
  for (const row of value) {
    if (!isRecord(row)) fail("plan.processes entries must be objects");
    requireExactFields(
      row,
      new Set(["process", "enabled", "engine", "model", "engineKind", "notices", "unavailable", "eligibleRefs"]),
    );
    if (
      typeof row.process !== "string" ||
      !(canonicalNames.includes(row.process) || row.process === "triage.judgment")
    ) {
      fail("plan.processes.process is invalid");
    }
    if (seen.has(row.process)) fail(`plan.processes must not repeat "${row.process}"`);
    seen.add(row.process);
    if (typeof row.enabled !== "boolean") fail("plan.processes.enabled must be a boolean");
    if (row.engine !== undefined && typeof row.engine !== "string") fail("plan.processes.engine must be a string");
    if (row.model !== undefined && typeof row.model !== "string") fail("plan.processes.model must be a string");
    if (row.engineKind !== undefined && (typeof row.engineKind !== "string" || !engineKinds.has(row.engineKind))) {
      fail("plan.processes.engineKind is invalid");
    }
    validateLoweringNotices(row.notices);
    if (row.unavailable !== undefined) {
      if (!isRecord(row.unavailable)) fail("plan.processes.unavailable must be an object");
      requireExactFields(row.unavailable, new Set(["configKey", "reason"]));
      if (typeof row.unavailable.configKey !== "string" || typeof row.unavailable.reason !== "string") {
        fail("plan.processes.unavailable must contain string configKey and reason");
      }
    }
    if (row.eligibleRefs !== undefined) requireCount(row, "eligibleRefs", "plan.processes entry");
  }
  for (const name of canonicalNames) {
    if (!seen.has(name)) fail(`plan.processes must contain exactly one "${name}" row`);
  }
}

function validateImprovePlan(value: unknown, dryRun: boolean, plannedRefNames: readonly string[]): void {
  if (!isRecord(value)) fail("plan must be an object");
  requireExactFields(
    value,
    new Set([
      "mode",
      "dispatch",
      "snapshot",
      "candidates",
      "limits",
      "gates",
      "effectiveRefs",
      "processes",
      "proactive",
      "consolidation",
      "stages",
      "triage",
    ]),
  );
  if (value.mode !== "estimate" && value.mode !== "execution") fail('plan.mode must be "estimate" or "execution"');
  if (typeof value.dispatch !== "boolean") fail("plan.dispatch must be a boolean");
  if ((value.mode === "estimate" && value.dispatch) || (value.mode === "execution" && !value.dispatch)) {
    fail("plan.dispatch must be false for estimate mode and true for execution mode");
  }
  if (dryRun && (value.mode !== "estimate" || value.dispatch !== false)) {
    fail("dryRun=true requires estimate mode with dispatch=false");
  }
  if (!dryRun && (value.mode !== "execution" || value.dispatch !== true)) {
    fail("dryRun=false requires execution mode with dispatch=true");
  }
  if (!isRecord(value.snapshot)) fail("plan.snapshot must be an object");
  requireExactFields(value.snapshot, new Set(["status", "reason"]));
  if (
    typeof value.snapshot.status !== "string" ||
    !new Set(["ready", "missing", "incompatible", "unknown"]).has(value.snapshot.status)
  ) {
    fail("plan.snapshot.status is invalid");
  }
  if (typeof value.snapshot.reason !== "string") fail("plan.snapshot.reason must be a string");
  if (!isRecord(value.candidates)) fail("plan.candidates must be an object");
  requireExactFields(value.candidates, new Set(["rawInScope", "selected", "effective"]));
  for (const field of ["rawInScope", "selected", "effective"] as const) {
    requireCount(value.candidates, field, "plan.candidates");
  }
  if ((value.candidates.rawInScope as number) < (value.candidates.selected as number)) {
    fail("plan.candidates.rawInScope cannot be less than plan.candidates.selected");
  }
  if ((value.candidates.selected as number) < (value.candidates.effective as number)) {
    fail("plan.candidates.selected cannot be less than plan.candidates.effective");
  }
  if (!isRecord(value.limits)) fail("plan.limits must be an object");
  requireExactFields(value.limits, new Set(["configured", "effective", "additiveReplayAllowance", "totalCeiling"]));
  if (!isRecord(value.limits.configured)) fail("plan.limits.configured must be an object");
  requireExactFields(value.limits.configured, new Set(["cli", "profile", "reflect"]));
  for (const field of ["cli", "profile", "reflect"] as const) {
    if (value.limits.configured[field] !== undefined)
      requireCount(value.limits.configured, field, "plan.limits.configured");
  }
  if (value.limits.effective !== undefined) requireCount(value.limits, "effective", "plan.limits");
  requireCount(value.limits, "additiveReplayAllowance", "plan.limits");
  if (value.limits.totalCeiling !== undefined) requireCount(value.limits, "totalCeiling", "plan.limits");
  if (value.limits.effective === undefined && value.limits.totalCeiling !== undefined) {
    fail("plan.limits.totalCeiling must be omitted when plan.limits.effective is unbounded");
  }
  if (
    value.limits.effective !== undefined &&
    value.limits.totalCeiling !== (value.limits.effective as number) + (value.limits.additiveReplayAllowance as number)
  ) {
    fail("plan.limits.totalCeiling must equal plan.limits.effective + plan.limits.additiveReplayAllowance");
  }

  const gateNames = new Set(["profile", "cleanup", "validation", "signal", "disk", "limit"]);
  if (!Array.isArray(value.gates)) fail("plan.gates must be an array");
  const gateRemovedByName = new Map<string, number>();
  for (const gate of value.gates) {
    if (!isRecord(gate)) fail("plan.gates entries must be objects");
    requireExactFields(gate, new Set(["name", "removed", "reason"]));
    if (typeof gate.name !== "string" || !gateNames.has(gate.name)) fail("plan.gates.name is invalid");
    requireCount(gate, "removed", "plan.gates entry");
    if (typeof gate.reason !== "string") fail("plan.gates.reason must be a string");
    if (gateRemovedByName.has(gate.name)) fail(`plan.gates must contain exactly one ${gate.name} gate`);
    gateRemovedByName.set(gate.name, gate.removed as number);
  }
  for (const gateName of gateNames) {
    if (!gateRemovedByName.has(gateName)) fail(`plan.gates must contain exactly one ${gateName} gate`);
  }
  const preLimitRemoved = [...gateRemovedByName]
    .filter(([gateName]) => gateName !== "limit")
    .reduce((total, [, removed]) => total + removed, 0);
  if (preLimitRemoved !== (value.candidates.rawInScope as number) - (value.candidates.selected as number)) {
    fail("plan pre-limit gate removals must equal plan.candidates.rawInScope - plan.candidates.selected");
  }
  if (
    gateRemovedByName.get("limit") !==
    (value.candidates.selected as number) - (value.candidates.effective as number)
  ) {
    fail("plan limit removal must equal plan.candidates.selected - plan.candidates.effective");
  }

  const lanes = new Set([
    "scope",
    "signal-delta",
    "proactive",
    "high-salience",
    "distill-only",
    "forgetting-safety",
    "replay",
    "unknown",
  ]);
  const reasons = new Set(["scope-ref", "scope-type", "memory-cleanup", "strategy_filtered_all_passes"]);
  if (!Array.isArray(value.effectiveRefs)) fail("plan.effectiveRefs must be an array");
  for (const entry of value.effectiveRefs) {
    if (!isRecord(entry)) fail("plan.effectiveRefs entries must be objects");
    requireExactFields(entry, new Set(["ref", "lane", "reason"]));
    if (typeof entry.ref !== "string") fail("plan.effectiveRefs.ref must be a string");
    if (typeof entry.lane !== "string" || !lanes.has(entry.lane)) fail("plan.effectiveRefs.lane is invalid");
    if (typeof entry.reason !== "string" || !reasons.has(entry.reason)) fail("plan.effectiveRefs.reason is invalid");
  }
  if (value.candidates.effective !== value.effectiveRefs.length) {
    fail("plan.candidates.effective must equal plan.effectiveRefs.length");
  }
  const effectiveRefNames = value.effectiveRefs.map((entry) => (entry as Record<string, unknown>).ref as string);
  if (new Set(effectiveRefNames).size !== effectiveRefNames.length) {
    fail("plan.effectiveRefs must not contain duplicate refs");
  }
  if (
    plannedRefNames.length !== effectiveRefNames.length ||
    plannedRefNames.some((ref, index) => ref !== effectiveRefNames[index])
  ) {
    fail("plannedRefs must contain the same refs in the same order as plan.effectiveRefs");
  }
  const replayCount = value.effectiveRefs.filter(
    (entry) => (entry as Record<string, unknown>).lane === "replay",
  ).length;
  const ordinaryCount = value.effectiveRefs.length - replayCount;
  if (replayCount > (value.limits.additiveReplayAllowance as number)) {
    fail("plan replay refs cannot exceed plan.limits.additiveReplayAllowance");
  }
  if (value.limits.effective !== undefined && ordinaryCount > (value.limits.effective as number)) {
    fail("plan ordinary refs cannot exceed plan.limits.effective");
  }
  if (value.limits.totalCeiling !== undefined && value.effectiveRefs.length > (value.limits.totalCeiling as number)) {
    fail("plan.effectiveRefs cannot exceed plan.limits.totalCeiling");
  }
  validateProcessRoutingRows(value.processes);
  if (value.proactive !== undefined) validateProactivePlan(value.proactive);
  validateConsolidationPlan(value.consolidation);

  const stageNames = new Set(["consolidation", "extract", "graph-extraction", "memory-inference"]);
  if (!Array.isArray(value.stages)) fail("plan.stages must be an array");
  for (const stage of value.stages) {
    if (!isRecord(stage)) fail("plan.stages entries must be objects");
    requireExactFields(stage, new Set(["name", "wouldRun", "reason"]));
    if (typeof stage.name !== "string" || !stageNames.has(stage.name)) fail("plan.stages.name is invalid");
    if (typeof stage.wouldRun !== "boolean" || typeof stage.reason !== "string") {
      fail("plan.stages entries must contain boolean wouldRun and string reason");
    }
  }
  if (!isRecord(value.triage)) fail("plan.triage must be an object");
  requireExactFields(value.triage, new Set(["enabled", "configuredMode", "mode", "maxAcceptsPerRun", "maxDiffLines"]));
  if (typeof value.triage.enabled !== "boolean") fail("plan.triage.enabled must be a boolean");
  for (const field of ["configuredMode", "mode"] as const) {
    if (value.triage[field] !== "queue" && value.triage[field] !== "promote") {
      fail(`plan.triage.${field} must be queue or promote`);
    }
  }
  requireCount(value.triage, "maxAcceptsPerRun", "plan.triage");
  if (value.triage.maxDiffLines !== undefined && typeof value.triage.maxDiffLines !== "number") {
    fail("plan.triage.maxDiffLines must be a number");
  }
}

function validateCommon(value: Record<string, unknown>): void {
  if (typeof value.ok !== "boolean") fail("ok must be a boolean");
  if (typeof value.dryRun !== "boolean") fail("dryRun must be a boolean");
  if (!Array.isArray(value.plannedRefs)) fail("plannedRefs must be an array");
  if (value.notices !== undefined) validateLoweringNotices(value.notices);
  const plannedRefNames = value.plannedRefs.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.ref !== "string") fail(`plannedRefs[${index}].ref must be a string`);
    return entry.ref;
  });
  if (value.plan !== undefined) validateImprovePlan(value.plan, value.dryRun, plannedRefNames);
  if (!isRecord(value.scope)) fail("scope must be an object");
  requireExactFields(value.scope, new Set(["mode", "value"]));
  if (value.scope.mode !== "all" && value.scope.mode !== "type" && value.scope.mode !== "ref") {
    fail('scope.mode must be "all", "type", or "ref"');
  }
  if (value.scope.value !== undefined && typeof value.scope.value !== "string") {
    fail("scope.value must be a string when present");
  }
  if (!isRecord(value.memorySummary)) fail("memorySummary must be an object");
  requireExactFields(value.memorySummary, new Set(["eligible", "derived"]));
  if (typeof value.memorySummary.eligible !== "number" || typeof value.memorySummary.derived !== "number") {
    fail("memorySummary.eligible and memorySummary.derived must be numbers");
  }

  for (const field of [
    "actions",
    "skippedProcesses",
    "validationFailures",
    "schemaRepairs",
    "extract",
    "coverageGaps",
    "deadUrls",
    "writtenPaths",
  ] as const) {
    if (value[field] !== undefined && !Array.isArray(value[field])) fail(`${field} must be an array`);
  }
  if (Array.isArray(value.writtenPaths) && value.writtenPaths.some((entry) => typeof entry !== "string")) {
    fail("writtenPaths must be an array of strings");
  }
  for (const field of [
    "cyclesRun",
    "evalCasesWritten",
    "reflectsWithErrorContext",
    "memoryInferenceDurationMs",
    "graphExtractionDurationMs",
    "orphansPurged",
    "proposalsExpired",
    "reflectCooldownActions",
    "reflectSkippedActions",
    "reflectGuardRejectedActions",
    "gateAutoAcceptedCount",
    "gateAutoAcceptFailedCount",
  ] as const) {
    if (value[field] !== undefined && typeof value[field] !== "number") fail(`${field} must be a number`);
  }
  for (const field of ["guidance", "runId"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") fail(`${field} must be a string`);
  }
  for (const field of [
    "skipped",
    "memoryCleanup",
    "distillSkipped",
    "consolidation",
    "lintSummary",
    "memoryIndexHealth",
    "memoryInference",
    "graphExtraction",
    "triage",
    "proactiveMaintenance",
    "cycleMetrics",
    "sync",
    "terminated",
    "plan",
    "deadUrlCoverage",
    "usageReport",
  ] as const) {
    if (value[field] !== undefined && !isRecord(value[field])) fail(`${field} must be an object`);
  }
  if (isRecord(value.terminated)) {
    requireExactFields(value.terminated, new Set(["reason", "at", "errorMessage"]));
    if (typeof value.terminated.reason !== "string" || typeof value.terminated.at !== "string") {
      fail("terminated.reason and terminated.at must be strings");
    }
    if (value.terminated.errorMessage !== undefined && typeof value.terminated.errorMessage !== "string") {
      fail("terminated.errorMessage must be a string when present");
    }
  }
  if (isRecord(value.deadUrlCoverage)) {
    requireExactFields(value.deadUrlCoverage, new Set(["checked", "total", "skipped"]));
    for (const field of ["checked", "total", "skipped"] as const) {
      requireCount(value.deadUrlCoverage, field, "deadUrlCoverage");
    }
  }
}

/**
 * Per-`schemaVersion` decoders for the persisted `improve_runs.result_json`
 * contract, keyed by the literal `schemaVersion` value each accepts.
 *
 * #866 item 5 / read-shim policy (same shape as the version router in
 * src/tasks/source/parse-task-source.ts, which this mirrors): every
 * `schemaVersion` this build understands gets its own entry here, so
 * decoding never regresses to "reject every row" the day the version bumps
 * — it only stops accepting the ONE version that changed shape. All 1,539
 * live rows today are v2; when a v3 shape is introduced, add a `3` entry
 * (and, if v2 rows must keep reading under the newer runtime, keep this `2`
 * entry as-is — every caller already skip-and-counts a decode failure, so a
 * genuinely unreadable old row degrades to "excluded from metrics", never a
 * crash). Do not remove the `2` entry when adding `3` unless the schema
 * bump is known to be a strict superset callers can validate with it.
 */
const SCHEMA_DECODERS: Record<number, (parsed: Record<string, unknown>) => DecodedImproveResult> = {
  2: (parsed) => {
    requireExactFields(parsed, V2_FIELDS);
    validateCommon(parsed);
    if (typeof parsed.strategy !== "string" || parsed.strategy.length === 0) {
      fail("strategy must be a non-empty string");
    }
    if (parsed.strategyFilteredRefs !== undefined && !Array.isArray(parsed.strategyFilteredRefs)) {
      fail("strategyFilteredRefs must be an array");
    }
    return {
      envelope: parsed as unknown as AkmImproveResult,
      strategy: parsed.strategy,
    };
  },
};

/** Decode the persisted public result contract. */
export function decodeImproveResult(input: string | unknown): DecodedImproveResult {
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      fail("not valid JSON");
    }
  }
  if (!isRecord(parsed)) fail("root must be an object");

  const decoder = typeof parsed.schemaVersion === "number" ? SCHEMA_DECODERS[parsed.schemaVersion] : undefined;
  if (decoder) return decoder(parsed);

  fail(`unsupported schemaVersion: ${String(parsed.schemaVersion)}`);
}
