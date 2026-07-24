// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import {
  CONSOLIDATION_ORACLE_LIMITS,
  type ConsolidationFidelityFixture,
  type ConsolidationFidelityManifest,
  gradeFixtureCalibrationCandidate,
  gradeFixtureCalibrationManifest,
  gradeGeneratedConsolidationCandidate,
  loadConsolidationFidelityManifest,
  normalizeDirectProvenance,
  parseConsolidationFidelityManifest,
} from "../scripts/akm-eval/src/consolidation-fidelity";
import { checkMergeInformationFloor } from "../src/commands/improve/anti-collapse";
import { bundleRefToString, parseBundleRef } from "../src/core/asset/asset-ref";
import { legacyRefToBundleRef } from "../src/migrate/legacy-ref-grammar";

const manifest = loadConsolidationFidelityManifest();

function fixtureById(id: string): ConsolidationFidelityFixture {
  const fixture = manifest.cases.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`missing fixture: ${id}`);
  return fixture;
}

function firstRequiredClaim(target: ConsolidationFidelityManifest) {
  const fixture = target.cases[0];
  const claim = fixture?.requiredClaims[0];
  if (!claim) throw new Error("test manifest must have a required claim");
  return claim;
}

describe("deterministic fixture-authored consolidation candidate oracle", () => {
  test("declares its grading-only purpose and covers the requested fixture classes", () => {
    expect(manifest.purpose).toBe("deterministic-fixture-authored-oracle-for-grading-generated-candidates");
    const classCounts = new Map<string, number>();
    for (const fixture of manifest.cases) {
      classCounts.set(fixture.class, (classCounts.get(fixture.class) ?? 0) + 1);
    }

    expect(classCounts.get("operational-procedure-omitted")).toBeGreaterThanOrEqual(1);
    expect(classCounts.get("implementation-invariant-omitted")).toBeGreaterThanOrEqual(1);
    expect(classCounts.get("stale-contradiction-retained")).toBeGreaterThanOrEqual(1);
    expect(classCounts.get("defensible-compression")).toBeGreaterThanOrEqual(3);
    expect(classCounts.get("provenance-equivalence")).toBeGreaterThanOrEqual(1);
    expect(classCounts.get("cardinality-false-negative")).toBeGreaterThanOrEqual(1);
    expect(classCounts.get("negation-adversarial")).toBeGreaterThanOrEqual(1);
  });

  test("calibrates the oracle against authored labels without claiming a production run passed", () => {
    const results = gradeFixtureCalibrationManifest(manifest);
    const safe = results.filter((result) => result.fixtureCalibrationLabel === "safe");
    const lossy = results.filter((result) => result.fixtureCalibrationLabel === "lossy");

    expect(safe.length).toBeGreaterThanOrEqual(4);
    expect(lossy.length).toBeGreaterThanOrEqual(5);
    expect(safe.every((result) => result.oraclePassed)).toBe(true);
    expect(lossy.every((result) => !result.oraclePassed)).toBe(true);

    const stale = results.find((result) => result.fixtureId === "lossy-stale-contradiction-retained");
    expect(stale?.requiredClaims.passed).toBe(true);
    expect(stale?.forbiddenClaims.present).toEqual(["superseded-open-before-lease"]);
  });

  test("grades a runner-supplied generated candidate instead of the embedded calibration candidate", () => {
    const fixture = fixtureById("safe-procedure-deduplication");
    expect(gradeFixtureCalibrationCandidate(fixture).oraclePassed).toBe(true);

    const generated = gradeGeneratedConsolidationCandidate(fixture, {
      body: "Deployment should follow the usual safe process.",
      directProvenance: fixture.calibrationCandidate.directProvenance,
    });
    expect(generated.oraclePassed).toBe(false);
    expect(generated.requiredClaims.missing).toEqual(["zero-depth-before-replace", "green-before-resume"]);
  });

  test("requires the exact normalized direct participant set and fails invalid actual refs", () => {
    const fixture = fixtureById("safe-invariant-compression");
    const missing = gradeGeneratedConsolidationCandidate(fixture, {
      ...fixture.calibrationCandidate,
      directProvenance: fixture.calibrationCandidate.directProvenance.slice(0, 1),
    });
    expect(missing.oraclePassed).toBe(false);
    expect(missing.directProvenance.missing).toEqual(["memories/blob-rename-failure"]);

    const unexpected = gradeGeneratedConsolidationCandidate(fixture, {
      ...fixture.calibrationCandidate,
      directProvenance: [...fixture.calibrationCandidate.directProvenance, "memories/unrelated-participant"],
    });
    expect(unexpected.oraclePassed).toBe(false);
    expect(unexpected.directProvenance).toMatchObject({
      policy: "exact-normalized-direct-participant-set",
      unexpected: ["memories/unrelated-participant"],
      passed: false,
    });

    const invalid = gradeGeneratedConsolidationCandidate(fixture, {
      ...fixture.calibrationCandidate,
      directProvenance: [...fixture.calibrationCandidate.directProvenance, "//memory:empty-origin"],
    });
    expect(invalid.oraclePassed).toBe(false);
    expect(invalid.directProvenance.invalidActual).toEqual(["//memory:empty-origin"]);
    expect(invalid.directProvenance.passed).toBe(false);
  });

  test("matches the frozen migrator for supported legacy provenance spellings", () => {
    const legacyRefs = [
      "agent:alpha",
      "command:alpha",
      "env:alpha",
      "fact:alpha",
      "knowledge:alpha",
      "lesson:alpha",
      "memory:alpha",
      "script:alpha.ts",
      "secret:alpha.pem",
      "session:alpha",
      "skill:alpha",
      "task:alpha",
      "workflow:alpha",
      "wiki:alpha",
      "foreign:alpha",
      "lab//memory:beta",
      "environment:production",
      "local//environment:staging",
      "stash//memory:nested/item",
      "owner/repo//memory:portable",
      "memory:nested\\windows-name",
    ];

    for (const raw of legacyRefs) {
      const runtimeNormalized = bundleRefToString(legacyRefToBundleRef(raw));
      expect(normalizeDirectProvenance(raw)).toBe(runtimeNormalized);
    }
    expect(normalizeDirectProvenance("environment:production")).toBe("env/production");
    expect(normalizeDirectProvenance("local//environment:staging")).toBe("env/staging");
    expect(normalizeDirectProvenance("wiki:alpha")).toBe("alpha");
    expect(normalizeDirectProvenance("foreign:alpha")).toBe("alpha");
  });

  test("matches current ref normalization and rejects empty legacy or current origins", () => {
    for (const raw of ["memories/alpha", "lab//memories/beta", "env/production", "memories/nested\\item"]) {
      expect(normalizeDirectProvenance(raw)).toBe(bundleRefToString(parseBundleRef(raw)));
    }

    for (const raw of ["//memory:alpha", "//environment:production"]) {
      expect(() => legacyRefToBundleRef(raw)).toThrow(/Empty origin/);
      expect(normalizeDirectProvenance(raw)).toBeUndefined();
    }
    expect(() => parseBundleRef("//memories/alpha")).toThrow(/Empty bundle/);
    expect(normalizeDirectProvenance("//memories/alpha")).toBeUndefined();
  });

  test("bounds bodies and patterns and rejects catastrophic regex syntax", () => {
    const oversizedCandidate = {
      ...fixtureById("safe-invariant-compression").calibrationCandidate,
      body: "x".repeat(CONSOLIDATION_ORACLE_LIMITS.bodyChars + 1),
    };
    expect(() =>
      gradeGeneratedConsolidationCandidate(fixtureById("safe-invariant-compression"), oversizedCandidate),
    ).toThrow(/body must be at most/);

    const unsafeRegex = structuredClone(manifest);
    Object.assign(firstRequiredClaim(unsafeRegex), { match: "regex", pattern: "(a+)+$" });
    expect(() => parseConsolidationFidelityManifest(unsafeRegex)).toThrow(/unsafe regex syntax/);

    const oversizedPattern = structuredClone(manifest);
    firstRequiredClaim(oversizedPattern).pattern = "a".repeat(CONSOLIDATION_ORACLE_LIMITS.patternChars + 1);
    expect(() => parseConsolidationFidelityManifest(oversizedPattern)).toThrow(/at most 256 characters/);
  });

  test("does not retain a required claim that appears only in a negated statement", () => {
    const result = gradeFixtureCalibrationCandidate(fixtureById("lossy-negated-required-claim"));
    expect(result.requiredClaims).toMatchObject({ missing: ["verify-before-publish"], passed: false });
    expect(result.forbiddenClaims).toMatchObject({ present: ["negated-verification-rule"], passed: false });
    expect(result.oraclePassed).toBe(false);
  });

  test("rejects negated operational requirements even without authored forbidden claims", () => {
    const fixture = fixtureById("lossy-operational-procedure-omitted");
    const result = gradeGeneratedConsolidationCandidate(fixture, {
      body: "Do not pause publishers before rotating the signing credential. Do not restore the previous alias before resuming publishers.",
      directProvenance: fixture.sources.map((source) => source.ref),
    });

    expect(result.requiredClaims).toMatchObject({
      retained: [],
      missing: ["pause-before-rotation", "rollback-before-resume"],
      passed: false,
    });
    expect(result.oraclePassed).toBe(false);
  });

  test("does not treat an explicitly negated stale ordering as retained", () => {
    const fixture = fixtureById("lossy-stale-contradiction-retained");
    const result = gradeGeneratedConsolidationCandidate(fixture, {
      body: "Workers acquire the lease before opening the output file. Workers must not open the output file before acquiring the lease.",
      directProvenance: fixture.sources.map((source) => source.ref),
    });

    expect(result.requiredClaims.passed).toBe(true);
    expect(result.forbiddenClaims).toMatchObject({ present: [], passed: true });
    expect(result.oraclePassed).toBe(true);
  });

  test("treats equivalent legacy and current direct provenance as retained", () => {
    const result = gradeFixtureCalibrationCandidate(fixtureById("safe-legacy-current-provenance-equivalence"));
    expect(result.directProvenance).toMatchObject({
      retention: 1,
      missing: [],
      unexpected: [],
      invalidActual: [],
      passed: true,
    });
  });

  test("keeps the equal-cardinality blind-spot demonstration without treating it as a production run", () => {
    const fixture = fixtureById("lossy-equal-cardinality-unrelated-text");
    const result = gradeFixtureCalibrationCandidate(fixture);

    expect(result.tokenOverlap.candidateDistinctTokens).toHaveLength(result.tokenOverlap.sourceDistinctTokens.length);
    expect(result.tokenOverlap.cardinalityRetention).toBe(1);
    expect(result.tokenOverlap.countOnlyCardinalityFloorPassed).toBe(true);
    expect(result.tokenOverlap.sharedTokens).toEqual([]);
    expect(result.tokenOverlap.sourceRetention).toBe(0);
    expect(result.requiredClaims.retention).toBe(0);
    expect(result.oraclePassed).toBe(false);

    const countOnlyGuard = checkMergeInformationFloor(
      fixture.calibrationCandidate.body,
      fixture.calibrationCandidate.directProvenance,
      fixture.sources.map((source) => ({ ...source, sourceRefs: [] })),
      {},
    );
    expect(countOnlyGuard.specificityRetention).toBe(1);
    expect(countOnlyGuard.passed).toBe(true);
  });
});
