#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertNonOverlappingPaths,
  captureFileManifest,
  createAkmCommandWrapper,
  emptyResourceMetrics,
  ensurePrivateDir,
  errorMessage,
  type FileManifest,
  isRecord,
  loadLatestEvalArtifacts,
  loadSuite,
  manifestsMatchExceptConfig,
  normalizedEffectiveConfigFingerprint,
  readImproveResourceMetrics,
  readMaxEventId,
  restrictTreeModes,
  summarizeMutations,
  writePrivateJson,
  writePrivateText,
} from "./twin-run-private";
import {
  materializeInstallationSnapshot,
  verifyInstallationSnapshot,
} from "./sources/installation-snapshot";
import { EVAL_STORAGE_ENV_KEYS } from "./sources/sandbox";
import { aggregateScores } from "./scoring";
import {
  assertSha256,
  assertTwinDecisionCriteria,
  isSha256,
  type EndpointAssignment,
  type EndpointFingerprint,
  type InstallationSnapshotManifest,
  type MaterializedInstallation,
  type Sha256,
  type TwinArm,
  type TwinArmArtifactPaths,
  type TwinArmIdentity,
  type TwinArmResources,
  type TwinArmResult,
  type TwinCaseDelta,
  type TwinDecisionCriteria,
  type TwinExperimentPolicy,
  type TwinExperimentResult,
  type TwinExperimentStatus,
  type TwinRegression,
  type TwinResourceMetrics,
  type TwinSampleResult,
  type TwinTreatmentPolicy,
} from "./twin-types";
import type { EvalCase, EvalCaseResult, EvalRunResult } from "./types";

const ZERO_SHA256 = "0".repeat(64) as Sha256;
const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
const COMMAND_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const SAFE_TWIN_PARENT_ENV = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
  "EVAL_ENV_LOG",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "WINDIR",
  "AKM_LLM_API_KEY",
  "AKM_EMBED_API_KEY",
] as const;
const NAMED_AKM_CREDENTIAL = /^AKM_(?:ENGINE|PROFILE)_[A-Z0-9_]+_API_KEY$/;
const APPEND_EVENT_FAILURE = /akm:\s*appendEvent failed:/i;
const ENDPOINT_KEYS = new Set([
  "schemaVersion",
  "endpointId",
  "servingFingerprint",
  "modelId",
  "modelSha256",
  "promptFingerprint",
  "quantization",
  "contextLimit",
  "serverImplementation",
  "serverVersion",
  "samplerSettings",
]);
const RESERVED_ENDPOINT_ENV = new Set([
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "AKM_STASH_DIR",
  "AKM_CONFIG_DIR",
  "AKM_DATA_DIR",
  "AKM_CACHE_DIR",
  "AKM_STATE_DIR",
  "PATH",
  "PWD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "AKM_EVAL_TWIN_COMMAND_TIMEOUT_MS",
]);

export interface EndpointRuntimeOverlay {
  env: Record<string, string>;
}

export interface CommonRuntimeOverlay {
  env: Record<string, string>;
}

export interface TwinRunOptions {
  snapshotDir: string;
  suite: string;
  akmCommand: string[];
  outDir: string;
  samples: number;
  policy: TwinTreatmentPolicy;
  improveArgs: string[];
  keepSandboxes: boolean;
  includePrivateArtifacts: boolean;
  criteria: TwinDecisionCriteria;
  commandTimeoutMs?: number;
  protectedCaseIds?: string[];
  /** Runtime-only environment shared identically by both arms. Never serialized. */
  commonRuntime?: CommonRuntimeOverlay;
  endpoints?: EndpointFingerprint[];
  endpointAssignments?: EndpointAssignment[][];
  /** Runtime-only endpoint routing. This object is never copied into a result or artifact. */
  endpointRuntimeOverlays?: Record<string, EndpointRuntimeOverlay>;
}

export interface TwinCommandRequest {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
}

export interface TwinCommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

export type TwinCommandExecutor = (
  request: TwinCommandRequest,
) => TwinCommandResult | Promise<TwinCommandResult>;

export interface TwinArmExecutionInput {
  arm: TwinArm;
  sampleId: string;
  installation: MaterializedInstallation;
  suite: string;
  suiteFingerprint: Sha256;
  caseIds: string[];
  akmCommand: string[];
  evalCommand: string[];
  improveArgs: string[];
  scratchDir: string;
  endpointAssigned: boolean;
  commonRuntimeEnv: Record<string, string>;
  endpointRuntimeEnv: Record<string, string>;
  commandTimeoutMs: number;
  commandExecutor: TwinCommandExecutor;
}

export interface TwinArmExecution {
  evalResult?: EvalRunResult;
  caseResults?: EvalCaseResult[];
  improveResult?: Record<string, unknown>;
  resources: TwinArmResources;
  errors: string[];
}

export type TwinArmExecutor = (
  input: TwinArmExecutionInput,
) => TwinArmExecution | Promise<TwinArmExecution>;

export interface TwinRunnerDependencies {
  verifySnapshot?: (snapshotDir: string) => InstallationSnapshotManifest;
  materializeSnapshot?: (snapshotDir: string, destinationRoot: string) => MaterializedInstallation;
  executeArm?: TwinArmExecutor;
  executeCommand?: TwinCommandExecutor;
  evalCommand?: string[];
  experimentId?: () => string;
}

export interface TwinCaseComparison {
  caseDeltas: TwinCaseDelta[];
  newlyPassingCaseIds: string[];
  newlyFailingCaseIds: string[];
  regressions: TwinRegression[];
  incompleteReasons: string[];
}

export interface TwinDecisionInput {
  criteria?: TwinDecisionCriteria;
  controlExecutedCaseCount: number;
  treatmentExecutedCaseCount: number;
  controlDeterministicScore: number;
  treatmentDeterministicScore: number;
  treatmentResources: TwinArmResources;
  controlIdentity: TwinArmIdentity;
  treatmentIdentity: TwinArmIdentity;
  regressions: TwinRegression[];
  snapshotFingerprintsMatch: boolean;
  suiteFingerprintsMatch: boolean;
  endpointServingFingerprintsCompatible: boolean;
  armErrors: string[];
  incompleteReasons: string[];
}

interface MaterializedArm {
  installation?: MaterializedInstallation;
  initialManifest?: FileManifest;
  effectiveConfigFingerprint?: Sha256;
  materializationError?: string;
}

interface CollectedArm {
  result: TwinArmResult;
  artifacts: TwinArmArtifactPaths;
  execution?: TwinArmExecution;
  incompleteReasons: string[];
}

interface CliOptions extends Omit<TwinRunOptions, "criteria" | "endpointRuntimeOverlays" | "commonRuntime"> {
  endpointMetadataFiles: string[];
  endpointAssignment?: string;
  endpointRuntimeFile?: string;
  commonRuntimeFile?: string;
  criteria: TwinDecisionCriteria;
}

export function tokenizeCommandVector(value: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  for (const character of value) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
    } else {
      token += character;
      started = true;
    }
  }
  if (escaped) throw new Error("trailing escape in command vector");
  if (quote) throw new Error("unterminated quote in command vector");
  if (started) tokens.push(token);
  if (tokens.length === 0 || tokens[0] === "") throw new Error("command vector must not be empty");
  return tokens;
}

export function deriveEndpointServingFingerprint(
  value: Pick<
    EndpointFingerprint,
    | "modelId"
    | "modelSha256"
    | "promptFingerprint"
    | "quantization"
    | "contextLimit"
    | "serverImplementation"
    | "serverVersion"
    | "samplerSettings"
  >,
): Sha256 {
  const samplerSettings = Object.fromEntries(
    Object.entries(value.samplerSettings).sort(([left], [right]) => left.localeCompare(right)),
  );
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        modelId: value.modelId,
        modelSha256: value.modelSha256,
        promptFingerprint: value.promptFingerprint,
        quantization: value.quantization,
        contextLimit: value.contextLimit,
        serverImplementation: value.serverImplementation,
        serverVersion: value.serverVersion,
        samplerSettings,
      }),
      "utf8",
    )
    .digest("hex") as Sha256;
}

export function validateEndpointFingerprint(value: unknown): EndpointFingerprint {
  if (!isRecord(value)) throw new Error("endpoint metadata must be an object");
  const unknownKeys = Object.keys(value).filter((key) => !ENDPOINT_KEYS.has(key));
  if (unknownKeys.length > 0) throw new Error(`unknown endpoint metadata keys: ${unknownKeys.sort().join(", ")}`);
  if (
    value.schemaVersion !== 1 ||
    typeof value.endpointId !== "string" ||
    value.endpointId.trim().length === 0 ||
    typeof value.modelId !== "string" ||
    value.modelId.length === 0 ||
    typeof value.quantization !== "string" ||
    value.quantization.length === 0 ||
    typeof value.serverImplementation !== "string" ||
    value.serverImplementation.length === 0 ||
    typeof value.serverVersion !== "string" ||
    value.serverVersion.length === 0 ||
    !Number.isInteger(value.contextLimit) ||
    Number(value.contextLimit) < 1 ||
    !isRecord(value.samplerSettings)
  ) {
    throw new Error("invalid endpoint metadata fields");
  }
  assertSha256(value.servingFingerprint);
  assertSha256(value.modelSha256);
  assertSha256(value.promptFingerprint);
  for (const setting of Object.values(value.samplerSettings)) {
    if (
      setting !== null &&
      (!["string", "number", "boolean"].includes(typeof setting) ||
        (typeof setting === "number" && !Number.isFinite(setting)))
    ) {
      throw new Error(`invalid sampler setting for endpoint ${value.endpointId}`);
    }
  }
  const endpoint = value as unknown as EndpointFingerprint;
  if (endpoint.servingFingerprint !== deriveEndpointServingFingerprint(endpoint)) {
    throw new Error(`serving fingerprint does not match canonical endpoint metadata: ${endpoint.endpointId}`);
  }
  return endpoint;
}

export function buildBalancedEndpointAssignments(
  endpoints: EndpointFingerprint[],
  sampleCount: number,
): EndpointAssignment[][] {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) throw new Error("sampleCount must be a positive integer");
  if (endpoints.length === 0) throw new Error("balanced endpoint assignment requires endpoint metadata");
  assertUniqueEndpointIds(endpoints);
  const blockSize = endpoints.length * 2;
  if (sampleCount % blockSize !== 0) {
    throw new Error(`balanced endpoint assignment requires --samples to be a multiple of ${blockSize}`);
  }
  return Array.from({ length: sampleCount }, (_, sampleIndex) => {
    const treatment = endpoints[Math.floor(sampleIndex / 2) % endpoints.length];
    if (!treatment) return [];
    return [{ arm: "treatment", endpointId: treatment.endpointId }];
  });
}

export function armExecutionOrder(sampleIndex: number): TwinArm[] {
  return sampleIndex % 2 === 0 ? ["control", "treatment"] : ["treatment", "control"];
}

export function endpointServingFingerprintsAreCompatible(
  endpoints: EndpointFingerprint[],
  assignments: EndpointAssignment[][],
): boolean {
  const assignedIds = new Set(assignments.flat().map((assignment) => assignment.endpointId));
  if (assignedIds.size === 0) return true;
  const assigned = endpoints.filter((endpoint) => assignedIds.has(endpoint.endpointId));
  if (assigned.length !== assignedIds.size) return false;
  return new Set(assigned.map(deriveEndpointServingFingerprint)).size <= 1;
}

export function compareTwinCaseResults(
  control: EvalCaseResult[],
  treatment: EvalCaseResult[],
  protectedCaseIds: ReadonlySet<string>,
  protectedLossMargin: number,
): TwinCaseComparison {
  const controlById = new Map(control.map((result) => [result.caseId, result]));
  const treatmentById = new Map(treatment.map((result) => [result.caseId, result]));
  const caseDeltas: TwinCaseDelta[] = [];
  const newlyPassingCaseIds: string[] = [];
  const newlyFailingCaseIds: string[] = [];
  const regressions: TwinRegression[] = [];
  const incompleteReasons: string[] = [];
  if (controlById.size !== control.length || treatmentById.size !== treatment.length) {
    incompleteReasons.push("duplicate case IDs in arm results");
  }
  for (const caseId of [...new Set([...controlById.keys(), ...treatmentById.keys()])].sort()) {
    const controlResult = controlById.get(caseId);
    const treatmentResult = treatmentById.get(caseId);
    if (!controlResult || !treatmentResult) {
      incompleteReasons.push(`case result missing from ${controlResult ? "treatment" : "control"}: ${caseId}`);
      continue;
    }
    if (Boolean(controlResult.skipped) !== Boolean(treatmentResult.skipped)) {
      incompleteReasons.push(`case skip state differs between arms: ${caseId}`);
      continue;
    }
    if (controlResult.skipped) continue;
    if (!Number.isFinite(controlResult.score) || !Number.isFinite(treatmentResult.score)) {
      incompleteReasons.push(`case score is not finite: ${caseId}`);
      continue;
    }
    const delta = treatmentResult.score - controlResult.score;
    caseDeltas.push({
      caseId,
      controlScore: controlResult.score,
      treatmentScore: treatmentResult.score,
      delta,
      controlPassed: controlResult.passed,
      treatmentPassed: treatmentResult.passed,
    });
    if (!controlResult.passed && treatmentResult.passed) newlyPassingCaseIds.push(caseId);
    if (controlResult.passed && !treatmentResult.passed) newlyFailingCaseIds.push(caseId);
    if (
      protectedCaseIds.has(caseId) &&
      ((controlResult.passed && !treatmentResult.passed) || delta < -protectedLossMargin)
    ) {
      regressions.push({
        caseId,
        protected: true,
        controlScore: controlResult.score,
        treatmentScore: treatmentResult.score,
        reason: controlResult.passed && !treatmentResult.passed
          ? "protected-newly-failing"
          : `protected-score-drop-beyond-${protectedLossMargin}`,
      });
    } else if (!protectedCaseIds.has(caseId) && controlResult.passed && !treatmentResult.passed) {
      regressions.push({
        caseId,
        protected: false,
        controlScore: controlResult.score,
        treatmentScore: treatmentResult.score,
        reason: "newly-failing",
      });
    }
  }
  return { caseDeltas, newlyPassingCaseIds, newlyFailingCaseIds, regressions, incompleteReasons };
}

export function decideTwinExperimentStatus(input: TwinDecisionInput): TwinExperimentStatus {
  const inconclusive = [...input.incompleteReasons];
  if (!input.criteria) inconclusive.push("decision criteria were not predeclared");
  if (!input.snapshotFingerprintsMatch) inconclusive.push("snapshot fingerprint mismatch");
  if (!input.suiteFingerprintsMatch) inconclusive.push("suite fingerprint mismatch");
  if (!input.endpointServingFingerprintsCompatible) inconclusive.push("incompatible endpoint serving fingerprints");
  if (!hasCompleteCommonIdentity(input.controlIdentity) || !hasCompleteCommonIdentity(input.treatmentIdentity)) {
    inconclusive.push("producer or config identity is incomplete");
  }
  if (
    !sameProducer(input.controlIdentity.runtimeProducer, input.treatmentIdentity.runtimeProducer) ||
    !sameProducer(input.controlIdentity.snapshotProducer, input.treatmentIdentity.snapshotProducer) ||
    input.controlIdentity.configFingerprint !== input.treatmentIdentity.configFingerprint
  ) {
    inconclusive.push("control and treatment identities differ");
  }
  const treatmentLlmRelevant = isLlmRelevant(input.treatmentResources);
  if (treatmentLlmRelevant) {
    if (!input.treatmentResources.improve) {
      inconclusive.push("treatment LLM telemetry is incomplete");
    } else {
      if (input.treatmentResources.improve.modelCalls === 0) {
        inconclusive.push("expected improve LLM work recorded zero model calls");
      }
      if (!input.treatmentResources.improve.telemetryComplete) {
        inconclusive.push("treatment LLM telemetry is incomplete");
      }
    }
  }
  if (
    treatmentLlmRelevant &&
    (input.treatmentIdentity.promptFingerprint === null || input.treatmentIdentity.modelFingerprint === null)
  ) {
    inconclusive.push("treatment LLM identity is incomplete");
  }
  if (
    input.controlIdentity.promptFingerprint !== null &&
    input.treatmentIdentity.promptFingerprint !== null &&
    input.controlIdentity.promptFingerprint !== input.treatmentIdentity.promptFingerprint
  ) {
    inconclusive.push("control and treatment prompt fingerprints differ");
  }
  if (
    input.controlIdentity.modelFingerprint !== null &&
    input.treatmentIdentity.modelFingerprint !== null &&
    input.controlIdentity.modelFingerprint !== input.treatmentIdentity.modelFingerprint
  ) {
    inconclusive.push("control and treatment model fingerprints differ");
  }
  if (input.controlExecutedCaseCount === 0 || input.treatmentExecutedCaseCount === 0) {
    inconclusive.push("zero executed cases in one or both arms");
  }
  if (!Number.isFinite(input.controlDeterministicScore) || !Number.isFinite(input.treatmentDeterministicScore)) {
    inconclusive.push("deterministic arm score is not finite");
  }
  inconclusive.push(...input.armErrors.map((error) => `arm error: ${error}`));
  const unique = [...new Set(inconclusive.filter(Boolean))];
  if (unique.length > 0) return { status: "inconclusive", reasons: unique as [string, ...string[]] };

  const criteria = input.criteria!;
  const resources = input.treatmentResources.improve ?? emptyResourceMetrics();
  const budgetFailures = resourceBudgetFailures(resources, criteria);
  if (budgetFailures.length > 0) return { status: "fail", reasons: budgetFailures as [string, ...string[]] };
  const protectedRegressions = input.regressions.filter((regression) => regression.protected);
  if (protectedRegressions.length > 0) {
    return {
      status: "fail",
      reasons: [`protected regressions: ${protectedRegressions.map((regression) => regression.caseId).join(", ")}`],
    };
  }
  const delta = input.treatmentDeterministicScore - input.controlDeterministicScore;
  if (delta >= criteria.minimumDeterministicLift) {
    return { status: "pass", reasons: [`deterministic lift ${delta.toFixed(6)} met the predeclared minimum`] };
  }
  return {
    status: "fail",
    reasons: [`deterministic lift ${delta.toFixed(6)} was below ${criteria.minimumDeterministicLift.toFixed(6)}`],
  };
}

function hasCompleteCommonIdentity(identity: TwinArmIdentity): boolean {
  return (
    identity.runtimeProducer.version.trim().length > 0 &&
    identity.runtimeProducer.version !== "unverified" &&
    identity.runtimeProducer.commit === null &&
    identity.snapshotProducer.version.trim().length > 0 &&
    identity.snapshotProducer.version !== "unverified" &&
    isSha256(identity.configFingerprint) &&
    identity.configFingerprint !== ZERO_SHA256
  );
}

function sameProducer(
  left: TwinArmIdentity["runtimeProducer"],
  right: TwinArmIdentity["runtimeProducer"],
): boolean {
  return left.version === right.version && left.commit === right.commit;
}

function isLlmRelevant(resources: TwinArmResources): boolean {
  return resources.llmWorkExpected || (resources.improve?.modelCalls ?? 0) > 0;
}

function resolveProtectedCases(
  cases: EvalCase[],
  explicitCaseIds: readonly string[],
): { caseIds: string[]; reasons: string[] } {
  const suiteIds = new Set(cases.map((evalCase) => evalCase.id));
  const caseIds = new Set(explicitCaseIds);
  for (const evalCase of cases) {
    if (evalCase.tags?.some((tag) => tag === "protected" || tag === "regression-guard")) {
      caseIds.add(evalCase.id);
    }
  }
  const sorted = [...caseIds].sort();
  const unknown = [...new Set(explicitCaseIds.filter((caseId) => !suiteIds.has(caseId)))].sort();
  const reasons: string[] = [];
  if (sorted.length === 0) reasons.push("no protected cases were predeclared or tagged by the suite");
  if (unknown.length > 0) reasons.push(`explicit protected cases are absent from the suite: ${unknown.join(", ")}`);
  return { caseIds: sorted, reasons };
}

export async function runTwinExperiment(
  options: TwinRunOptions,
  dependencies: TwinRunnerDependencies = {},
): Promise<TwinExperimentResult> {
  validateRunOptions(options);
  assertNonOverlappingPaths(options.snapshotDir, options.outDir);
  const effectiveOptions: TwinRunOptions = {
    ...options,
    akmCommand: [...options.akmCommand],
    improveArgs: [...options.improveArgs, "--no-sync"],
    commandTimeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    protectedCaseIds: [...(options.protectedCaseIds ?? [])],
  };
  const verifySnapshot = dependencies.verifySnapshot ?? verifyInstallationSnapshot;
  const materializeSnapshot = dependencies.materializeSnapshot ?? materializeInstallationSnapshot;
  const executeArm = dependencies.executeArm ?? executeArmWithExistingRunner;
  const commandExecutor = dependencies.executeCommand ?? executeCommand;
  const evalCommand = dependencies.evalCommand ?? [process.execPath, "run", path.join(import.meta.dir, "run.ts")];
  const experimentId = (dependencies.experimentId ?? defaultExperimentId)();
  const experimentRoot = path.resolve(effectiveOptions.outDir, experimentId);
  ensurePrivateDir(experimentRoot);

  let snapshotManifest: InstallationSnapshotManifest | undefined;
  let snapshotError: string | undefined;
  try {
    snapshotManifest = verifySnapshot(path.resolve(effectiveOptions.snapshotDir));
  } catch (error) {
    snapshotError = `snapshot verification failed: ${errorMessage(error)}`;
  }
  let cases: EvalCase[] = [];
  let suiteFingerprint = ZERO_SHA256;
  let suiteError: string | undefined;
  try {
    const loaded = loadSuite(effectiveOptions.suite);
    cases = loaded.cases;
    suiteFingerprint = loaded.fingerprint;
  } catch (error) {
    suiteError = `suite loading failed: ${errorMessage(error)}`;
  }
  const endpoints = effectiveOptions.endpoints ?? [];
  validateEndpoints(endpoints);
  const assignments = normalizeEndpointAssignments(effectiveOptions, endpoints);
  const endpointCompatibility = endpointServingFingerprintsAreCompatible(endpoints, assignments);
  const protection = resolveProtectedCases(cases, effectiveOptions.protectedCaseIds ?? []);
  const policy: TwinExperimentPolicy = {
    schemaVersion: 1,
    control: "no-improve",
    treatment: effectiveOptions.policy,
    improveArgs: [...effectiveOptions.improveArgs],
    commandTimeoutMs: effectiveOptions.commandTimeoutMs!,
    protectedCaseIds: protection.caseIds,
    criteria: { ...effectiveOptions.criteria },
  };
  const protectedCaseIds = new Set(policy.protectedCaseIds);
  const unsupportedPolicyReason =
    effectiveOptions.policy === "candidate-only"
      ? "candidate-only is unsupported until AKM provides an enforced queue-only improve mode"
      : undefined;

  const samples: TwinSampleResult[] = [];
  const sampleResultPaths: string[] = [];
  for (let sampleIndex = 0; sampleIndex < effectiveOptions.samples; sampleIndex++) {
    const sampleId = `sample-${String(sampleIndex + 1).padStart(3, "0")}`;
    const sampleRoot = path.join(experimentRoot, sampleId);
    ensurePrivateDir(sampleRoot);
    const globalReasons = [snapshotError, suiteError, unsupportedPolicyReason, ...protection.reasons].filter(
      (reason): reason is string => reason !== undefined,
    );
    const sample = await runSample({
      options: effectiveOptions,
      sampleIndex,
      sampleId,
      sampleRoot,
      experimentId,
      snapshotManifest,
      suiteFingerprint,
      cases,
      protectedCaseIds,
      endpoints,
      endpointAssignments: assignments[sampleIndex] ?? [],
      endpointCompatibility,
      policy,
      globalReasons,
      verifySnapshot,
      materializeSnapshot,
      executeArm,
      commandExecutor,
      evalCommand,
    });
    const sampleResultPath = path.join(sampleRoot, "twin-result.json");
    writePrivateJson(sampleResultPath, sample);
    sampleResultPaths.push(relativeArtifactPath(experimentRoot, sampleResultPath));
    samples.push(sample);
  }

  const aggregate = buildAggregateResult({
    experimentId,
    snapshotFingerprint: snapshotManifest?.snapshotFingerprint ?? ZERO_SHA256,
    suiteFingerprint,
    policy,
    endpoints,
    samples,
    experimentResultPath: "twin-experiment-result.json",
    sampleResultPaths,
  });
  writePrivateJson(path.join(experimentRoot, aggregate.artifactPaths.experimentResult), aggregate);
  return aggregate;
}

async function runSample(input: {
  options: TwinRunOptions;
  sampleIndex: number;
  sampleId: string;
  sampleRoot: string;
  experimentId: string;
  snapshotManifest?: InstallationSnapshotManifest;
  suiteFingerprint: Sha256;
  cases: EvalCase[];
  protectedCaseIds: ReadonlySet<string>;
  endpoints: EndpointFingerprint[];
  endpointAssignments: EndpointAssignment[];
  endpointCompatibility: boolean;
  policy: TwinExperimentPolicy;
  globalReasons: string[];
  verifySnapshot: (snapshotDir: string) => InstallationSnapshotManifest;
  materializeSnapshot: (snapshotDir: string, destinationRoot: string) => MaterializedInstallation;
  executeArm: TwinArmExecutor;
  commandExecutor: TwinCommandExecutor;
  evalCommand: string[];
}): Promise<TwinSampleResult> {
  const { options, snapshotManifest, sampleRoot } = input;
  let snapshotArtifact: string | null = null;
  if (options.includePrivateArtifacts && snapshotManifest) {
    const file = path.join(sampleRoot, "private", "snapshot-manifest.json");
    writePrivateJson(file, snapshotManifest);
    snapshotArtifact = relativeArtifactPath(sampleRoot, file);
  }
  if (snapshotManifest) verifySampleSnapshot(input, snapshotManifest.snapshotFingerprint);

  const transientRoot = options.keepSandboxes
    ? path.join(sampleRoot, "private", "sandboxes")
    : fs.mkdtempSync(path.join(os.tmpdir(), "akm-eval-twin-"));
  ensurePrivateDir(transientRoot);
  const installationRoots: Record<TwinArm, string> = {
    control: path.join(transientRoot, crypto.randomBytes(12).toString("hex")),
    treatment: path.join(transientRoot, crypto.randomBytes(12).toString("hex")),
  };
  const scratchDirs: Record<TwinArm, string> = {
    control: path.join(transientRoot, crypto.randomBytes(12).toString("hex")),
    treatment: path.join(transientRoot, crypto.randomBytes(12).toString("hex")),
  };
  const materialized: Record<TwinArm, MaterializedArm> = { control: {}, treatment: {} };
  if (snapshotManifest && input.globalReasons.length === 0) {
    for (const arm of ["control", "treatment"] as const) {
      try {
        const installation = input.materializeSnapshot(
          path.resolve(options.snapshotDir),
          installationRoots[arm],
        );
        restrictTreeModes(installation.root);
        materialized[arm] = {
          installation,
          initialManifest: captureFileManifest(installation.root),
          effectiveConfigFingerprint: normalizedEffectiveConfigFingerprint(installation),
        };
      } catch (error) {
        materialized[arm].materializationError = `${arm} materialization failed: ${errorMessage(error)}`;
      }
    }
    verifySampleSnapshot(input, snapshotManifest.snapshotFingerprint);
  }
  const initialFingerprintsMatch = manifestsMatchExceptConfig(
    materialized.control.initialManifest,
    materialized.treatment.initialManifest,
    snapshotManifest?.configPath,
  );
  const effectiveConfigsMatch =
    materialized.control.effectiveConfigFingerprint !== undefined &&
    materialized.control.effectiveConfigFingerprint === materialized.treatment.effectiveConfigFingerprint;
  const bothMaterialized = Boolean(materialized.control.installation && materialized.treatment.installation);
  const collected = {} as Record<TwinArm, CollectedArm>;
  const armOrder = armExecutionOrder(input.sampleIndex);
  try {
    for (const arm of armOrder) {
      collected[arm] = await collectArm({
        arm,
        materialized: materialized[arm],
        mayExecute: bothMaterialized && input.globalReasons.length === 0,
        options,
        sampleId: input.sampleId,
        sampleRoot,
        snapshotManifest,
        suiteFingerprint: input.suiteFingerprint,
        cases: input.cases,
        endpointAssignments: input.endpointAssignments,
        endpoints: input.endpoints,
        executeArm: input.executeArm,
        commandExecutor: input.commandExecutor,
        evalCommand: input.evalCommand,
        scratchDir: scratchDirs[arm],
      });
    }
  } finally {
    if (!options.keepSandboxes) fs.rmSync(transientRoot, { recursive: true, force: true });
  }

  const comparison = compareTwinCaseResults(
    collected.control.execution?.caseResults ?? [],
    collected.treatment.execution?.caseResults ?? [],
    input.protectedCaseIds,
    options.criteria.protectedLossMargin,
  );
  const controlFingerprint = readSuiteFingerprint(collected.control.execution?.evalResult);
  const treatmentFingerprint = readSuiteFingerprint(collected.treatment.execution?.evalResult);
  const suiteFingerprintsMatch =
    controlFingerprint === input.suiteFingerprint &&
    treatmentFingerprint === input.suiteFingerprint &&
    controlFingerprint === treatmentFingerprint;
  const incompleteReasons = [
    ...input.globalReasons,
    ...comparison.incompleteReasons,
    ...collected.control.incompleteReasons,
    ...collected.treatment.incompleteReasons,
  ];
  if (!initialFingerprintsMatch) incompleteReasons.push("materialized arm fingerprints differ or are unavailable");
  if (!effectiveConfigsMatch) incompleteReasons.push("normalized effective configs differ or are unavailable");
  const status = decideTwinExperimentStatus({
    criteria: options.criteria,
    controlExecutedCaseCount: collected.control.result.executedCaseCount,
    treatmentExecutedCaseCount: collected.treatment.result.executedCaseCount,
    controlDeterministicScore: collected.control.result.deterministicScore,
    treatmentDeterministicScore: collected.treatment.result.deterministicScore,
    treatmentResources: collected.treatment.result.resources,
    controlIdentity: collected.control.result.identity,
    treatmentIdentity: collected.treatment.result.identity,
    regressions: comparison.regressions,
    snapshotFingerprintsMatch: initialFingerprintsMatch && effectiveConfigsMatch,
    suiteFingerprintsMatch,
    endpointServingFingerprintsCompatible: input.endpointCompatibility,
    armErrors: [
      ...collected.control.result.errors.map((error) => `control: ${error}`),
      ...collected.treatment.result.errors.map((error) => `treatment: ${error}`),
    ],
    incompleteReasons,
  });
  return {
    schemaVersion: 1,
    experimentId: input.experimentId,
    sampleId: input.sampleId,
    snapshotFingerprint: snapshotManifest?.snapshotFingerprint ?? ZERO_SHA256,
    suiteFingerprint: input.suiteFingerprint,
    policy: input.policy,
    endpoints: input.endpoints,
    endpointAssignments: input.endpointAssignments,
    arms: { control: collected.control.result, treatment: collected.treatment.result },
    caseDeltas: comparison.caseDeltas,
    newlyPassingCaseIds: comparison.newlyPassingCaseIds,
    newlyFailingCaseIds: comparison.newlyFailingCaseIds,
    regressions: comparison.regressions,
    artifactPaths: {
      snapshotManifest: snapshotArtifact,
      control: collected.control.artifacts,
      treatment: collected.treatment.artifacts,
    },
    ...status,
  };
}

async function collectArm(input: {
  arm: TwinArm;
  materialized: MaterializedArm;
  mayExecute: boolean;
  options: TwinRunOptions;
  sampleId: string;
  sampleRoot: string;
  snapshotManifest?: InstallationSnapshotManifest;
  suiteFingerprint: Sha256;
  cases: EvalCase[];
  endpointAssignments: EndpointAssignment[];
  endpoints: EndpointFingerprint[];
  executeArm: TwinArmExecutor;
  commandExecutor: TwinCommandExecutor;
  evalCommand: string[];
  scratchDir: string;
}): Promise<CollectedArm> {
  const armDir = path.join(input.sampleRoot, "arms", input.arm);
  ensurePrivateDir(armDir);
  const metricsPath = path.join(armDir, "metrics.json");
  const privateDir = path.join(input.sampleRoot, "private", input.arm);
  if (input.options.includePrivateArtifacts) ensurePrivateDir(privateDir);
  const errors: string[] = [];
  const incompleteReasons: string[] = [];
  const assignment = input.endpointAssignments.find((candidate) => candidate.arm === input.arm);
  const overlay = assignment ? input.options.endpointRuntimeOverlays?.[assignment.endpointId] : undefined;
  const sensitiveValues = [
    ...Object.values(input.options.commonRuntime?.env ?? {}),
    ...Object.values(overlay?.env ?? {}),
  ].filter((value) => value.length > 0);
  const endpointApplied = assignment === undefined || overlay !== undefined;
  if (assignment && !overlay) {
    incompleteReasons.push(
      `${input.arm} endpoint ${assignment.endpointId} has no runtime overlay; assignment was not applied`,
    );
  }
  if (input.materialized.materializationError) errors.push(input.materialized.materializationError);
  let execution: TwinArmExecution | undefined;
  let evalArtifactWritten = false;
  let caseArtifactWritten = false;
  let improveArtifactWritten = false;
  let finalManifestArtifactWritten = false;
  const scratchDir = input.scratchDir;
  ensurePrivateDir(scratchDir);
  try {
    if (input.materialized.installation && input.mayExecute && endpointApplied) {
      try {
        execution = await input.executeArm({
          arm: input.arm,
          sampleId: input.sampleId,
          installation: input.materialized.installation,
          suite: input.options.suite,
          suiteFingerprint: input.suiteFingerprint,
          caseIds: input.cases.map((evalCase) => evalCase.id),
          akmCommand: [...input.options.akmCommand],
          evalCommand: [...input.evalCommand],
          improveArgs: [...input.options.improveArgs],
          scratchDir,
          endpointAssigned: assignment !== undefined,
          commonRuntimeEnv: { ...(input.options.commonRuntime?.env ?? {}) },
          endpointRuntimeEnv: { ...(overlay?.env ?? {}) },
          commandTimeoutMs: input.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
          commandExecutor: input.commandExecutor,
        });
        errors.push(...execution.errors.map((error) => redactRuntimeString(error, sensitiveValues)));
      } catch {
        errors.push("executor failed");
      }
    }

    if (input.options.includePrivateArtifacts && execution) {
      if (execution.evalResult) {
        writePrivateJson(
          path.join(privateDir, "eval-result.json"),
          redactRuntimeValues(execution.evalResult, sensitiveValues),
        );
        evalArtifactWritten = true;
      }
      if (execution.caseResults) {
        writePrivateText(
          path.join(privateDir, "case-results.jsonl"),
          `${execution.caseResults.map((result) => JSON.stringify(redactRuntimeValues(result, sensitiveValues))).join("\n")}\n`,
        );
        caseArtifactWritten = true;
      }
      if (execution.improveResult) {
        writePrivateJson(
          path.join(privateDir, "improve-result.json"),
          redactRuntimeValues(execution.improveResult, sensitiveValues),
        );
        improveArtifactWritten = true;
      }
    }
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }

  if (!execution?.evalResult) incompleteReasons.push(`${input.arm} eval-result data unavailable`);
  if (!execution?.caseResults) incompleteReasons.push(`${input.arm} case-result data unavailable`);
  if (input.arm === "treatment") {
    if (!execution?.improveResult) incompleteReasons.push("treatment improve-result data unavailable");
    else {
      if (execution.improveResult.ok !== true) errors.push("improve-result reports ok=false or omits ok");
      if (execution.improveResult.dryRun !== false) errors.push("improve-result is not a live improve run");
    }
  }

  let finalManifest: FileManifest | undefined;
  if (input.materialized.installation) {
    try {
      restrictTreeModes(input.materialized.installation.root);
      finalManifest = captureFileManifest(input.materialized.installation.root);
      if (input.options.includePrivateArtifacts) {
        writePrivateJson(
          path.join(privateDir, "final-manifest.json"),
          redactRuntimeValues(finalManifest, sensitiveValues),
        );
        finalManifestArtifactWritten = true;
      }
    } catch (error) {
      incompleteReasons.push(`${input.arm} final manifest unavailable: ${errorMessage(error)}`);
    }
  } else {
    incompleteReasons.push(`${input.arm} installation unavailable`);
  }
  const mutations = summarizeMutations(input.materialized.initialManifest, finalManifest);
  const evalResult = execution?.evalResult;
  const caseResults = execution?.caseResults ?? [];
  let deterministicScore = 0;
  if (evalResult) {
    validateEvalResult(
      evalResult,
      caseResults,
      input.cases,
      input.materialized.installation,
      input.options.suite,
      input.arm,
      incompleteReasons,
      errors,
    );
    if (Number.isFinite(evalResult.scores?.deterministic)) deterministicScore = evalResult.scores.deterministic;
  }
  const executionResources = execution?.resources ?? { llmWorkExpected: false, improve: null };
  const resources: TwinArmResources = {
    llmWorkExpected: executionResources.llmWorkExpected || (executionResources.improve?.modelCalls ?? 0) > 0,
    improve: executionResources.improve,
  };
  const assignedEndpoint = assignment
    ? input.endpoints.find((endpoint) => endpoint.endpointId === assignment.endpointId)
    : undefined;
  const endpointBound = Boolean(
    assignedEndpoint &&
    resources.improve?.telemetryComplete &&
    resources.improve.modelCalls > 0 &&
    resources.improve.observedModelIds.length > 0 &&
    resources.improve.observedModelIds.every((modelId) => modelId === assignedEndpoint.modelId),
  );
  if (isLlmRelevant(resources)) {
    if (!resources.improve) {
      incompleteReasons.push(`${input.arm} expected improve LLM telemetry is incomplete`);
    } else {
      if (resources.improve.modelCalls === 0) {
        incompleteReasons.push(`${input.arm} expected improve LLM telemetry recorded zero calls`);
      }
      if (!resources.improve.telemetryComplete) {
        incompleteReasons.push(`${input.arm} expected improve LLM telemetry is incomplete`);
      }
    }
    if (assignment && !endpointBound) {
      incompleteReasons.push(`${input.arm} observed models do not match the assigned endpoint model`);
    }
  }
  const result: TwinArmResult = {
    identity: buildArmIdentity(
      evalResult,
      input.snapshotManifest,
      assignment,
      input.endpoints,
      endpointBound,
    ),
    executedCaseCount: caseResults.filter((caseResult) => !caseResult.skipped).length,
    deterministicScore,
    mutations,
    resources,
    errors: [...new Set(errors)],
  };
  writePrivateJson(metricsPath, { schemaVersion: 1, arm: input.arm, result });
  const privateArtifacts = input.options.includePrivateArtifacts
    ? {
        evalResult: evalArtifactWritten
          ? relativeArtifactPath(input.sampleRoot, path.join(privateDir, "eval-result.json"))
          : null,
        caseResults: caseArtifactWritten
          ? relativeArtifactPath(input.sampleRoot, path.join(privateDir, "case-results.jsonl"))
          : null,
        improveResult: improveArtifactWritten
          ? relativeArtifactPath(input.sampleRoot, path.join(privateDir, "improve-result.json"))
          : null,
        finalManifest: finalManifestArtifactWritten
          ? relativeArtifactPath(input.sampleRoot, path.join(privateDir, "final-manifest.json"))
          : null,
        sandboxRoot: input.options.keepSandboxes ? (input.materialized.installation?.root ?? null) : null,
    }
    : null;
  return {
    result,
    artifacts: { metrics: relativeArtifactPath(input.sampleRoot, metricsPath), privateArtifacts },
    execution,
    incompleteReasons,
  };
}

async function executeArmWithExistingRunner(input: TwinArmExecutionInput): Promise<TwinArmExecution> {
  const env = { ...buildTwinChildEnv(input.installation, input.scratchDir), ...input.commonRuntimeEnv };
  const errors: string[] = [];
  const runAkm = (args: string[], commandEnv = env): Promise<TwinCommandResult> =>
    Promise.resolve(
      input.commandExecutor({
        command: input.akmCommand[0]!,
        args: [...input.akmCommand.slice(1), ...args],
        env: commandEnv,
        cwd: input.installation.root,
        timeoutMs: input.commandTimeoutMs,
      }),
    );
  const index = await runAkm(["index"]);
  if (index.status !== 0) errors.push(commandFailure("akm index", index));

  let improveResult: Record<string, unknown> | undefined;
  let improveMetrics: TwinResourceMetrics | null = null;
  let llmWorkExpected = input.endpointAssigned;
  if (input.arm === "treatment") {
    const stateDbPath = path.join(input.installation.dataDir, "state.db");
    let beforeCursor: number | undefined;
    try {
      beforeCursor = readMaxEventId(stateDbPath);
    } catch {
      // Missing telemetry becomes inconclusive below when LLM work was expected.
    }
    const improveStartedAt = performance.now();
    const improve = await runAkm(
      ["improve", "--json-to-stdout", ...input.improveArgs],
      { ...env, ...input.endpointRuntimeEnv },
    );
    const improveWallDurationMs = Math.max(0, Math.ceil(performance.now() - improveStartedAt));
    if (improve.status !== 0) errors.push(commandFailure("akm improve", improve));
    if (improve.stdout.trim() === "") {
      errors.push("akm improve did not emit improve-result JSON");
    } else {
      try {
        const parsed = JSON.parse(improve.stdout) as unknown;
        if (!isRecord(parsed)) throw new Error("root is not an object");
        improveResult = parsed;
        llmWorkExpected ||= improveResultIndicatesLlmWork(parsed);
      } catch {
        errors.push("invalid improve-result JSON");
      }
    }
    improveMetrics = { ...emptyResourceMetrics(), wallDurationMs: improveWallDurationMs };
    if (beforeCursor !== undefined) {
      try {
        const afterCursor = readMaxEventId(stateDbPath);
        improveMetrics = readImproveResourceMetrics(
          stateDbPath,
          beforeCursor,
          afterCursor,
          improveWallDurationMs,
        );
        llmWorkExpected ||= improveMetrics.modelCalls > 0;
      } catch {
        improveMetrics.telemetryComplete = false;
      }
    }
    if (APPEND_EVENT_FAILURE.test(improve.stderr)) {
      improveMetrics.telemetryComplete = false;
      llmWorkExpected = true;
    }
    const reindex = await runAkm(["index"]);
    if (reindex.status !== 0) errors.push(commandFailure("post-improve akm index", reindex));
  }

  const evalOut = path.join(input.scratchDir, "eval-run");
  const wrapper = createAkmCommandWrapper(input.scratchDir);
  const evalEnv = {
    ...env,
    AKM_EVAL_TWIN_AKM_COMMAND_B64: Buffer.from(JSON.stringify(input.akmCommand), "utf8").toString("base64"),
    AKM_EVAL_TWIN_COMMAND_TIMEOUT_MS: String(input.commandTimeoutMs),
  };
  const evaluation = await input.commandExecutor({
    command: input.evalCommand[0]!,
    args: [
      ...input.evalCommand.slice(1),
      "--suite",
      input.suite,
      "--mode",
      "baseline",
      "--stash",
      input.installation.bundleRoots[input.installation.defaultBundle]!,
      "--out",
      evalOut,
      "--akm",
      wrapper,
      "--format",
      "none",
    ],
    env: evalEnv,
    cwd: input.installation.root,
    timeoutMs: input.commandTimeoutMs,
  });
  if (evaluation.status !== 0) errors.push(commandFailure("akm-eval-run", evaluation));
  let loaded: { evalResult: EvalRunResult; caseResults: EvalCaseResult[] } | undefined;
  try {
    loaded = loadLatestEvalArtifacts(evalOut);
  } catch {
    errors.push("failed to collect eval artifacts");
  }
  return {
    evalResult: loaded?.evalResult,
    caseResults: loaded?.caseResults,
    improveResult,
    resources: {
      llmWorkExpected: input.arm === "treatment" && llmWorkExpected,
      improve: input.arm === "treatment" ? improveMetrics : null,
    },
    errors,
  };
}

function validateEvalResult(
  evalResult: EvalRunResult,
  caseResults: EvalCaseResult[],
  expectedCases: EvalCase[],
  installation: MaterializedInstallation | undefined,
  suite: string,
  arm: TwinArm,
  incompleteReasons: string[],
  errors: string[],
): void {
  if (evalResult.schemaVersion !== 2) incompleteReasons.push(`${arm} eval-result is not schemaVersion 2`);
  if (evalResult.suite !== suite) incompleteReasons.push(`${arm} eval-result suite mismatch`);
  if (evalResult.mode !== "baseline") incompleteReasons.push(`${arm} eval-result did not use baseline mode`);
  const reportedCaseCount = evalResult.inputs?.caseCount;
  if (reportedCaseCount !== expectedCases.length || reportedCaseCount !== caseResults.length) {
    incompleteReasons.push(`${arm} eval case count is incomplete`);
  }
  if (!Number.isFinite(evalResult.scores?.deterministic)) {
    incompleteReasons.push(`${arm} deterministic score is unavailable`);
  }
  if (installation) {
    const expectedStash = installation.bundleRoots[installation.defaultBundle];
    if (!evalResult.akm.stashRoot || path.resolve(evalResult.akm.stashRoot) !== path.resolve(expectedStash ?? "")) {
      incompleteReasons.push(`${arm} eval stash path does not match the materialized installation`);
    }
    if (!evalResult.akm.dataDir || path.resolve(evalResult.akm.dataDir) !== path.resolve(installation.dataDir)) {
      incompleteReasons.push(`${arm} eval data path does not match the materialized installation`);
    }
  }
  const expectedIds = new Set(expectedCases.map((evalCase) => evalCase.id));
  const actualIds = new Set(caseResults.map((caseResult) => caseResult.caseId));
  let caseDataValid = true;
  if (
    expectedIds.size !== expectedCases.length ||
    actualIds.size !== caseResults.length ||
    expectedIds.size !== actualIds.size ||
    [...expectedIds].some((caseId) => !actualIds.has(caseId))
  ) {
    incompleteReasons.push(`${arm} case-result IDs do not match the suite`);
    caseDataValid = false;
  }
  const expectedById = new Map(expectedCases.map((evalCase) => [evalCase.id, evalCase]));
  for (const caseResult of caseResults) {
    const expected = expectedById.get(caseResult.caseId);
    if (
      !expected ||
      caseResult.type !== expected.type ||
      (caseResult.deterministic !== false) !== (expected.scoring?.deterministic !== false)
    ) {
      incompleteReasons.push(`${arm} case-result metadata does not match the suite: ${caseResult.caseId}`);
      caseDataValid = false;
    }
  }
  if (caseDataValid) {
    const recomputed = aggregateScores(caseResults).deterministic;
    if (!scoresEqual(recomputed, evalResult.scores.deterministic)) {
      incompleteReasons.push(`${arm} deterministic score does not match case-result aggregation`);
    }
  }
  if (Array.isArray(evalResult.errors)) {
    errors.push(...evalResult.errors.map((error) => `${error.caseId}: eval case error`));
  } else {
    incompleteReasons.push(`${arm} eval error list is unavailable`);
  }
  for (const caseResult of caseResults) {
    errors.push(...(caseResult.errors ?? []).map(() => `${caseResult.caseId}: eval case error`));
  }
}

function scoresEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 8;
}

function buildArmIdentity(
  evalResult: EvalRunResult | undefined,
  manifest: InstallationSnapshotManifest | undefined,
  assignment: EndpointAssignment | undefined,
  endpoints: EndpointFingerprint[],
  endpointBoundByTelemetry: boolean,
): TwinArmIdentity {
  const endpoint = endpointBoundByTelemetry && assignment
    ? endpoints.find((candidate) => candidate.endpointId === assignment.endpointId)
    : undefined;
  return {
    runtimeProducer: {
      version: evalResult?.akm.version ?? "unverified",
      commit: null,
    },
    snapshotProducer: manifest?.producer ?? { version: "unverified", commit: null },
    configFingerprint: manifest?.configFingerprint ?? ZERO_SHA256,
    promptFingerprint: endpoint?.promptFingerprint ?? null,
    modelFingerprint: endpoint?.modelSha256 ?? null,
  };
}

function buildAggregateResult(input: {
  experimentId: string;
  snapshotFingerprint: Sha256;
  suiteFingerprint: Sha256;
  policy: TwinExperimentPolicy;
  endpoints: EndpointFingerprint[];
  samples: TwinSampleResult[];
  experimentResultPath: string;
  sampleResultPaths: string[];
}): TwinExperimentResult {
  const conclusive = input.samples.filter((sample) => sample.status !== "inconclusive");
  const deterministicDeltas = conclusive.map(
    (sample) => sample.arms.treatment.deterministicScore - sample.arms.control.deterministicScore,
  );
  const meanDeterministicDelta = deterministicDeltas.length > 0
    ? deterministicDeltas.reduce((sum, value) => sum + value, 0) / deterministicDeltas.length
    : null;
  const treatmentResources = sumTreatmentResources(input.samples);
  const identityFailures = aggregateIdentityFailures(input.samples);
  const reasons: string[] = [];
  let status: TwinExperimentStatus["status"];
  if (input.samples.length < input.policy.criteria.requiredSampleCount) {
    status = "inconclusive";
    reasons.push(
      `completed ${input.samples.length} samples; ${input.policy.criteria.requiredSampleCount} were required`,
    );
  } else if (input.samples.some((sample) => sample.status === "inconclusive")) {
    status = "inconclusive";
    reasons.push(
      `inconclusive samples: ${input.samples.filter((sample) => sample.status === "inconclusive").map((sample) => sample.sampleId).join(", ")}`,
    );
  } else if (identityFailures.length > 0) {
    status = "inconclusive";
    reasons.push(...identityFailures);
  } else if (meanDeterministicDelta === null) {
    status = "inconclusive";
    reasons.push("no conclusive deterministic sample deltas");
  } else {
    const budgetFailures = resourceBudgetFailures(treatmentResources, input.policy.criteria);
    const protectedRegressions = input.samples.flatMap((sample) => sample.regressions.filter((regression) => regression.protected));
    if (budgetFailures.length > 0) {
      status = "fail";
      reasons.push(...budgetFailures);
    } else if (protectedRegressions.length > 0) {
      status = "fail";
      reasons.push(`protected regressions occurred in ${protectedRegressions.length} sample-case comparisons`);
    } else if (meanDeterministicDelta >= input.policy.criteria.minimumDeterministicLift) {
      status = "pass";
      reasons.push(`mean deterministic lift ${meanDeterministicDelta.toFixed(6)} met the predeclared minimum`);
    } else {
      status = "fail";
      reasons.push(
        `mean deterministic lift ${meanDeterministicDelta.toFixed(6)} was below ${input.policy.criteria.minimumDeterministicLift.toFixed(6)}`,
      );
    }
  }
  return {
    schemaVersion: 1,
    experimentId: input.experimentId,
    snapshotFingerprint: input.snapshotFingerprint,
    suiteFingerprint: input.suiteFingerprint,
    policy: input.policy,
    endpoints: input.endpoints,
    samples: input.samples,
    metrics: {
      requestedSampleCount: input.samples.length,
      requiredSampleCount: input.policy.criteria.requiredSampleCount,
      conclusiveSampleCount: conclusive.length,
      deterministicDeltas,
      meanDeterministicDelta,
      treatmentResources,
    },
    artifactPaths: {
      experimentResult: input.experimentResultPath,
      sampleResults: input.sampleResultPaths,
    },
    status,
    reasons: reasons as [string, ...string[]],
  };
}

function aggregateIdentityFailures(samples: TwinSampleResult[]): string[] {
  const reference = samples[0]?.arms.control.identity;
  if (!reference) return ["no sample identity is available"];
  for (const sample of samples) {
    for (const arm of [sample.arms.control, sample.arms.treatment]) {
      if (
        !sameProducer(reference.runtimeProducer, arm.identity.runtimeProducer) ||
        !sameProducer(reference.snapshotProducer, arm.identity.snapshotProducer) ||
        reference.configFingerprint !== arm.identity.configFingerprint
      ) {
        return ["producer or config identity changed across samples"];
      }
    }
  }
  const llmIdentities = samples
    .filter(
      (sample) =>
        sample.arms.treatment.resources.llmWorkExpected ||
        (sample.arms.treatment.resources.improve?.modelCalls ?? 0) > 0,
    )
    .map((sample) => sample.arms.treatment.identity);
  const llmReference = llmIdentities[0];
  if (
    llmReference &&
    llmIdentities.some(
      (identity) =>
        identity.promptFingerprint !== llmReference.promptFingerprint ||
        identity.modelFingerprint !== llmReference.modelFingerprint,
    )
  ) {
    return ["treatment model or prompt identity changed across samples"];
  }
  return [];
}

function sumTreatmentResources(samples: TwinSampleResult[]): TwinResourceMetrics {
  const total = emptyResourceMetrics();
  const observedModelIds = new Set<string>();
  for (const sample of samples) {
    const metrics = sample.arms.treatment.resources.improve;
    if (!metrics) continue;
    total.modelCalls += metrics.modelCalls;
    total.promptTokens += metrics.promptTokens;
    total.completionTokens += metrics.completionTokens;
    total.totalTokens += metrics.totalTokens;
    total.wallDurationMs += metrics.wallDurationMs;
    total.modelCallDurationMs += metrics.modelCallDurationMs;
    for (const modelId of metrics.observedModelIds) observedModelIds.add(modelId);
  }
  total.telemetryComplete = samples.every(
    (sample) => !isLlmRelevant(sample.arms.treatment.resources) || sample.arms.treatment.resources.improve?.telemetryComplete === true,
  );
  total.observedModelIds = [...observedModelIds].sort();
  // Throughput is endpoint-specific and is not pooled across samples or hardware.
  total.tokensPerSecond = null;
  return total;
}

function resourceBudgetFailures(resources: TwinResourceMetrics, criteria: TwinDecisionCriteria): string[] {
  const failures: string[] = [];
  if (resources.totalTokens > criteria.maxTreatmentTokens) {
    failures.push(`treatment tokens ${resources.totalTokens} exceeded ${criteria.maxTreatmentTokens}`);
  }
  if (resources.modelCalls > criteria.maxTreatmentModelCalls) {
    failures.push(`treatment model calls ${resources.modelCalls} exceeded ${criteria.maxTreatmentModelCalls}`);
  }
  if (resources.wallDurationMs > criteria.maxTreatmentDurationMs) {
    failures.push(
      `treatment improve wall duration ${resources.wallDurationMs}ms exceeded ${criteria.maxTreatmentDurationMs}ms`,
    );
  }
  return failures;
}

function improveResultIndicatesLlmWork(result: Record<string, unknown>): boolean {
  return (
    (Array.isArray(result.plannedRefs) && result.plannedRefs.length > 0) ||
    (Array.isArray(result.actions) && result.actions.length > 0) ||
    isRecord(result.consolidation) ||
    isRecord(result.memoryInference) ||
    isRecord(result.graphExtraction)
  );
}

function redactRuntimeValues(value: unknown, sensitiveValues: string[]): unknown {
  if (typeof value === "string") {
    return redactRuntimeString(value, sensitiveValues);
  }
  if (Array.isArray(value)) return value.map((item) => redactRuntimeValues(item, sensitiveValues));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, redactRuntimeValues(child, sensitiveValues)]),
  );
}

function redactRuntimeString(value: string, sensitiveValues: string[]): string {
  return sensitiveValues.reduce(
    (current, sensitive) => current.replaceAll(sensitive, "[REDACTED]"),
    value,
  );
}

function verifySampleSnapshot(
  input: {
    options: TwinRunOptions;
    globalReasons: string[];
    verifySnapshot: (snapshotDir: string) => InstallationSnapshotManifest;
  },
  expectedFingerprint: Sha256,
): void {
  try {
    const current = input.verifySnapshot(path.resolve(input.options.snapshotDir));
    if (current.snapshotFingerprint !== expectedFingerprint) input.globalReasons.push("snapshot fingerprint mismatch");
  } catch (error) {
    input.globalReasons.push(`snapshot re-verification failed: ${errorMessage(error)}`);
  }
}

function normalizeEndpointAssignments(
  options: TwinRunOptions,
  endpoints: EndpointFingerprint[],
): EndpointAssignment[][] {
  const assignments = options.endpointAssignments ?? Array.from({ length: options.samples }, () => []);
  validateEndpointAssignments(assignments, options.samples, endpoints);
  return assignments.map((sample) => sample.map((assignment) => ({ ...assignment })));
}

function validateEndpointAssignments(
  assignments: EndpointAssignment[][],
  samples: number,
  endpoints: EndpointFingerprint[],
): void {
  if (assignments.length !== samples) throw new Error("endpoint assignment sample count does not match --samples");
  const endpointIds = new Set(endpoints.map((endpoint) => endpoint.endpointId));
  const orderCounts = new Map<string, [number, number]>();
  for (const [sampleIndex, sample] of assignments.entries()) {
    const arms = new Set<TwinArm>();
    for (const assignment of sample) {
      if (!isRecord(assignment) || Object.keys(assignment).some((key) => key !== "arm" && key !== "endpointId")) {
        throw new Error(`invalid endpoint assignment in sample ${sampleIndex + 1}`);
      }
      if (assignment.arm !== "control" && assignment.arm !== "treatment") {
        throw new Error(`invalid endpoint arm in sample ${sampleIndex + 1}`);
      }
      if (assignment.arm === "control") {
        throw new Error(`control endpoint assignment is invalid because endpoint overlays are improve-only`);
      }
      if (arms.has(assignment.arm)) throw new Error(`duplicate endpoint arm in sample ${sampleIndex + 1}`);
      if (!endpointIds.has(assignment.endpointId)) throw new Error(`unknown assigned endpoint: ${assignment.endpointId}`);
      arms.add(assignment.arm);
      const counts: [number, number] = orderCounts.get(assignment.endpointId) ?? [0, 0];
      if (sampleIndex % 2 === 0) counts[0] += 1;
      else counts[1] += 1;
      orderCounts.set(assignment.endpointId, counts);
    }
  }
  for (const [endpointId, [controlFirst, treatmentFirst]] of orderCounts) {
    if (controlFirst !== treatmentFirst) {
      throw new Error(`endpoint assignment is not counterbalanced across arm order: ${endpointId}`);
    }
  }
}

function validateEndpoints(endpoints: EndpointFingerprint[]): void {
  assertUniqueEndpointIds(endpoints);
  for (const endpoint of endpoints) validateEndpointFingerprint(endpoint);
}

function assertUniqueEndpointIds(endpoints: EndpointFingerprint[]): void {
  const ids = new Set<string>();
  for (const endpoint of endpoints) {
    if (ids.has(endpoint.endpointId)) throw new Error(`duplicate endpointId: ${endpoint.endpointId}`);
    ids.add(endpoint.endpointId);
  }
}

function validateRunOptions(options: TwinRunOptions): void {
  if (!options.snapshotDir) throw new Error("--snapshot is required");
  if (!options.suite) throw new Error("--suite is required");
  if (!options.outDir) throw new Error("--out is required");
  if (!Array.isArray(options.akmCommand) || options.akmCommand.length === 0 || options.akmCommand.some((part) => !part)) {
    throw new Error("--akm must resolve to a non-empty command vector");
  }
  if (!Number.isSafeInteger(options.samples) || options.samples < 1) {
    throw new Error("--samples must be a positive integer");
  }
  if (options.policy !== "current" && options.policy !== "candidate-only") {
    throw new Error("--policy must be current|candidate-only");
  }
  assertTwinDecisionCriteria(options.criteria);
  if (options.samples < options.criteria.requiredSampleCount) {
    throw new Error("--samples must be at least --required-samples");
  }
  if (
    options.commandTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.commandTimeoutMs) || options.commandTimeoutMs < 1)
  ) {
    throw new Error("--command-timeout-ms must be a positive integer");
  }
  if (options.keepSandboxes && !options.includePrivateArtifacts) {
    throw new Error("--keep-sandboxes requires --include-private-artifacts");
  }
  if (
    options.keepSandboxes &&
    (Object.keys(options.endpointRuntimeOverlays ?? {}).length > 0 || options.commonRuntime !== undefined)
  ) {
    throw new Error("--keep-sandboxes with runtime overlays is unsupported because overlays must never persist");
  }
  if (
    options.protectedCaseIds !== undefined &&
    (!Array.isArray(options.protectedCaseIds) ||
      options.protectedCaseIds.some((caseId) => typeof caseId !== "string" || caseId.trim().length === 0))
  ) {
    throw new Error("--protected-case values must be non-empty strings");
  }
  if (options.commonRuntime) validateRuntimeOverlay("common runtime", options.commonRuntime);
  const endpointIds = new Set((options.endpoints ?? []).map((endpoint) => endpoint.endpointId));
  for (const [endpointId, overlay] of Object.entries(options.endpointRuntimeOverlays ?? {})) {
    if (!endpointIds.has(endpointId)) throw new Error(`runtime overlay references unknown endpoint: ${endpointId}`);
    validateEndpointRuntimeOverlay(endpointId, overlay);
  }
}

function validateEndpointRuntimeOverlay(endpointId: string, overlay: EndpointRuntimeOverlay): void {
  validateRuntimeOverlay(`endpoint ${endpointId}`, overlay);
}

function validateRuntimeOverlay(label: string, overlay: CommonRuntimeOverlay): void {
  if (!isRecord(overlay) || Object.keys(overlay).some((key) => key !== "env") || !isRecord(overlay.env)) {
    throw new Error(`invalid runtime overlay for ${label}`);
  }
  for (const [key, value] of Object.entries(overlay.env)) {
    if (!key || typeof value !== "string") throw new Error(`invalid runtime environment for ${label}`);
    if (RESERVED_ENDPOINT_ENV.has(key)) throw new Error(`runtime overlay cannot replace isolation variable: ${key}`);
  }
}

function readSuiteFingerprint(evalResult: EvalRunResult | undefined): Sha256 | undefined {
  const fingerprint = evalResult?.inputs?.suiteFingerprint;
  return isSha256(fingerprint) ? fingerprint : undefined;
}

function executeCommand(request: TwinCommandRequest): TwinCommandResult {
  const result = spawnSync(request.command, request.args, {
    encoding: "utf8",
    env: request.env,
    cwd: request.cwd,
    timeout: request.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
  });
  if (result.error) throw new Error(`subprocess failed to spawn: ${result.error.message}`);
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function commandFailure(label: string, result: TwinCommandResult): string {
  return `${label} failed (exit ${String(result.status)})`;
}

function buildTwinChildEnv(
  installation: MaterializedInstallation,
  scratchDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_TWIN_PARENT_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && NAMED_AKM_CREDENTIAL.test(key)) env[key] = value;
  }
  for (const key of EVAL_STORAGE_ENV_KEYS) {
    const value = installation.env[key];
    if (!value || !isSameOrInside(installation.root, value)) {
      throw new Error(`materialized installation has invalid isolated environment path: ${key}`);
    }
    env[key] = value;
  }
  env.TMPDIR = scratchDir;
  env.TMP = scratchDir;
  env.TEMP = scratchDir;
  return env;
}

function isSameOrInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function relativeArtifactPath(root: string, artifact: string): string {
  return path.relative(root, artifact).split(path.sep).join("/");
}

function defaultExperimentId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
}

function parseArgs(argv: string[]): CliOptions {
  let criteria: Partial<TwinDecisionCriteria> = {};
  const options: Omit<CliOptions, "criteria"> = {
    snapshotDir: "",
    suite: "improve-smoke",
    akmCommand: tokenizeCommandVector(process.env.AKM_BIN ?? "akm"),
    outDir: "",
    samples: 1,
    policy: "current",
    improveArgs: [],
    keepSandboxes: false,
    includePrivateArtifacts: false,
    commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    protectedCaseIds: [],
    endpointMetadataFiles: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    const next = (): string => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`missing value for ${argument}`);
      return value;
    };
    switch (argument) {
      case "--snapshot": options.snapshotDir = next(); break;
      case "--suite": options.suite = next(); break;
      case "--akm": options.akmCommand = tokenizeCommandVector(next()); break;
      case "--out": options.outDir = next(); break;
      case "--samples": options.samples = Number(next()); break;
      case "--policy": {
        const policy = next();
        if (policy !== "current" && policy !== "candidate-only") throw new Error("--policy must be current|candidate-only");
        options.policy = policy;
        break;
      }
      case "--improve-args": {
        const value = next();
        options.improveArgs = value.trim() ? tokenizeCommandVector(value) : [];
        break;
      }
      case "--keep-sandboxes": options.keepSandboxes = true; break;
      case "--include-private-artifacts": options.includePrivateArtifacts = true; break;
      case "--endpoint-metadata":
      case "--endpoint": options.endpointMetadataFiles.push(next()); break;
      case "--endpoint-assignment": options.endpointAssignment = next(); break;
      case "--endpoint-runtime": options.endpointRuntimeFile = next(); break;
      case "--common-runtime": options.commonRuntimeFile = next(); break;
      case "--protected-case": options.protectedCaseIds?.push(next()); break;
      case "--minimum-deterministic-lift":
      case "--min-deterministic-lift": criteria.minimumDeterministicLift = Number(next()); break;
      case "--protected-loss-margin": criteria.protectedLossMargin = Number(next()); break;
      case "--max-treatment-tokens": criteria.maxTreatmentTokens = Number(next()); break;
      case "--max-treatment-calls": criteria.maxTreatmentModelCalls = Number(next()); break;
      case "--max-treatment-duration-ms": criteria.maxTreatmentDurationMs = Number(next()); break;
      case "--required-samples": criteria.requiredSampleCount = Number(next()); break;
      case "--command-timeout-ms": options.commandTimeoutMs = Number(next()); break;
      case "-h":
      case "--help": printHelp(); process.exit(0);
      default: throw new Error(`unknown argument: ${argument}`);
    }
  }
  assertTwinDecisionCriteria(criteria);
  return { ...options, criteria };
}

function loadEndpointMetadata(files: string[]): EndpointFingerprint[] {
  return files.flatMap((file) => {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as unknown;
    return (Array.isArray(parsed) ? parsed : [parsed]).map(validateEndpointFingerprint);
  });
}

function loadEndpointAssignment(
  value: string | undefined,
  endpoints: EndpointFingerprint[],
  samples: number,
): EndpointAssignment[][] | undefined {
  if (!value) return undefined;
  if (value === "balanced") return buildBalancedEndpointAssignments(endpoints, samples);
  if (endpoints.some((endpoint) => endpoint.endpointId === value)) {
    return Array.from({ length: samples }, () => [{ arm: "treatment", endpointId: value }]);
  }
  const parsed = JSON.parse(fs.readFileSync(path.resolve(value), "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("endpoint assignment JSON must be an array of sample arrays");
  return parsed as EndpointAssignment[][];
}

function loadEndpointRuntimeOverlays(file: string | undefined): Record<string, EndpointRuntimeOverlay> | undefined {
  if (!file) return undefined;
  const absolute = path.resolve(file);
  assertPrivateRuntimeFile(absolute, "endpoint runtime overlay");
  const parsed = JSON.parse(fs.readFileSync(absolute, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("endpoint runtime overlay must be an object keyed by endpoint ID");
  const overlays: Record<string, EndpointRuntimeOverlay> = {};
  for (const [endpointId, overlay] of Object.entries(parsed)) {
    validateEndpointRuntimeOverlay(endpointId, overlay as EndpointRuntimeOverlay);
    overlays[endpointId] = overlay as EndpointRuntimeOverlay;
  }
  return overlays;
}

function loadCommonRuntime(file: string | undefined): CommonRuntimeOverlay | undefined {
  if (!file) return undefined;
  const absolute = path.resolve(file);
  assertPrivateRuntimeFile(absolute, "common runtime");
  const parsed = JSON.parse(fs.readFileSync(absolute, "utf8")) as unknown;
  validateRuntimeOverlay("common runtime", parsed as CommonRuntimeOverlay);
  return parsed as CommonRuntimeOverlay;
}

function assertPrivateRuntimeFile(file: string, label: string): void {
  const mode = fs.statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${label} file must be mode 0600 or stricter`);
}

function printHelp(): void {
  process.stdout.write(`akm-eval-twin - private frozen-installation twin runner

Usage:
  akm-eval-twin --snapshot <dir> --suite <name> --akm "<command>" --out <dir>
                --minimum-deterministic-lift <n> --protected-loss-margin <n>
                --max-treatment-tokens <n> --max-treatment-calls <n>
                --max-treatment-duration-ms <n> --required-samples <n> [options]

Options:
  --samples <n>                    Samples to execute (default: 1).
  --policy current|candidate-only  Candidate-only currently returns inconclusive without executing.
  --improve-args "<args>"          Safely tokenized arguments; --no-sync is always appended.
  --include-private-artifacts      Persist full eval/case/improve/manifests with private modes.
  --keep-sandboxes                 Retain sandboxes; requires --include-private-artifacts.
  --command-timeout-ms <n>         Per-command timeout (default: ${DEFAULT_COMMAND_TIMEOUT_MS}).
  --protected-case <id>            Protected case ID; repeatable. Unioned with protected and
                                   regression-guard suite tags; at least one is required.
  --common-runtime <json>          Mode-0600 {env:{...}} applied identically to both arms.
  --endpoint-metadata <json>       Strict canonical EndpointFingerprint JSON; repeatable.
  --endpoint-assignment <value>    balanced, endpoint ID, or assignment JSON file. Every endpoint
                                   must occur equally in control-first and treatment-first samples.
  --endpoint-runtime <json>        Mode-0600 runtime env overlays keyed by endpoint ID; never serialized.
`);
}

async function main(): Promise<number> {
  const cli = parseArgs(process.argv.slice(2));
  const endpoints = loadEndpointMetadata(cli.endpointMetadataFiles);
  const endpointAssignments = loadEndpointAssignment(cli.endpointAssignment, endpoints, cli.samples);
  const endpointRuntimeOverlays = loadEndpointRuntimeOverlays(cli.endpointRuntimeFile);
  const commonRuntime = loadCommonRuntime(cli.commonRuntimeFile);
  const result = await runTwinExperiment({
    ...cli,
    endpoints,
    endpointAssignments,
    endpointRuntimeOverlays,
    commonRuntime,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(
    `[akm-eval-twin] ${result.status} -> ${path.join(path.resolve(cli.outDir), result.experimentId, result.artifactPaths.experimentResult)}\n`,
  );
  return result.status === "pass" ? 0 : result.status === "fail" ? 1 : 2;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    process.stderr.write(`[akm-eval-twin] ${errorMessage(error)}\n`);
    process.exit(2);
  }
}
