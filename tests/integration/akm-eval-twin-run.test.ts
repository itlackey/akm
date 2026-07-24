// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  armExecutionOrder,
  buildBalancedEndpointAssignments,
  compareTwinCaseResults,
  decideTwinExperimentStatus,
  deriveEndpointServingFingerprint,
  endpointServingFingerprintsAreCompatible,
  runTwinExperiment,
  type TwinArmExecution,
  type TwinArmExecutionInput,
  tokenizeCommandVector,
  validateEndpointFingerprint,
} from "../../scripts/akm-eval/src/twin-run";
import { readImproveResourceMetrics } from "../../scripts/akm-eval/src/twin-run-private";
import type {
  EndpointFingerprint,
  InstallationSnapshotManifest,
  MaterializedInstallation,
  Sha256,
  TwinDecisionCriteria,
  TwinResourceMetrics,
} from "../../scripts/akm-eval/src/twin-types";
import type { EvalCaseResult, EvalRunResult } from "../../scripts/akm-eval/src/types";
import { withEnv } from "../_helpers/sandbox";

const digest = "a".repeat(64) as Sha256;
const protectedCaseId = "retrieval-search-returns-hits";
const criteria: TwinDecisionCriteria = {
  minimumDeterministicLift: 0.2,
  protectedLossMargin: 0.1,
  maxTreatmentTokens: 100,
  maxTreatmentModelCalls: 10,
  maxTreatmentDurationMs: 1_000,
  requiredSampleCount: 2,
};

function endpoint(endpointId: string): EndpointFingerprint {
  const metadata = {
    schemaVersion: 1,
    endpointId,
    modelId: "fixture-model",
    modelSha256: digest,
    promptFingerprint: digest,
    quantization: "q8",
    contextLimit: 8192,
    serverImplementation: "fixture",
    serverVersion: "1",
    samplerSettings: { temperature: 0 },
  } as const;
  return { ...metadata, servingFingerprint: deriveEndpointServingFingerprint(metadata) };
}

function armIdentity(overrides: Partial<EndpointFingerprint> = {}) {
  const selected = { ...endpoint("identity"), ...overrides };
  return {
    runtimeProducer: { version: "fixture", commit: null },
    snapshotProducer: { version: "fixture", commit: "snapshot-commit" },
    configFingerprint: digest,
    promptFingerprint: selected.promptFingerprint,
    modelFingerprint: selected.modelSha256,
  };
}

function snapshotManifest(): InstallationSnapshotManifest {
  return {
    schemaVersion: 2,
    snapshotFingerprint: digest,
    producer: { version: "fixture", commit: "snapshot-commit" },
    configFingerprint: digest,
    defaultBundle: "personal",
    bundleRoots: { personal: "bundles/personal" as InstallationSnapshotManifest["configPath"] },
    configPath: "config/config.json" as InstallationSnapshotManifest["configPath"],
    dataDir: "data" as InstallationSnapshotManifest["dataDir"],
    entries: [],
  };
}

function materializeFixture(destinationRoot: string): MaterializedInstallation {
  const bundle = path.join(destinationRoot, "bundles", "personal");
  const dataDir = path.join(destinationRoot, "data");
  const configPath = path.join(destinationRoot, "config", "config.json");
  const runtimeRoot = path.join(destinationRoot, "runtime");
  fs.mkdirSync(bundle, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(path.join(bundle, "asset.md"), "fixture\n");
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ defaultBundle: "personal", bundles: { personal: { kind: "filesystem", path: bundle } } })}\n`,
  );
  const db = new Database(path.join(dataDir, "state.db"));
  db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, metadata_json TEXT)");
  db.close();
  const isolatedDirs = {
    HOME: path.join(runtimeRoot, "home"),
    XDG_CONFIG_HOME: path.join(runtimeRoot, "xdg-config"),
    XDG_DATA_HOME: path.join(runtimeRoot, "xdg-data"),
    XDG_CACHE_HOME: path.join(runtimeRoot, "xdg-cache"),
    XDG_STATE_HOME: path.join(runtimeRoot, "xdg-state"),
    AKM_CACHE_DIR: path.join(runtimeRoot, "cache"),
    AKM_STATE_DIR: path.join(runtimeRoot, "state"),
  };
  for (const directory of Object.values(isolatedDirs)) fs.mkdirSync(directory, { recursive: true });
  return {
    root: destinationRoot,
    defaultBundle: "personal",
    bundleRoots: { personal: bundle },
    configPath,
    dataDir,
    env: {
      ...isolatedDirs,
      AKM_STASH_DIR: bundle,
      AKM_DATA_DIR: dataDir,
      AKM_CONFIG_DIR: path.dirname(configPath),
    },
  };
}

function fakeArmExecution(input: TwinArmExecutionInput): TwinArmExecution {
  const score = input.arm === "control" ? 0.5 : 0.75;
  const suiteDir = path.join(input.casesRoot, input.suite);
  const caseResults = input.caseIds.map<EvalCaseResult>((caseId) => {
    const evalCase = JSON.parse(fs.readFileSync(path.join(suiteDir, `${caseId}.json`), "utf8")) as {
      type: EvalCaseResult["type"];
      scoring?: { deterministic?: boolean };
    };
    return {
      caseId,
      type: evalCase.type,
      score,
      passed: score >= 0.7,
      metrics: {},
      evidence: {},
      durationMs: 1,
      deterministic: evalCase.scoring?.deterministic !== false,
    };
  });
  const evalResult: EvalRunResult = {
    schemaVersion: 2,
    evalRunId: input.arm,
    suite: input.suite,
    mode: "baseline",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.001Z",
    durationMs: 1,
    akm: {
      version: "fixture",
      stashRoot: input.installation.bundleRoots[input.installation.defaultBundle],
      dataDir: input.installation.dataDir,
    },
    inputs: { caseCount: caseResults.length, caseDir: "fixture", suiteFingerprint: input.suiteFingerprint },
    scores: { overall: score, deterministic: score },
    countsByType: emptyCounts(),
    metrics: {},
    errors: [],
    artifacts: {},
  };
  return {
    evalResult,
    caseResults,
    ...(input.arm === "treatment"
      ? { improveResult: { schemaVersion: 2, ok: true, dryRun: false, plannedRefs: [] } }
      : {}),
    resources: { llmWorkExpected: false, improve: input.arm === "treatment" ? emptyResources() : null },
    errors: [],
  };
}

function emptyCounts(): EvalRunResult["countsByType"] {
  return {
    retrieval: { run: 0, passed: 0, skipped: 0 },
    "lesson-application": { run: 0, passed: 0, skipped: 0 },
    "proposal-quality": { run: 0, passed: 0, skipped: 0 },
    "reflect-quality": { run: 0, passed: 0, skipped: 0 },
    "planner-waste": { run: 0, passed: 0, skipped: 0 },
    "memory-safety": { run: 0, passed: 0, skipped: 0 },
    "workflow-compliance": { run: 0, passed: 0, skipped: 0 },
    "judge-calibration": { run: 0, passed: 0, skipped: 0 },
    regression: { run: 0, passed: 0, skipped: 0 },
  };
}

function emptyResources(): TwinResourceMetrics {
  return {
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    wallDurationMs: 0,
    modelCallDurationMs: 0,
    tokensPerSecond: null,
    telemetryComplete: false,
    observedModelIds: [],
  };
}

function completeResources(overrides: Partial<TwinResourceMetrics> = {}): TwinResourceMetrics {
  return {
    ...emptyResources(),
    modelCalls: 1,
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
    wallDurationMs: 10,
    modelCallDurationMs: 20,
    tokensPerSecond: 100,
    telemetryComplete: true,
    observedModelIds: ["fixture-model"],
    ...overrides,
  };
}

function completeUsage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome: "success",
    modelSource: "response",
    model: "fixture-model",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    durationMs: 100,
    ...overrides,
  };
}

function readTelemetryRows(rows: Array<{ eventType: string; metadataJson: string }>): TwinResourceMetrics {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-twin-telemetry-"));
  const stateDbPath = path.join(root, "state.db");
  const db = new Database(stateDbPath);
  try {
    db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, metadata_json TEXT)");
    const insert = db.prepare("INSERT INTO events (event_type, metadata_json) VALUES (?, ?)");
    for (const row of rows) insert.run(row.eventType, row.metadataJson);
  } finally {
    db.close();
  }
  try {
    return readImproveResourceMetrics(stateDbPath, 0, rows.length, 250);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function telemetryRow(eventType: string, metadata: unknown): { eventType: string; metadataJson: string } {
  return { eventType, metadataJson: JSON.stringify(metadata) };
}

describe("readImproveResourceMetrics terminal accounting", () => {
  test("accepts complete response-observed rows with an exact summary", () => {
    const metrics = readTelemetryRows([
      telemetryRow("llm_usage", completeUsage()),
      telemetryRow("llm_usage_summary", { expectedTerminalRecords: 1 }),
    ]);

    expect(metrics).toMatchObject({
      modelCalls: 1,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      modelCallDurationMs: 100,
      telemetryComplete: true,
      observedModelIds: ["fixture-model"],
    });
  });

  test("preserves visible totals when the summary is missing or mismatched", () => {
    const missing = readTelemetryRows([telemetryRow("llm_usage", completeUsage())]);
    const mismatched = readTelemetryRows([
      telemetryRow("llm_usage", completeUsage()),
      telemetryRow("llm_usage_summary", { expectedTerminalRecords: 2 }),
    ]);

    for (const metrics of [missing, mismatched]) {
      expect(metrics.telemetryComplete).toBe(false);
      expect(metrics.modelCalls).toBe(1);
      expect(metrics.totalTokens).toBe(15);
    }
  });

  test("rejects duplicate summaries without discarding terminal rows", () => {
    const metrics = readTelemetryRows([
      telemetryRow("llm_usage", completeUsage()),
      telemetryRow("llm_usage_summary", { expectedTerminalRecords: 1 }),
      telemetryRow("llm_usage_summary", { expectedTerminalRecords: 1 }),
    ]);

    expect(metrics.telemetryComplete).toBe(false);
    expect(metrics.modelCalls).toBe(1);
    expect(metrics.totalTokens).toBe(15);
  });

  test("marks error outcomes incomplete while preserving their call and numeric totals", () => {
    const metrics = readTelemetryRows([
      telemetryRow("llm_usage", completeUsage({ outcome: "error", errorCode: "provider_error" })),
      telemetryRow("llm_usage_summary", { expectedTerminalRecords: 1 }),
    ]);

    expect(metrics.telemetryComplete).toBe(false);
    expect(metrics.modelCalls).toBe(1);
    expect(metrics.totalTokens).toBe(15);
  });

  test("does not treat configured fallback models as observed", () => {
    const metrics = readTelemetryRows([
      telemetryRow("llm_usage", completeUsage({ modelSource: "configured", model: "configured-model" })),
      telemetryRow("llm_usage_summary", { expectedTerminalRecords: 1 }),
    ]);

    expect(metrics.telemetryComplete).toBe(false);
    expect(metrics.modelCalls).toBe(1);
    expect(metrics.totalTokens).toBe(15);
    expect(metrics.observedModelIds).toEqual([]);
  });

  test("returns partial totals instead of throwing for malformed terminal JSON and fields", () => {
    const metrics = readTelemetryRows([
      { eventType: "llm_usage", metadataJson: "{" },
      telemetryRow("llm_usage", completeUsage({ promptTokens: "unknown" })),
      telemetryRow("llm_usage_summary", { expectedTerminalRecords: 2 }),
    ]);

    expect(metrics.telemetryComplete).toBe(false);
    expect(metrics.modelCalls).toBe(2);
    expect(metrics.promptTokens).toBe(0);
    expect(metrics.completionTokens).toBe(5);
    expect(metrics.totalTokens).toBe(15);
  });

  test("allows an exact zero-attempt summary to be complete", () => {
    const metrics = readTelemetryRows([telemetryRow("llm_usage_summary", { expectedTerminalRecords: 0 })]);
    expect(metrics.telemetryComplete).toBe(true);
    expect(metrics.modelCalls).toBe(0);
    expect(metrics.observedModelIds).toEqual([]);
  });
});

function listTree(root: string): string[] {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      paths.push(absolute);
      if (entry.isDirectory()) visit(absolute);
    }
  };
  visit(root);
  return paths;
}

describe("akm-eval twin runner", () => {
  test("validates commands, endpoint metadata, balancing, identities, and protected regressions", () => {
    expect(tokenizeCommandVector('bun "./src/cli file.ts" --flag\\ value')).toEqual([
      "bun",
      "./src/cli file.ts",
      "--flag value",
    ]);
    expect(() => validateEndpointFingerprint({ ...endpoint("one"), endpointUrl: "https://private.invalid" })).toThrow(
      /unknown endpoint metadata keys/,
    );
    expect(() => validateEndpointFingerprint({ ...endpoint("one"), modelId: "contradictory-model" })).toThrow(
      /canonical endpoint metadata/,
    );
    expect(
      endpointServingFingerprintsAreCompatible(
        [endpoint("one"), { ...endpoint("two"), modelId: "contradictory-model" }],
        [[{ arm: "treatment", endpointId: "one" }], [{ arm: "treatment", endpointId: "two" }]],
      ),
    ).toBe(false);
    const assignments = buildBalancedEndpointAssignments([endpoint("one"), endpoint("two")], 4);
    expect(assignments.map((sample) => sample[0]?.endpointId)).toEqual(["one", "one", "two", "two"]);
    for (const endpointId of ["one", "two"]) {
      const orders = assignments
        .map((sample, sampleIndex) => ({ endpointId: sample[0]?.endpointId, first: armExecutionOrder(sampleIndex)[0] }))
        .filter((entry) => entry.endpointId === endpointId)
        .map((entry) => entry.first);
      expect(orders).toEqual(["control", "treatment"]);
    }
    expect(() => buildBalancedEndpointAssignments([endpoint("one"), endpoint("two")], 2)).toThrow(/multiple of 4/);

    const control: EvalCaseResult = {
      caseId: "protected",
      type: "retrieval",
      score: 0.71,
      passed: true,
      metrics: {},
      evidence: {},
      durationMs: 1,
    };
    const comparison = compareTwinCaseResults(
      [control],
      [{ ...control, score: 0.69, passed: false }],
      new Set(["protected"]),
      0.1,
    );
    expect(comparison.regressions).toHaveLength(1);
    expect(comparison.regressions[0]?.protected).toBe(true);
    expect(
      decideTwinExperimentStatus({
        criteria: undefined,
        controlExecutedCaseCount: 1,
        treatmentExecutedCaseCount: 1,
        controlDeterministicScore: 0.4,
        treatmentDeterministicScore: 0.6,
        treatmentResources: { llmWorkExpected: false, improve: emptyResources() },
        controlIdentity: armIdentity(),
        treatmentIdentity: armIdentity(),
        regressions: [],
        snapshotFingerprintsMatch: true,
        suiteFingerprintsMatch: true,
        endpointServingFingerprintsCompatible: true,
        armErrors: [],
        incompleteReasons: [],
      }).status,
    ).toBe("inconclusive");
    expect(
      decideTwinExperimentStatus({
        criteria,
        controlExecutedCaseCount: 1,
        treatmentExecutedCaseCount: 1,
        controlDeterministicScore: 0.4,
        treatmentDeterministicScore: 0.6,
        treatmentResources: { llmWorkExpected: true, improve: null },
        controlIdentity: armIdentity(),
        treatmentIdentity: armIdentity(),
        regressions: [],
        snapshotFingerprintsMatch: true,
        suiteFingerprintsMatch: true,
        endpointServingFingerprintsCompatible: true,
        armErrors: [],
        incompleteReasons: [],
      }).status,
    ).toBe("inconclusive");
    const incompleteTelemetry = decideTwinExperimentStatus({
      criteria,
      controlExecutedCaseCount: 1,
      treatmentExecutedCaseCount: 1,
      controlDeterministicScore: 0.4,
      treatmentDeterministicScore: 0.6,
      treatmentResources: { llmWorkExpected: true, improve: { ...emptyResources(), modelCalls: 1 } },
      controlIdentity: armIdentity(),
      treatmentIdentity: { ...armIdentity(), promptFingerprint: null, modelFingerprint: null },
      regressions: [],
      snapshotFingerprintsMatch: true,
      suiteFingerprintsMatch: true,
      endpointServingFingerprintsCompatible: true,
      armErrors: [],
      incompleteReasons: [],
    });
    expect(incompleteTelemetry.reasons).toContain("treatment LLM identity is incomplete");
    expect(incompleteTelemetry.reasons).toContain("treatment LLM telemetry is incomplete");
    expect(
      decideTwinExperimentStatus({
        criteria,
        controlExecutedCaseCount: 1,
        treatmentExecutedCaseCount: 1,
        controlDeterministicScore: 0.4,
        treatmentDeterministicScore: 0.6,
        treatmentResources: { llmWorkExpected: false, improve: emptyResources() },
        controlIdentity: armIdentity(),
        treatmentIdentity: {
          ...armIdentity(),
          runtimeProducer: { version: "different", commit: null },
        },
        regressions: [],
        snapshotFingerprintsMatch: true,
        suiteFingerprintsMatch: true,
        endpointServingFingerprintsCompatible: true,
        armErrors: [],
        incompleteReasons: [],
      }).reasons,
    ).toContain("control and treatment identities differ");

    const wallBudget = decideTwinExperimentStatus({
      criteria: { ...criteria, maxTreatmentDurationMs: 10 },
      controlExecutedCaseCount: 1,
      treatmentExecutedCaseCount: 1,
      controlDeterministicScore: 0.4,
      treatmentDeterministicScore: 0.7,
      treatmentResources: {
        llmWorkExpected: true,
        improve: completeResources({ wallDurationMs: 20, modelCallDurationMs: 1 }),
      },
      controlIdentity: armIdentity(),
      treatmentIdentity: armIdentity(),
      regressions: [],
      snapshotFingerprintsMatch: true,
      suiteFingerprintsMatch: true,
      endpointServingFingerprintsCompatible: true,
      armErrors: [],
      incompleteReasons: [],
    });
    expect(wallBudget.status).toBe("fail");
    expect(wallBudget.reasons[0]).toContain("improve wall duration");
    expect(
      decideTwinExperimentStatus({
        criteria: { ...criteria, maxTreatmentDurationMs: 10 },
        controlExecutedCaseCount: 1,
        treatmentExecutedCaseCount: 1,
        controlDeterministicScore: 0.4,
        treatmentDeterministicScore: 0.7,
        treatmentResources: {
          llmWorkExpected: true,
          improve: completeResources({ wallDurationMs: 1, modelCallDurationMs: 10_000 }),
        },
        controlIdentity: armIdentity(),
        treatmentIdentity: armIdentity(),
        regressions: [],
        snapshotFingerprintsMatch: true,
        suiteFingerprintsMatch: true,
        endpointServingFingerprintsCompatible: true,
        armErrors: [],
        incompleteReasons: [],
      }).status,
    ).toBe("pass");
  });

  test("resolves and persists protected cases before arm execution", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-twin-protection-"));
    const snapshot = path.join(root, "snapshot");
    fs.mkdirSync(snapshot);
    let materializations = 0;
    let executions = 0;
    const dependencies = {
      verifySnapshot: snapshotManifest,
      materializeSnapshot: (_source: string, destination: string) => {
        materializations += 1;
        return materializeFixture(destination);
      },
      executeArm: (input: TwinArmExecutionInput) => {
        executions += 1;
        return fakeArmExecution(input);
      },
    };
    const options = {
      snapshotDir: snapshot,
      suite: "improve-smoke",
      akmCommand: ["unused"],
      samples: 1,
      policy: "current" as const,
      improveArgs: [],
      keepSandboxes: false,
      includePrivateArtifacts: false,
      criteria: { ...criteria, requiredSampleCount: 1 },
    };
    try {
      const unprotected = await runTwinExperiment(
        { ...options, outDir: path.join(root, "unprotected") },
        { ...dependencies, experimentId: () => "unprotected" },
      );
      expect(unprotected.status).toBe("inconclusive");
      expect(unprotected.policy.protectedCaseIds).toEqual([]);
      expect(unprotected.samples[0]?.reasons).toContain("no protected cases were predeclared or tagged by the suite");
      expect(materializations).toBe(0);
      expect(executions).toBe(0);

      const unknown = await runTwinExperiment(
        { ...options, outDir: path.join(root, "unknown"), protectedCaseIds: ["missing-case"] },
        { ...dependencies, experimentId: () => "unknown" },
      );
      expect(unknown.status).toBe("inconclusive");
      expect(unknown.policy.protectedCaseIds).toEqual(["missing-case"]);
      expect(unknown.samples[0]?.reasons).toContain("explicit protected cases are absent from the suite: missing-case");
      expect(materializations).toBe(0);
      expect(executions).toBe(0);

      const tagged = await runTwinExperiment(
        { ...options, suite: "memory-regression", outDir: path.join(root, "tagged") },
        {
          ...dependencies,
          experimentId: () => "tagged",
          verifySnapshot: () => {
            throw new Error("fixture stops after policy resolution");
          },
        },
      );
      expect(tagged.policy.protectedCaseIds).toContain("hot-memory-preservation");
      expect(tagged.samples[0]?.reasons).not.toContain("no protected cases were predeclared or tagged by the suite");
      expect(materializations).toBe(0);
      expect(executions).toBe(0);

      const commonRuntimeFile = path.join(root, "common-runtime.json");
      fs.writeFileSync(commonRuntimeFile, JSON.stringify({ env: { SHARED_EMBED_KEY: "cli-common-secret" } }), {
        mode: 0o600,
      });
      fs.chmodSync(commonRuntimeFile, 0o600);
      const cli = spawnSync(
        path.join(process.cwd(), "scripts", "akm-eval", "bin", "akm-eval-twin"),
        [
          "--snapshot",
          path.join(root, "missing-snapshot"),
          "--suite",
          "improve-smoke",
          "--akm",
          "unused",
          "--out",
          path.join(root, "cli"),
          "--samples",
          "1",
          "--protected-case",
          protectedCaseId,
          "--protected-case",
          "retrieval-release-keywords",
          "--common-runtime",
          commonRuntimeFile,
          "--minimum-deterministic-lift",
          "0.2",
          "--protected-loss-margin",
          "0.1",
          "--max-treatment-tokens",
          "100",
          "--max-treatment-calls",
          "10",
          "--max-treatment-duration-ms",
          "1000",
          "--required-samples",
          "1",
        ],
        { encoding: "utf8", env: process.env },
      );
      expect(cli.status).toBe(2);
      const cliResult = JSON.parse(cli.stdout) as { policy: { protectedCaseIds: string[] } };
      expect(cliResult.policy.protectedCaseIds).toEqual(["retrieval-release-keywords", protectedCaseId]);
      expect(cli.stdout).not.toContain("cli-common-secret");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads owner-private external cases without persisting their host path", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-twin-external-cases-"));
    const snapshot = path.join(root, "snapshot");
    const casesRoot = path.join(root, "private-cases");
    const suiteDir = path.join(casesRoot, "private-suite");
    fs.mkdirSync(snapshot, { mode: 0o700 });
    fs.mkdirSync(suiteDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(suiteDir, "guard.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "guard",
        suite: "private-suite",
        type: "retrieval",
        input: { query: "private fixture", topK: 1 },
        expected: { minHits: 0 },
        scoring: { deterministic: true },
        tags: ["protected"],
      })}\n`,
      { mode: 0o600 },
    );
    fs.chmodSync(casesRoot, 0o700);
    fs.chmodSync(suiteDir, 0o700);
    try {
      const result = await runTwinExperiment(
        {
          snapshotDir: snapshot,
          suite: "private-suite",
          casesDir: casesRoot,
          akmCommand: ["unused"],
          outDir: path.join(root, "out"),
          samples: 1,
          policy: "current",
          improveArgs: [],
          keepSandboxes: false,
          includePrivateArtifacts: false,
          criteria: { ...criteria, requiredSampleCount: 1 },
        },
        {
          experimentId: () => "external",
          verifySnapshot: snapshotManifest,
          materializeSnapshot: (_source, destination) => materializeFixture(destination),
          executeArm: fakeArmExecution,
        },
      );

      expect(result.status).toBe("pass");
      expect(result.policy.casesSource).toBe("external");
      const serialized = fs.readFileSync(path.join(root, "out", "external", "twin-experiment-result.json"), "utf8");
      expect(serialized).not.toContain(casesRoot);

      fs.chmodSync(path.join(suiteDir, "guard.json"), 0o644);
      let executions = 0;
      const rejected = await runTwinExperiment(
        {
          snapshotDir: snapshot,
          suite: "private-suite",
          casesDir: casesRoot,
          akmCommand: ["unused"],
          outDir: path.join(root, "rejected-out"),
          samples: 1,
          policy: "current",
          improveArgs: [],
          keepSandboxes: false,
          includePrivateArtifacts: false,
          criteria: { ...criteria, requiredSampleCount: 1 },
        },
        {
          experimentId: () => "rejected",
          verifySnapshot: snapshotManifest,
          materializeSnapshot: (_source, destination) => materializeFixture(destination),
          executeArm: (input) => {
            executions += 1;
            return fakeArmExecution(input);
          },
        },
      );
      expect(rejected.status).toBe("inconclusive");
      expect(rejected.reasons.some((reason) => reason.includes("inconclusive samples"))).toBe(true);
      expect(executions).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("declares protected snapshot hashes and fails when treatment bytes drift", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-twin-protected-assets-"));
    const snapshot = path.join(root, "snapshot");
    fs.mkdirSync(snapshot);
    const protectedPath = "bundles/personal/asset.md";
    const assetHash = crypto.createHash("sha256").update("fixture\n").digest("hex") as Sha256;
    const manifest = {
      ...snapshotManifest(),
      entries: [
        {
          kind: "bundle" as const,
          path: protectedPath as InstallationSnapshotManifest["configPath"],
          byteSize: 8,
          sha256: assetHash,
          mtimeMs: 1,
        },
      ],
    };
    try {
      const result = await runTwinExperiment(
        {
          snapshotDir: snapshot,
          suite: "improve-smoke",
          akmCommand: ["unused"],
          outDir: path.join(root, "out"),
          protectedCaseIds: [protectedCaseId],
          protectedAssetPaths: [protectedPath],
          samples: 1,
          policy: "current",
          improveArgs: [],
          keepSandboxes: false,
          includePrivateArtifacts: false,
          criteria: { ...criteria, requiredSampleCount: 1 },
        },
        {
          experimentId: () => "protected",
          verifySnapshot: () => manifest,
          materializeSnapshot: (_source, destination) => materializeFixture(destination),
          executeArm: (input) => {
            const execution = fakeArmExecution(input);
            if (input.arm === "treatment") {
              fs.writeFileSync(path.join(input.installation.bundleRoots.personal ?? "", "asset.md"), "drifted\n");
            }
            return execution;
          },
        },
      );

      expect(result.status).toBe("fail");
      expect(result.policy.protectedAssets).toEqual([
        { path: protectedPath as InstallationSnapshotManifest["configPath"], sha256: assetHash },
      ]);
      expect(result.samples[0]?.arms.control.protectedAssets[0]?.status).toBe("preserved");
      expect(result.samples[0]?.arms.treatment.protectedAssets[0]?.status).toBe("modified");
      expect(result.samples[0]?.reasons[0]).toContain("protected asset bytes drifted");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses candidate-only before materialization and refuses unapplied endpoint labels", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-twin-refusal-"));
    const snapshot = path.join(root, "snapshot");
    fs.mkdirSync(snapshot);
    let materializations = 0;
    let executions = 0;
    try {
      await expect(
        runTwinExperiment({
          snapshotDir: snapshot,
          suite: "improve-smoke",
          akmCommand: ["unused"],
          outDir: path.join(snapshot, "nested-output"),
          protectedCaseIds: [protectedCaseId],
          samples: 2,
          policy: "current",
          improveArgs: [],
          keepSandboxes: false,
          includePrivateArtifacts: false,
          criteria: { ...criteria, requiredSampleCount: 1 },
        }),
      ).rejects.toThrow(/must not overlap/);
      expect(fs.existsSync(path.join(snapshot, "nested-output"))).toBe(false);

      await expect(
        runTwinExperiment(
          {
            snapshotDir: snapshot,
            suite: "improve-smoke",
            akmCommand: ["unused"],
            outDir: path.join(root, "insufficient-out"),
            protectedCaseIds: [protectedCaseId],
            samples: 1,
            policy: "current",
            improveArgs: [],
            keepSandboxes: false,
            includePrivateArtifacts: false,
            criteria,
          },
          {
            verifySnapshot: snapshotManifest,
            materializeSnapshot: (_source, destination) => {
              materializations += 1;
              return materializeFixture(destination);
            },
          },
        ),
      ).rejects.toThrow(/at least --required-samples/);
      expect(materializations).toBe(0);
      expect(fs.existsSync(path.join(root, "insufficient-out"))).toBe(false);

      await expect(
        runTwinExperiment({
          snapshotDir: snapshot,
          suite: "improve-smoke",
          akmCommand: ["unused"],
          outDir: path.join(root, "invalid-common-runtime"),
          protectedCaseIds: [protectedCaseId],
          samples: 1,
          policy: "current",
          improveArgs: [],
          keepSandboxes: false,
          includePrivateArtifacts: false,
          criteria: { ...criteria, requiredSampleCount: 1 },
          commonRuntime: { env: { HOME: "/not-isolated" } },
        }),
      ).rejects.toThrow(/cannot replace isolation variable: HOME/);

      const candidate = await runTwinExperiment(
        {
          snapshotDir: snapshot,
          suite: "improve-smoke",
          akmCommand: ["unused"],
          outDir: path.join(root, "candidate-out"),
          protectedCaseIds: [protectedCaseId],
          samples: 1,
          policy: "candidate-only",
          improveArgs: [],
          keepSandboxes: false,
          includePrivateArtifacts: false,
          criteria: { ...criteria, requiredSampleCount: 1 },
        },
        {
          experimentId: () => "candidate",
          verifySnapshot: snapshotManifest,
          materializeSnapshot: (_source, destination) => {
            materializations += 1;
            return materializeFixture(destination);
          },
          executeArm: (input) => {
            executions += 1;
            return fakeArmExecution(input);
          },
        },
      );
      expect(candidate.status).toBe("inconclusive");
      expect(materializations).toBe(0);
      expect(executions).toBe(0);

      const routedEndpoint = endpoint("routed");
      const assigned = await runTwinExperiment(
        {
          snapshotDir: snapshot,
          suite: "improve-smoke",
          akmCommand: ["unused"],
          outDir: path.join(root, "assigned-out"),
          protectedCaseIds: [protectedCaseId],
          samples: 2,
          policy: "current",
          improveArgs: [],
          keepSandboxes: false,
          includePrivateArtifacts: false,
          criteria: { ...criteria, requiredSampleCount: 1 },
          endpoints: [routedEndpoint],
          endpointAssignments: [
            [{ arm: "treatment", endpointId: "routed" }],
            [{ arm: "treatment", endpointId: "routed" }],
          ],
        },
        {
          experimentId: () => "assigned",
          verifySnapshot: snapshotManifest,
          materializeSnapshot: (_source, destination) => materializeFixture(destination),
          executeArm: (input) => {
            executions += 1;
            return fakeArmExecution(input);
          },
        },
      );
      expect(assigned.status).toBe("inconclusive");
      expect(assigned.samples[0]?.arms.treatment.identity.modelFingerprint).toBeNull();
      expect(assigned.samples[0]?.reasons.some((reason) => reason.includes("assignment was not applied"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("redacts runtime overlays from opted-in artifacts and keeps them private", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-twin-private-"));
    const snapshot = path.join(root, "snapshot");
    const outDir = path.join(root, "out");
    fs.mkdirSync(snapshot);
    const routed = endpoint("private");
    try {
      const result = await runTwinExperiment(
        {
          snapshotDir: snapshot,
          suite: "improve-smoke",
          akmCommand: ["unused"],
          outDir,
          protectedCaseIds: [protectedCaseId],
          samples: 2,
          policy: "current",
          improveArgs: [],
          keepSandboxes: false,
          includePrivateArtifacts: true,
          criteria: { ...criteria, requiredSampleCount: 1 },
          commonRuntime: { env: { COMMON_PRIVATE_TOKEN: "common-never-serialize-me" } },
          endpoints: [routed],
          endpointAssignments: [
            [{ arm: "treatment", endpointId: "private" }],
            [{ arm: "treatment", endpointId: "private" }],
          ],
          endpointRuntimeOverlays: { private: { env: { PRIVATE_ENDPOINT_TOKEN: "never-serialize-me" } } },
        },
        {
          experimentId: () => "private",
          verifySnapshot: snapshotManifest,
          materializeSnapshot: (_source, destination) => materializeFixture(destination),
          executeArm: (input) => {
            const execution = fakeArmExecution(input);
            if (execution.caseResults?.[0]) {
              execution.caseResults[0].evidence = { common: input.commonRuntimeEnv.COMMON_PRIVATE_TOKEN };
            }
            if (input.arm === "treatment") {
              execution.improveResult = {
                schemaVersion: 2,
                ok: true,
                dryRun: false,
                plannedRefs: [],
                privateValue: input.endpointRuntimeEnv.PRIVATE_ENDPOINT_TOKEN,
              };
              execution.resources = {
                llmWorkExpected: true,
                improve: {
                  modelCalls: 1,
                  promptTokens: 1,
                  completionTokens: 1,
                  totalTokens: 2,
                  wallDurationMs: 10,
                  modelCallDurationMs: 10,
                  tokensPerSecond: 200,
                  telemetryComplete: true,
                  observedModelIds: [routed.modelId],
                },
              };
              if (execution.caseResults?.[0]) {
                execution.caseResults[0].evidence = { query: input.endpointRuntimeEnv.PRIVATE_ENDPOINT_TOKEN };
              }
            }
            return execution;
          },
        },
      );
      expect(result.status).toBe("pass");
      expect(result.samples[0]?.artifactPaths.treatment.privateArtifacts).not.toBeNull();
      expect(result.samples[0]?.arms.treatment.identity.modelFingerprint).toBe(routed.modelSha256);
      expect(result.samples[0]?.arms.treatment.identity.promptFingerprint).toBe(routed.promptFingerprint);

      const mismatched = await runTwinExperiment(
        {
          snapshotDir: snapshot,
          suite: "improve-smoke",
          akmCommand: ["unused"],
          outDir,
          protectedCaseIds: [protectedCaseId],
          samples: 2,
          policy: "current",
          improveArgs: [],
          keepSandboxes: false,
          includePrivateArtifacts: false,
          criteria: { ...criteria, requiredSampleCount: 1 },
          endpoints: [routed],
          endpointAssignments: buildBalancedEndpointAssignments([routed], 2),
          endpointRuntimeOverlays: { private: { env: { PRIVATE_ENDPOINT_TOKEN: "runtime-only" } } },
        },
        {
          experimentId: () => "mismatched",
          verifySnapshot: snapshotManifest,
          materializeSnapshot: (_source, destination) => materializeFixture(destination),
          executeArm: (input) => {
            const execution = fakeArmExecution(input);
            if (input.arm === "treatment") {
              execution.resources = {
                llmWorkExpected: true,
                improve: completeResources({ observedModelIds: ["different-model"] }),
              };
            }
            return execution;
          },
        },
      );
      expect(mismatched.status).toBe("inconclusive");
      expect(mismatched.samples[0]?.arms.treatment.identity.modelFingerprint).toBeNull();
      expect(mismatched.samples[0]?.arms.treatment.identity.promptFingerprint).toBeNull();
      expect(mismatched.samples[0]?.reasons).toContain(
        "treatment observed models do not match the assigned endpoint model",
      );
      const experimentRoot = path.join(outDir, "private");
      for (const entry of [experimentRoot, ...listTree(experimentRoot)]) {
        const stat = fs.statSync(entry);
        expect(stat.mode & 0o777).toBe(stat.isDirectory() ? 0o700 : 0o600);
        if (stat.isFile()) expect(fs.readFileSync(entry, "utf8")).not.toContain("never-serialize-me");
        if (stat.isFile()) expect(fs.readFileSync(entry, "utf8")).not.toContain("common-never-serialize-me");
      }
      expect(
        fs.readFileSync(path.join(experimentRoot, "sample-001", "private", "treatment", "improve-result.json"), "utf8"),
      ).toContain("[REDACTED]");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects score-envelope drift and reports only artifacts that were written", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-twin-validation-"));
    const snapshot = path.join(root, "snapshot");
    fs.mkdirSync(snapshot);
    try {
      const drifted = await runTwinExperiment(
        {
          snapshotDir: snapshot,
          suite: "improve-smoke",
          akmCommand: ["unused"],
          outDir: path.join(root, "drifted-out"),
          protectedCaseIds: [protectedCaseId],
          samples: 1,
          policy: "current",
          improveArgs: [],
          keepSandboxes: false,
          includePrivateArtifacts: false,
          criteria: { ...criteria, requiredSampleCount: 1 },
        },
        {
          experimentId: () => "drifted",
          verifySnapshot: snapshotManifest,
          materializeSnapshot: (_source, destination) => materializeFixture(destination),
          executeArm: (input) => {
            const execution = fakeArmExecution(input);
            if (input.arm === "treatment" && execution.evalResult) {
              execution.evalResult.scores.deterministic = 0.99;
            }
            return execution;
          },
        },
      );
      expect(drifted.status).toBe("inconclusive");
      expect(drifted.samples[0]?.reasons).toContain(
        "treatment deterministic score does not match case-result aggregation",
      );

      const identityDrift = await runTwinExperiment(
        {
          snapshotDir: snapshot,
          suite: "improve-smoke",
          akmCommand: ["unused"],
          outDir: path.join(root, "identity-out"),
          protectedCaseIds: [protectedCaseId],
          samples: 2,
          policy: "current",
          improveArgs: [],
          keepSandboxes: false,
          includePrivateArtifacts: false,
          criteria,
        },
        {
          experimentId: () => "identity",
          verifySnapshot: snapshotManifest,
          materializeSnapshot: (_source, destination) => materializeFixture(destination),
          executeArm: (input) => {
            const execution = fakeArmExecution(input);
            if (execution.evalResult) execution.evalResult.akm.version = input.sampleId;
            return execution;
          },
        },
      );
      expect(identityDrift.status).toBe("inconclusive");
      expect(identityDrift.reasons).toContain("producer or config identity changed across samples");

      const partial = await runTwinExperiment(
        {
          snapshotDir: snapshot,
          suite: "improve-smoke",
          akmCommand: ["unused"],
          outDir: path.join(root, "partial-out"),
          protectedCaseIds: [protectedCaseId],
          samples: 1,
          policy: "current",
          improveArgs: [],
          keepSandboxes: false,
          includePrivateArtifacts: true,
          criteria: { ...criteria, requiredSampleCount: 1 },
        },
        {
          experimentId: () => "partial",
          verifySnapshot: snapshotManifest,
          materializeSnapshot: (_source, destination) => materializeFixture(destination),
          executeArm: (input) => {
            const execution = fakeArmExecution(input);
            if (input.arm === "treatment") execution.caseResults = undefined;
            return execution;
          },
        },
      );
      const artifacts = partial.samples[0]?.artifactPaths.treatment.privateArtifacts;
      expect(artifacts?.caseResults).toBeNull();
      expect(artifacts?.evalResult).not.toBeNull();
      expect(artifacts?.improveResult).not.toBeNull();
      for (const artifact of [artifacts?.evalResult, artifacts?.improveResult, artifacts?.finalManifest]) {
        expect(artifact).not.toBeNull();
        if (!artifact) throw new Error("expected a written private artifact path");
        expect(fs.existsSync(path.join(root, "partial-out", "partial", "sample-001", artifact))).toBe(true);
      }

      const missingFinalManifest = await runTwinExperiment(
        {
          snapshotDir: snapshot,
          suite: "improve-smoke",
          akmCommand: ["unused"],
          outDir: path.join(root, "missing-final-out"),
          protectedCaseIds: [protectedCaseId],
          samples: 1,
          policy: "current",
          improveArgs: [],
          keepSandboxes: false,
          includePrivateArtifacts: false,
          criteria: { ...criteria, requiredSampleCount: 1 },
        },
        {
          experimentId: () => "missing-final",
          verifySnapshot: snapshotManifest,
          materializeSnapshot: (_source, destination) => materializeFixture(destination),
          executeArm: (input) => {
            const execution = fakeArmExecution(input);
            if (input.arm === "treatment") fs.rmSync(input.installation.root, { recursive: true, force: true });
            return execution;
          },
        },
      );
      expect(missingFinalManifest.status).toBe("inconclusive");
      expect(
        missingFinalManifest.samples[0]?.reasons.some((reason) => reason.includes("final manifest unavailable")),
      ).toBe(true);
      const mutationSummary = missingFinalManifest.samples[0]?.arms.treatment.mutations;
      expect(mutationSummary?.initialManifestFingerprint).not.toBeNull();
      expect(mutationSummary?.finalManifestFingerprint).toBeNull();
      expect(mutationSummary?.addedFileCount).toBeNumber();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("times out subprocesses and removes transient installations", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-twin-timeout-"));
    const snapshot = path.join(root, "snapshot");
    const slowAkm = path.join(root, "slow-akm.ts");
    const materializedRoots: string[] = [];
    fs.mkdirSync(snapshot);
    fs.writeFileSync(slowAkm, "await Bun.sleep(500);\n");
    try {
      const result = await runTwinExperiment(
        {
          snapshotDir: snapshot,
          suite: "improve-smoke",
          akmCommand: [process.execPath, slowAkm],
          outDir: path.join(root, "out"),
          protectedCaseIds: [protectedCaseId],
          samples: 1,
          policy: "current",
          improveArgs: [],
          keepSandboxes: false,
          includePrivateArtifacts: false,
          criteria: { ...criteria, requiredSampleCount: 1 },
          commandTimeoutMs: 20,
        },
        {
          experimentId: () => "timeout",
          verifySnapshot: snapshotManifest,
          materializeSnapshot: (_source, destination) => {
            materializedRoots.push(destination);
            return materializeFixture(destination);
          },
        },
      );
      expect(result.status).toBe("inconclusive");
      expect(result.policy.commandTimeoutMs).toBe(20);
      expect(materializedRoots).toHaveLength(2);
      expect(materializedRoots.every((materializedRoot) => !fs.existsSync(materializedRoot))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("runs command vectors through real fake subprocesses and writes private metrics-only aggregates", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-twin-subprocess-"));
    const snapshot = path.join(root, "snapshot");
    const outDir = path.join(root, "out");
    const logFile = path.join(root, "akm.log");
    const fakeAkm = path.join(root, "fake-akm.ts");
    const fakeEval = path.join(root, "fake-eval.ts");
    fs.mkdirSync(snapshot);
    fs.writeFileSync(
      fakeAkm,
      `import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
const verb = process.argv[2] ?? "";
fs.appendFileSync(process.env.EVAL_ENV_LOG, JSON.stringify({
  stash: process.env.AKM_STASH_DIR,
  verb,
  cwd: process.cwd(),
  tmp: process.env.TMPDIR,
  endpointToken: process.env.FAKE_ENDPOINT_TOKEN ?? null,
  commonToken: process.env.COMMON_EMBED_TOKEN ?? null,
  armLabel: process.env.AKM_EVAL_TWIN_ARM ?? null,
  sampleLabel: process.env.AKM_EVAL_TWIN_SAMPLE_ID ?? null,
  hostSecret: process.env.TWIN_HOST_SECRET ?? null,
  llmKey: process.env.AKM_LLM_API_KEY ?? null,
  namedKey: process.env.AKM_ENGINE_FIXTURE_API_KEY ?? null,
}) + "\\n");
if (verb === "--version") { process.stdout.write("fixture-akm\\n"); process.exit(0); }
if (verb === "index") process.exit(0);
if (verb === "improve") {
  if (process.env.FAKE_ENDPOINT_TOKEN !== "private-token") process.exit(9);
  await Bun.sleep(25);
  fs.writeFileSync(path.join(process.env.AKM_STASH_DIR, "asset.md"), "treated\\n");
  const db = new Database(path.join(process.env.AKM_DATA_DIR, "state.db"));
  const telemetry = process.env.FAKE_TELEMETRY_FAILURE === "1"
    ? {outcome:"error",modelSource:"configured",model:"fixture-model",durationMs:100,errorCode:"provider_error"}
    : {outcome:"success",modelSource:"response",promptTokens:10,completionTokens:5,totalTokens:15,durationMs:100,model:"fixture-model"};
  db.prepare("INSERT INTO events (event_type, metadata_json) VALUES ('llm_usage', ?)").run(JSON.stringify(telemetry));
  db.prepare("INSERT INTO events (event_type, metadata_json) VALUES ('llm_usage_summary', ?)").run(JSON.stringify({expectedTerminalRecords:1}));
  db.close();
  if (process.env.FAKE_TELEMETRY_FAILURE === "1") process.stderr.write("akm: appendEvent failed: fixture\\n");
  process.stdout.write(JSON.stringify({schemaVersion:2,ok:true,dryRun:false,plannedRefs:[{ref:"fixture"}]}));
  process.exit(0);
}
process.exit(2);
`,
    );
    const evalRunsImport = path.join(process.cwd(), "scripts", "akm-eval", "src", "sources", "eval-runs.ts");
    const casesRoot = path.join(process.cwd(), "scripts", "akm-eval", "cases");
    fs.writeFileSync(
      fakeEval,
      `import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fingerprintEvalCases } from ${JSON.stringify(evalRunsImport)};
const argv = process.argv.slice(2);
const get = (name) => argv[argv.indexOf(name) + 1];
const suite = get("--suite");
const out = get("--out");
const stash = get("--stash");
const akm = get("--akm");
const version = spawnSync(akm, ["--version"], {encoding:"utf8",env: process.env});
if (version.status !== 0) process.exit(8);
const suiteDir = path.join(${JSON.stringify(casesRoot)}, suite);
const cases = fs.readdirSync(suiteDir).filter((name) => name.endsWith(".json")).sort().map((name) => JSON.parse(fs.readFileSync(path.join(suiteDir, name), "utf8")));
const fingerprint = fingerprintEvalCases(cases, suiteDir);
const score = fs.readFileSync(path.join(stash, "asset.md"), "utf8") === "treated\\n" ? 0.75 : 0.5;
const results = cases.map((item) => ({caseId:item.id,type:item.type,score,passed:score >= 0.7,metrics:{},evidence:{},durationMs:1,deterministic:item.scoring?.deterministic !== false}));
const runDir = path.join(out, "runs", "fake");
fs.mkdirSync(runDir, {recursive:true});
const blank = {run:0,passed:0,skipped:0};
const envelope = {schemaVersion:2,evalRunId:"fake",suite,mode:"baseline",startedAt:"2026-01-01T00:00:00.000Z",completedAt:"2026-01-01T00:00:00.001Z",durationMs:1,akm:{version:version.stdout.trim(),stashRoot:stash,dataDir:process.env.AKM_DATA_DIR},inputs:{caseCount:cases.length,caseDir:suiteDir,suiteFingerprint:fingerprint},scores:{overall:score,deterministic:score},countsByType:{retrieval:blank,"lesson-application":blank,"proposal-quality":blank,"reflect-quality":blank,"planner-waste":blank,"memory-safety":blank,"workflow-compliance":blank,"judge-calibration":blank,regression:blank},metrics:{},errors:[],artifacts:{}};
fs.writeFileSync(path.join(runDir, "eval-result.json"), JSON.stringify(envelope));
fs.writeFileSync(path.join(runDir, "case-results.jsonl"), results.map((item) => JSON.stringify(item)).join("\\n") + "\\n");
`,
    );
    try {
      const routed = endpoint("local");
      const result = await withEnv(
        {
          EVAL_ENV_LOG: logFile,
          TWIN_HOST_SECRET: "must-not-reach-child",
          AKM_LLM_API_KEY: "ambient-must-not-reach-child",
          AKM_ENGINE_FIXTURE_API_KEY: "named-ambient-must-not-reach-child",
        },
        () =>
          runTwinExperiment(
            {
              snapshotDir: snapshot,
              suite: "improve-smoke",
              akmCommand: [process.execPath, fakeAkm],
              outDir,
              protectedCaseIds: [protectedCaseId],
              samples: 2,
              policy: "current",
              improveArgs: [],
              keepSandboxes: false,
              includePrivateArtifacts: false,
              criteria,
              commonRuntime: { env: { COMMON_EMBED_TOKEN: "shared-embedding-secret" } },
              endpoints: [routed],
              endpointAssignments: buildBalancedEndpointAssignments([routed], 2),
              endpointRuntimeOverlays: {
                local: { env: { FAKE_ENDPOINT_TOKEN: "private-token", AKM_LLM_API_KEY: "explicit-overlay-key" } },
              },
            },
            {
              experimentId: () => "experiment",
              verifySnapshot: snapshotManifest,
              materializeSnapshot: (_source, destination) => materializeFixture(destination),
              evalCommand: [process.execPath, fakeEval],
            },
          ),
      );

      expect(result.status).toBe("pass");
      expect(result.metrics.deterministicDeltas).toEqual([0.25, 0.25]);
      expect(result.metrics.meanDeterministicDelta).toBe(0.25);
      expect(result.metrics.treatmentResources).toMatchObject({
        modelCalls: 2,
        totalTokens: 30,
        modelCallDurationMs: 200,
        telemetryComplete: true,
        observedModelIds: ["fixture-model"],
      });
      expect(result.metrics.treatmentResources.wallDurationMs).toBeGreaterThanOrEqual(40);
      expect(result.metrics.treatmentResources.tokensPerSecond).toBeNull();
      expect(result.samples[0]?.arms.treatment.identity.modelFingerprint).toBe(digest);
      expect(result.samples[0]?.arms.treatment.identity.runtimeProducer).toEqual({
        version: "fixture-akm",
        commit: null,
      });
      expect(result.samples[0]?.arms.treatment.identity.snapshotProducer).toEqual({
        version: "fixture",
        commit: "snapshot-commit",
      });
      expect(result.policy.protectedCaseIds).toEqual([protectedCaseId]);
      expect(result.samples[0]?.arms.control.mutations.initialManifestFingerprint).not.toBeNull();
      expect(result.samples[0]?.arms.control.mutations.finalManifestFingerprint).not.toBeNull();
      expect(result.samples[0]?.arms.control.mutations.addedFileCount).toBeNumber();
      expect(result.samples.every((sample) => sample.artifactPaths.control.privateArtifacts === null)).toBe(true);

      const commandRecords = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, string | null>);
      for (const record of commandRecords) {
        expect(record.armLabel).toBeNull();
        expect(record.sampleLabel).toBeNull();
        expect(record.hostSecret).toBeNull();
        expect(record.namedKey).toBeNull();
        expect(record.llmKey === "explicit-overlay-key").toBe(record.verb === "improve");
        expect(record.commonToken).toBe("shared-embedding-secret");
        expect(record.endpointToken === null).toBe(record.verb !== "improve");
        if (!record.stash || !record.tmp) throw new Error("expected isolated child paths");
        const installationRoot = path.dirname(path.dirname(record.stash));
        expect(record.cwd).toBe(installationRoot);
        expect(path.basename(installationRoot)).not.toMatch(/control|treatment/);
        expect(path.basename(record.tmp)).not.toMatch(/control|treatment/);
      }
      const recordsByStash = new Map<string, Array<Record<string, string | null>>>();
      for (const record of commandRecords) {
        if (!record.stash) throw new Error("expected an isolated stash path");
        const records = recordsByStash.get(record.stash) ?? [];
        records.push(record);
        recordsByStash.set(record.stash, records);
      }
      expect(
        [...recordsByStash.values()].map((records) =>
          records.some((record) => record.verb === "improve") ? "treatment" : "control",
        ),
      ).toEqual(["control", "treatment", "treatment", "control"]);

      const experimentRoot = path.join(outDir, "experiment");
      const tree = listTree(experimentRoot);
      expect(tree.some((file) => /(?:eval-result|case-results|improve-result|\.db$)/.test(file))).toBe(false);
      expect(fs.readFileSync(path.join(experimentRoot, "twin-experiment-result.json"), "utf8")).not.toContain(
        "private-token",
      );
      expect(fs.readFileSync(path.join(experimentRoot, "twin-experiment-result.json"), "utf8")).not.toContain(
        "shared-embedding-secret",
      );
      for (const entry of [experimentRoot, ...tree]) {
        const stat = fs.statSync(entry);
        expect(stat.mode & 0o777).toBe(stat.isDirectory() ? 0o700 : 0o600);
      }

      const telemetryFailure = await withEnv({ EVAL_ENV_LOG: logFile }, () =>
        runTwinExperiment(
          {
            snapshotDir: snapshot,
            suite: "improve-smoke",
            akmCommand: [process.execPath, fakeAkm],
            outDir,
            protectedCaseIds: [protectedCaseId],
            samples: 2,
            policy: "current",
            improveArgs: [],
            keepSandboxes: false,
            includePrivateArtifacts: false,
            criteria,
            endpoints: [routed],
            endpointAssignments: buildBalancedEndpointAssignments([routed], 2),
            endpointRuntimeOverlays: {
              local: { env: { FAKE_ENDPOINT_TOKEN: "private-token", FAKE_TELEMETRY_FAILURE: "1" } },
            },
          },
          {
            experimentId: () => "telemetry-failure",
            verifySnapshot: snapshotManifest,
            materializeSnapshot: (_source, destination) => materializeFixture(destination),
            evalCommand: [process.execPath, fakeEval],
          },
        ),
      );
      expect(telemetryFailure.status).toBe("inconclusive");
      expect(telemetryFailure.samples[0]?.arms.treatment.resources.improve?.telemetryComplete).toBe(false);
      expect(telemetryFailure.samples[0]?.arms.treatment.identity.modelFingerprint).toBeNull();
      expect(telemetryFailure.samples[0]?.reasons).toContain("treatment expected improve LLM telemetry is incomplete");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
