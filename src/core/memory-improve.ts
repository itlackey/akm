import fs from "node:fs";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { makeAssetRef, parseAssetRef } from "./asset-ref";
import { parseFrontmatter } from "./frontmatter";

export type MemoryPruneReason = "duplicate-derived" | "superseded-derived" | "obsolete-derived";
export type MemoryBeliefState = "active" | "superseded" | "contradicted" | "archived";

export interface MemoryPruneCandidate {
  ref: string;
  parentRef: string;
  reason: MemoryPruneReason;
  survivorRef?: string;
}

export interface MemoryConsolidationCandidate {
  parentRef: string;
  signal: string;
  refs: string[];
  suggestedSurvivorRef: string;
}

export interface MemoryContradictionCandidate {
  ref: string;
  parentRef: string;
  reason: "contradicted-derived";
  contradictedByRef: string;
  contradictedByRefs: string[];
  currentBeliefRefs: string[];
}

export interface MemoryBeliefStateTransition {
  ref: string;
  parentRef: string;
  fromState: Exclude<MemoryBeliefState, "archived">;
  toState: Exclude<MemoryBeliefState, "archived">;
  reason: "contradicted-derived" | "belief-refresh";
  relatedRef?: string;
  relatedRefs?: string[];
  currentBeliefRefs?: string[];
}

export interface MemoryCleanupPlan {
  analyzedDerived: number;
  pruneCandidates: MemoryPruneCandidate[];
  contradictionCandidates: MemoryContradictionCandidate[];
  beliefStateTransitions: MemoryBeliefStateTransition[];
  consolidationCandidates: MemoryConsolidationCandidate[];
}

export interface ArchivedMemoryCleanupRecord {
  ref: string;
  parentRef: string;
  reason: MemoryPruneReason;
  beliefState: "archived";
  previousBeliefState: Exclude<MemoryBeliefState, "archived">;
  survivorRef?: string;
  originalPath: string;
  archivedPath: string;
  auditPath: string;
  archivedAt: string;
}

export interface MemoryBeliefTransitionLogRecord extends MemoryBeliefStateTransition {
  appliedAt: string;
}

export interface MemoryCleanupApplyResult {
  archived: ArchivedMemoryCleanupRecord[];
  beliefStateTransitions: MemoryBeliefStateTransition[];
  transitionLogPath?: string;
  transitionLogEntries?: number;
  warnings?: string[];
}

export interface MemoryCleanupOptions {
  parentRef?: string;
}

interface DerivedMemoryRecord {
  ref: string;
  name: string;
  filePath: string;
  parentRef: string;
  title: string;
  description: string;
  tags: string[];
  searchHints: string[];
  body: string;
  canonicalName: boolean;
  signalScore: number;
  fingerprint: string;
  signalKey?: string;
  supersededBy: string[];
  contradictedBy: string[];
  currentBeliefRefs: string[];
  obsolete: boolean;
  beliefState: Exclude<MemoryBeliefState, "archived">;
}

interface PlannedPrune extends MemoryPruneCandidate {
  filePath: string;
}

interface FamilyContradictionResolution {
  contradictionCandidates: MemoryContradictionCandidate[];
  transitions: MemoryBeliefStateTransition[];
}

const DERIVED_SUFFIX = ".derived";

export function analyzeMemoryCleanup(stashDir: string, options: MemoryCleanupOptions = {}): MemoryCleanupPlan {
  const records = collectDerivedMemories(stashDir, options.parentRef);
  const byRef = new Map(records.map((record) => [record.ref, record]));
  const byParent = groupBy(records, (record) => record.parentRef);
  const planned = new Map<string, PlannedPrune>();
  const contradictionCandidates: MemoryContradictionCandidate[] = [];
  const beliefTransitions = new Map<string, MemoryBeliefStateTransition>();

  const planPrune = (record: DerivedMemoryRecord, reason: MemoryPruneReason, survivorRef?: string) => {
    const existing = planned.get(record.ref);
    if (existing) return existing;
    const next: PlannedPrune = {
      ref: record.ref,
      parentRef: record.parentRef,
      reason,
      ...(survivorRef ? { survivorRef } : {}),
      filePath: record.filePath,
    };
    planned.set(record.ref, next);
    return next;
  };

  const planBeliefTransition = (
    record: DerivedMemoryRecord,
    toState: Exclude<MemoryBeliefState, "archived">,
    reason: MemoryBeliefStateTransition["reason"],
    currentBeliefRefs: string[] = [],
  ) => {
    const normalizedRefs = [...new Set(currentBeliefRefs)].sort();
    const metadataChanged =
      !sameStringArray(record.currentBeliefRefs, normalizedRefs) ||
      (toState === "contradicted"
        ? !sameStringArray(record.contradictedBy, normalizedRefs)
        : record.contradictedBy.length > 0);
    if (record.beliefState === toState && !metadataChanged) return;

    const existing = beliefTransitions.get(record.ref);
    if (existing) return existing;

    const next: MemoryBeliefStateTransition = {
      ref: record.ref,
      parentRef: record.parentRef,
      fromState: record.beliefState,
      toState,
      reason,
      ...(normalizedRefs[0] ? { relatedRef: normalizedRefs[0] } : {}),
      ...(normalizedRefs.length > 0 ? { relatedRefs: normalizedRefs, currentBeliefRefs: normalizedRefs } : {}),
    };
    beliefTransitions.set(record.ref, next);
    return next;
  };

  for (const record of records) {
    const supersededTarget = firstExistingRef(record.supersededBy, byRef, record.ref);
    if (supersededTarget) {
      planPrune(record, "superseded-derived", supersededTarget);
      continue;
    }
    if (record.obsolete) {
      planPrune(record, "obsolete-derived");
    }
  }

  const excludedRefs = new Set<string>(planned.keys());
  for (const family of byParent.values()) {
    const activeFamily = family.filter((record) => !excludedRefs.has(record.ref));
    const resolution = resolveFamilyContradictions(activeFamily);
    for (const candidate of resolution.contradictionCandidates) {
      contradictionCandidates.push(candidate);
    }
    for (const transition of resolution.transitions) {
      const record = byRef.get(transition.ref);
      if (!record) continue;
      planBeliefTransition(record, transition.toState, transition.reason, transition.currentBeliefRefs ?? []);
    }
  }

  const excludedForDuplicateDetection = new Set<string>([
    ...planned.keys(),
    ...contradictionCandidates.map((candidate) => candidate.ref),
  ]);

  for (const family of byParent.values()) {
    const active = family.filter((record) => !excludedForDuplicateDetection.has(record.ref));
    const byFingerprint = groupBy(active, (record) => record.fingerprint);
    for (const duplicates of byFingerprint.values()) {
      if (duplicates.length < 2) continue;
      const [survivor, ...rest] = sortRecordsForSurvival(duplicates);
      for (const duplicate of rest) {
        planPrune(duplicate, "duplicate-derived", survivor.ref);
      }
    }
  }

  const consolidationCandidates: MemoryConsolidationCandidate[] = [];
  const excludedForConsolidation = new Set<string>([
    ...planned.keys(),
    ...contradictionCandidates.map((candidate) => candidate.ref),
  ]);
  for (const [parentRef, family] of byParent.entries()) {
    const active = family.filter((record) => !excludedForConsolidation.has(record.ref));
    if (active.length < 2) continue;
    const bySignal = groupBy(
      active.filter((record) => record.signalKey !== undefined),
      (record) => record.signalKey as string,
    );
    for (const [signal, signalRecords] of bySignal.entries()) {
      if (signalRecords.length < 2) continue;
      const ordered = sortRecordsForSurvival(signalRecords);
      consolidationCandidates.push({
        parentRef,
        signal,
        refs: ordered.map((record) => record.ref),
        suggestedSurvivorRef: ordered[0].ref,
      });
    }
  }

  return {
    analyzedDerived: records.length,
    pruneCandidates: [...planned.values()]
      .map(({ filePath: _filePath, ...candidate }) => candidate)
      .sort(compareCandidates),
    contradictionCandidates: contradictionCandidates.sort(compareContradictionCandidates),
    beliefStateTransitions: [...beliefTransitions.values()].sort(compareBeliefTransitions),
    consolidationCandidates: consolidationCandidates.sort(compareConsolidationCandidates),
  };
}

export function applyMemoryCleanup(stashDir: string, plan: MemoryCleanupPlan): MemoryCleanupApplyResult {
  const records = collectDerivedMemories(stashDir);
  const fileByRef = new Map(records.map((record) => [record.ref, record.filePath]));
  const archived: ArchivedMemoryCleanupRecord[] = [];
  const appliedBeliefTransitions: MemoryBeliefStateTransition[] = [];
  const warnings: string[] = [];

  for (const transition of plan.beliefStateTransitions) {
    const filePath = fileByRef.get(transition.ref);
    if (!filePath) continue;
    try {
      persistBeliefStateTransition(filePath, transition);
      appliedBeliefTransitions.push(transition);
    } catch (error) {
      warnings.push(formatApplyWarning("belief-transition", transition.ref, error));
    }
  }

  let transitionLogPath: string | undefined;
  if (appliedBeliefTransitions.length > 0) {
    try {
      transitionLogPath = appendBeliefStateTransitionLog(stashDir, appliedBeliefTransitions);
    } catch (error) {
      warnings.push(formatApplyWarning("transition-log", "memory-cleanup", error));
    }
  }

  for (const candidate of plan.pruneCandidates) {
    const filePath = fileByRef.get(candidate.ref);
    if (!filePath) continue;
    try {
      archived.push(archiveCleanupCandidate(stashDir, candidate, filePath));
    } catch (error) {
      warnings.push(formatApplyWarning("archive", candidate.ref, error));
    }
  }

  archived.sort((a, b) => a.ref.localeCompare(b.ref));
  appliedBeliefTransitions.sort(compareBeliefTransitions);
  return {
    archived,
    beliefStateTransitions: appliedBeliefTransitions,
    ...(transitionLogPath ? { transitionLogPath: path.relative(stashDir, transitionLogPath).replace(/\\/g, "/") } : {}),
    ...(transitionLogPath ? { transitionLogEntries: appliedBeliefTransitions.length } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function formatApplyWarning(stage: string, ref: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${stage} failed for ${ref}: ${detail}`;
}

function resolveFamilyContradictions(family: DerivedMemoryRecord[]): FamilyContradictionResolution {
  if (family.length === 0) return { contradictionCandidates: [], transitions: [] };

  const familyRefSet = new Set(family.map((record) => record.ref));
  const edges = new Map<string, string[]>();
  let edgeCount = 0;

  for (const record of family) {
    const targets = [
      ...new Set(record.contradictedBy.filter((ref) => ref !== record.ref && familyRefSet.has(ref))),
    ].sort();
    edges.set(record.ref, targets);
    edgeCount += targets.length;
  }

  if (edgeCount === 0) {
    return {
      contradictionCandidates: [],
      transitions: family
        .filter(
          (record) =>
            record.beliefState !== "active" || record.contradictedBy.length > 0 || record.currentBeliefRefs.length > 0,
        )
        .map((record) => ({
          ref: record.ref,
          parentRef: record.parentRef,
          fromState: record.beliefState,
          toState: "active",
          reason: "belief-refresh" as const,
        })),
    };
  }

  const { components, componentIndexByRef } = stronglyConnectedComponents(
    family.map((record) => record.ref),
    edges,
  );
  const outgoingComponents = new Map<number, Set<number>>();
  for (let index = 0; index < components.length; index += 1) {
    outgoingComponents.set(index, new Set());
  }
  for (const [ref, targets] of edges.entries()) {
    const fromIndex = componentIndexByRef.get(ref);
    if (fromIndex === undefined) continue;
    for (const target of targets) {
      const toIndex = componentIndexByRef.get(target);
      if (toIndex === undefined || toIndex === fromIndex) continue;
      outgoingComponents.get(fromIndex)?.add(toIndex);
    }
  }

  const sinkComponents = new Set<number>();
  for (const [index, outgoing] of outgoingComponents.entries()) {
    if (outgoing.size === 0) sinkComponents.add(index);
  }

  const reachableSinkRefsMemo = new Map<number, string[]>();
  const reachableSinkRefsForComponent = (index: number): string[] => {
    const memoized = reachableSinkRefsMemo.get(index);
    if (memoized) return memoized;

    const outgoing = outgoingComponents.get(index);
    if (!outgoing || outgoing.size === 0) {
      const refs = [...components[index]].sort();
      reachableSinkRefsMemo.set(index, refs);
      return refs;
    }

    const refs = new Set<string>();
    for (const nextIndex of outgoing) {
      for (const ref of reachableSinkRefsForComponent(nextIndex)) refs.add(ref);
    }
    const resolved = [...refs].sort();
    reachableSinkRefsMemo.set(index, resolved);
    return resolved;
  };

  const contradictionCandidates: MemoryContradictionCandidate[] = [];
  const transitions: MemoryBeliefStateTransition[] = [];
  for (const record of family) {
    const componentIndex = componentIndexByRef.get(record.ref);
    if (componentIndex === undefined) continue;
    const isCurrentComponent = sinkComponents.has(componentIndex);
    const currentRefs = reachableSinkRefsForComponent(componentIndex);

    if (!isCurrentComponent) {
      contradictionCandidates.push({
        ref: record.ref,
        parentRef: record.parentRef,
        reason: "contradicted-derived",
        contradictedByRef: currentRefs[0],
        contradictedByRefs: currentRefs,
        currentBeliefRefs: currentRefs,
      });

      if (
        record.beliefState !== "contradicted" ||
        !sameStringArray(record.contradictedBy, currentRefs) ||
        !sameStringArray(record.currentBeliefRefs, currentRefs)
      ) {
        transitions.push({
          ref: record.ref,
          parentRef: record.parentRef,
          fromState: record.beliefState,
          toState: "contradicted",
          reason: "contradicted-derived",
          relatedRef: currentRefs[0],
          relatedRefs: currentRefs,
          currentBeliefRefs: currentRefs,
        });
      }
      continue;
    }

    const componentRefs = [...components[componentIndex]].sort();
    const peerCurrentRefs = componentRefs.filter((ref) => ref !== record.ref);
    if (
      record.beliefState !== "active" ||
      record.contradictedBy.length > 0 ||
      !sameStringArray(record.currentBeliefRefs, peerCurrentRefs)
    ) {
      transitions.push({
        ref: record.ref,
        parentRef: record.parentRef,
        fromState: record.beliefState,
        toState: "active",
        reason: "belief-refresh",
        ...(peerCurrentRefs[0] ? { relatedRef: peerCurrentRefs[0], relatedRefs: peerCurrentRefs } : {}),
        ...(peerCurrentRefs.length > 0 ? { currentBeliefRefs: peerCurrentRefs } : {}),
      });
    }
  }

  return {
    contradictionCandidates: contradictionCandidates.sort(compareContradictionCandidates),
    transitions: transitions.sort(compareBeliefTransitions),
  };
}

function stronglyConnectedComponents(
  refs: string[],
  edges: Map<string, string[]>,
): { components: string[][]; componentIndexByRef: Map<string, number> } {
  let index = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (ref: string) => {
    indices.set(ref, index);
    lowLinks.set(ref, index);
    index += 1;
    stack.push(ref);
    onStack.add(ref);

    for (const target of edges.get(ref) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(ref, Math.min(lowLinks.get(ref) ?? 0, lowLinks.get(target) ?? 0));
      } else if (onStack.has(target)) {
        lowLinks.set(ref, Math.min(lowLinks.get(ref) ?? 0, indices.get(target) ?? 0));
      }
    }

    if ((lowLinks.get(ref) ?? -1) !== (indices.get(ref) ?? -2)) return;

    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop() as string;
      onStack.delete(member);
      component.push(member);
      if (member === ref) break;
    }
    components.push(component.sort());
  };

  for (const ref of refs) {
    if (!indices.has(ref)) visit(ref);
  }

  const componentIndexByRef = new Map<string, number>();
  for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
    for (const ref of components[componentIndex]) {
      componentIndexByRef.set(ref, componentIndex);
    }
  }

  return { components, componentIndexByRef };
}

function archiveCleanupCandidate(
  stashDir: string,
  candidate: MemoryPruneCandidate,
  filePath: string,
): ArchivedMemoryCleanupRecord {
  const archivedAt = new Date().toISOString();
  const originalPath = path.relative(stashDir, filePath).replace(/\\/g, "/");
  const archiveDir = createArchiveDir(stashDir, candidate.ref, archivedAt);
  const archivedPath = path.join(archiveDir, originalPath);
  fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
  fs.renameSync(filePath, archivedPath);

  const archiveRef = path.relative(stashDir, archivedPath).replace(/\\/g, "/");
  const auditPath = path.join(archiveDir, "cleanup.md");
  const auditRef = path.relative(stashDir, auditPath).replace(/\\/g, "/");
  const auditFrontmatter = yamlStringify({
    schemaVersion: 1,
    kind: "memory-cleanup-archive",
    archivedAt,
    beliefState: "archived",
    previousBeliefState: priorBeliefStateForArchive(candidate),
    ref: candidate.ref,
    parentRef: candidate.parentRef,
    reason: candidate.reason,
    ...(candidate.survivorRef ? { survivorRef: candidate.survivorRef } : {}),
    originalPath,
    archivedPath: archiveRef,
  }).trimEnd();
  fs.writeFileSync(
    auditPath,
    `---\n${auditFrontmatter}\n---\n\nArchived derived memory for recoverable cleanup.\n`,
    "utf8",
  );

  return {
    ref: candidate.ref,
    parentRef: candidate.parentRef,
    reason: candidate.reason,
    beliefState: "archived",
    previousBeliefState: priorBeliefStateForArchive(candidate),
    ...(candidate.survivorRef ? { survivorRef: candidate.survivorRef } : {}),
    originalPath,
    archivedPath: archiveRef,
    auditPath: auditRef,
    archivedAt,
  };
}

function persistBeliefStateTransition(filePath: string, transition: MemoryBeliefStateTransition): void {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = parseFrontmatter(raw);
  const nextFrontmatter: Record<string, unknown> = {
    ...parsed.data,
    beliefState: transition.toState,
  };

  const currentBeliefRefs = [...new Set(transition.currentBeliefRefs ?? [])].sort();
  if (transition.toState === "contradicted") {
    nextFrontmatter.contradictedBy = [...currentBeliefRefs];
  } else {
    delete nextFrontmatter.contradictedBy;
    if (parsed.data.supersededBy !== undefined && refArray(parsed.data.supersededBy).length === 0) {
      delete nextFrontmatter.supersededBy;
    }
  }

  if (currentBeliefRefs.length > 0) nextFrontmatter.currentBeliefRefs = [...currentBeliefRefs];
  else delete nextFrontmatter.currentBeliefRefs;

  const frontmatter = yamlStringify(nextFrontmatter).trimEnd();
  const body = parsed.content.replace(/^\n+/, "");
  fs.writeFileSync(filePath, `---\n${frontmatter}\n---\n\n${body}`, "utf8");
}

function appendBeliefStateTransitionLog(stashDir: string, transitions: MemoryBeliefStateTransition[]): string {
  const logDir = path.join(stashDir, ".akm", "memory-cleanup");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "belief-transitions.jsonl");
  const appliedAt = new Date().toISOString();
  const lines = transitions
    .map((transition) =>
      JSON.stringify({
        appliedAt,
        ref: transition.ref,
        parentRef: transition.parentRef,
        fromState: transition.fromState,
        toState: transition.toState,
        reason: transition.reason,
        ...(transition.relatedRef ? { relatedRef: transition.relatedRef } : {}),
        ...(transition.relatedRefs ? { relatedRefs: transition.relatedRefs } : {}),
        ...(transition.currentBeliefRefs ? { currentBeliefRefs: transition.currentBeliefRefs } : {}),
      } satisfies MemoryBeliefTransitionLogRecord),
    )
    .join("\n");
  fs.appendFileSync(logPath, `${lines}\n`, "utf8");
  return logPath;
}

function priorBeliefStateForArchive(candidate: MemoryPruneCandidate): Exclude<MemoryBeliefState, "archived"> {
  if (candidate.reason === "superseded-derived") return "superseded";
  return "active";
}

function createArchiveDir(stashDir: string, ref: string, archivedAt: string): string {
  const baseName = `${archivedAt.replace(/[:.]/g, "-")}-${sanitizeRef(ref)}`;
  const root = path.join(stashDir, ".akm", "memory-cleanup", "archive");
  fs.mkdirSync(root, { recursive: true });
  let attempt = 0;
  while (true) {
    const candidate = path.join(root, attempt === 0 ? baseName : `${baseName}-${attempt}`);
    if (!fs.existsSync(candidate)) {
      fs.mkdirSync(candidate, { recursive: true });
      return candidate;
    }
    attempt += 1;
  }
}

function sanitizeRef(ref: string): string {
  return ref.replace(/[^a-z0-9._-]+/gi, "-");
}

function collectDerivedMemories(stashDir: string, parentRefFilter?: string): DerivedMemoryRecord[] {
  const memoriesDir = path.join(stashDir, "memories");
  if (!fs.existsSync(memoriesDir)) return [];

  const records: DerivedMemoryRecord[] = [];
  for (const filePath of walkMarkdownFiles(memoriesDir)) {
    const name = toMemoryName(memoriesDir, filePath);
    if (!name) continue;

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const parsed = parseFrontmatter(raw);
    const parentRef = resolveParentRef(name, parsed.data);
    if (!parentRef) continue;
    if (parentRefFilter && parentRef !== parentRefFilter) continue;
    if (!isDerivedMemory(name, parsed.data)) continue;

    const title = firstString(parsed.data.title) ?? extractHeading(parsed.content) ?? "";
    const description = firstString(parsed.data.description) ?? "";
    const tags = stringArray(parsed.data.tags);
    const searchHints = stringArray(parsed.data.searchHints);
    const body = parsed.content.trim();
    const signalKey = normalizeSignal(firstNonEmpty([title, description, searchHints[0]]));

    records.push({
      ref: makeAssetRef("memory", name),
      name,
      filePath,
      parentRef,
      title,
      description,
      tags,
      searchHints,
      body,
      canonicalName: name === `${parentRef.slice("memory:".length)}${DERIVED_SUFFIX}`,
      signalScore: computeSignalScore(title, description, tags, searchHints, body),
      fingerprint: buildFingerprint(title, description, tags, searchHints, body),
      ...(signalKey ? { signalKey } : {}),
      supersededBy: refArray(parsed.data.supersededBy),
      contradictedBy: refArray(parsed.data.contradictedBy),
      currentBeliefRefs: refArray(parsed.data.currentBeliefRefs),
      obsolete: parsed.data.obsolete === true || parsed.data.retracted === true,
      beliefState: resolveBeliefState(parsed.data),
    });
  }

  return records.sort(compareRecords);
}

function resolveBeliefState(frontmatter: Record<string, unknown>): Exclude<MemoryBeliefState, "archived"> {
  const explicit = firstString(frontmatter.beliefState);
  if (explicit === "active" || explicit === "superseded" || explicit === "contradicted") {
    return explicit;
  }
  return "active";
}

function isDerivedMemory(name: string, frontmatter: Record<string, unknown>): boolean {
  return frontmatter.inferred === true || name.endsWith(DERIVED_SUFFIX);
}

function resolveParentRef(name: string, frontmatter: Record<string, unknown>): string | undefined {
  const fromSource = parseMemoryRef(firstString(frontmatter.source));
  if (fromSource) return fromSource;

  const derivedFrom = firstString(frontmatter.derivedFrom);
  if (derivedFrom) return makeAssetRef("memory", derivedFrom);

  if (name.endsWith(DERIVED_SUFFIX)) {
    return makeAssetRef("memory", name.slice(0, -DERIVED_SUFFIX.length));
  }

  return undefined;
}

function refArray(value: unknown): string[] {
  if (typeof value === "string") {
    const parsed = parseMemoryRef(value);
    return parsed ? [parsed] : [];
  }
  if (!Array.isArray(value)) return [];
  const refs = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const parsed = parseMemoryRef(item);
    if (parsed) refs.add(parsed);
  }
  return [...refs].sort();
}

function parseMemoryRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = parseAssetRef(value.trim());
    if (parsed.type !== "memory") return undefined;
    return makeAssetRef(parsed.type, parsed.name);
  } catch {
    return undefined;
  }
}

function buildFingerprint(
  title: string,
  description: string,
  tags: string[],
  searchHints: string[],
  body: string,
): string {
  return JSON.stringify({
    title: normalizeSignal(title),
    description: normalizeSignal(description),
    tags: normalizeList(tags),
    searchHints: normalizeList(searchHints),
    body: normalizeBody(body),
  });
}

function normalizeBody(value: string): string {
  return value
    .replace(/^#+\s+/gm, "")
    .replace(/[`*_>#-]+/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSignal(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeList(values: string[]): string[] {
  return [
    ...new Set(values.map((value) => normalizeSignal(value)).filter((value): value is string => value !== undefined)),
  ].sort();
}

function computeSignalScore(
  title: string,
  description: string,
  tags: string[],
  searchHints: string[],
  body: string,
): number {
  return [title, description, body].join("\n").trim().length + tags.length * 25 + searchHints.length * 10;
}

function sortRecordsForSurvival(records: DerivedMemoryRecord[]): DerivedMemoryRecord[] {
  return [...records].sort((a, b) => {
    if (a.canonicalName !== b.canonicalName) return a.canonicalName ? -1 : 1;
    if (a.signalScore !== b.signalScore) return b.signalScore - a.signalScore;
    return compareRecords(a, b);
  });
}

function compareRecords(a: DerivedMemoryRecord, b: DerivedMemoryRecord): number {
  return a.ref.localeCompare(b.ref);
}

function compareCandidates(a: MemoryPruneCandidate, b: MemoryPruneCandidate): number {
  return a.ref.localeCompare(b.ref);
}

function compareContradictionCandidates(a: MemoryContradictionCandidate, b: MemoryContradictionCandidate): number {
  return a.ref.localeCompare(b.ref);
}

function compareBeliefTransitions(a: MemoryBeliefStateTransition, b: MemoryBeliefStateTransition): number {
  return a.ref.localeCompare(b.ref);
}

function compareConsolidationCandidates(a: MemoryConsolidationCandidate, b: MemoryConsolidationCandidate): number {
  return a.parentRef.localeCompare(b.parentRef) || a.signal.localeCompare(b.signal);
}

function firstExistingRef(
  refs: string[],
  byRef: Map<string, DerivedMemoryRecord>,
  selfRef: string,
): string | undefined {
  for (const ref of refs) {
    if (ref === selfRef) continue;
    if (byRef.has(ref)) return ref;
  }
  return undefined;
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim().length > 0) out.push(item.trim());
  }
  return out;
}

function extractHeading(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^#\s+(.+)$/);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value && value.trim().length > 0) return value;
  }
  return undefined;
}

function groupBy<T>(values: T[], keyFn: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFn(value);
    const existing = groups.get(key);
    if (existing) existing.push(value);
    else groups.set(key, [value]);
  }
  return groups;
}

function* walkMarkdownFiles(root: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdownFiles(full);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      yield full;
    }
  }
}

function toMemoryName(memoriesDir: string, filePath: string): string | undefined {
  const rel = path.relative(memoriesDir, filePath);
  if (!rel || rel.startsWith("..")) return undefined;
  return rel.replace(/\\/g, "/").replace(/\.md$/i, "");
}
