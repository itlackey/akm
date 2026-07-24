// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Deterministic, fixture-authored claim and exact-direct-provenance oracle.
 *
 * This module grades a supplied generated candidate against authored fixture
 * expectations. Grading embedded calibration candidates only checks the
 * oracle and fixture labels; it does not invoke production consolidation or
 * establish that production currently passes these cases.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { bundleRefToString, parseBundleRef } from "../../../src/core/asset/asset-ref";
import { classifyRefGrammar, legacyRefToBundleRef } from "../../../src/migrate/legacy-ref-grammar";

export type ConsolidationFidelityLabel = "lossy" | "safe";

export type ConsolidationFidelityClass =
  | "operational-procedure-omitted"
  | "implementation-invariant-omitted"
  | "stale-contradiction-retained"
  | "defensible-compression"
  | "provenance-equivalence"
  | "cardinality-false-negative"
  | "negation-adversarial";

export interface ConsolidationClaimPattern {
  id: string;
  match: "literal" | "regex";
  pattern: string;
}

export interface ConsolidationSourceFixture {
  ref: string;
  body: string;
}

/** Body and direct provenance emitted by a model or supplied as calibration data. */
export interface GeneratedConsolidationCandidate {
  body: string;
  directProvenance: string[];
}

export interface ConsolidationFidelityFixture {
  id: string;
  class: ConsolidationFidelityClass;
  /** Expected outcome for calibrationCandidate, not a claim about production output. */
  label: ConsolidationFidelityLabel;
  description: string;
  sources: ConsolidationSourceFixture[];
  /** Authored example used to prove the deterministic oracle separates safe and lossy outputs. */
  calibrationCandidate: GeneratedConsolidationCandidate;
  requiredClaims: ConsolidationClaimPattern[];
  forbiddenClaims: ConsolidationClaimPattern[];
}

export interface ConsolidationFidelityManifest {
  schemaVersion: 1;
  purpose: "deterministic-fixture-authored-oracle-for-grading-generated-candidates";
  cases: ConsolidationFidelityFixture[];
}

export interface ConsolidationOracleResult {
  fixtureId: string;
  fixtureCalibrationLabel: ConsolidationFidelityLabel;
  oraclePassed: boolean;
  requiredClaims: {
    retained: string[];
    missing: string[];
    retention: number;
    passed: boolean;
  };
  forbiddenClaims: {
    present: string[];
    absent: string[];
    presence: number;
    passed: boolean;
  };
  directProvenance: {
    policy: "exact-normalized-direct-participant-set";
    expected: string[];
    actual: string[];
    retained: string[];
    missing: string[];
    unexpected: string[];
    invalidActual: string[];
    retention: number;
    passed: boolean;
  };
  tokenOverlap: {
    sourceDistinctTokens: string[];
    candidateDistinctTokens: string[];
    sharedTokens: string[];
    sourceOnlyTokens: string[];
    candidateOnlyTokens: string[];
    sourceRetention: number;
    candidatePrecision: number;
    jaccard: number;
    cardinalityRetention: number;
    /** Count-only diagnostic. It is not a semantic-fidelity verdict. */
    countOnlyCardinalityFloorPassed: boolean;
  };
}

export const CONSOLIDATION_ORACLE_LIMITS = {
  manifestCases: 128,
  sourcesPerFixture: 16,
  claimsPerKind: 64,
  bodyChars: 32_768,
  patternChars: 256,
  boundedWildcardChars: 64,
  optionalLiteralGroups: 4,
  provenanceRefs: 32,
  provenanceRefChars: 512,
  idChars: 128,
  descriptionChars: 512,
} as const;

export const DISTINCT_TOKEN_COUNT_DIAGNOSTIC_FLOOR = 0.6;

export const CONSOLIDATION_FIDELITY_MANIFEST_PATH = fileURLToPath(
  new URL("../cases/consolidation-fidelity/fixtures/manifest.json", import.meta.url),
);

const MANIFEST_PURPOSE = "deterministic-fixture-authored-oracle-for-grading-generated-candidates" as const;

const CLASSES = new Set<ConsolidationFidelityClass>([
  "operational-procedure-omitted",
  "implementation-invariant-omitted",
  "stale-contradiction-retained",
  "defensible-compression",
  "provenance-equivalence",
  "cardinality-false-negative",
  "negation-adversarial",
]);

const OPTIONAL_LITERAL_GROUP = /\(\?:[A-Za-z0-9 ,;:'"\/_-]+\)\?/g;
const BOUNDED_WILDCARD = /\.\{(\d+),(\d+)\}/g;
const REGEX_META = /[\\^$.*+?()[\]{}|]/;
const PLAIN_PATTERN_TEXT = /^[A-Za-z0-9 \t,;:'"\/_-]*$/;

function requireObject(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object`);
  return value as Record<string, unknown>;
}

function requireBoundedString(value: unknown, context: string, maxChars: number): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${context} must be a non-empty string`);
  if (value.length > maxChars) throw new Error(`${context} must be at most ${maxChars} characters`);
  return value;
}

function requireCandidateRefArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  if (value.length > CONSOLIDATION_ORACLE_LIMITS.provenanceRefs) {
    throw new Error(`${context} must contain at most ${CONSOLIDATION_ORACLE_LIMITS.provenanceRefs} refs`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") throw new Error(`${context}[${index}] must be a string`);
    if (item.length > CONSOLIDATION_ORACLE_LIMITS.provenanceRefChars) {
      throw new Error(
        `${context}[${index}] must be at most ${CONSOLIDATION_ORACLE_LIMITS.provenanceRefChars} characters`,
      );
    }
    return item;
  });
}

/**
 * Regex claims intentionally support only literal text, up to four optional
 * non-capturing literal groups (`(?:text)?`), and one bounded wildcard
 * (`.{min,max}` with max <= 64). There is no alternation, nesting, lookaround,
 * backreference, character class, escape, or unbounded quantifier surface.
 */
function assertRestrictedRegex(pattern: string, context: string): void {
  const optionalGroups = pattern.match(OPTIONAL_LITERAL_GROUP) ?? [];
  if (optionalGroups.length > CONSOLIDATION_ORACLE_LIMITS.optionalLiteralGroups) {
    throw new Error(`${context} has too many optional literal groups`);
  }
  let reduced = pattern.replace(OPTIONAL_LITERAL_GROUP, "");
  let wildcardCount = 0;
  reduced = reduced.replace(BOUNDED_WILDCARD, (_whole, rawMin: string, rawMax: string) => {
    wildcardCount++;
    const min = Number(rawMin);
    const max = Number(rawMax);
    if (min > max || max > CONSOLIDATION_ORACLE_LIMITS.boundedWildcardChars) {
      throw new Error(
        `${context} bounded wildcard must satisfy min <= max <= ${CONSOLIDATION_ORACLE_LIMITS.boundedWildcardChars}`,
      );
    }
    return "";
  });
  if (wildcardCount > 1) throw new Error(`${context} may contain at most one bounded wildcard`);
  if (REGEX_META.test(reduced) || !PLAIN_PATTERN_TEXT.test(reduced)) {
    throw new Error(`${context} uses unsupported or potentially unsafe regex syntax`);
  }
  new RegExp(pattern, "iu");
}

function parseClaim(value: unknown, context: string): ConsolidationClaimPattern {
  const claim = requireObject(value, context);
  const match = requireBoundedString(claim.match, `${context}.match`, 16);
  if (match !== "literal" && match !== "regex") throw new Error(`${context}.match must be literal or regex`);
  const pattern = requireBoundedString(
    claim.pattern,
    `${context}.pattern`,
    CONSOLIDATION_ORACLE_LIMITS.patternChars,
  );
  if (match === "regex") assertRestrictedRegex(pattern, `${context}.pattern`);
  return {
    id: requireBoundedString(claim.id, `${context}.id`, CONSOLIDATION_ORACLE_LIMITS.idChars),
    match,
    pattern,
  };
}

function parseClaims(value: unknown, context: string, required: boolean): ConsolidationClaimPattern[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  if (required && value.length === 0) throw new Error(`${context} must contain at least one claim`);
  if (value.length > CONSOLIDATION_ORACLE_LIMITS.claimsPerKind) {
    throw new Error(`${context} must contain at most ${CONSOLIDATION_ORACLE_LIMITS.claimsPerKind} claims`);
  }
  return value.map((claim, index) => parseClaim(claim, `${context}[${index}]`));
}

function parseCandidate(value: unknown, context: string): GeneratedConsolidationCandidate {
  const candidate = requireObject(value, context);
  return {
    body: requireBoundedString(candidate.body, `${context}.body`, CONSOLIDATION_ORACLE_LIMITS.bodyChars),
    directProvenance: requireCandidateRefArray(candidate.directProvenance, `${context}.directProvenance`),
  };
}

function parseFixture(value: unknown, index: number): ConsolidationFidelityFixture {
  const context = `cases[${index}]`;
  const fixture = requireObject(value, context);
  const fixtureClass = requireBoundedString(fixture.class, `${context}.class`, 64);
  if (!CLASSES.has(fixtureClass as ConsolidationFidelityClass)) throw new Error(`${context}.class is not supported`);
  const label = requireBoundedString(fixture.label, `${context}.label`, 16);
  if (label !== "lossy" && label !== "safe") throw new Error(`${context}.label must be lossy or safe`);
  if (!Array.isArray(fixture.sources) || fixture.sources.length === 0) {
    throw new Error(`${context}.sources must be a non-empty array`);
  }
  if (fixture.sources.length > CONSOLIDATION_ORACLE_LIMITS.sourcesPerFixture) {
    throw new Error(`${context}.sources must contain at most ${CONSOLIDATION_ORACLE_LIMITS.sourcesPerFixture} items`);
  }
  const sources = fixture.sources.map((value, sourceIndex) => {
    const sourceContext = `${context}.sources[${sourceIndex}]`;
    const source = requireObject(value, sourceContext);
    const ref = requireBoundedString(source.ref, `${sourceContext}.ref`, CONSOLIDATION_ORACLE_LIMITS.provenanceRefChars);
    if (!normalizeDirectProvenance(ref)) throw new Error(`${sourceContext}.ref is invalid`);
    return {
      ref,
      body: requireBoundedString(source.body, `${sourceContext}.body`, CONSOLIDATION_ORACLE_LIMITS.bodyChars),
    };
  });
  const requiredClaims = parseClaims(fixture.requiredClaims, `${context}.requiredClaims`, true);
  const forbiddenClaims = parseClaims(fixture.forbiddenClaims, `${context}.forbiddenClaims`, false);
  const claimIds = [...requiredClaims, ...forbiddenClaims].map((claim) => claim.id);
  if (new Set(claimIds).size !== claimIds.length) throw new Error(`${context} claim IDs must be unique`);
  return {
    id: requireBoundedString(fixture.id, `${context}.id`, CONSOLIDATION_ORACLE_LIMITS.idChars),
    class: fixtureClass as ConsolidationFidelityClass,
    label,
    description: requireBoundedString(
      fixture.description,
      `${context}.description`,
      CONSOLIDATION_ORACLE_LIMITS.descriptionChars,
    ),
    sources,
    calibrationCandidate: parseCandidate(fixture.calibrationCandidate, `${context}.calibrationCandidate`),
    requiredClaims,
    forbiddenClaims,
  };
}

export function parseConsolidationFidelityManifest(value: unknown): ConsolidationFidelityManifest {
  const manifest = requireObject(value, "manifest");
  if (manifest.schemaVersion !== 1) throw new Error("manifest.schemaVersion must be 1");
  if (manifest.purpose !== MANIFEST_PURPOSE) throw new Error(`manifest.purpose must be ${MANIFEST_PURPOSE}`);
  if (!Array.isArray(manifest.cases)) throw new Error("manifest.cases must be an array");
  if (manifest.cases.length > CONSOLIDATION_ORACLE_LIMITS.manifestCases) {
    throw new Error(`manifest.cases must contain at most ${CONSOLIDATION_ORACLE_LIMITS.manifestCases} cases`);
  }
  const cases = manifest.cases.map(parseFixture);
  const ids = new Set(cases.map((fixture) => fixture.id));
  if (ids.size !== cases.length) throw new Error("manifest case IDs must be unique");
  return { schemaVersion: 1, purpose: MANIFEST_PURPOSE, cases };
}

export function loadConsolidationFidelityManifest(
  manifestPath = CONSOLIDATION_FIDELITY_MANIFEST_PATH,
): ConsolidationFidelityManifest {
  return parseConsolidationFidelityManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
}

/**
 * Normalize direct provenance through the canonical current parser and frozen
 * legacy migrator. Export fragments are not direct participant identities.
 */
export function normalizeDirectProvenance(raw: string): string | undefined {
  if (typeof raw !== "string" || raw.length > CONSOLIDATION_ORACLE_LIMITS.provenanceRefChars) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    if (classifyRefGrammar(trimmed) === "legacy") {
      return bundleRefToString(legacyRefToBundleRef(trimmed));
    }
    const parsed = parseBundleRef(trimmed);
    if (parsed.fragment !== undefined) return undefined;
    return bundleRefToString(parsed);
  } catch {
    return undefined;
  }
}

function normalizedUnique(values: readonly string[]): { valid: string[]; invalid: string[] } {
  const valid = new Set<string>();
  const invalid: string[] = [];
  for (const value of values) {
    const normalized = normalizeDirectProvenance(value);
    if (normalized) valid.add(normalized);
    else invalid.push(value);
  }
  return { valid: [...valid].sort(), invalid: invalid.sort() };
}

function assertFixtureSafeForGrading(fixture: ConsolidationFidelityFixture): void {
  if (fixture.sources.length === 0 || fixture.sources.length > CONSOLIDATION_ORACLE_LIMITS.sourcesPerFixture) {
    throw new Error(`fixture.sources must contain 1-${CONSOLIDATION_ORACLE_LIMITS.sourcesPerFixture} items`);
  }
  if (fixture.requiredClaims.length === 0) throw new Error("fixture.requiredClaims must not be empty");
  for (const source of fixture.sources) {
    if (source.body.length > CONSOLIDATION_ORACLE_LIMITS.bodyChars) throw new Error("fixture source body exceeds limit");
    if (!normalizeDirectProvenance(source.ref)) throw new Error(`fixture source ref is invalid: ${source.ref}`);
  }
  for (const claims of [fixture.requiredClaims, fixture.forbiddenClaims]) {
    if (claims.length > CONSOLIDATION_ORACLE_LIMITS.claimsPerKind) throw new Error("fixture claim count exceeds limit");
    for (const claim of claims) {
      if (claim.match !== "literal" && claim.match !== "regex") throw new Error("fixture claim match is invalid");
      if (!claim.pattern || claim.pattern.length > CONSOLIDATION_ORACLE_LIMITS.patternChars) {
        throw new Error("fixture claim pattern exceeds limit");
      }
      if (claim.match === "regex") assertRestrictedRegex(claim.pattern, `fixture claim ${claim.id}`);
    }
  }
}

function assertCandidateBounds(candidate: GeneratedConsolidationCandidate): void {
  if (typeof candidate.body !== "string") throw new Error("generated candidate body must be a string");
  if (candidate.body.length > CONSOLIDATION_ORACLE_LIMITS.bodyChars) {
    throw new Error(`generated candidate body must be at most ${CONSOLIDATION_ORACLE_LIMITS.bodyChars} characters`);
  }
  if (!Array.isArray(candidate.directProvenance)) {
    throw new Error("generated candidate directProvenance must be an array");
  }
  if (candidate.directProvenance.length > CONSOLIDATION_ORACLE_LIMITS.provenanceRefs) {
    throw new Error(
      `generated candidate directProvenance must contain at most ${CONSOLIDATION_ORACLE_LIMITS.provenanceRefs} refs`,
    );
  }
  if (!candidate.directProvenance.every((ref) => typeof ref === "string")) {
    throw new Error("generated candidate directProvenance entries must be strings");
  }
}

const NEGATED_CLAIM_PREFIX =
  /(?:\bnot|\bnever|\bno longer|\b(?:do|does|did|must|should|shall|can|could|may|will|would)\s+not|\bcannot|\bcan't)(?:\s+[a-z0-9'-]+){0,3}\s*$/iu;

function isNegatedClaim(candidate: string, matchIndex: number): boolean {
  return NEGATED_CLAIM_PREFIX.test(candidate.slice(Math.max(0, matchIndex - 96), matchIndex));
}

function claimMatches(claim: ConsolidationClaimPattern, candidate: string): boolean {
  if (claim.match === "regex") {
    const matches = candidate.matchAll(new RegExp(claim.pattern, "giu"));
    return [...matches].some((match) => !isNegatedClaim(candidate, match.index));
  }
  const normalizedCandidate = candidate.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
  const normalizedPattern = claim.pattern.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
  let start = normalizedCandidate.indexOf(normalizedPattern);
  while (start >= 0) {
    if (!isNegatedClaim(normalizedCandidate, start)) return true;
    start = normalizedCandidate.indexOf(normalizedPattern, start + 1);
  }
  return false;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function distinctTokens(text: string): string[] {
  return [...new Set(text.toLocaleLowerCase("en-US").match(/[a-z0-9]+(?:['-][a-z0-9]+)*/g) ?? [])].sort();
}

/** Grade one runner-generated candidate against an existing authored fixture. */
export function gradeGeneratedConsolidationCandidate(
  fixture: ConsolidationFidelityFixture,
  generatedCandidate: GeneratedConsolidationCandidate,
): ConsolidationOracleResult {
  assertFixtureSafeForGrading(fixture);
  assertCandidateBounds(generatedCandidate);

  const retainedClaims = fixture.requiredClaims.filter((claim) => claimMatches(claim, generatedCandidate.body));
  const missingClaims = fixture.requiredClaims.filter((claim) => !claimMatches(claim, generatedCandidate.body));
  const presentForbidden = fixture.forbiddenClaims.filter((claim) => claimMatches(claim, generatedCandidate.body));
  const absentForbidden = fixture.forbiddenClaims.filter((claim) => !claimMatches(claim, generatedCandidate.body));

  const expectedProvenance = normalizedUnique(fixture.sources.map((source) => source.ref)).valid;
  const actualProvenance = normalizedUnique(generatedCandidate.directProvenance);
  const actualSet = new Set(actualProvenance.valid);
  const expectedSet = new Set(expectedProvenance);
  const retainedProvenance = expectedProvenance.filter((ref) => actualSet.has(ref));
  const missingProvenance = expectedProvenance.filter((ref) => !actualSet.has(ref));
  const unexpectedProvenance = actualProvenance.valid.filter((ref) => !expectedSet.has(ref));

  const sourceTokens = distinctTokens(fixture.sources.map((source) => source.body).join("\n"));
  const candidateTokens = distinctTokens(generatedCandidate.body);
  const sourceTokenSet = new Set(sourceTokens);
  const candidateTokenSet = new Set(candidateTokens);
  const sharedTokens = sourceTokens.filter((token) => candidateTokenSet.has(token));
  const sourceOnlyTokens = sourceTokens.filter((token) => !candidateTokenSet.has(token));
  const candidateOnlyTokens = candidateTokens.filter((token) => !sourceTokenSet.has(token));
  const tokenUnionSize = new Set([...sourceTokens, ...candidateTokens]).size;
  const cardinalityRetention = Math.min(1, ratio(candidateTokens.length, sourceTokens.length));

  const requiredPassed = missingClaims.length === 0;
  const forbiddenPassed = presentForbidden.length === 0;
  const provenancePassed =
    missingProvenance.length === 0 && unexpectedProvenance.length === 0 && actualProvenance.invalid.length === 0;
  return {
    fixtureId: fixture.id,
    fixtureCalibrationLabel: fixture.label,
    oraclePassed: requiredPassed && forbiddenPassed && provenancePassed,
    requiredClaims: {
      retained: retainedClaims.map((claim) => claim.id),
      missing: missingClaims.map((claim) => claim.id),
      retention: ratio(retainedClaims.length, fixture.requiredClaims.length),
      passed: requiredPassed,
    },
    forbiddenClaims: {
      present: presentForbidden.map((claim) => claim.id),
      absent: absentForbidden.map((claim) => claim.id),
      presence:
        fixture.forbiddenClaims.length === 0 ? 0 : presentForbidden.length / fixture.forbiddenClaims.length,
      passed: forbiddenPassed,
    },
    directProvenance: {
      policy: "exact-normalized-direct-participant-set",
      expected: expectedProvenance,
      actual: actualProvenance.valid,
      retained: retainedProvenance,
      missing: missingProvenance,
      unexpected: unexpectedProvenance,
      invalidActual: actualProvenance.invalid,
      retention: ratio(retainedProvenance.length, expectedProvenance.length),
      passed: provenancePassed,
    },
    tokenOverlap: {
      sourceDistinctTokens: sourceTokens,
      candidateDistinctTokens: candidateTokens,
      sharedTokens,
      sourceOnlyTokens,
      candidateOnlyTokens,
      sourceRetention: ratio(sharedTokens.length, sourceTokens.length),
      candidatePrecision: ratio(sharedTokens.length, candidateTokens.length),
      jaccard: ratio(sharedTokens.length, tokenUnionSize),
      cardinalityRetention,
      countOnlyCardinalityFloorPassed: cardinalityRetention >= DISTINCT_TOKEN_COUNT_DIAGNOSTIC_FLOOR,
    },
  };
}

/** Grade one fixture's authored calibration candidate; this is oracle calibration, not a production run. */
export function gradeFixtureCalibrationCandidate(fixture: ConsolidationFidelityFixture): ConsolidationOracleResult {
  return gradeGeneratedConsolidationCandidate(fixture, fixture.calibrationCandidate);
}

/** Grade all authored calibration candidates; this does not execute production consolidation. */
export function gradeFixtureCalibrationManifest(
  manifest: ConsolidationFidelityManifest,
): ConsolidationOracleResult[] {
  return manifest.cases.map(gradeFixtureCalibrationCandidate);
}
