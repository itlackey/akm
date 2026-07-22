#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveIndexDbPath, resolveStateDbPath } from "./sources/paths";

export type RecombineRelatedness = "tags" | "graph" | "both";

export interface RecombineGraphStatus {
  availability: "available" | "degraded" | "not-requested";
  degradedReason: string | null;
  fileCount: number | null;
  entityCount: number | null;
  coveredMemoryCount: number | null;
  memoryCount: number | null;
  memoryCoverage: number | null;
}

export interface RecombineProvenance {
  xrefs: string[];
  sources: string[];
  sourceRefs: string[];
  evidenceSources: string[];
}

export interface RecombineAnalyzerEntry {
  id: number;
  /** Current canonical stored ref: `<bundle>//memories/<name>`. */
  ref: string;
  bundle: string;
  sourceRoot: string;
  name: string;
  tags: string[];
  entities: string[];
  /** Current-ref provenance channels. Values are normalized internally and never reported. */
  provenance: RecombineProvenance;
  /** Project identifier when current ref/cwd metadata makes one available. Never reported by value. */
  project?: string;
  fileSize?: number;
}

export interface RecombineAnalyzerOptions {
  minClusterSize?: number;
  maxClusterSize?: number;
  maxClusters?: number;
  relatedness?: RecombineRelatedness;
  skippedMissingCanonicalRef?: number;
  graphStatus?: RecombineGraphStatus;
}

export interface RecombineClusterReport {
  fingerprint: string;
  signature: string;
  scope: {
    bundle: string;
    sourceFingerprint: string;
  };
  memberRefs: string[];
  selected: boolean;
  recurrence: {
    observationCount: number;
    supportingMemberCount: number;
    supportingMemberCoverage: number;
    independentContextCount: number | null;
    strength: "unknown" | "weak" | "moderate" | "strong";
  };
  diversity: {
    sourceContextCount: number | null;
    sourceCoverage: number;
    projectCount: number | null;
    projectCoverage: number;
    projectConcentration: number | null;
    provenanceCoverage: Record<keyof RecombineProvenance, number>;
  };
  generalizabilityRisk: {
    level: "unknown" | "low" | "medium" | "high";
    signals: string[];
    concretePathSignals: number;
    concreteIdentifierSignals: number;
  };
  estimatedTokens: number;
}

export interface RecombineAnalyzerReport {
  schemaVersion: 1;
  analyzer: "akm-eval-recombine-analyze";
  mode: "read-only";
  graph: RecombineGraphStatus;
  options: {
    minClusterSize: number;
    maxClusterSize: number | null;
    maxClusters: number;
    relatedness: RecombineRelatedness;
  };
  summary: {
    indexedMemoryCount: number;
    eligibleMemoryCount: number;
    excludedSessionTelemetry: number;
    excludedDerived: number;
    skippedMissingCanonicalRef: number;
    clusterCount: number;
    selectedClusterCount: number;
    lowRiskSelectedClusterCount: number;
    unknownRiskSelectedClusterCount: number;
    diverseSelectedClusterCount: number;
  };
  decision: {
    observePassWorthwhile: boolean;
    reason: string;
  };
  estimatedLlm: {
    selectedClusterCap: number;
    estimatedCalls: number;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    estimatedTotalTokens: number;
    assumptions: string[];
  };
  clusters: RecombineClusterReport[];
}

interface CandidateCluster {
  signature: string;
  bundle: string;
  sourceRoot: string;
  members: RecombineAnalyzerEntry[];
}

interface ReadIndexResult {
  entries: RecombineAnalyzerEntry[];
  skippedMissingCanonicalRef: number;
  graphStatus: RecombineGraphStatus;
}

interface ReadGraphResult {
  entities: Map<string, string[]>;
  status: RecombineGraphStatus;
}

interface OpenSnapshotSource {
  path: string;
  fd: number;
  dev: bigint;
  ino: bigint;
}

interface SnapshotFingerprint {
  bytes: number;
  sha256: string;
}

interface SnapshotState {
  main: SnapshotFingerprint;
  wal: SnapshotFingerprint | null;
}

const DEFAULT_MIN_CLUSTER_SIZE = 3;
const DEFAULT_MAX_CLUSTERS = 5;
const RESERVED_TAG_SLOTS = 3;
const TAG_RESERVE_SOFT_CAP = 20;
const CONTEXT_COVERAGE_GATE = 2 / 3;
const MIN_SUPPORTING_MEMBERS = 2;
const ESTIMATED_MEMBER_CHARS = 8_000;
const PROMPT_OVERHEAD_TOKENS = 256;
const ESTIMATED_OUTPUT_TOKENS_PER_CALL = 800;
const PROVENANCE_CHANNELS = ["xrefs", "sources", "sourceRefs", "evidenceSources"] as const;
const DECISION_PROVENANCE_CHANNELS = ["sources", "sourceRefs", "evidenceSources"] as const;
const SNAPSHOT_BUFFER_BYTES = 1024 * 1024;

function baseGraphStatus(
  availability: RecombineGraphStatus["availability"],
  degradedReason: string | null = null,
): RecombineGraphStatus {
  return {
    availability,
    degradedReason,
    fileCount: null,
    entityCount: null,
    coveredMemoryCount: null,
    memoryCount: null,
    memoryCoverage: null,
  };
}

const CURRENT_CONCEPT_ROOTS = new Set([
  "agents",
  "commands",
  "env",
  "facts",
  "knowledge",
  "lessons",
  "memories",
  "scripts",
  "secrets",
  "sessions",
  "skills",
  "tasks",
  "wikis",
  "workflows",
]);

const JUNK_STOPWORD_TAGS = new Set([
  "a",
  "an",
  "and",
  "the",
  "to",
  "of",
  "in",
  "on",
  "for",
  "is",
  "are",
  "be",
  "no",
  "not",
  "or",
  "if",
  "it",
  "as",
  "at",
  "by",
  "we",
  "us",
  "do",
  "so",
  "when",
  "then",
  "than",
  "with",
  "from",
  "this",
  "that",
  "uses",
  "use",
  "via",
]);

const JUNK_ENTITY_NORMS = new Set([
  "session",
  "session_id",
  "session_checkpoint",
  "checkpoint",
  "reason",
  "harness",
  "event",
  "event log",
  "structured event",
  "structured event log",
  "timestamp",
  "metadata",
  "status",
]);

export function isRecombineJunkTag(tag: string): boolean {
  return isConcretePath(tag) || isStructuralJunk(tag);
}

export function isRecombineJunkEntity(entity: string): boolean {
  const normalized = entity.trim().toLowerCase();
  return JUNK_ENTITY_NORMS.has(normalized) || isConcretePath(normalized) || isStructuralJunk(normalized);
}

export function isSessionTelemetryMemory(name: string): boolean {
  return /-(session|checkpoint)-\d{8}/.test(name);
}

function isStructuralJunk(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length <= 1 || JUNK_STOPWORD_TAGS.has(normalized)) return true;
  if (/^\d+$/.test(normalized)) return true;
  if (/^v?\d+(?:\.\d+)+$/.test(normalized)) return true;
  if (/^v\d+$/.test(normalized)) return true;
  return /^[0-9a-f]{4,}$/.test(normalized) && /\d/.test(normalized);
}

function isConcretePath(value: string): boolean {
  const trimmed = value.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.includes("/") || trimmed.includes("\\");
}

function isConcreteIdentifier(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    /^\d{4,}$/.test(normalized) ||
    /^v?\d+(?:\.\d+)+$/.test(normalized) ||
    /^[a-f0-9]{7,}$/.test(normalized) ||
    /^[a-z][a-z0-9_-]*-\d+$/.test(normalized) ||
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(normalized)
  );
}

function normalizedSourceRoot(sourceRoot: string): string {
  const normalized = sourceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized || "/";
}

function sourceFingerprint(sourceRoot: string): string {
  return `sha256:${createHash("sha256").update(normalizedSourceRoot(sourceRoot)).digest("hex").slice(0, 12)}`;
}

function clusterFingerprint(cluster: CandidateCluster): string {
  const memberKey = cluster.members
    .map((member) => member.ref)
    .sort()
    .join("\n");
  return `sha256:${createHash("sha256").update(memberKey).digest("hex").slice(0, 16)}`;
}

function entityRank(signature: string): number {
  return signature.startsWith("entity:") ? 0 : 1;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareClusters(a: CandidateCluster, b: CandidateCluster): number {
  return (
    entityRank(a.signature) - entityRank(b.signature) ||
    b.members.length - a.members.length ||
    compareText(a.signature, b.signature) ||
    compareText(a.bundle, b.bundle) ||
    compareText(sourceFingerprint(a.sourceRoot), sourceFingerprint(b.sourceRoot))
  );
}

function clusterScopeKey(cluster: CandidateCluster): string {
  return `${cluster.bundle}\0${normalizedSourceRoot(cluster.sourceRoot)}`;
}

interface ScopeCandidates {
  bundle: string;
  sourceRoot: string;
  entities: CandidateCluster[];
  tags: CandidateCluster[];
}

function compareTagSelection(a: CandidateCluster, b: CandidateCluster): number {
  const aOver = a.members.length > TAG_RESERVE_SOFT_CAP ? 1 : 0;
  const bOver = b.members.length > TAG_RESERVE_SOFT_CAP ? 1 : 0;
  return aOver - bOver || b.members.length - a.members.length || compareClusters(a, b);
}

function chooseFromScope(
  scope: ScopeCandidates,
  targets: { entities: number; tags: number },
  selectedCounts: { entities: number; tags: number },
): CandidateCluster | undefined {
  if (selectedCounts.entities < targets.entities && scope.entities.length > 0) {
    selectedCounts.entities += 1;
    return scope.entities.shift();
  }
  if (selectedCounts.tags < targets.tags && scope.tags.length > 0) {
    selectedCounts.tags += 1;
    return scope.tags.shift();
  }
  if (scope.entities.length > 0) {
    selectedCounts.entities += 1;
    return scope.entities.shift();
  }
  if (scope.tags.length > 0) {
    selectedCounts.tags += 1;
    return scope.tags.shift();
  }
  return undefined;
}

function selectClusters(ranked: CandidateCluster[], maxClusters: number): CandidateCluster[] {
  const max = Math.max(0, maxClusters);
  if (max === 0) return [];
  const entities = ranked.filter((cluster) => cluster.signature.startsWith("entity:"));
  const tags = ranked.filter((cluster) => !cluster.signature.startsWith("entity:"));
  const reservedForTags =
    entities.length === 0 ? Math.min(tags.length, max) : Math.min(tags.length, RESERVED_TAG_SLOTS, Math.max(0, max - 1));
  const entityTarget = Math.min(entities.length, max - reservedForTags);
  const tagTarget = Math.min(tags.length, max - entityTarget);
  const byScope = new Map<string, ScopeCandidates>();
  for (const cluster of ranked) {
    const key = clusterScopeKey(cluster);
    let scope = byScope.get(key);
    if (!scope) {
      scope = { bundle: cluster.bundle, sourceRoot: cluster.sourceRoot, entities: [], tags: [] };
      byScope.set(key, scope);
    }
    if (cluster.signature.startsWith("entity:")) scope.entities.push(cluster);
    else scope.tags.push(cluster);
  }
  const scopes = [...byScope.values()].sort(
    (a, b) =>
      compareText(a.bundle, b.bundle) ||
      compareText(sourceFingerprint(a.sourceRoot), sourceFingerprint(b.sourceRoot)),
  );
  for (const scope of scopes) scope.tags.sort(compareTagSelection);

  const selected: CandidateCluster[] = [];
  const selectedCounts = { entities: 0, tags: 0 };
  while (selected.length < max) {
    let progressed = false;
    for (const scope of scopes) {
      const chosen = chooseFromScope(scope, { entities: entityTarget, tags: tagTarget }, selectedCounts);
      if (!chosen) continue;
      selected.push(chosen);
      progressed = true;
      if (selected.length === max) return selected;
    }
    if (!progressed) break;
  }
  return selected;
}

function buildClusters(
  entries: RecombineAnalyzerEntry[],
  options: Required<Pick<RecombineAnalyzerOptions, "minClusterSize" | "maxClusters" | "relatedness">> & {
    maxClusterSize?: number;
  },
): CandidateCluster[] {
  const scopes = new Map<string, RecombineAnalyzerEntry[]>();
  for (const entry of entries) {
    const key = `${entry.bundle}\0${normalizedSourceRoot(entry.sourceRoot)}`;
    const members = scopes.get(key);
    if (members) members.push(entry);
    else scopes.set(key, [entry]);
  }

  const clusters: CandidateCluster[] = [];
  for (const scopedEntries of scopes.values()) {
    scopedEntries.sort((a, b) => compareText(a.ref, b.ref) || a.id - b.id);
    const first = scopedEntries[0];
    if (!first) continue;
    const groups = new Map<string, RecombineAnalyzerEntry[]>();
    const useTags = options.relatedness === "tags" || options.relatedness === "both";
    const useGraph = options.relatedness !== "tags" && scopedEntries.some((entry) => entry.entities.length > 0);

    const add = (signature: string, entry: RecombineAnalyzerEntry): void => {
      const members = groups.get(signature);
      if (members) members.push(entry);
      else groups.set(signature, [entry]);
    };

    for (const entry of scopedEntries) {
      if (useTags) {
        for (const tag of [...new Set(entry.tags.map((value) => value.trim().toLowerCase()))].sort()) {
          if (tag && !isRecombineJunkTag(tag)) add(`tag:${tag}`, entry);
        }
      }
      if (useGraph) {
        for (const entity of [...new Set(entry.entities.map((value) => value.trim().toLowerCase()))].sort()) {
          if (entity && !isRecombineJunkEntity(entity)) add(`entity:${entity}`, entry);
        }
      }
    }

    for (const [signature, members] of groups) {
      if (members.length < options.minClusterSize) continue;
      if (options.maxClusterSize !== undefined && members.length > options.maxClusterSize) continue;
      clusters.push({ signature, bundle: first.bundle, sourceRoot: first.sourceRoot, members });
    }
  }

  clusters.sort(compareClusters);
  const seenMemberSets = new Set<string>();
  return clusters.filter((cluster) => {
    const key = `${cluster.bundle}\0${normalizedSourceRoot(cluster.sourceRoot)}\0${cluster.members
      .map((member) => member.ref)
      .sort()
      .join("\0")}`;
    if (seenMemberSets.has(key)) return false;
    seenMemberSets.add(key);
    return true;
  });
}

function normalizeCurrentRef(value: string, defaultBundle: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes(":")) return undefined;
  const boundary = trimmed.indexOf("//");
  const bundle = boundary >= 0 ? trimmed.slice(0, boundary) : defaultBundle;
  const conceptWithFragment = boundary >= 0 ? trimmed.slice(boundary + 2) : trimmed;
  if (!bundle || bundle.includes("/") || !conceptWithFragment || conceptWithFragment.includes("//")) return undefined;
  const conceptId = conceptWithFragment.split("#", 1)[0] ?? "";
  const segments = conceptId.split("/");
  if (
    segments.length < 2 ||
    !CURRENT_CONCEPT_ROOTS.has(segments[0] ?? "") ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))
  ) {
    return undefined;
  }
  return `${bundle}//${conceptWithFragment}`;
}

function normalizedProvenance(entry: RecombineAnalyzerEntry): RecombineProvenance {
  const result: RecombineProvenance = { xrefs: [], sources: [], sourceRefs: [], evidenceSources: [] };
  for (const channel of PROVENANCE_CHANNELS) {
    result[channel] = [
      ...new Set(
        (entry.provenance?.[channel] ?? [])
          .map((value) => normalizeCurrentRef(value, entry.bundle))
          .filter((value): value is string => value !== undefined),
      ),
    ].sort();
  }
  return result;
}

function hasDecisionProvenance(provenance: RecombineProvenance): boolean {
  return DECISION_PROVENANCE_CHANNELS.some((channel) => provenance[channel].length > 0);
}

function decisionContextSignature(provenance: RecombineProvenance): string {
  return DECISION_PROVENANCE_CHANNELS.map((channel) =>
    provenance[channel].length > 0 ? `${channel}=${provenance[channel].join(",")}` : "",
  )
    .filter(Boolean)
    .join("|");
}

function evidencePasses(supportingMembers: number, memberCount: number): boolean {
  return supportingMembers >= MIN_SUPPORTING_MEMBERS && supportingMembers / memberCount >= CONTEXT_COVERAGE_GATE;
}

function projectConcentration(members: RecombineAnalyzerEntry[], evidenceKnown: boolean): number | null {
  if (!evidenceKnown) return null;
  const counts = new Map<string, number>();
  for (const member of members) {
    if (!member.project) continue;
    counts.set(member.project, (counts.get(member.project) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const known = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return Math.max(...counts.values()) / known;
}

function riskForCluster(
  cluster: CandidateCluster,
  sourceEvidenceKnown: boolean,
  sourceContextCount: number | null,
  concentration: number | null,
  generalizabilityEvidenceKnown: boolean,
) {
  const rawSignals = new Set(
    cluster.members.flatMap((member) => [...member.tags, ...member.entities]).map((value) => value.trim()),
  );
  const concretePathSignals = [...rawSignals].filter(isConcretePath).length;
  const concreteIdentifierSignals = [...rawSignals].filter(isConcreteIdentifier).length;
  const signals: string[] = [];
  if (concretePathSignals > 0) signals.push("concrete-paths");
  if (concreteIdentifierSignals > 0) signals.push("concrete-identifiers");
  if (concentration !== null && concentration >= 0.75) signals.push("single-project-concentration");
  if (sourceEvidenceKnown && sourceContextCount === 1) signals.push("insufficient-source-diversity");
  if (!sourceEvidenceKnown) signals.push("source-diversity-unknown");
  if (!generalizabilityEvidenceKnown) signals.push("generalizability-evidence-unknown");
  const concreteRisk = concretePathSignals > 0 || concreteIdentifierSignals > 0;
  const level =
    signals.includes("single-project-concentration") && signals.includes("insufficient-source-diversity")
      ? "high"
      : concreteRisk || signals.includes("single-project-concentration") || signals.includes("insufficient-source-diversity")
        ? "medium"
        : generalizabilityEvidenceKnown
          ? "low"
          : "unknown";
  return {
    level: level as "unknown" | "low" | "medium" | "high",
    signals,
    concretePathSignals,
    concreteIdentifierSignals,
  };
}

function estimateTokens(cluster: CandidateCluster): { input: number; output: number; total: number } {
  const memberTokens = cluster.members.reduce((sum, member) => {
    const chars =
      member.fileSize === undefined ? ESTIMATED_MEMBER_CHARS : Math.min(member.fileSize, ESTIMATED_MEMBER_CHARS);
    return sum + Math.ceil(chars / 4);
  }, 0);
  const input = PROMPT_OVERHEAD_TOKENS + memberTokens;
  return {
    input,
    output: ESTIMATED_OUTPUT_TOKENS_PER_CALL,
    total: input + ESTIMATED_OUTPUT_TOKENS_PER_CALL,
  };
}

function assertUniqueCanonicalMemberRefs(entries: RecombineAnalyzerEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const normalized = normalizeCurrentRef(entry.ref, entry.bundle);
    const boundary = entry.ref.indexOf("//");
    const conceptId = boundary >= 0 ? entry.ref.slice(boundary + 2) : "";
    if (normalized !== entry.ref || !conceptId.startsWith("memories/") || entry.ref.includes("#")) {
      throw new Error(`invalid current canonical memory ref: ${entry.ref}`);
    }
    if (seen.has(entry.ref)) throw new Error(`duplicate canonical item ref: ${entry.ref}`);
    seen.add(entry.ref);
  }
}

export function analyzeRecombineCandidates(
  inputEntries: RecombineAnalyzerEntry[],
  rawOptions: RecombineAnalyzerOptions = {},
): RecombineAnalyzerReport {
  const minClusterSize = rawOptions.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;
  const maxClusters = rawOptions.maxClusters ?? DEFAULT_MAX_CLUSTERS;
  const relatedness = rawOptions.relatedness ?? "both";
  const graphStatus =
    rawOptions.graphStatus ??
    (relatedness === "tags" ? baseGraphStatus("not-requested") : baseGraphStatus("available"));
  if (!Number.isInteger(minClusterSize) || minClusterSize < 2) throw new Error("minClusterSize must be an integer >= 2");
  if (!Number.isInteger(maxClusters) || maxClusters < 0) throw new Error("maxClusters must be an integer >= 0");
  if (
    rawOptions.maxClusterSize !== undefined &&
    (!Number.isInteger(rawOptions.maxClusterSize) || rawOptions.maxClusterSize < minClusterSize)
  ) {
    throw new Error("maxClusterSize must be an integer >= minClusterSize");
  }
  if (relatedness === "graph" && graphStatus.availability !== "available") {
    const reason =
      graphStatus.degradedReason ??
      "graph data was not loaded. Run `akm index --full` with the current akm version, then retry.";
    throw new Error(`graph relatedness unavailable: ${reason}`);
  }
  assertUniqueCanonicalMemberRefs(inputEntries);

  let excludedSessionTelemetry = 0;
  let excludedDerived = 0;
  const entries = inputEntries.filter((entry) => {
    if (entry.name.endsWith(".derived")) {
      excludedDerived += 1;
      return false;
    }
    if (isSessionTelemetryMemory(entry.name)) {
      excludedSessionTelemetry += 1;
      return false;
    }
    return true;
  });
  const ranked = buildClusters(entries, {
    minClusterSize,
    maxClusters,
    relatedness,
    ...(rawOptions.maxClusterSize === undefined ? {} : { maxClusterSize: rawOptions.maxClusterSize }),
  });
  const selected = selectClusters(ranked, maxClusters);
  const selectedClusters = new Set(selected);
  let estimatedInputTokens = 0;
  let estimatedOutputTokens = 0;

  const clusters: RecombineClusterReport[] = ranked.map((cluster) => {
    const fingerprint = clusterFingerprint(cluster);
    const memberContexts = cluster.members.map((member) => ({ member, provenance: normalizedProvenance(member) }));
    const provenance = memberContexts.map((context) => context.provenance);
    const provenanceCoverage = Object.fromEntries(
      PROVENANCE_CHANNELS.map((channel) => [
        channel,
        provenance.filter((member) => member[channel].length > 0).length / cluster.members.length,
      ]),
    ) as Record<keyof RecombineProvenance, number>;
    const sourceSupportingMemberCount = provenance.filter(hasDecisionProvenance).length;
    const sourceCoverage = sourceSupportingMemberCount / cluster.members.length;
    const sourceEvidenceKnown = evidencePasses(sourceSupportingMemberCount, cluster.members.length);
    const sourceContextCount = sourceEvidenceKnown
      ? new Set(provenance.filter(hasDecisionProvenance).map(decisionContextSignature)).size
      : null;
    const projectSupportingMemberCount = cluster.members.filter((member) => member.project).length;
    const projectCoverage = projectSupportingMemberCount / cluster.members.length;
    const projectEvidenceKnown = evidencePasses(projectSupportingMemberCount, cluster.members.length);
    const projectCount = projectEvidenceKnown
      ? new Set(cluster.members.flatMap((member) => (member.project ? [member.project] : []))).size
      : null;
    const supportingContexts = memberContexts.filter(({ provenance: memberProvenance }) =>
      hasDecisionProvenance(memberProvenance),
    );
    const supportingMemberCount = supportingContexts.length;
    const supportingMemberCoverage = supportingMemberCount / cluster.members.length;
    const generalizabilityEvidenceKnown = evidencePasses(supportingMemberCount, cluster.members.length);
    const independentContextCount = generalizabilityEvidenceKnown
      ? new Set(supportingContexts.map(({ provenance: value }) => decisionContextSignature(value))).size
      : null;
    const recurrenceStrength =
      independentContextCount === null
        ? "unknown"
        : independentContextCount >= 3
          ? "strong"
          : independentContextCount >= 2
            ? "moderate"
            : "weak";
    const concentration = projectConcentration(cluster.members, projectEvidenceKnown);
    const estimate = estimateTokens(cluster);
    const isSelected = selectedClusters.has(cluster);
    if (isSelected) {
      estimatedInputTokens += estimate.input;
      estimatedOutputTokens += estimate.output;
    }
    return {
      fingerprint,
      signature: cluster.signature,
      scope: { bundle: cluster.bundle, sourceFingerprint: sourceFingerprint(cluster.sourceRoot) },
      memberRefs: cluster.members.map((member) => member.ref).sort(),
      selected: isSelected,
      recurrence: {
        observationCount: cluster.members.length,
        supportingMemberCount,
        supportingMemberCoverage,
        independentContextCount,
        strength: recurrenceStrength,
      },
      diversity: {
        sourceContextCount,
        sourceCoverage,
        projectCount,
        projectCoverage,
        projectConcentration: concentration,
        provenanceCoverage,
      },
      generalizabilityRisk: riskForCluster(
        cluster,
        sourceEvidenceKnown,
        sourceContextCount,
        concentration,
        generalizabilityEvidenceKnown,
      ),
      estimatedTokens: estimate.total,
    };
  });

  const selectedReports = clusters.filter((cluster) => cluster.selected);
  const lowRiskSelectedClusterCount = selectedReports.filter(
    (cluster) => cluster.generalizabilityRisk.level === "low",
  ).length;
  const unknownRiskSelectedClusterCount = selectedReports.filter(
    (cluster) => cluster.generalizabilityRisk.level === "unknown",
  ).length;
  const diverseSelectedClusterCount = selectedReports.filter(
    (cluster) => cluster.recurrence.independentContextCount !== null && cluster.recurrence.independentContextCount >= 2,
  ).length;
  const observePassWorthwhile =
    selectedReports.length > 0 && (lowRiskSelectedClusterCount > 0 || diverseSelectedClusterCount > 0);
  const reason =
    selectedReports.length === 0
      ? "No clusters satisfy the deterministic filters and selection cap."
      : observePassWorthwhile
        ? `${selectedReports.length} cluster(s) are selectable; ${diverseSelectedClusterCount} have coverage-gated independent-context evidence.`
        : `${selectedReports.length} cluster(s) formed, but all are concentrated or lack coverage-gated context evidence.`;

  return {
    schemaVersion: 1,
    analyzer: "akm-eval-recombine-analyze",
    mode: "read-only",
    graph: graphStatus,
    options: {
      minClusterSize,
      maxClusterSize: rawOptions.maxClusterSize ?? null,
      maxClusters,
      relatedness,
    },
    summary: {
      indexedMemoryCount: inputEntries.length,
      eligibleMemoryCount: entries.length,
      excludedSessionTelemetry,
      excludedDerived,
      skippedMissingCanonicalRef: rawOptions.skippedMissingCanonicalRef ?? 0,
      clusterCount: clusters.length,
      selectedClusterCount: selectedReports.length,
      lowRiskSelectedClusterCount,
      unknownRiskSelectedClusterCount,
      diverseSelectedClusterCount,
    },
    decision: { observePassWorthwhile, reason },
    estimatedLlm: {
      selectedClusterCap: maxClusters,
      estimatedCalls: selectedReports.length,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
      assumptions: [
        `assumes one optional observe call per selected cluster`,
        `estimates input from file-size metadata using four characters/token and ${ESTIMATED_MEMBER_CHARS} characters per member`,
        `assumes ${ESTIMATED_OUTPUT_TOKENS_PER_CALL} output tokens per call`,
        `the hypothetical observe pass does not currently enforce these token estimates`,
        `no LLM call is made by this analyzer`,
      ],
    },
    clusters,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function projectFrom(conceptId: string, cwd: unknown): string | undefined {
  const parts = conceptId.split("/");
  if (parts.length > 2 && parts[0] === "memories") return parts[1];
  if (typeof cwd === "string" && cwd.trim()) return path.basename(cwd.trim());
  return undefined;
}

function graphFailureReason(error: unknown): string {
  const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 240);
  return `graph schema/query unavailable${detail ? `: ${detail}` : ""}. Run \`akm index --full\` with the current akm version.`;
}

function readGraphEntities(
  db: Database,
  relatedness: RecombineRelatedness,
): ReadGraphResult {
  const result = new Map<string, string[]>();
  const fileKeys = new Set<string>();
  if (relatedness === "tags") {
    return { entities: result, status: baseGraphStatus("not-requested") };
  }
  try {
    const rows = db
      .query(
         `SELECT gf.stash_root, gf.file_path, gfe.entity_norm
          FROM graph_files gf
          LEFT JOIN graph_file_entities gfe
            ON gfe.stash_root = gf.stash_root
           AND gfe.file_path = gf.file_path
           AND gfe.body_hash = gf.body_hash
          ORDER BY gf.stash_root, gf.file_path, gfe.entity_norm`,
      )
      .all() as Array<{ stash_root: string; file_path: string; entity_norm: string | null }>;
    const uniqueEntities = new Set<string>();
    for (const row of rows) {
      const key = `${row.stash_root}\0${row.file_path}`;
      fileKeys.add(key);
      const entity = row.entity_norm?.trim();
      if (!entity) continue;
      uniqueEntities.add(entity);
      const entities = result.get(key);
      if (entities) {
        if (!entities.includes(entity)) entities.push(entity);
      } else {
        result.set(key, [entity]);
      }
    }
    return {
      entities: result,
      status: {
        ...baseGraphStatus("available"),
        fileCount: fileKeys.size,
        entityCount: uniqueEntities.size,
      },
    };
  } catch (error) {
    return {
      entities: result,
      status: baseGraphStatus("degraded", graphFailureReason(error)),
    };
  }
}

function snapshotChangedError(): Error {
  return new Error("index database changed while creating read-only snapshot; retry when indexing is idle");
}

function sameOpenSourceStat(
  a: fs.BigIntStats,
  b: fs.BigIntStats,
): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

function assertOpenSourceIdentity(source: OpenSnapshotSource): void {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(source.path, { bigint: true });
  } catch {
    throw snapshotChangedError();
  }
  if (!stat.isFile() || stat.dev !== source.dev || stat.ino !== source.ino) throw snapshotChangedError();
}

function assertPathAbsent(filePath: string): void {
  try {
    fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw snapshotChangedError();
}

function openSnapshotSource(filePath: string, optional = false): OpenSnapshotSource | undefined {
  let pathStat: fs.BigIntStats;
  try {
    pathStat = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!pathStat.isFile()) throw new Error(`index snapshot source is not a regular file: ${filePath}`);
  const fd = fs.openSync(filePath, "r");
  try {
    const fdStat = fs.fstatSync(fd, { bigint: true });
    if (!fdStat.isFile() || fdStat.dev !== pathStat.dev || fdStat.ino !== pathStat.ino) {
      throw snapshotChangedError();
    }
    return { path: filePath, fd, dev: fdStat.dev, ino: fdStat.ino };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readSnapshotSource(source: OpenSnapshotSource, destinationFd?: number): SnapshotFingerprint {
  assertOpenSourceIdentity(source);
  const before = fs.fstatSync(source.fd, { bigint: true });
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(SNAPSHOT_BUFFER_BYTES);
  let position = 0;
  while (true) {
    const bytesRead = fs.readSync(source.fd, buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    if (destinationFd !== undefined) {
      let written = 0;
      while (written < bytesRead) {
        written += fs.writeSync(destinationFd, buffer, written, bytesRead - written);
      }
    }
    position += bytesRead;
  }
  const after = fs.fstatSync(source.fd, { bigint: true });
  assertOpenSourceIdentity(source);
  if (!sameOpenSourceStat(before, after) || BigInt(position) !== after.size) throw snapshotChangedError();
  return { bytes: position, sha256: hash.digest("hex") };
}

function fingerprintSnapshotSources(
  main: OpenSnapshotSource,
  wal: OpenSnapshotSource | undefined,
  walPath: string,
): SnapshotState {
  const mainFingerprint = readSnapshotSource(main);
  const walFingerprint = wal ? readSnapshotSource(wal) : null;
  if (!wal) assertPathAbsent(walPath);
  return { main: mainFingerprint, wal: walFingerprint };
}

function copySnapshotSource(source: OpenSnapshotSource, destination: string): SnapshotFingerprint {
  const destinationFd = fs.openSync(destination, "wx", 0o600);
  try {
    const fingerprint = readSnapshotSource(source, destinationFd);
    fs.fsyncSync(destinationFd);
    return fingerprint;
  } finally {
    fs.closeSync(destinationFd);
  }
}

function copySnapshotSources(
  main: OpenSnapshotSource,
  wal: OpenSnapshotSource | undefined,
  walPath: string,
  databasePath: string,
): SnapshotState {
  const mainFingerprint = copySnapshotSource(main, databasePath);
  const walFingerprint = wal ? copySnapshotSource(wal, `${databasePath}-wal`) : null;
  if (!wal) assertPathAbsent(walPath);
  return { main: mainFingerprint, wal: walFingerprint };
}

function sameSnapshotFingerprint(a: SnapshotFingerprint | null, b: SnapshotFingerprint | null): boolean {
  return a === null || b === null
    ? a === b
    : a.bytes === b.bytes && a.sha256 === b.sha256;
}

function sameSnapshotState(a: SnapshotState, b: SnapshotState): boolean {
  return sameSnapshotFingerprint(a.main, b.main) && sameSnapshotFingerprint(a.wal, b.wal);
}

function createRecombineIndexSnapshot(indexDbPath: string): { databasePath: string; cleanup: () => void } {
  const sourcePath = fs.realpathSync(indexDbPath);
  const walPath = `${sourcePath}-wal`;
  const main = openSnapshotSource(sourcePath);
  if (!main) throw new Error(`index database not found: ${indexDbPath}`);
  let wal: OpenSnapshotSource | undefined;
  let snapshotDir: string | undefined;
  let mainOpen = true;
  let walOpen = false;
  try {
    wal = openSnapshotSource(walPath, true);
    walOpen = wal !== undefined;
    snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-recombine-index-"));
    fs.chmodSync(snapshotDir, 0o700);
    const databasePath = path.join(snapshotDir, "index.db");
    const before = fingerprintSnapshotSources(main, wal, walPath);
    const copied = copySnapshotSources(main, wal, walPath, databasePath);
    const after = fingerprintSnapshotSources(main, wal, walPath);
    if (!sameSnapshotState(before, copied) || !sameSnapshotState(before, after)) throw snapshotChangedError();
    const completedDir = snapshotDir;
    fs.closeSync(main.fd);
    mainOpen = false;
    if (wal) {
      fs.closeSync(wal.fd);
      walOpen = false;
    }
    snapshotDir = undefined;
    return {
      databasePath,
      cleanup: () => fs.rmSync(completedDir, { recursive: true, force: true }),
    };
  } finally {
    if (mainOpen) {
      try {
        fs.closeSync(main.fd);
      } catch {
        // The original snapshot/close failure remains authoritative.
      }
    }
    if (walOpen && wal) {
      try {
        fs.closeSync(wal.fd);
      } catch {
        // The original snapshot/close failure remains authoritative.
      }
    }
    if (snapshotDir) fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
}

export function readCurrentRecombineEntries(
  indexDbPath: string,
  relatedness: RecombineRelatedness = "both",
): ReadIndexResult {
  if (!fs.existsSync(indexDbPath)) throw new Error(`index database not found: ${indexDbPath}`);
  const snapshot = createRecombineIndexSnapshot(indexDbPath);
  let db: Database | undefined;
  let transactionOpen = false;
  try {
    db = new Database(snapshot.databasePath, { readonly: true, create: false });
    db.exec("BEGIN");
    transactionOpen = true;
    const columns = new Set(
      (db.query("PRAGMA table_info(entries)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    const missingCanonicalColumns = ["item_ref", "bundle_id"].filter((column) => !columns.has(column));
    if (missingCanonicalColumns.length > 0) {
      throw new Error(
        `index database lacks current canonical-ref columns (${missingCanonicalColumns.join(", ")}); refusing legacy ref reconstruction`,
      );
    }
    const rows = db
      .query(
        `SELECT id, item_ref, bundle_id, stash_dir, file_path, entry_json
         FROM entries
         WHERE entry_type = 'memory'
         ORDER BY item_ref, id`,
      )
      .all() as Array<{
      id: number;
      item_ref: string | null;
      bundle_id: string | null;
      stash_dir: string;
      file_path: string;
      entry_json: string;
    }>;
    const graph = readGraphEntities(db, relatedness);
    const entries: RecombineAnalyzerEntry[] = [];
    const seenItemRefs = new Set<string>();
    let skippedMissingCanonicalRef = 0;
    let coveredMemoryCount = 0;
    for (const row of rows) {
      const itemRef = row.item_ref;
      const boundary = itemRef?.indexOf("//") ?? -1;
      const bundle = boundary > 0 ? itemRef?.slice(0, boundary) : undefined;
      const conceptId = boundary > 0 ? itemRef?.slice(boundary + 2) : undefined;
      if (!itemRef || !bundle || !conceptId?.startsWith("memories/") || (row.bundle_id && row.bundle_id !== bundle)) {
        skippedMissingCanonicalRef += 1;
        continue;
      }
      if (seenItemRefs.has(itemRef)) throw new Error(`duplicate canonical item ref: ${itemRef}`);
      seenItemRefs.add(itemRef);
      let document: Record<string, unknown>;
      try {
        const parsed = JSON.parse(row.entry_json) as unknown;
        document = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
      } catch {
        document = {};
      }
      const name = conceptId.slice("memories/".length);
      if ((graph.entities.get(`${row.stash_dir}\0${row.file_path}`)?.length ?? 0) > 0) coveredMemoryCount += 1;
      let fileSize =
        typeof document.fileSize === "number" && Number.isFinite(document.fileSize) && document.fileSize >= 0
          ? document.fileSize
          : undefined;
      if (fileSize === undefined) {
        try {
          fileSize = fs.statSync(row.file_path).size;
        } catch {
          // Missing files remain analyzable from index metadata; use the fallback token estimate.
        }
      }
      entries.push({
        id: row.id,
        ref: itemRef,
        bundle,
        sourceRoot: row.stash_dir,
        name,
        tags: stringArray(document.tags),
        entities: graph.entities.get(`${row.stash_dir}\0${row.file_path}`) ?? [],
        provenance: {
          xrefs: stringArray(document.xrefs),
          sources: stringArray(document.sources),
          sourceRefs: stringArray(document.sourceRefs),
          evidenceSources: stringArray(document.evidenceSources),
        },
        project: projectFrom(conceptId, document.cwd),
        ...(fileSize === undefined ? {} : { fileSize }),
      });
    }
    const memoryCoverage = entries.length === 0 ? null : coveredMemoryCount / entries.length;
    const populatedGraphStatus: RecombineGraphStatus =
      graph.status.availability === "available"
        ? {
            ...graph.status,
            coveredMemoryCount,
            memoryCount: entries.length,
            memoryCoverage,
          }
        : graph.status;
    db.exec("COMMIT");
    transactionOpen = false;
    return { entries, skippedMissingCanonicalRef, graphStatus: populatedGraphStatus };
  } catch (error) {
    if (transactionOpen) {
      try {
        db?.exec("ROLLBACK");
      } catch {
        // Preserve the read failure when SQLite has already closed the transaction.
      }
    }
    throw error;
  } finally {
    try {
      db?.close();
    } finally {
      snapshot.cleanup();
    }
  }
}

interface CliOptions {
  indexDb: string;
  stateDb: string;
  minClusterSize: number;
  maxClusterSize?: number;
  maxClusters: number;
  relatedness: RecombineRelatedness;
  format: "json" | "md";
  out?: string;
}

function printHelp(): void {
  process.stdout.write(`akm-eval-recombine-analyze - read-only recombine candidate analyzer

Usage:
  akm-eval-recombine-analyze [options]

Reads the current index/graph without indexing, proposing, emitting events, or
changing state. The report is written to stdout only unless --out names an
explicit additional report file.

Options:
  --index-db <path>          Current index.db (default: $AKM_DATA_DIR/index.db).
  --relatedness <mode>       tags | graph | both (default: both). Graph fails
                             when graph schema/query is unavailable; both
                             reports degradation and falls back to tags.
  --min-cluster-size <n>     Minimum members (default: 3).
  --max-cluster-size <n>     Exclude larger clusters (default: no upper limit).
  --max-clusters <n>         Fair selected-cluster cap (default: 5).
  --format <format>          json | md (default: md).
  --out <path>               Also create this report; existing/input files are refused.
  -h, --help                 Show help.
`);
}

function positiveInteger(value: string, flag: string, minimum: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) throw new Error(`${flag} must be an integer >= ${minimum}`);
  return number;
}

function parseArgs(argv: string[]): CliOptions | undefined {
  const options: CliOptions = {
    indexDb: resolveIndexDbPath(),
    stateDb: resolveStateDbPath(),
    minClusterSize: DEFAULT_MIN_CLUSTER_SIZE,
    maxClusters: DEFAULT_MAX_CLUSTERS,
    relatedness: "both",
    format: "md",
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--index-db":
        options.indexDb = path.resolve(next());
        break;
      case "--relatedness": {
        const value = next();
        if (value !== "tags" && value !== "graph" && value !== "both") {
          throw new Error(`--relatedness must be tags|graph|both (got ${value})`);
        }
        options.relatedness = value;
        break;
      }
      case "--min-cluster-size":
        options.minClusterSize = positiveInteger(next(), arg, 2);
        break;
      case "--max-cluster-size":
        options.maxClusterSize = positiveInteger(next(), arg, 2);
        break;
      case "--max-clusters":
        options.maxClusters = positiveInteger(next(), arg, 0);
        break;
      case "--format": {
        const value = next();
        if (value !== "json" && value !== "md") throw new Error(`--format must be json|md (got ${value})`);
        options.format = value;
        break;
      }
      case "--out":
        options.out = path.resolve(next());
        break;
      case "-h":
      case "--help":
        printHelp();
        return undefined;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.maxClusterSize !== undefined && options.maxClusterSize < options.minClusterSize) {
    throw new Error("--max-cluster-size must be >= --min-cluster-size");
  }
  return options;
}

function renderMarkdown(report: RecombineAnalyzerReport): string {
  const memoryCoverage =
    report.graph.memoryCoverage === null ? "undefined" : `${(report.graph.memoryCoverage * 100).toFixed(1)}%`;
  const graphCoverage =
    report.graph.availability === "available"
      ? `${report.graph.coveredMemoryCount}/${report.graph.memoryCount} memories (${memoryCoverage}); ${report.graph.fileCount} files; ${report.graph.entityCount} entities`
      : report.graph.availability === "degraded"
        ? "unavailable"
        : "not requested";
  const lines = [
    "# Recombine candidate analysis",
    "",
    `Read-only: yes`,
    `Graph status: ${report.graph.availability}`,
    `Graph coverage: ${graphCoverage}`,
    ...(report.graph.degradedReason ? [`Graph detail: ${report.graph.degradedReason}`] : []),
    ...(report.graph.availability === "degraded" && report.options.relatedness === "both"
      ? ["Graph fallback: tags"]
      : []),
    `Clusters: ${report.summary.clusterCount} formed, ${report.summary.selectedClusterCount} selected`,
    `Eligible memories: ${report.summary.eligibleMemoryCount} (${report.summary.excludedSessionTelemetry} telemetry and ${report.summary.excludedDerived} derived excluded)`,
    `Observe pass worthwhile: ${report.decision.observePassWorthwhile ? "yes" : "no"}`,
    `Reason: ${report.decision.reason}`,
    `Estimated observe cost: ${report.estimatedLlm.estimatedCalls} calls, ${report.estimatedLlm.estimatedTotalTokens} total tokens`,
    "",
  ];
  for (const cluster of report.clusters) {
    lines.push(`## ${cluster.signature}${cluster.selected ? " (selected)" : ""}`);
    lines.push(`- Fingerprint: \`${cluster.fingerprint}\``);
    lines.push(`- Scope: \`${cluster.scope.bundle}\` / \`${cluster.scope.sourceFingerprint}\``);
    lines.push(
      `- Diversity: ${cluster.diversity.sourceContextCount ?? "unknown"} source contexts, ${cluster.diversity.projectCount ?? "unknown"} projects`,
    );
    lines.push(
      `- Recurrence: ${cluster.recurrence.observationCount} observations, ${cluster.recurrence.strength} independent-context proxy`,
    );
    lines.push(
      `- Generalizability risk: ${cluster.generalizabilityRisk.level}${cluster.generalizabilityRisk.signals.length > 0 ? ` (${cluster.generalizabilityRisk.signals.join(", ")})` : ""}`,
    );
    lines.push("- Members:");
    for (const ref of cluster.memberRefs) lines.push(`  - \`${ref}\``);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderRecombineAnalyzerReport(
  report: RecombineAnalyzerReport,
  format: "json" | "md",
): string {
  return format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report);
}

function pathExistsIncludingSymlink(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function sameExistingFile(a: string, b: string): boolean {
  try {
    const aStat = fs.statSync(a);
    const bStat = fs.statSync(b);
    return aStat.dev === bStat.dev && aStat.ino === bStat.ino;
  } catch {
    return false;
  }
}

function validateOutputPath(options: CliOptions): void {
  if (!options.out) return;
  const out = path.resolve(options.out);
  const protectedInputs = [
    path.resolve(options.indexDb),
    path.resolve(options.stateDb),
    path.resolve(path.dirname(options.indexDb), "state.db"),
  ];
  for (const input of new Set(protectedInputs)) {
    if (out === input || sameExistingFile(out, input)) {
      throw new Error(`--out collides with an input database: ${input}`);
    }
  }
  if (pathExistsIncludingSymlink(out)) throw new Error(`--out already exists: ${out}`);
}

export function runRecombineAnalyzerCli(argv: string[]): number {
  const options = parseArgs(argv);
  if (!options) return 0;
  validateOutputPath(options);
  const input = readCurrentRecombineEntries(options.indexDb, options.relatedness);
  const report = analyzeRecombineCandidates(input.entries, {
    minClusterSize: options.minClusterSize,
    maxClusters: options.maxClusters,
    relatedness: options.relatedness,
    skippedMissingCanonicalRef: input.skippedMissingCanonicalRef,
    graphStatus: input.graphStatus,
    ...(options.maxClusterSize === undefined ? {} : { maxClusterSize: options.maxClusterSize }),
  });
  const rendered = renderRecombineAnalyzerReport(report, options.format);
  if (options.out) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, rendered, { encoding: "utf8", flag: "wx" });
  }
  process.stdout.write(rendered);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = runRecombineAnalyzerCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[akm-eval-recombine-analyze] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
