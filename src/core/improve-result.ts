// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmImproveResult, LegacyAkmImproveResult } from "./improve-types";

export type ImproveResultEnvelope = LegacyAkmImproveResult | AkmImproveResult;

export interface DecodedImproveResult {
  envelope: ImproveResultEnvelope;
  strategy: string | null;
  legacyProfile: string | null;
}

const COMMON_FIELDS = [
  "schemaVersion",
  "ok",
  "scope",
  "dryRun",
  "skipped",
  "guidance",
  "memorySummary",
  "memoryCleanup",
  "cyclesRun",
  "plannedRefs",
  "actions",
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
  "recombination",
  "proceduralCompilation",
  "cycleMetrics",
  "runId",
  "sync",
  "terminated",
] as const;

const V1_FIELDS = new Set<string>([...COMMON_FIELDS, "profile", "profileFilteredRefs"]);
const V2_FIELDS = new Set<string>([...COMMON_FIELDS, "strategy", "strategyFilteredRefs"]);

function fail(message: string): never {
  throw new Error(`invalid improve-result envelope: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactFields(value: Record<string, unknown>, allowed: Set<string>): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(`unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.sort().join(", ")}`);
}

function validateCommon(value: Record<string, unknown>): void {
  if (typeof value.ok !== "boolean") fail("ok must be a boolean");
  if (typeof value.dryRun !== "boolean") fail("dryRun must be a boolean");
  if (!Array.isArray(value.plannedRefs)) fail("plannedRefs must be an array");
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
    "validationFailures",
    "schemaRepairs",
    "extract",
    "coverageGaps",
    "deadUrls",
  ] as const) {
    if (value[field] !== undefined && !Array.isArray(value[field])) fail(`${field} must be an array`);
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
    "recombination",
    "proceduralCompilation",
    "cycleMetrics",
    "sync",
    "terminated",
  ] as const) {
    if (value[field] !== undefined && !isRecord(value[field])) fail(`${field} must be an object`);
  }
}

/** Decode the persisted public v1/v2 contract without guessing across versions. */
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

  if (parsed.schemaVersion === 1) {
    requireExactFields(parsed, V1_FIELDS);
    validateCommon(parsed);
    if (parsed.profile !== undefined && typeof parsed.profile !== "string") fail("profile must be a string");
    if (parsed.profileFilteredRefs !== undefined && !Array.isArray(parsed.profileFilteredRefs)) {
      fail("profileFilteredRefs must be an array");
    }
    return {
      envelope: parsed as LegacyAkmImproveResult,
      strategy: null,
      legacyProfile: typeof parsed.profile === "string" ? parsed.profile : null,
    };
  }

  if (parsed.schemaVersion === 2) {
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
      legacyProfile: null,
    };
  }

  fail(`unsupported schemaVersion: ${String(parsed.schemaVersion)}`);
}
