// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import {
  assertSafeRelativePath,
  assertSha256,
  assertTwinDecisionCriteria,
  assertTwinExperimentStatus,
  type InstallationSnapshotManifest,
  isSafeRelativePath,
  isSha256,
  type TwinArmIdentity,
  type TwinDecisionCriteria,
  type TwinExperimentPolicy,
  type TwinExperimentStatus,
} from "../scripts/akm-eval/src/twin-types";

describe("akm-eval twin contracts", () => {
  test("accepts only safe canonical relative paths", () => {
    for (const value of ["bundles/personal/skills/review.md", "config/config.json", "data/state.db"]) {
      expect(isSafeRelativePath(value)).toBe(true);
      expect(() => assertSafeRelativePath(value)).not.toThrow();
    }

    for (const value of [
      "",
      "/data/state.db",
      "../data/state.db",
      "data/../state.db",
      "data/./state.db",
      "data//state.db",
      "data\\state.db",
      "C:/data/state.db",
    ]) {
      expect(isSafeRelativePath(value)).toBe(false);
      expect(() => assertSafeRelativePath(value)).toThrow(/safe.*relative path/);
    }
  });

  test("accepts only lowercase SHA-256 digests", () => {
    const valid = "a".repeat(64);
    expect(isSha256(valid)).toBe(true);
    expect(() => assertSha256(valid)).not.toThrow();

    for (const value of ["a".repeat(63), "A".repeat(64), "g".repeat(64), `${"a".repeat(64)} `]) {
      expect(isSha256(value)).toBe(false);
      expect(() => assertSha256(value)).toThrow(/SHA-256/);
    }
  });

  test("recognizes all statuses and requires a reason for inconclusive results", () => {
    const statuses: TwinExperimentStatus[] = [
      { status: "pass", reasons: ["quality threshold cleared"] },
      { status: "fail", reasons: ["protected regression"] },
      { status: "inconclusive", reasons: ["zero executed cases"] },
    ];

    for (const status of statuses) expect(() => assertTwinExperimentStatus(status)).not.toThrow();
    expect(statuses.map((status) => status.status === "inconclusive")).toEqual([false, false, true]);
    expect(() => assertTwinExperimentStatus({ status: "inconclusive", reasons: [] })).toThrow(/at least one/);
    expect(() => assertTwinExperimentStatus({ status: "unknown", reasons: ["invalid"] })).toThrow(
      /pass, fail, or inconclusive/,
    );
  });

  test("requires a complete predeclared decision policy", () => {
    const criteria: TwinDecisionCriteria = {
      minimumDeterministicLift: 0.05,
      protectedLossMargin: 0.01,
      maxTreatmentTokens: 10_000,
      maxTreatmentModelCalls: 20,
      maxTreatmentDurationMs: 60_000,
      requiredSampleCount: 2,
    };
    expect(() => assertTwinDecisionCriteria(criteria)).not.toThrow();
    expect(() => assertTwinDecisionCriteria({ ...criteria, minimumDeterministicLift: -1 })).toThrow(
      /minimumDeterministicLift/,
    );
    expect(() => assertTwinDecisionCriteria({ ...criteria, requiredSampleCount: 0 })).toThrow(/requiredSampleCount/);
    expect(() => assertTwinDecisionCriteria({ ...criteria, requiredSampleCount: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      /requiredSampleCount/,
    );
  });

  test("snapshot layout names every materialized root", () => {
    const digest = "a".repeat(64) as InstallationSnapshotManifest["snapshotFingerprint"];
    const manifest: InstallationSnapshotManifest = {
      schemaVersion: 2,
      snapshotFingerprint: digest,
      producer: { version: "0.9.0-rc.10", commit: null },
      configFingerprint: digest,
      defaultBundle: "personal",
      bundleRoots: { personal: "bundles/personal" as InstallationSnapshotManifest["configPath"] },
      configPath: "config/config.json" as InstallationSnapshotManifest["configPath"],
      dataDir: "data" as InstallationSnapshotManifest["dataDir"],
      entries: [],
    };

    expect(String(manifest.bundleRoots[manifest.defaultBundle])).toBe("bundles/personal");
    for (const relativePath of [manifest.configPath, manifest.dataDir, ...Object.values(manifest.bundleRoots)]) {
      expect(isSafeRelativePath(relativePath)).toBe(true);
    }
  });

  test("separates runtime and snapshot producers and persists protected policy", () => {
    const digest = "a".repeat(64) as InstallationSnapshotManifest["snapshotFingerprint"];
    const identity: TwinArmIdentity = {
      runtimeProducer: { version: "runtime-dirty", commit: null },
      snapshotProducer: { version: "snapshot", commit: "snapshot-commit" },
      configFingerprint: digest,
      promptFingerprint: null,
      modelFingerprint: null,
    };
    const policy: TwinExperimentPolicy = {
      schemaVersion: 2,
      control: "no-improve",
      treatment: "current",
      casesSource: "builtin",
      improveArgs: ["--no-sync"],
      commandTimeoutMs: 1_000,
      protectedCaseIds: ["guard"],
      protectedAssets: [],
      criteria: {
        minimumDeterministicLift: 0.1,
        protectedLossMargin: 0,
        maxTreatmentTokens: 10,
        maxTreatmentModelCalls: 1,
        maxTreatmentDurationMs: 100,
        requiredSampleCount: 1,
      },
    };
    expect(identity.runtimeProducer.commit).toBeNull();
    expect(identity.snapshotProducer.commit).toBe("snapshot-commit");
    expect(policy.protectedCaseIds).toEqual(["guard"]);
  });
});
