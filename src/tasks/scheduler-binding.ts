// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Secret-free input to every native scheduler backend.
 *
 * The binding deliberately contains only stable source identity, trigger
 * identity, and the public CLI tail. Source content, action inputs,
 * environment values, resolved requests, and credentials must never cross
 * this boundary or be persisted by an OS scheduler.
 */

import { createHash } from "node:crypto";
import { bundleRefToString, parseBundleRef } from "../core/asset/asset-ref";
import { UsageError } from "../core/errors";
import { canonicalInputJson } from "../execution/input-contract";
import type { ScheduleBackend } from "./schedule";
import { normaliseTaskConceptId } from "./task-id";

export type SchedulerLogicalSource = Readonly<{
  kind: "task" | "workflow";
  ref: string;
}>;

export interface SchedulerBinding {
  /** Stable logical binding identity. Ordinal zero keeps the flat task ABI. */
  readonly id: string;
  /** Exact portable OS artifact spelling; never recovered from the public owner. */
  readonly nativeId?: string;
  readonly logicalSource: SchedulerLogicalSource;
  readonly cron: string;
  readonly source: string;
  readonly ordinal: number;
  readonly enabled: boolean;
  /** Public CLI tail, excluding the resolved launcher and context descriptor. */
  readonly invocation: readonly string[];
  /** Secret-free digest of a scheduled workflow's dry-frozen v4 plan/read set. */
  readonly executionEvidenceDigest?: string;
}

export interface SchedulerSourceSchedule {
  readonly cron: string;
  readonly source: string;
  readonly ordinal: number;
  /**
   * P2b Lane B (spec docs/plans/specs/p2b-input-bindings.md §4.4, §1.7 B-N3):
   * a v4 `schedule[i].inputs` literal override. v3 never sets this, so its compiled invocation tail gains not a
   * single byte (B-03). When present and non-empty,
   * {@link compileTaskSchedulerBindings} appends a canonically-sorted
   * `--<name> <value>` flag tail after `--scheduled`.
   */
  readonly inputs?: Readonly<Record<string, unknown>>;
}

export interface CompileTaskSchedulerBindingsInput {
  readonly id: string;
  readonly qualifiedRef: string;
  readonly bundleTarget?: string;
  readonly schedules: readonly SchedulerSourceSchedule[];
}

export interface CompileWorkflowSchedulerBindingsInput {
  readonly qualifiedRef: string;
  readonly schedules: readonly SchedulerSourceSchedule[];
  readonly executionEvidenceDigest?: string;
}

/** Existing native definition as exposed to the whole-set planner. */
export interface InstalledSchedulerBinding {
  readonly id: string;
  /** Native scheduler activation state, when the backend can prove it. */
  readonly enabled?: boolean;
  /** Exact backend artifact spelling enumerated from the native scheduler. */
  readonly nativeId?: string;
  readonly binding: readonly string[];
  readonly contextPath: string;
  readonly signature?: string;
  readonly target?: string;
  /** Parsed public CLI tail, used to attribute higher-ordinal task bindings. */
  readonly invocation?: readonly string[];
  /**
   * Resolved `AKM_BUNDLE_DIR` recovered from this entry's scheduler-context
   * descriptor (#846), when the descriptor exists and can be validated.
   * Absent whenever ownership cannot be established — a missing value must
   * never be treated as "belongs to the invoking bundle" (see
   * `belongsToBundle` in scheduler-sync.ts).
   */
  readonly ownerBundlePath?: string;
}

/** Existing native ownership visible during an explicit destructive rebind. */
export interface RebindSchedulerBinding {
  readonly id: string;
  readonly nativeId?: string;
  readonly signature?: string;
  readonly target?: string;
  readonly invocation?: readonly string[];
}

export interface SchedulerInstallOptions {
  readonly target?: string;
  readonly binding?: readonly string[];
  readonly contextPath?: string;
}

/** Read-only native inventory, including artifacts whose invocation is malformed. */
export interface SchedulerNativeArtifact {
  readonly nativeId: string;
  /** Exact binding identity recovered from the artifact plus its parsed invocation. */
  readonly bindingId?: string;
  /** Exact parsed public CLI tail. Missing means the artifact is unowned/malformed. */
  readonly invocation?: readonly string[];
  /** Exact read-only native definition fingerprint when the backend can provide it. */
  readonly fingerprint?: string;
}

export interface SchedulerBackendInspection {
  readonly installed: readonly InstalledSchedulerBinding[];
  readonly artifacts: readonly SchedulerNativeArtifact[];
}

export interface SchedulerTransactionSnapshot {
  readonly nativeIds: readonly string[];
  readonly artifacts: readonly SchedulerNativeArtifact[];
}

/** One exact native state a transaction itself may have produced before rollback. */
export type SchedulerRollbackState =
  | Readonly<{ state: "absent" }>
  | Readonly<{
      state: "present";
      bindingId?: string;
      invocation?: readonly string[];
      fingerprint: string;
    }>;

/** CAS guard that prevents rollback from overwriting a concurrent native edit. */
export interface SchedulerRollbackExpectation {
  readonly nativeId: string;
  readonly allowed: readonly SchedulerRollbackState[];
}

/** Frozen compare-and-swap proof required by every scheduler mutation. */
export interface SchedulerMutationExpectation {
  readonly state: "absent" | "present";
  readonly bindingId: string;
  readonly nativeId: string;
  readonly logicalSource: SchedulerLogicalSource;
  readonly ordinal: number;
  readonly invocation: readonly string[];
  readonly fingerprint?: string;
}

/** Removal always targets a currently owned scheduler artifact. */
export type SchedulerRemovalExpectation = Omit<SchedulerMutationExpectation, "state"> & {
  readonly state?: "present";
};

/** Structural backend view used by the command layer without source documents. */
export interface SchedulerBackend {
  readonly name: ScheduleBackend;
  install(
    binding: SchedulerBinding,
    opts?: SchedulerInstallOptions,
    expected?: SchedulerMutationExpectation,
  ): Promise<void> | void;
  uninstall(id: string, expected?: SchedulerRemovalExpectation): Promise<void> | void;
  setEnabled(id: string, enabled: boolean): Promise<void> | void;
  list(): Promise<InstalledSchedulerBinding[]> | InstalledSchedulerBinding[];
  listForRebind?(): Promise<RebindSchedulerBinding[]> | RebindSchedulerBinding[];
  listNativeArtifacts?(): Promise<SchedulerNativeArtifact[]> | SchedulerNativeArtifact[];
  /** One coherent inventory derived from one raw native state read. */
  inspectBindings?(options?: {
    readonly rebind?: boolean;
  }): Promise<SchedulerBackendInspection> | SchedulerBackendInspection;
  expectedSignature?(binding: SchedulerBinding, opts?: SchedulerInstallOptions): string;
  /** Capture exact native definitions for a command-layer transaction. */
  snapshotBindings?(ids: readonly string[]): Promise<SchedulerTransactionSnapshot> | SchedulerTransactionSnapshot;
  /** Restore a snapshot returned by this backend's `snapshotBindings`. */
  restoreBindings?(snapshot: unknown, expectedCurrent?: readonly SchedulerRollbackExpectation[]): Promise<void> | void;
}

export function compileTaskSchedulerBindings(input: CompileTaskSchedulerBindingsInput): readonly SchedulerBinding[] {
  const id = normaliseTaskConceptId(input.id);
  const ref = assertQualifiedRef(input.qualifiedRef, "task");
  const bundle = parseBundleRef(ref).bundle;
  if (!bundle) throw new Error("invariant: qualified scheduler task ref lost its bundle");
  // P2b Lane B (B-N3): the invocation is compiled PER schedule entry now —
  // each entry's own `inputs` produces its own trailing flag tail, so it can
  // no longer be hoisted as one binding shared by every entry.
  return Object.freeze(
    input.schedules.map((schedule) => {
      const bindingId = schedule.ordinal === 0 ? id : digestBindingId("task", ref, schedule.ordinal);
      const invocation = Object.freeze([
        "task",
        "run",
        id,
        "--bundle",
        bundle,
        "--scheduled",
        ...schedulerInputFlagTail(schedule.inputs),
      ]);
      return freezeBinding({
        id: bindingId,
        nativeId: schedulerNativeBindingId(bindingId),
        logicalSource: { kind: "task", ref },
        cron: schedule.cron,
        source: schedule.source,
        ordinal: schedule.ordinal,
        enabled: true,
        invocation,
      });
    }),
  );
}

/**
 * The canonically-sorted `--<name> <value>` flag tail for one schedule
 * entry's `inputs` (spec §1.7 B-N3). Empty/absent `inputs` yields an empty
 * tail — the fixed six-token invocation, byte-identical to every schedule
 * entry before P2b (B-03).
 *
 * Code-review finding (scheduler-binding.ts:536): a value whose exact text
 * begins with `-` (a negative number, or a string that just happens to
 * start with a dash) is indistinguishable from a NEW flag in the two-token
 * `--<name> <value>` form — `isValidSchedulerInputFlagTail`
 * (scheduler-invocation.ts) refuses it outright, and even a looser parser
 * would still be wrong for a non-numeric dash-leading string: the real `akm
 * task run` flag parser (`parseTaskInputFlags`, tasks-cli.ts) only
 * special-cases a dash-DIGIT lead, so it would silently treat `--scope
 * -urgent` as the boolean flag `--scope` followed by an orphaned,
 * dropped `-urgent` token. The inline `--<name>=<value>` form has no such
 * ambiguity on EITHER side — `isValidSchedulerInputFlagTail` accepts it
 * unconditionally, and `parseTaskInputFlags`'s own inline-`=` branch splits
 * on the first `=` without ever inspecting the value's leading character —
 * so it is used whenever the value's exact text would otherwise be
 * ambiguous. Every other value keeps the existing two-token form
 * byte-identical to before this fix (B-03/B-45).
 */
function schedulerInputFlagTail(inputs: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  if (!inputs) return [];
  const names = Object.keys(inputs).sort();
  const tail: string[] = [];
  for (const name of names) {
    const text = schedulerInputFlagValueText(inputs[name]);
    if (text.startsWith("-")) tail.push(`--${name}=${text}`);
    else tail.push(`--${name}`, text);
  }
  return tail;
}

/**
 * One input value's argv text. A scalar is its exact text — `String(value)`
 * for a number/boolean (a `true` boolean is `"true"`, never a bare flag, so
 * the tail round-trips through one parser), the string itself for a string.
 * An object/array value is its `canonicalInputJson` text, which
 * `materializeInputFlags`'s JSON-shorthand path already coerces back through
 * the declaration.
 */
function schedulerInputFlagValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return canonicalInputJson(value);
}

export function compileWorkflowSchedulerBindings(
  input: CompileWorkflowSchedulerBindingsInput,
): readonly SchedulerBinding[] {
  const ref = assertQualifiedRef(input.qualifiedRef, "workflow");
  const invocation = Object.freeze(["workflow", "run", ref]);
  return Object.freeze(
    input.schedules.map((schedule) => {
      const bindingId = digestBindingId("workflow", ref, schedule.ordinal);
      return freezeBinding({
        id: bindingId,
        nativeId: bindingId,
        logicalSource: { kind: "workflow", ref },
        cron: schedule.cron,
        source: schedule.source,
        ordinal: schedule.ordinal,
        enabled: true,
        invocation,
        ...(input.executionEvidenceDigest !== undefined
          ? { executionEvidenceDigest: assertSchedulerExecutionEvidenceDigest(input.executionEvidenceDigest) }
          : {}),
      });
    }),
  );
}

export function assertSchedulerExecutionEvidenceDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new UsageError(
      "Scheduler workflow execution evidence must be a lowercase SHA-256 digest.",
      "INVALID_FLAG_VALUE",
    );
  }
  return value;
}

/**
 * Map a logical binding id to the flat portable token persisted by native
 * schedulers. Existing flat ids are byte-for-byte stable; only standalone
 * component-relative ids need an encoded native spelling.
 */
export function schedulerNativeBindingId(id: string): string {
  if (!id.includes("/")) return id;
  const digest = createHash("sha256")
    .update(JSON.stringify(["nested-task", id]))
    .digest("hex")
    .slice(0, 32);
  return `task-${digest}`;
}

/** Portable collision key for scheduler namespaces with Windows semantics. */
export function schedulerNativeArtifactKey(nativeId: string): string {
  return nativeId.toLowerCase().replace(/\.+$/u, "");
}

export function schedulerNativeArtifactsForKey(
  artifacts: readonly SchedulerNativeArtifact[],
  nativeId: string,
): readonly SchedulerNativeArtifact[] {
  const key = schedulerNativeArtifactKey(nativeId);
  return artifacts.filter((artifact) => schedulerNativeArtifactKey(artifact.nativeId) === key);
}

export function assertSchedulerNativeArtifactCardinality(
  artifacts: readonly SchedulerNativeArtifact[],
  nativeId: string,
  expectedCount: 0 | 1,
): SchedulerNativeArtifact | undefined {
  const matches = schedulerNativeArtifactsForKey(artifacts, nativeId);
  if (matches.length !== expectedCount) {
    const expectedState = expectedCount === 0 ? "absence" : "one present owner";
    throw new UsageError(
      `Native scheduler artifact ${JSON.stringify(nativeId)} changed: normalized cardinality ${matches.length} violates the expected ${expectedState} before mutation.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }
  return matches[0];
}

/** Return a logical owner only when the public invocation proves the mapping. */
export function schedulerLogicalBindingOwner(nativeId: string, invocation: readonly string[]): string | undefined {
  return schedulerNativeArtifactOwner(nativeId, invocation)?.logicalId;
}

export function schedulerNativeArtifactOwner(
  nativeId: string,
  invocation: readonly string[],
): { logicalId: string; logicalKind: SchedulerLogicalSource["kind"] } | undefined {
  if (invocation[0] === "workflow" && invocation[1] === "run" && invocation.length === 3) {
    const ref = invocation[2];
    if (ref && workflowRefDigestsToNativeId(ref, nativeId)) {
      return { logicalId: nativeId, logicalKind: "workflow" };
    }
    return undefined;
  }
  const taskId = invocation[0] === "task" && invocation[1] === "run" ? invocation[2] : undefined;
  if (!taskId) return undefined;
  return {
    logicalId: schedulerNativeBindingId(taskId) === nativeId ? taskId : nativeId,
    logicalKind: "task",
  };
}

export function assertSchedulerNativeArtifactOwner(
  nativeId: string,
  intended: SchedulerBinding,
  invocation: readonly string[] | undefined,
): void {
  const intendedNativeId = intended.nativeId ?? schedulerNativeBindingId(intended.id);
  if (nativeId === intendedNativeId && invocation && sameInvocation(invocation, intended.invocation)) return;
  const description = invocation ? JSON.stringify(invocation) : "an unproven or malformed invocation";
  throw new UsageError(
    `Native scheduler artifact ${JSON.stringify(nativeId)} belongs to ${description}, not the exact ${intended.logicalSource.kind} owner ${JSON.stringify(intended.logicalSource.ref)} with binding ${JSON.stringify(intended.id)}.`,
    "RESOURCE_ALREADY_EXISTS",
  );
}

/** Recover binding identity without treating the native hash as source ownership. */
export function schedulerLogicalBindingId(nativeId: string, invocation: readonly string[]): string {
  return schedulerLogicalBindingOwner(nativeId, invocation) ?? nativeId;
}

export function schedulerBindingNativeId(binding: SchedulerBinding): string {
  return binding.nativeId ?? schedulerNativeBindingId(binding.id);
}

export function assertSchedulerRemovalArtifact(
  nativeId: string,
  expected: SchedulerRemovalExpectation,
  invocation: readonly string[] | undefined,
  fingerprint: string | undefined,
): void {
  const normalized = normalizeRemovalExpectation(expected);
  assertSchedulerExpectationIdentity(normalized);
  const fingerprintMatches = normalized.fingerprint === undefined || normalized.fingerprint === fingerprint;
  if (
    nativeId === normalized.nativeId &&
    invocation !== undefined &&
    sameInvocation(invocation, normalized.invocation) &&
    fingerprintMatches
  ) {
    return;
  }
  throw new UsageError(
    `Native scheduler artifact ${JSON.stringify(nativeId)} changed owner or fingerprint; refusing to remove an unverified ${normalized.logicalSource.kind} owner ${JSON.stringify(normalized.logicalSource.ref)}.`,
    "RESOURCE_ALREADY_EXISTS",
  );
}

export function assertSchedulerExpectationIdentity(
  expected: SchedulerMutationExpectation,
  binding?: SchedulerBinding,
): void {
  const identity = canonicalSchedulerIdentity(expected.logicalSource, expected.ordinal, expected.invocation);
  if (
    identity.bindingId !== expected.bindingId ||
    identity.nativeId !== expected.nativeId ||
    !sameInvocation(identity.invocation, expected.invocation) ||
    (binding !== undefined &&
      (binding.id !== expected.bindingId ||
        schedulerBindingNativeId(binding) !== expected.nativeId ||
        binding.ordinal !== expected.ordinal ||
        binding.logicalSource.kind !== expected.logicalSource.kind ||
        binding.logicalSource.ref !== expected.logicalSource.ref ||
        !sameInvocation(binding.invocation, expected.invocation)))
  ) {
    throw new UsageError(
      "Scheduler mutation expectation has a forged or inconsistent binding identity.",
      "INVALID_FLAG_VALUE",
    );
  }
  if (expected.state === "absent" && expected.fingerprint !== undefined) {
    throw new UsageError("An absent scheduler expectation cannot carry prior artifact state.", "INVALID_FLAG_VALUE");
  }
}

export function assertSchedulerMutationArtifact(
  artifact: SchedulerNativeArtifact | undefined,
  expected: SchedulerMutationExpectation,
): void {
  assertSchedulerExpectationIdentity(expected);
  if (expected.state === "absent") {
    if (artifact === undefined) return;
  } else if (
    artifact !== undefined &&
    artifact.nativeId === expected.nativeId &&
    artifact.bindingId === expected.bindingId &&
    artifact.invocation !== undefined &&
    expected.fingerprint !== undefined &&
    artifact.fingerprint === expected.fingerprint
  ) {
    return;
  }
  throw new UsageError(
    `Native scheduler artifact ${JSON.stringify(expected.nativeId)} changed from its frozen ${expected.state} state; refusing mutation.`,
    "RESOURCE_ALREADY_EXISTS",
  );
}

export function assertSchedulerRollbackArtifact(
  artifact: SchedulerNativeArtifact | undefined,
  expected: SchedulerRollbackExpectation,
): void {
  const matches = expected.allowed.some((state) => {
    if (state.state === "absent") return artifact === undefined;
    if (!artifact || artifact.nativeId !== expected.nativeId) return false;
    if (artifact.fingerprint !== state.fingerprint || artifact.bindingId !== state.bindingId) return false;
    return state.invocation === undefined
      ? artifact.invocation === undefined
      : artifact.invocation !== undefined && sameInvocation(artifact.invocation, state.invocation);
  });
  if (matches) return;
  throw new UsageError(
    `Native scheduler artifact ${JSON.stringify(expected.nativeId)} changed after the transaction began; refusing rollback over a concurrent owner or fingerprint.`,
    "RESOURCE_ALREADY_EXISTS",
  );
}

/**
 * Validate a rollback target from one complete native inventory. Rollback
 * guards may allow either the transaction-written state or the prior state,
 * but neither state permits two portable-key-equivalent artifacts.
 */
export function assertSchedulerRollbackArtifactCardinality(
  artifacts: readonly SchedulerNativeArtifact[],
  expected: SchedulerRollbackExpectation,
): SchedulerNativeArtifact | undefined {
  const matches = schedulerNativeArtifactsForKey(artifacts, expected.nativeId);
  if (matches.length > 1) {
    throw new UsageError(
      `Native scheduler artifact ${JSON.stringify(expected.nativeId)} changed after the transaction began: normalized rollback cardinality ${matches.length} exceeds one.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }
  const artifact = matches[0];
  assertSchedulerRollbackArtifact(artifact, expected);
  return artifact;
}

export function canonicalSchedulerIdentity(
  logicalSource: SchedulerLogicalSource,
  ordinal: number,
  invocation: readonly string[],
): Readonly<{ bindingId: string; nativeId: string; invocation: readonly string[] }> {
  const parsed = parseBundleRef(logicalSource.ref);
  if (!parsed.bundle || parsed.fragment !== undefined || bundleRefToString(parsed) !== logicalSource.ref) {
    throw new UsageError("Scheduler expectation requires one canonical fully-qualified source.", "INVALID_FLAG_VALUE");
  }
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new UsageError("Scheduler expectation ordinal must be a non-negative integer.", "INVALID_FLAG_VALUE");
  }
  if (logicalSource.kind === "workflow") {
    const canonicalInvocation = ["workflow", "run", logicalSource.ref];
    if (!sameInvocation(invocation, canonicalInvocation)) {
      throw new UsageError(
        "Workflow scheduler expectation invocation does not match its qualified source.",
        "INVALID_FLAG_VALUE",
      );
    }
    const bindingId = digestBindingId("workflow", logicalSource.ref, ordinal);
    return Object.freeze({ bindingId, nativeId: bindingId, invocation: Object.freeze(canonicalInvocation) });
  }
  const taskId = invocation[0] === "task" && invocation[1] === "run" ? invocation[2] : undefined;
  if (!taskId || normaliseTaskConceptId(taskId) !== taskId) {
    throw new UsageError("Task scheduler expectation has an invalid public task id.", "INVALID_FLAG_VALUE");
  }
  const canonicalInvocation = ["task", "run", taskId, "--bundle", parsed.bundle, "--scheduled"];
  if (!sameInvocation(invocation, canonicalInvocation)) {
    throw new UsageError(
      `Task scheduler expectation invocation does not match its qualified source: expected ${JSON.stringify(canonicalInvocation)}, got ${JSON.stringify(invocation)}.`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (parsed.conceptId !== taskId && parsed.conceptId !== `tasks/${taskId}`) {
    throw new UsageError("Task scheduler expectation id does not match its qualified source.", "INVALID_FLAG_VALUE");
  }
  const bindingId = ordinal === 0 ? taskId : digestBindingId("task", logicalSource.ref, ordinal);
  return Object.freeze({
    bindingId,
    nativeId: schedulerNativeBindingId(bindingId),
    invocation: Object.freeze(canonicalInvocation),
  });
}

/** Recover the authored schedule ordinal from the exact source/binding identity. */
export function schedulerBindingOrdinal(
  bindingId: string,
  logicalSource: SchedulerLogicalSource,
  invocation: readonly string[],
): number | undefined {
  if (logicalSource.kind === "task" && bindingId === invocation[2]) return 0;
  for (let ordinal = 0; ordinal < 4096; ordinal += 1) {
    if (digestBindingId(logicalSource.kind, logicalSource.ref, ordinal) === bindingId) return ordinal;
  }
  return undefined;
}

/** Whether some schedule ordinal on `ref` would digest to `nativeId` (mirrors schedulerBindingOrdinal). */
function workflowRefDigestsToNativeId(ref: string, nativeId: string): boolean {
  for (let ordinal = 0; ordinal < 4096; ordinal += 1) {
    if (digestBindingId("workflow", ref, ordinal) === nativeId) return true;
  }
  return false;
}

function digestBindingId(kind: "task" | "workflow", ref: string, ordinal: number): string {
  const prefix = kind === "workflow" ? "wf" : "task";
  const digest = createHash("sha256")
    .update(JSON.stringify([kind, ref, ordinal]))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}-${digest}`;
}

function assertQualifiedRef(value: string, kind: "task" | "workflow"): string {
  const parsed = parseBundleRef(value);
  if (!parsed.bundle || parsed.fragment !== undefined || bundleRefToString(parsed) !== value) {
    throw new UsageError(`${kind} scheduler bindings require one canonical fully-qualified ref.`, "INVALID_FLAG_VALUE");
  }
  return value;
}

function freezeBinding(binding: SchedulerBinding): SchedulerBinding {
  return Object.freeze({
    ...binding,
    logicalSource: Object.freeze({ ...binding.logicalSource }),
    invocation: Object.freeze([...binding.invocation]),
  });
}

function sameInvocation(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeRemovalExpectation(expected: SchedulerRemovalExpectation): SchedulerMutationExpectation {
  return { ...expected, state: "present" };
}
