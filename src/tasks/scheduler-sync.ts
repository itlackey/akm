// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Pure whole-set scheduler reconciliation planning. */

import { createHash } from "node:crypto";
import path from "node:path";
import { loadAdapterExecutionSource } from "../commands/command/execution-source-loader";
import { makeBundleRef } from "../core/asset/asset-ref";
import { compareCodePoints, toPosix } from "../core/common";
import type { AkmConfig } from "../core/config/config-types";
import { UsageError } from "../core/errors";
import { canonicalizeWorkflowName, WORKFLOW_EXTENSIONS } from "../core/recognition-util";
import {
  captureGuardedDirectoryManifest,
  captureGuardedExecutionSource,
  type GuardedDirectoryManifest,
  type GuardedExecutionSource,
  GuardedExecutionSourceCollector,
} from "../execution/guarded-source";
import { applyInputDefaults, validateInputs } from "../execution/input-contract";
import type { FileContext } from "../indexer/walk/file-context";
import { compileWorkflowPlan } from "../workflows/ir/compile";
import { compileResolveFreezeWorkflowV4 } from "../workflows/ir/freeze-v4";
import { canonicalJson, computePlanHash } from "../workflows/ir/plan-hash";
import type { DurableWorkflowSourceSnapshot } from "../workflows/ir/schema-v4";
import type { WorkflowAsset } from "../workflows/runtime/workflow-asset-loader";
import {
  WorkflowSourceCollisionError,
  WorkflowSourceNameError,
  WorkflowSourceRejectionError,
  workflowNameForSourcePath,
} from "../workflows/source-files";
import { compileWorkflowSource } from "../workflows/source-ir/compile";
import { prepareTaskV3Execution } from "./prepare/prepare";
import type { PrepareTaskV3ExecutionContext } from "./prepare/prepared-execution";
import { parseSchedule, type ScheduleBackend } from "./schedule";
import {
  assertSchedulerNativeArtifactCardinality,
  compileTaskSchedulerBindings,
  compileWorkflowSchedulerBindings,
  type InstalledSchedulerBinding,
  type SchedulerBackendInspection,
  type SchedulerBinding,
  type SchedulerInstallOptions,
  type SchedulerMutationExpectation,
  type SchedulerNativeArtifact,
  type SchedulerRemovalExpectation,
  schedulerBindingNativeId,
  schedulerBindingOrdinal,
  schedulerNativeArtifactKey,
  schedulerNativeArtifactOwner,
  schedulerNativeBindingId,
} from "./scheduler-binding";
import { type ParsedTaskSource, parseTaskSource } from "./source/parse-task-source";
import { projectTaskSourceV4 } from "./source/project-v4";
import { taskSourceErrorDetail } from "./source-v3";

export interface SchedulerSyncPlanInput {
  readonly sourceRoot: string;
  readonly adapterId: string;
  readonly bundleName: string;
  /** CLI selector embedded only in task invocations for a non-primary bundle. */
  readonly bundleTarget?: string;
  /**
   * Resolved filesystem path of the invoking bundle (#846). When present,
   * `belongsToBundle` scopes strictly by this path instead of the legacy
   * name-based comparison — a display name derived from a directory
   * basename is not an identity two bundles can't collide on, but a
   * resolved path is.
   */
  readonly bundlePath?: string;
  readonly backend: ScheduleBackend;
  readonly installed: readonly InstalledSchedulerBinding[];
  /** Complete read-only backend inventory, including malformed artifacts. */
  readonly nativeArtifacts?: readonly SchedulerNativeArtifact[];
  /** One coherent backend read. Production mutation paths always provide this. */
  readonly inspection?: SchedulerBackendInspection;
  /** Frozen config used only while projecting command targets. */
  readonly config?: AkmConfig;
  /** Bundle-aware local asset resolver used while freezing workflow/script targets. */
  readonly resolveAsset?: PrepareTaskV3ExecutionContext["resolveAsset"];
  /** Exact host-local activation allow-list, keyed by kind and canonical ref. */
  readonly enabledActivations?: ReadonlySet<string>;
  readonly installOptions?: SchedulerInstallOptions;
  readonly rebind?: boolean;
  readonly expectedSignature?: (binding: SchedulerBinding, options?: SchedulerInstallOptions) => string;
}

export type SchedulerSyncOperation =
  | Readonly<{
      kind: "install" | "update";
      binding: SchedulerBinding;
      expected: SchedulerMutationExpectation;
      /** Exact native fingerprint this operation is expected to produce. */
      resultFingerprint?: string;
      options?: SchedulerInstallOptions;
    }>
  | Readonly<{
      kind: "remove";
      id: string;
      nativeId: string;
      expected: SchedulerRemovalExpectation;
      /** Resolved bundle path this installed binding was attributed to (#846), when known. */
      ownerBundlePath?: string;
      /**
       * Why `akm task prune` (#851) selected this entry for removal — never
       * set by `finalizeSchedulerSyncPlan`'s own removal path, which removes
       * only attributable orphans (a backing file that's gone) and has no
       * notion of "unresolvable ownership" to report.
       */
      reason?: "invalid-context" | "dead-bundle-path";
    }>;

export interface SchedulerSyncPlan {
  readonly desired: readonly SchedulerBinding[];
  readonly installed: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
  readonly unchanged: readonly string[];
  readonly operations: readonly SchedulerSyncOperation[];
  readonly sourceSnapshot: SchedulerSourceSnapshot;
  /** Sources that failed to parse/prepare (#867) — excluded from `desired`, never silently dropped. */
  readonly failures: readonly SchedulerSourceFailure[];
  /**
   * Refs granted from an installed native scheduler binding that had no
   * grant yet (carry-forward) — present only when non-empty.
   * A real sync already applied these; `--dry-run` reports them here
   * without applying.
   */
  readonly carriedForward?: readonly string[];
}

/** One task/workflow source that could not be parsed/prepared into a scheduler binding. */
export interface SchedulerSourceFailure {
  readonly path: string;
  readonly ref?: string;
  readonly reason: string;
}

export interface SchedulerSourceSnapshot {
  readonly adapterId: string;
  readonly sourceRoot: string;
  readonly sourceRealPath: string;
  readonly sourcePhysicalIdentity: string;
  readonly sourceDirectoryVersion: string;
  readonly files: readonly GuardedExecutionSource[];
  readonly directoryManifests: readonly GuardedDirectoryManifest[];
}

export interface PreparedSchedulerSourceSet {
  readonly desired: readonly SchedulerBinding[];
  readonly sourceSnapshot: SchedulerSourceSnapshot;
  /** Validation/reconciliation evidence only; scheduled fire always freezes a fresh guarded v4 plan. */
  readonly executableWorkflows: readonly SchedulerExecutableWorkflowEvidence[];
  /** Sources that failed to parse/prepare (#867) — excluded from `desired`, never silently dropped. */
  readonly failures: readonly SchedulerSourceFailure[];
}

export interface SchedulerExecutableWorkflowEvidence {
  readonly ref: string;
  readonly irVersion: 5;
  readonly planHash: string;
  readonly sourceReadSet: import("../workflows/ir/schema-v4").WorkflowPlanGraphV4["sourceReadSet"];
  readonly executionEvidenceDigest: string;
}

export function computeSchedulerExecutionEvidenceDigest(
  planHash: string,
  sourceReadSet: readonly DurableWorkflowSourceSnapshot[],
): string {
  const envelope = canonicalJson({
    version: 1,
    planHash,
    sourceReadSet: sourceReadSet.map((snapshot) => ({
      identity: snapshot.identity,
      containmentPhysicalIdentity: snapshot.containmentPhysicalIdentity,
      physicalIdentity: snapshot.physicalIdentity,
      size: snapshot.size,
    })),
  });
  return createHash("sha256").update("akm.scheduler.workflow-evidence\0v1\0").update(envelope).digest("hex");
}

const SCHEDULER_PROJECTION_CONFIG: AkmConfig = Object.freeze({
  configVersion: "0.9.0",
  semanticSearchMode: "off",
});

export async function prepareSchedulerSyncSourceSet(
  input: SchedulerSyncPlanInput,
): Promise<PreparedSchedulerSourceSet> {
  const collector = new SchedulerSourceCollector(input);
  const compiled = await compileDesiredSourceSet(input, collector);
  const sourceSnapshot = collector.snapshot();
  assertSchedulerSourceSnapshot(sourceSnapshot);
  return Object.freeze({
    desired: compiled.desired,
    sourceSnapshot,
    executableWorkflows: compiled.executableWorkflows,
    failures: compiled.failures,
  });
}

function schedulerActivationKey(kind: SchedulerBinding["logicalSource"]["kind"], ref: string): string {
  return `${kind}\0${ref}`;
}

export function finalizeSchedulerSyncPlan(
  input: SchedulerSyncPlanInput,
  prepared: PreparedSchedulerSourceSet,
): SchedulerSyncPlan {
  const inspection = inspectionForPlan(input);
  const coherentInput: SchedulerSyncPlanInput = {
    ...input,
    installed: inspection.installed,
    nativeArtifacts: inspection.artifacts,
  };
  // Preconditions for this bundle's plan: a duplicate id WITHIN the authored
  // desired set, or an incoherent/ambiguous backend read, can't be safely
  // attributed to one binding — which of two colliding sources is "the
  // anomaly" is exactly what's unproven, so reconciling everything else
  // around a guess would risk silently overwriting or orphaning a native
  // scheduler entry. They hard-fail this bundle's plan: the whole sync when
  // it is scoped to one bundle, one reported bundle failure when it is not
  // (the backend-wide coherence check runs once before the per-bundle loop
  // and hard-fails the whole sync either way).
  assertUniqueDesiredIds(prepared.desired);
  assertSchedulerBackendInspection(inspection, prepared.desired, input.inspection !== undefined);

  // A desired binding whose id collides with a DIFFERENT bundle's real
  // installed entry is a per-item anomaly — unlike the assertions above,
  // exactly one side of the collision is ours, so that one binding is
  // excluded (never installed/updated) and reported in `failures` instead
  // of aborting every other binding in this same bundle's sync.
  const reconcileFailures: SchedulerSourceFailure[] = [];
  const foreignCollisions = foreignIdCollisions(prepared.desired, coherentInput);
  const desired =
    foreignCollisions.size === 0
      ? prepared.desired
      : prepared.desired.filter((binding) => !foreignCollisions.has(binding.id));
  for (const [id, foreign] of foreignCollisions) {
    const binding = prepared.desired.find((candidate) => candidate.id === id);
    if (binding) reconcileFailures.push(foreignIdFailure(binding, foreign, coherentInput));
  }

  const scopedInstalled = coherentInput.installed.filter((entry) => belongsToBundle(entry, coherentInput));
  const present = new Map(scopedInstalled.map((entry) => [entry.id, entry] as const));
  const installed: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const operations: SchedulerSyncOperation[] = [];

  for (const binding of desired) {
    const current = present.get(binding.id);
    const options = installOptionsFor(coherentInput, current);
    const resultFingerprint = coherentInput.expectedSignature?.(binding, options);
    if (!current) {
      installed.push(binding.id);
      operations.push(
        freezeOperation({
          kind: "install",
          binding,
          expected: freezeMutationExpectation(expectationForBinding(binding, "absent")),
          ...(resultFingerprint !== undefined ? { resultFingerprint } : {}),
          ...(options ? { options } : {}),
        }),
      );
      continue;
    }
    if (current.signature !== undefined && resultFingerprint !== undefined && current.signature === resultFingerprint) {
      unchanged.push(binding.id);
      continue;
    }
    const artifact = exactInstalledArtifact(binding.id, current, inspection.artifacts);
    const priorFingerprint = artifact?.fingerprint ?? current.signature;
    if (artifact === undefined || priorFingerprint === undefined) {
      // Can't prove what's currently installed, so this ONE binding is
      // left exactly as installed (no update applied) and reported — every
      // other binding still reconciles normally.
      reconcileFailures.push(
        Object.freeze({
          path: binding.source,
          ref: binding.logicalSource.ref,
          reason: `Installed scheduler binding ${JSON.stringify(binding.id)} has no exact native fingerprint; leaving it unchanged rather than applying an unverifiable update.`,
        }),
      );
      continue;
    }
    updated.push(binding.id);
    operations.push(
      freezeOperation({
        kind: "update",
        binding,
        expected: freezeMutationExpectation(expectationForBinding(binding, "present", priorFingerprint)),
        ...(resultFingerprint !== undefined ? { resultFingerprint } : {}),
        ...(options ? { options } : {}),
      }),
    );
  }

  const desiredIds = new Set(desired.map(({ id }) => id));
  const removalCandidates = scopedInstalled
    .map(({ id }) => id)
    .filter((id) => !desiredIds.has(id))
    .sort(compareCodePoints);
  const removed: string[] = [];
  for (const id of removalCandidates) {
    const current = present.get(id);
    // `buildSchedulerRemoveOperation` keeps throwing on its own
    // — `akm task prune` (#851) still depends on that contract for entries
    // it has independently confirmed are safe to remove — but sync's own
    // removal loop is per-item here: one installed row this process can't
    // safely attribute (no exact fingerprint, no resolvable ordinal, no
    // recognizable invocation shape) is left installed and reported,
    // rather than refusing to remove every OTHER orphaned entry too.
    try {
      operations.push(buildSchedulerRemoveOperation(id, current, inspection.artifacts, coherentInput));
      removed.push(id);
    } catch (cause) {
      reconcileFailures.push(installedRowFailure(id, current, coherentInput, cause));
    }
  }

  return Object.freeze({
    desired,
    installed: Object.freeze(installed),
    updated: Object.freeze(updated),
    removed: Object.freeze(removed),
    unchanged: Object.freeze(unchanged),
    operations: Object.freeze(operations),
    sourceSnapshot: prepared.sourceSnapshot,
    failures: Object.freeze([...prepared.failures, ...reconcileFailures]),
  });
}

/** Validate one coherent whole-backend read before deriving any mutation plan. */
export function assertSchedulerBackendInspection(
  inspection: SchedulerBackendInspection,
  desired: readonly SchedulerBinding[] = [],
  requireCompleteFingerprint = true,
): void {
  assertCoherentInspection(inspection, requireCompleteFingerprint);
  assertUniqueInstalledIds(inspection.installed);
  assertSchedulerNativeArtifactOwnership(desired, inspection.artifacts);
}

/**
 * Build the exact removal operation for one installed binding: same
 * exact-native-fingerprint / ordinal-attribution safety checks
 * `finalizeSchedulerSyncPlan`'s remove loop always applied, factored out so
 * `akm task prune` (#851) can build removal operations for entries
 * `belongsToBundle` structurally can't see (unresolvable ownership) without
 * re-deriving — or weakening — this logic. Throws the same `UsageError`s a
 * sync removal would on an inexact match; callers computing prune candidates
 * should only pass entries they've already independently confirmed are safe
 * to remove.
 */
export function buildSchedulerRemoveOperation(
  id: string,
  current: InstalledSchedulerBinding | undefined,
  artifacts: readonly SchedulerNativeArtifact[],
  input: Pick<SchedulerSyncPlanInput, "adapterId" | "bundleName">,
): Extract<SchedulerSyncOperation, { kind: "remove" }> {
  if (!current?.invocation) {
    throw nativeArtifactCollision(
      { nativeId: current?.nativeId ?? schedulerNativeBindingId(id), bindingId: id },
      { nativeId: current?.nativeId ?? schedulerNativeBindingId(id) },
    );
  }
  const nativeId = exactInstalledNativeId(id, current, artifacts);
  const artifact = artifacts.find((candidate) => candidate.nativeId === nativeId && candidate.bindingId === id);
  const priorFingerprint = current.signature ?? artifact?.fingerprint;
  if (!artifact || priorFingerprint === undefined) {
    throw new UsageError(
      `Installed scheduler binding ${JSON.stringify(id)} has no exact native fingerprint; refusing removal.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }
  const logicalSource = installedLogicalSource(current.invocation, input);
  const ordinal = schedulerBindingOrdinal(id, logicalSource, current.invocation);
  if (ordinal === undefined) {
    throw new UsageError(
      `Installed scheduler binding ${JSON.stringify(id)} cannot be attributed to an exact schedule ordinal; refusing removal.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }
  return Object.freeze({
    kind: "remove" as const,
    id,
    nativeId,
    expected: freezeRemovalExpectation({
      state: "present",
      bindingId: id,
      nativeId,
      logicalSource,
      ordinal,
      invocation: current.invocation,
      fingerprint: priorFingerprint,
    }),
    ...(current.ownerBundlePath !== undefined ? { ownerBundlePath: current.ownerBundlePath } : {}),
  });
}

function exactInstalledNativeId(
  logicalId: string,
  current: InstalledSchedulerBinding | undefined,
  artifacts: readonly SchedulerNativeArtifact[],
): string {
  const exact = artifacts.find((artifact) => artifact.bindingId === logicalId);
  return exact?.nativeId ?? current?.nativeId ?? schedulerNativeBindingId(logicalId);
}

function exactInstalledArtifact(
  bindingId: string,
  current: InstalledSchedulerBinding,
  artifacts: readonly SchedulerNativeArtifact[],
): SchedulerNativeArtifact | undefined {
  const nativeId = current.nativeId ?? schedulerNativeBindingId(bindingId);
  return artifacts.find(
    (artifact) =>
      artifact.nativeId === nativeId && (artifact.bindingId === bindingId || artifact.bindingId === undefined),
  );
}

function nativeArtifactsForPlan(input: SchedulerSyncPlanInput): readonly SchedulerNativeArtifact[] {
  return (
    input.nativeArtifacts ??
    input.installed.map((entry) => ({
      nativeId: entry.nativeId ?? schedulerNativeBindingId(entry.id),
      bindingId: entry.id,
      ...(entry.invocation ? { invocation: Object.freeze([...entry.invocation]) } : {}),
      ...(entry.signature !== undefined ? { fingerprint: entry.signature } : {}),
    }))
  );
}

function inspectionForPlan(input: SchedulerSyncPlanInput): SchedulerBackendInspection {
  return input.inspection ?? Object.freeze({ installed: input.installed, artifacts: nativeArtifactsForPlan(input) });
}

export function assertSchedulerNativeArtifactOwnership(
  desired: readonly SchedulerBinding[],
  installed: readonly SchedulerNativeArtifact[],
): void {
  const desiredByKey = new Map<string, SchedulerBinding>();
  for (const binding of desired) {
    const nativeId = schedulerBindingNativeId(binding);
    const key = schedulerNativeArtifactKey(nativeId);
    const prior = desiredByKey.get(key);
    if (prior && !sameDesiredArtifact(prior, binding)) {
      throw nativeArtifactCollision(desiredArtifact(prior), desiredArtifact(binding));
    }
    desiredByKey.set(key, binding);
  }

  const installedByKey = new Map<string, SchedulerNativeArtifact>();
  for (const artifact of installed) {
    const key = schedulerNativeArtifactKey(artifact.nativeId);
    const prior = installedByKey.get(key);
    if (prior) {
      throw nativeArtifactCollision(prior, artifact);
    }
    installedByKey.set(key, artifact);
    const wanted = desiredByKey.get(key);
    if (!wanted) continue;
    // Re-derive ownership from the artifact's own invocation content (not the
    // caller-supplied `bindingId` label) so a proven owner whose invocation
    // no longer matches the desired shape is an UPDATE, not a refusal — that
    // reconciliation happens below in finalizeSchedulerSyncPlan. An artifact
    // whose invocation content does not actually prove it belongs to
    // `wanted` (unproven, malformed, or a different logical owner) is still
    // a genuine collision.
    const provenBindingId =
      artifact.invocation !== undefined
        ? schedulerNativeArtifactOwner(artifact.nativeId, artifact.invocation)?.logicalId
        : undefined;
    if (artifact.nativeId !== schedulerBindingNativeId(wanted) || provenBindingId !== wanted.id) {
      throw nativeArtifactCollision(desiredArtifact(wanted), artifact);
    }
  }
}

function assertCoherentInspection(inspection: SchedulerBackendInspection, requireCompleteFingerprint = false): void {
  const seenNativeKeys = new Set<string>();
  for (const artifact of inspection.artifacts) {
    const key = schedulerNativeArtifactKey(artifact.nativeId);
    if (seenNativeKeys.has(key)) {
      throw new UsageError(
        `Scheduler inspection has duplicate normalized native artifact ${JSON.stringify(artifact.nativeId)}; expected cardinality one. ` +
          "Remove the duplicate native entry by hand, or run `akm task prune` to reconcile orphaned entries, then retry.",
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    seenNativeKeys.add(key);
  }
  for (const installed of inspection.installed) {
    const nativeId = installed.nativeId ?? schedulerNativeBindingId(installed.id);
    const artifact = assertSchedulerNativeArtifactCardinality(inspection.artifacts, nativeId, 1);
    if (
      !artifact ||
      (installed.signature !== undefined &&
        (artifact.fingerprint !== undefined
          ? installed.signature !== artifact.fingerprint
          : requireCompleteFingerprint)) ||
      (artifact.bindingId !== undefined && artifact.bindingId !== installed.id)
    ) {
      throw new UsageError(
        `Scheduler inspection is not coherent for ${JSON.stringify(nativeId)}: installed and native fingerprints differ. ` +
          "Re-run `akm task sync` (the native scheduler changed mid-read), or inspect the entry by hand if it recurs.",
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    if (
      installed.invocation !== undefined &&
      (artifact.invocation === undefined || !sameInvocation(installed.invocation, artifact.invocation))
    ) {
      throw new UsageError(
        `Scheduler inspection is not coherent for ${JSON.stringify(nativeId)}: installed and native owners differ. ` +
          "Re-run `akm task sync` (the native scheduler changed mid-read), or inspect the entry by hand if it recurs.",
        "RESOURCE_ALREADY_EXISTS",
      );
    }
  }
}

function nativeArtifactCollision(
  left: { nativeId: string; bindingId?: string; invocation?: readonly string[] },
  right: { nativeId: string; bindingId?: string; invocation?: readonly string[] },
): UsageError {
  const owner = (value: { nativeId: string; bindingId?: string; invocation?: readonly string[] }) =>
    value.bindingId === undefined || value.invocation === undefined
      ? `${JSON.stringify(value.nativeId)} (unproven owner)`
      : `binding ${JSON.stringify(value.bindingId)} invoking ${JSON.stringify(value.invocation)}`;
  return new UsageError(
    `Native scheduler artifact collision between ${owner(left)} and ${owner(right)}; refusing to overwrite an existing or ambiguous native owner. ` +
      "Rename one of the colliding tasks or workflows, or run `akm task prune` to remove the stale native entry first.",
    "RESOURCE_ALREADY_EXISTS",
  );
}

function desiredArtifact(binding: SchedulerBinding): SchedulerNativeArtifact {
  return {
    nativeId: schedulerBindingNativeId(binding),
    bindingId: binding.id,
    invocation: binding.invocation,
  };
}

function sameDesiredArtifact(left: SchedulerBinding, right: SchedulerBinding): boolean {
  return (
    schedulerBindingNativeId(left) === schedulerBindingNativeId(right) &&
    left.id === right.id &&
    left.logicalSource.kind === right.logicalSource.kind &&
    left.logicalSource.ref === right.logicalSource.ref &&
    left.ordinal === right.ordinal &&
    left.executionEvidenceDigest === right.executionEvidenceDigest &&
    sameInvocation(left.invocation, right.invocation)
  );
}

async function compileDesiredSourceSet(
  input: SchedulerSyncPlanInput,
  collector: SchedulerSourceCollector,
): Promise<{
  readonly desired: readonly SchedulerBinding[];
  readonly executableWorkflows: readonly SchedulerExecutableWorkflowEvidence[];
  readonly failures: readonly SchedulerSourceFailure[];
}> {
  const bindings: SchedulerBinding[] = [];
  const executableWorkflows: SchedulerExecutableWorkflowEvidence[] = [];
  const failures: SchedulerSourceFailure[] = [];
  await compileTaskSources(input, collector, bindings, failures);
  await compileWorkflowSources(input, collector, bindings, executableWorkflows, failures);
  // Degrade, don't reject (#867): one source that fails to parse/prepare no
  // longer poisons the whole desired set — it is dropped from `desired` and
  // reported here instead, so every OTHER task/workflow still reconciles.
  // Genuinely cross-cutting integrity violations (duplicate ids, native
  // artifact ownership conflicts, an incoherent backend inspection) are
  // asserted separately in `finalizeSchedulerSyncPlan` and still hard-fail
  // the whole sync — this only relaxes the per-source parse/prepare gate.
  return Object.freeze({
    desired: Object.freeze(bindings),
    executableWorkflows: Object.freeze(
      executableWorkflows.sort((left, right) => compareCodePoints(left.ref, right.ref)),
    ),
    failures: Object.freeze(failures.sort((left, right) => compareCodePoints(left.path, right.path))),
  });
}

async function compileTaskSources(
  input: SchedulerSyncPlanInput,
  collector: SchedulerSourceCollector,
  out: SchedulerBinding[],
  failures: SchedulerSourceFailure[],
): Promise<void> {
  if (input.adapterId !== "akm" && input.adapterId !== "akm-task") return;
  for (const symlink of collector.symlinkSources()) {
    if (!isAuthoredTaskRelativePath(input.adapterId, symlink.relativePath)) continue;
    const qualifiedRef = makeBundleRef(input.bundleName, symlink.relativePath.slice(0, -4));
    if (input.enabledActivations && !input.enabledActivations.has(schedulerActivationKey("task", qualifiedRef))) {
      continue;
    }
    failures.push(taskFailure(symlink.sourcePath, qualifiedRef, symbolicSourceError(symlink.sourcePath)));
  }
  const physicalOwners = new Map<string, string>();
  for (const guarded of collector.authoredTaskSources(input.adapterId)) {
    const sourcePath = guarded.sourcePath;
    const relative = guarded.relativePath;
    const conceptId = relative.slice(0, -4);
    const id = input.adapterId === "akm-task" ? conceptId : path.basename(sourcePath, ".yml");
    const qualifiedRefForFailure = makeBundleRef(input.bundleName, conceptId);
    if (
      input.enabledActivations &&
      !input.enabledActivations.has(schedulerActivationKey("task", qualifiedRefForFailure))
    ) {
      continue;
    }
    try {
      const physicalIdentity = guarded.physicalIdentity;
      const priorOwner = physicalOwners.get(physicalIdentity);
      if (priorOwner !== undefined && priorOwner !== sourcePath) {
        throw new UsageError(
          `Task sources ${JSON.stringify(priorOwner)} and ${JSON.stringify(sourcePath)} resolve to the same physical source identity; refusing canonical task identity collision.`,
          "RESOURCE_ALREADY_EXISTS",
        );
      }
      physicalOwners.set(physicalIdentity, sourcePath);
      // Project BEFORE prepareTaskV3Execution so projectability is checked —
      // but build the scheduler bindings from the ORIGINAL task source v4
      // document, not the projection, which deliberately drops
      // `schedule[i].inputs` (project-v4.ts) —
      // schedule-supplied inputs are delivered through the scheduler
      // binding's own compiled invocation tail (P2b Lane B, spec §4.4,
      // B-N3), not through the prepare-seam projection. A task source v4
      const parsed = parseTaskSource({
        yaml: guarded.content,
        filePath: sourcePath,
        workspaceRoot: input.sourceRoot,
      });
      const document = projectTaskSourceV4(parsed.v4);
      const qualifiedRef = makeBundleRef(input.bundleName, conceptId);
      // See assertTaskScheduleInputsSatisfyContract's own docblock (below in
      // this file) for why this second, defaults-applied gate exists.
      assertTaskScheduleInputsSatisfyContract(parsed.v4, qualifiedRef);
      await prepareTaskV3Execution(document, {
        taskId: id,
        taskRef: qualifiedRef,
        bundleName: input.bundleName,
        bundleRoot: input.sourceRoot,
        config: input.config ?? SCHEDULER_PROJECTION_CONFIG,
        ...(input.resolveAsset ? { resolveAsset: input.resolveAsset } : {}),
        readFile: (file, bundleRoot) => collector.readBytes(file, bundleRoot ?? input.sourceRoot),
        commandSourceLoader: (ref, kind, options) => {
          const guardedOptions = {
            ...options,
            fileContext: (root: string, file: string) => collector.fileContext(root, file),
          };
          return kind === "command"
            ? loadAdapterExecutionSource(ref, "command", guardedOptions)
            : loadAdapterExecutionSource(ref, "persona", guardedOptions);
        },
      });
      const relSource = toPosix(path.relative(input.sourceRoot, sourcePath));
      const sourceBindings = compileTaskSchedulerBindings({
        id,
        qualifiedRef,
        ...(input.bundleTarget ? { bundleTarget: input.bundleTarget } : {}),
        schedules: parsed.v4.schedule.map((schedule) => ({
          cron: schedule.cron,
          ordinal: schedule.ordinal,
          source: `${relSource}:${schedule.source}`,
          // P2b Lane B (spec §4.4, B-N3): delivered through the compiled
          // binding's own invocation tail below — the F-B2 flip that closes
          // the P2a B-38 "validated but not yet delivered" gap this comment
          // used to describe.
          inputs: schedule.inputs,
        })),
      });
      assertTaskScheduleCronValid(parsed.v4, input.backend);
      out.push(...sourceBindings);
    } catch (cause) {
      failures.push(taskFailure(sourcePath, qualifiedRefForFailure, cause));
    }
  }
}

/**
 * P2b Lane B (spec §4.4, rows B-50/F-B2): validate every v4 `schedule:`
 * entry's `inputs` against the task's OWN declared contract WITH DEFAULTS
 * APPLIED — the same `applyInputDefaults` + `validateInputs` pair
 * `akm task run` uses (`src/tasks/run/load-task.ts`). `parseTaskSource`'s
 * own parse-time check (`task-source-v4.ts`'s `parseScheduleEntry`) already
 * rejects an unknown/malformed entry against the RAW supplied values; this
 * is a deliberate second, independent gate over the DEFAULTED view — the
 * exact set of values a compiled invocation actually delivers — so a
 * violation fails HERE, recorded as a task failure at sync, rather than
 * surfacing for the first time when the scheduler fires the invocation.
 *
 * Extracted so `akm task validate` can run the IDENTICAL gate
 * over a bare file path without a second, potentially-diverging copy of
 * this check. `refLabel` is only the text embedded in the thrown message —
 * `compileTaskSources` passes its bundle-qualified ref; `akm task validate`,
 * which never resolves a bundle for a bare file, passes the file path.
 */
export function assertTaskScheduleInputsSatisfyContract(
  v4: Pick<ParsedTaskSource["v4"], "inputs" | "schedule">,
  refLabel: string,
): void {
  const contract = v4.inputs ?? {};
  for (const scheduleEntry of v4.schedule) {
    const defaultedInputs = applyInputDefaults(contract, { ...scheduleEntry.inputs });
    const errors = validateInputs(contract, defaultedInputs);
    if (errors.length > 0) {
      throw new UsageError(
        `Task ${JSON.stringify(refLabel)} schedule[${scheduleEntry.ordinal}].inputs does not satisfy ` +
          `its declared inputs once defaults are applied: ${errors.join("; ")}`,
        "TASK_SOURCE_INVALID",
      );
    }
  }
}

/**
 * Validate every v4 `schedule:` entry's `cron` against the active scheduler
 * backend's dialect (`parseSchedule`, `./schedule.ts`) — cron is the most
 * permissive of the three backends, so a task authored on Linux can carry a
 * cron expression launchd/schtasks cannot translate; `compileTaskSources`
 * re-checks against the LOCAL backend on every sync rather than trusting
 * whatever backend the file was authored against.
 *
 * Extracted alongside {@link assertTaskScheduleInputsSatisfyContract}
 * so `akm task validate` shares this exact gate instead of a second copy
 * that could silently drift from what `akm task sync` actually enforces.
 */
export function assertTaskScheduleCronValid(
  v4: Pick<ParsedTaskSource["v4"], "schedule">,
  backend: ScheduleBackend,
): void {
  for (const scheduleEntry of v4.schedule) {
    parseSchedule(scheduleEntry.cron, backend);
  }
}

async function compileWorkflowSources(
  input: SchedulerSyncPlanInput,
  collector: SchedulerSourceCollector,
  out: SchedulerBinding[],
  evidence: SchedulerExecutableWorkflowEvidence[],
  failures: SchedulerSourceFailure[],
): Promise<void> {
  if (input.adapterId !== "akm" && input.adapterId !== "akm-workflow") return;
  const lookups = enumerateWorkflowLookups(input, collector, failures);
  for (const [canonicalName, sources] of lookups) {
    const failurePath = sources[0]?.sourcePath ?? canonicalName;
    const failureRef = makeBundleRef(
      input.bundleName,
      input.adapterId === "akm" ? `workflows/${canonicalName}` : canonicalName,
    );
    if (input.enabledActivations && !input.enabledActivations.has(schedulerActivationKey("workflow", failureRef))) {
      continue;
    }
    try {
      if (sources.length > 1) {
        throw new WorkflowSourceCollisionError(
          input.adapterId === "akm" ? `workflows/${canonicalName}` : canonicalName,
          sources.map((source) => source.relativePath),
        );
      }
      const guarded = sources[0];
      if (!guarded) continue;
      const compiled = compileWorkflowSource(guarded.content, {
        path: guarded.relativePath,
        workspaceRoot: input.sourceRoot,
      });
      if (!compiled.ok) {
        throw new UsageError(
          compiled.errors
            .map((error) => `${error.path}:${error.line ?? 1} [${error.code}] ${error.message}`)
            .join("; "),
          "WORKFLOW_SOURCE_INVALID",
        );
      }
      const planDraft = compileWorkflowPlan(compiled.ir, canonicalName);
      if (!planDraft.ok) {
        throw new UsageError(
          planDraft.errors.map((error) => `${guarded.relativePath}:${error.line} ${error.message}`).join("; "),
          "WORKFLOW_SOURCE_INVALID",
        );
      }
      const conceptId = input.adapterId === "akm" ? `workflows/${canonicalName}` : canonicalName;
      const qualifiedRef = makeBundleRef(input.bundleName, conceptId);
      const asset: WorkflowAsset = {
        ref: qualifiedRef,
        path: guarded.sourcePath,
        sourcePath: input.sourceRoot,
        adapterId: input.adapterId,
        title: canonicalName,
        steps: [],
        sourceIr: compiled.ir,
      };
      const frozen = await compileResolveFreezeWorkflowV4(asset, input.config ?? schedulerProjectionConfig(input), {
        sourceCollector: collector.executionCollector(),
      });
      const planHash = computePlanHash(frozen.plan);
      const executionEvidenceDigest = computeSchedulerExecutionEvidenceDigest(planHash, frozen.plan.sourceReadSet);
      evidence.push(
        Object.freeze({
          ref: qualifiedRef,
          irVersion: 5 as const,
          planHash,
          sourceReadSet: frozen.plan.sourceReadSet,
          executionEvidenceDigest,
        }),
      );
      const schedules = compiled.ir.triggers.flatMap((trigger) =>
        trigger.kind === "schedule"
          ? [
              {
                cron: trigger.cron,
                source: `${trigger.source.path}:${trigger.source.start}`,
                ordinal: trigger.ordinal,
              },
            ]
          : [],
      );
      for (const binding of compileWorkflowSchedulerBindings({
        qualifiedRef,
        schedules,
        executionEvidenceDigest,
      })) {
        parseSchedule(binding.cron, input.backend);
        out.push(binding);
      }
    } catch (cause) {
      failures.push(workflowFailure(failurePath, failureRef, cause));
    }
  }
}

function schedulerProjectionConfig(input: SchedulerSyncPlanInput): AkmConfig {
  return Object.freeze({
    ...SCHEDULER_PROJECTION_CONFIG,
    defaultBundle: input.bundleName,
    bundles: {
      [input.bundleName]: {
        path: input.sourceRoot,
        components: { main: { root: ".", adapter: input.adapterId } },
      },
    },
  });
}

function enumerateWorkflowLookups(
  input: SchedulerSyncPlanInput,
  collector: SchedulerSourceCollector,
  failures: SchedulerSourceFailure[],
): ReadonlyMap<string, readonly GuardedSchedulerSource[]> {
  const lookups = new Map<string, GuardedSchedulerSource[]>();
  for (const guarded of collector.authoredWorkflowSources(input.adapterId)) {
    const sourcePath = guarded.sourcePath;
    if (path.basename(sourcePath).toLowerCase() === "readme.md") continue;
    const authoredName = workflowNameForSourcePath(input.sourceRoot, input.adapterId, sourcePath);
    if (authoredName === undefined) continue;
    const extension = path.posix.extname(authoredName).toLowerCase();
    const stem = authoredName.slice(0, -extension.length).toLowerCase();
    const nestedSuffix = (WORKFLOW_EXTENSIONS as readonly string[]).find((suffix) => stem.endsWith(suffix));
    if (nestedSuffix) {
      failures.push(
        workflowFailure(sourcePath, undefined, new WorkflowSourceNameError(guarded.relativePath, nestedSuffix)),
      );
      continue;
    }
    const canonicalName = canonicalizeWorkflowName(authoredName);
    const owners = lookups.get(canonicalName) ?? [];
    owners.push(guarded);
    lookups.set(canonicalName, owners);
  }
  for (const symlink of collector.symlinkSources()) {
    if (!isAuthoredWorkflowRelativePath(input.adapterId, symlink.relativePath)) continue;
    if (path.basename(symlink.sourcePath).toLowerCase() === "readme.md") continue;
    const authoredName = workflowNameForSourcePath(input.sourceRoot, input.adapterId, symlink.sourcePath);
    if (authoredName === undefined) continue;
    const canonicalName = canonicalizeWorkflowName(authoredName);
    // A real sibling sharing this name must not compile either: runtime
    // resolution follows the symlink and may pick it over the file the
    // binding was compiled from. The symbolic failure below is the ref's
    // only report.
    lookups.delete(canonicalName);
    const failureRef = makeBundleRef(
      input.bundleName,
      input.adapterId === "akm" ? `workflows/${canonicalName}` : canonicalName,
    );
    if (input.enabledActivations && !input.enabledActivations.has(schedulerActivationKey("workflow", failureRef))) {
      continue;
    }
    failures.push(workflowFailure(symlink.sourcePath, failureRef, symbolicSourceError(symlink.sourcePath)));
  }
  return new Map(
    [...lookups]
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([name, sources]) => [name, Object.freeze(sources.sort(compareGuardedSources))]),
  );
}

function installOptionsFor(
  input: SchedulerSyncPlanInput,
  current: InstalledSchedulerBinding | undefined,
): SchedulerInstallOptions | undefined {
  if (current && !input.rebind) {
    return Object.freeze({
      ...(input.bundleTarget ? { target: input.bundleTarget } : {}),
      binding: Object.freeze([...current.binding]),
      contextPath: current.contextPath,
    });
  }
  return input.installOptions ? Object.freeze({ ...input.installOptions }) : undefined;
}

function belongsToBundle(entry: InstalledSchedulerBinding, input: SchedulerSyncPlanInput): boolean {
  if (input.bundlePath !== undefined && entry.target === input.bundleName) {
    // Path-scoped (#846), primary/unconfigured-bundle sync only: the name
    // already matches, but a display name derived from a directory
    // basename is not an identity — two unrelated bundles can legitimately
    // share one. Require the entry's own scheduler-context descriptor to
    // additionally confirm the resolved path. An entry whose owning path
    // cannot be established is never assumed to be ours — that silent
    // assumption is exactly what let an isolated/foreign bundle's sync
    // reach for another bundle's real scheduler entries. (`bundlePath` is
    // only set for a primary sync — a `--bundle <target>` entry's
    // descriptor reflects the invoking process's OWN primary directory,
    // not the targeted bundle's, so it is not a meaningful signal there;
    // that case keeps relying on config-name uniqueness below.)
    return entry.ownerBundlePath !== undefined && entry.ownerBundlePath === input.bundlePath;
  }
  if (entry.target === input.bundleName || entry.target === input.bundleTarget) return true;
  return false;
}

/**
 * Every desired binding whose id collides with a DIFFERENT bundle's real
 * installed entry: a map from that binding's id to the foreign
 * installed row it collides with, one entry per colliding id. Replaces the
 * single-collision `assertNoForeignIds` throw — `finalizeSchedulerSyncPlan`
 * excludes each colliding binding and reports it instead of refusing the
 * whole bundle's sync over one name clash.
 */
function foreignIdCollisions(
  desired: readonly SchedulerBinding[],
  input: SchedulerSyncPlanInput,
): ReadonlyMap<string, InstalledSchedulerBinding> {
  const collisions = new Map<string, InstalledSchedulerBinding>();
  for (const binding of desired) {
    const foreign = input.installed.find((entry) => entry.id === binding.id && !belongsToBundle(entry, input));
    if (foreign) collisions.set(binding.id, foreign);
  }
  return collisions;
}

function foreignIdFailure(
  binding: SchedulerBinding,
  foreign: InstalledSchedulerBinding,
  input: SchedulerSyncPlanInput,
): SchedulerSourceFailure {
  const where = foreign.ownerBundlePath
    ? `the bundle at ${JSON.stringify(foreign.ownerBundlePath)}`
    : foreign.target
      ? `bundle ${JSON.stringify(foreign.target)}`
      : "the default bundle";
  const mine = input.bundlePath ? ` (this sync is scoped to ${JSON.stringify(input.bundlePath)})` : "";
  return Object.freeze({
    path: binding.source,
    ref: binding.logicalSource.ref,
    reason: `Scheduler id ${JSON.stringify(binding.id)} is already scheduled from ${where}${mine}; desired source ids must not collide across bundles. Leaving it out of this sync.`,
  });
}

function assertUniqueDesiredIds(desired: readonly SchedulerBinding[]): void {
  const seen = new Set<string>();
  for (const binding of desired) {
    if (seen.has(binding.id)) {
      throw new UsageError(
        `Desired scheduler id collision for ${JSON.stringify(binding.id)}; no native definitions were changed. ` +
          "Rename one of the colliding tasks or workflows so their scheduler ids differ, then retry.",
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    seen.add(binding.id);
  }
}

function assertUniqueInstalledIds(installed: readonly InstalledSchedulerBinding[]): void {
  const seen = new Set<string>();
  for (const binding of installed) {
    if (seen.has(binding.id)) {
      throw new UsageError(
        `Installed scheduler id collision for ${JSON.stringify(binding.id)}; refusing whole-set reconciliation. ` +
          "Run `akm task prune` or remove the duplicate native entry by hand, then retry.",
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    seen.add(binding.id);
  }
}

/**
 * The reason recorded for a symlinked task/workflow source: it stays a
 * per-source failure (like the read boundary it replaces), never a silent
 * drop and never a follow.
 */
function symbolicSourceError(sourcePath: string): UsageError {
  return new UsageError(
    `${sourcePath} is a symbolic source; guarded reads require a regular no-follow owner.`,
    "RESOURCE_ALREADY_EXISTS",
  );
}

function taskFailure(file: string, ref: string, cause: unknown): SchedulerSourceFailure {
  const detail = taskSourceErrorDetail(cause);
  const reason = detail === errorMessage(cause) ? `${file}: ${detail}` : detail;
  return Object.freeze({ path: file, ref, reason });
}

function workflowFailure(file: string, ref: string | undefined, cause: unknown): SchedulerSourceFailure {
  return Object.freeze({ path: file, ...(ref ? { ref } : {}), reason: errorMessage(cause) });
}

/**
 * `buildSchedulerRemoveOperation` threw for one installed row — there is no
 * source file for an installed-only row, so `path` falls back to the
 * scheduler binding id itself; `ref` is filled in only when
 * {@link installedLogicalSource} can still recognize the invocation shape
 * (best-effort — the same throw this wraps often means it can't). Exported
 * so `buildSchedulerSyncPlan`'s inactive-bundle removal loop
 * (`src/commands/tasks/tasks.ts`) reports one unattributable installed row
 * of a disabled bundle without a second builder.
 */
export function installedRowFailure(
  id: string,
  current: InstalledSchedulerBinding | undefined,
  input: Pick<SchedulerSyncPlanInput, "adapterId" | "bundleName">,
  cause: unknown,
): SchedulerSourceFailure {
  let ref: string | undefined;
  if (current?.invocation) {
    try {
      ref = installedLogicalSource(current.invocation, input).ref;
    } catch {
      ref = undefined;
    }
  }
  return Object.freeze({ path: id, ...(ref ? { ref } : {}), reason: errorMessage(cause) });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function assertSchedulerSourceSnapshot(snapshot: SchedulerSourceSnapshot): void {
  try {
    for (const source of snapshot.files) {
      const current = captureGuardedExecutionSource(source.sourcePath, source.containmentRoot, {
        authored: source.authored,
        ...(source.identity ? { identity: source.identity } : {}),
      });
      if (JSON.stringify(current) !== JSON.stringify(source)) {
        throw new Error(`source identity changed: ${source.sourcePath}`);
      }
    }
    for (const manifest of snapshot.directoryManifests) {
      const current = captureGuardedDirectoryManifest(manifest.directoryPath, manifest.containmentRoot);
      if (JSON.stringify(current) !== JSON.stringify(manifest)) {
        throw new Error(`directory manifest changed: ${manifest.directoryPath}`);
      }
    }
  } catch (cause) {
    throw new UsageError(
      `Scheduler desired source read set changed after projection; refusing native mutation: ${errorMessage(cause)}. ` +
        "Re-run `akm task sync` (the source changed mid-sync).",
      "RESOURCE_ALREADY_EXISTS",
    );
  }
}

type GuardedSchedulerSource = SchedulerSourceSnapshot["files"][number];

/**
 * Shared with the symlink classification in {@link compileTaskSources}: a
 * `.yml` under `tasks/` (or, for `akm-task`, anywhere) is a task candidate —
 * one classifier for both a captured file and an uncaptured symlink entry.
 */
function isAuthoredTaskRelativePath(adapterId: string, relativePath: string): boolean {
  if (!relativePath.endsWith(".yml")) return false;
  if (adapterId === "akm-task") return true;
  return path.posix.dirname(relativePath) === "tasks";
}

/**
 * Shared with the symlink classification in {@link enumerateWorkflowLookups}:
 * anything under `workflows/` (or, for `akm-workflow`, anywhere) is a
 * workflow candidate — one classifier for both a captured file and an
 * uncaptured symlink entry.
 */
function isAuthoredWorkflowRelativePath(adapterId: string, relativePath: string): boolean {
  if (adapterId === "akm-workflow") return true;
  return relativePath.startsWith("workflows/");
}

class SchedulerSourceCollector {
  readonly #adapterId: string;
  readonly #sourceRoot: string;
  readonly #collector = new GuardedExecutionSourceCollector();

  constructor(input: Pick<SchedulerSyncPlanInput, "adapterId" | "sourceRoot">) {
    this.#adapterId = input.adapterId;
    this.#sourceRoot = path.resolve(input.sourceRoot);
    const root = this.#collector.trackDirectory(this.#sourceRoot, this.#sourceRoot);
    if (input.adapterId === "akm") {
      for (const scheduledName of ["tasks", "workflows"] as const) {
        const entry = root.entries.find((candidate) => candidate.name === scheduledName);
        if (entry?.kind === "symlink") {
          throw new UsageError(
            `${path.join(this.#sourceRoot, scheduledName)} is a symbolic source with a physical source identity collision; guarded reads require one no-follow owner. ` +
              `Replace the symlinked ${JSON.stringify(scheduledName)} with a regular directory, then retry.`,
            "RESOURCE_ALREADY_EXISTS",
          );
        }
      }
    }
    const rootDirectories = new Set(
      root.entries.filter((entry) => entry.kind === "directory").map((entry) => entry.name),
    );
    const candidates: string[] = [];
    if (input.adapterId === "akm") {
      if (rootDirectories.has("tasks")) {
        const taskRoot = path.join(this.#sourceRoot, "tasks");
        const taskManifest = this.#collector.trackDirectory(taskRoot, this.#sourceRoot);
        for (const entry of taskManifest.entries) {
          if (entry.kind === "file" && entry.name.endsWith(".yml")) {
            candidates.push(path.join(taskRoot, entry.name));
          }
        }
      }
      if (rootDirectories.has("workflows")) {
        candidates.push(...this.#collector.enumerateTree(path.join(this.#sourceRoot, "workflows"), this.#sourceRoot));
      }
    } else if (input.adapterId === "akm-task") {
      candidates.push(
        ...this.#collector.enumerateTree(this.#sourceRoot, this.#sourceRoot).filter((file) => file.endsWith(".yml")),
      );
    } else if (input.adapterId === "akm-workflow") {
      candidates.push(...this.#collector.enumerateTree(this.#sourceRoot, this.#sourceRoot));
    }
    for (const file of candidates.sort(compareCodePoints)) {
      this.#collector.capture(file, this.#sourceRoot, { authored: true });
    }
  }

  executionCollector(): GuardedExecutionSourceCollector {
    return this.#collector;
  }

  authoredTaskSources(adapterId: string): readonly GuardedSchedulerSource[] {
    return this.#collector
      .snapshot()
      .sources.filter((file) => file.authored && isAuthoredTaskRelativePath(adapterId, file.relativePath))
      .sort(compareGuardedSources);
  }

  authoredWorkflowSources(adapterId: string): readonly GuardedSchedulerSource[] {
    return this.#collector
      .snapshot()
      .sources.filter((file) => file.authored && isAuthoredWorkflowRelativePath(adapterId, file.relativePath))
      .sort(compareGuardedSources);
  }

  /**
   * Every `kind: "symlink"` entry across the directory manifests captured so
   * far (never read, never followed — see `captureGuardedDirectoryManifest`),
   * with its path relative to the source root so callers can classify it
   * with the same predicates as a real, captured file.
   */
  symlinkSources(): readonly { readonly sourcePath: string; readonly relativePath: string }[] {
    const entries: { sourcePath: string; relativePath: string }[] = [];
    for (const manifest of this.#collector.snapshot().directoryManifests) {
      for (const entry of manifest.entries) {
        if (entry.kind !== "symlink") continue;
        const sourcePath = path.join(manifest.directoryPath, entry.name);
        entries.push({ sourcePath, relativePath: toPosix(path.relative(this.#sourceRoot, sourcePath)) });
      }
    }
    return entries;
  }

  readBytes(file: string, containmentRoot: string): Uint8Array {
    this.#trackAncestors(file, containmentRoot);
    return this.#collector.readBytes(file, containmentRoot);
  }

  fileContext(root: string, file: string): FileContext {
    this.#trackAncestors(file, root);
    return this.#collector.fileContext(root, file);
  }

  snapshot(): SchedulerSourceSnapshot {
    const guarded = this.#collector.snapshot();
    const root = guarded.directoryManifests.find(
      (manifest) => manifest.directoryPath === this.#sourceRoot && manifest.containmentRoot === this.#sourceRoot,
    );
    if (!root) throw new Error("scheduler source collector lost its guarded root manifest");
    return Object.freeze({
      adapterId: this.#adapterId,
      sourceRoot: this.#sourceRoot,
      sourceRealPath: root.realPath,
      sourcePhysicalIdentity: root.physicalIdentity,
      sourceDirectoryVersion: root.version,
      files: Object.freeze([...guarded.sources].sort(compareGuardedSources)),
      directoryManifests: guarded.directoryManifests,
    });
  }

  #trackAncestors(file: string, containmentRoot: string): void {
    const root = path.resolve(containmentRoot);
    const parent = path.dirname(path.resolve(file));
    const relative = path.relative(root, parent);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return;
    this.#collector.trackDirectory(root, root);
    if (relative === "") return;
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      this.#collector.trackDirectory(current, root);
    }
  }
}

function compareGuardedSources(left: GuardedSchedulerSource, right: GuardedSchedulerSource): number {
  return compareCodePoints(left.sourcePath, right.sourcePath);
}

function installedLogicalSource(
  invocation: readonly string[],
  input: Pick<SchedulerSyncPlanInput, "adapterId" | "bundleName">,
): SchedulerBinding["logicalSource"] {
  if (invocation[0] === "workflow" && invocation[1] === "run" && invocation.length === 3) {
    return Object.freeze({ kind: "workflow", ref: invocation[2]! });
  }
  if (invocation[0] === "task" && invocation[1] === "run" && invocation[2]) {
    const bundleIndex = invocation.indexOf("--bundle", 3);
    const bundle = bundleIndex === -1 ? input.bundleName : invocation[bundleIndex + 1];
    if (!bundle) {
      throw new UsageError("Installed task invocation has no resolvable bundle owner.", "RESOURCE_ALREADY_EXISTS");
    }
    const conceptId = input.adapterId === "akm" ? `tasks/${invocation[2]}` : invocation[2];
    return Object.freeze({ kind: "task", ref: makeBundleRef(bundle, conceptId) });
  }
  throw new UsageError(
    "Installed scheduler invocation has no exact canonical source owner.",
    "RESOURCE_ALREADY_EXISTS",
  );
}

function freezeRemovalExpectation(expectation: SchedulerRemovalExpectation): SchedulerRemovalExpectation {
  return Object.freeze({
    ...expectation,
    logicalSource: Object.freeze({ ...expectation.logicalSource }),
    invocation: Object.freeze([...expectation.invocation]),
  });
}

function expectationForBinding(
  binding: SchedulerBinding,
  state: SchedulerMutationExpectation["state"],
  fingerprint?: string,
): SchedulerMutationExpectation {
  return {
    state,
    bindingId: binding.id,
    nativeId: schedulerBindingNativeId(binding),
    logicalSource: binding.logicalSource,
    ordinal: binding.ordinal,
    invocation: binding.invocation,
    ...(fingerprint !== undefined ? { fingerprint } : {}),
  };
}

function freezeMutationExpectation(expectation: SchedulerMutationExpectation): SchedulerMutationExpectation {
  return Object.freeze({
    ...expectation,
    logicalSource: Object.freeze({ ...expectation.logicalSource }),
    invocation: Object.freeze([...expectation.invocation]),
  });
}

function freezeOperation<T extends SchedulerSyncOperation>(operation: T): T {
  return Object.freeze(operation);
}

function sameInvocation(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// Retain the concrete error in this module's public dependency graph so callers
// can continue to identify ownership failures without importing an adapter.
export { WorkflowSourceRejectionError };
