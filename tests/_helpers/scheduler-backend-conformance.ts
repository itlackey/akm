import { describe, expect, test } from "bun:test";
import type {
  SchedulerBackend,
  SchedulerBinding,
  SchedulerMutationExpectation,
  SchedulerRemovalExpectation,
  SchedulerRollbackExpectation,
} from "../../src/tasks/scheduler-binding";
import { compileTaskSchedulerBindings, schedulerNativeBindingId } from "../../src/tasks/scheduler-binding";
import type { ScheduledTaskContext } from "../../src/tasks/scheduler-invocation";

export type SchedulerArtifactDrift = "foreign" | "malformed" | "fingerprint";
export type SchedulerNormalizedPeer = "case" | "trailing-dot";

/**
 * Backend-local native state controls used by the shared scheduler contract.
 *
 * The adapter deliberately exposes state changes rather than platform storage
 * details. Cron, launchd, and Task Scheduler still keep their parser, encoding,
 * OS API, and compensation tests in their own suites.
 */
export interface SchedulerBackendContractDriver {
  readonly backend: SchedulerBackend;
  captureState(): unknown;
  clearArtifact(binding: SchedulerBinding): void;
  driftArtifact(binding: SchedulerBinding, drift: SchedulerArtifactDrift): void;
  addNormalizedPeer(binding: SchedulerBinding, peer: SchedulerNormalizedPeer): void;
  currentFingerprint(binding: SchedulerBinding): string;
  resetActivity(): void;
  accessCount(): number;
  mutationCount(): number;
}

export interface SchedulerBackendContractAdapter {
  readonly name: string;
  readonly scheduledContext: ScheduledTaskContext;
  readonly movedContext: ScheduledTaskContext;
  create(scheduledContext?: ScheduledTaskContext): SchedulerBackendContractDriver;
}

export function qualifiedSchedulerTask(schedule: string, id = "ping", enabled = true): SchedulerBinding {
  return {
    id,
    nativeId: schedulerNativeBindingId(id),
    logicalSource: { kind: "task", ref: `stash//tasks/${id}` },
    cron: schedule,
    source: "akm.schedule",
    ordinal: 0,
    enabled,
    invocation: ["task", "run", id, "--bundle", "stash", "--scheduled"],
  };
}

function mutationExpectation(
  binding: SchedulerBinding,
  state: "absent" | "present",
  fingerprint?: string,
): SchedulerMutationExpectation {
  return {
    state,
    bindingId: binding.id,
    nativeId: binding.nativeId ?? schedulerNativeBindingId(binding.id),
    logicalSource: binding.logicalSource,
    ordinal: binding.ordinal,
    invocation: binding.invocation,
    ...(fingerprint !== undefined ? { fingerprint } : {}),
  };
}

function removalExpectation(binding: SchedulerBinding, fingerprint: string): SchedulerRemovalExpectation {
  return {
    bindingId: binding.id,
    nativeId: binding.nativeId ?? schedulerNativeBindingId(binding.id),
    logicalSource: binding.logicalSource,
    ordinal: binding.ordinal,
    invocation: binding.invocation,
    fingerprint,
  };
}

function rollbackExpectation(
  binding: SchedulerBinding,
  allowed: SchedulerRollbackExpectation["allowed"],
): SchedulerRollbackExpectation {
  return {
    nativeId: binding.nativeId ?? schedulerNativeBindingId(binding.id),
    allowed,
  };
}

function syncResult<T>(value: T | Promise<T>, operation: string): T {
  if (value instanceof Promise) {
    throw new Error(`${operation} unexpectedly returned a Promise in the synchronous backend contract`);
  }
  return value;
}

function install(backend: SchedulerBackend, binding: SchedulerBinding, expected?: SchedulerMutationExpectation): void {
  syncResult(backend.install(binding, undefined, expected), "install");
}

function uninstall(backend: SchedulerBackend, expected: SchedulerRemovalExpectation): void {
  syncResult(backend.uninstall(expected.nativeId, expected), "uninstall");
}

function snapshot(backend: SchedulerBackend, ids: readonly string[]): unknown {
  if (!backend.snapshotBindings) throw new Error(`${backend.name} backend does not implement snapshotBindings`);
  return syncResult(backend.snapshotBindings(ids), "snapshotBindings");
}

function restore(
  backend: SchedulerBackend,
  saved: unknown,
  expectedCurrent?: readonly SchedulerRollbackExpectation[],
): void {
  if (!backend.restoreBindings) throw new Error(`${backend.name} backend does not implement restoreBindings`);
  syncResult(backend.restoreBindings(saved, expectedCurrent), "restoreBindings");
}

function list(backend: SchedulerBackend) {
  return syncResult(backend.list(), "list");
}

function listNativeArtifacts(backend: SchedulerBackend) {
  if (!backend.listNativeArtifacts) throw new Error(`${backend.name} backend does not implement listNativeArtifacts`);
  return syncResult(backend.listNativeArtifacts(), "listNativeArtifacts");
}

function higherOrdinalBinding(): SchedulerBinding {
  const bindings = compileTaskSchedulerBindings({
    id: "ping",
    qualifiedRef: "stash//tasks/ping",
    schedules: [
      { cron: "0 1 * * *", source: "akm.schedule[0]", ordinal: 0 },
      { cron: "0 2 * * *", source: "akm.schedule[1]", ordinal: 1 },
    ],
  });
  const binding = bindings[1];
  if (!binding) throw new Error("missing higher-ordinal scheduler binding fixture");
  return binding;
}

/** Register the native-scheduler invariants that are identical on every backend. */
export function schedulerBackendConformance(adapter: SchedulerBackendContractAdapter): void {
  describe(`${adapter.name} shared scheduler backend contract`, () => {
    test("create CAS rejects an artifact that appeared after frozen absence", () => {
      const driver = adapter.create();
      const binding = qualifiedSchedulerTask("0 9 * * *");
      install(driver.backend, binding);
      const prior = driver.captureState();
      driver.resetActivity();

      expect(() =>
        install(driver.backend, { ...binding, cron: "30 10 * * *" }, mutationExpectation(binding, "absent")),
      ).toThrow(/changed|absence|exists|compare|owner/i);
      expect(driver.captureState()).toEqual(prior);
      expect(driver.mutationCount()).toBe(0);
    });

    test("update CAS rejects same-owner native-definition drift", () => {
      const driver = adapter.create();
      const binding = qualifiedSchedulerTask("0 9 * * *");
      install(driver.backend, binding);
      const fingerprint = driver.currentFingerprint(binding);
      driver.driftArtifact(binding, "fingerprint");
      const drifted = driver.captureState();
      driver.resetActivity();

      expect(() =>
        install(
          driver.backend,
          { ...binding, cron: "30 10 * * *" },
          mutationExpectation(binding, "present", fingerprint),
        ),
      ).toThrow(/changed|fingerprint|compare/i);
      expect(driver.captureState()).toEqual(drifted);
      expect(driver.mutationCount()).toBe(0);
    });

    test("removal CAS rejects a binding that disappeared after frozen presence", () => {
      const driver = adapter.create();
      const binding = qualifiedSchedulerTask("0 9 * * *");
      install(driver.backend, binding);
      const expected = removalExpectation(binding, driver.currentFingerprint(binding));
      driver.clearArtifact(binding);
      const absent = driver.captureState();
      driver.resetActivity();

      expect(() => uninstall(driver.backend, expected)).toThrow(/changed|missing|present|compare/i);
      expect(driver.captureState()).toEqual(absent);
      expect(driver.mutationCount()).toBe(0);
    });

    test("update rejects a case-equivalent peer that appeared after planning", () => {
      const driver = adapter.create();
      const binding = qualifiedSchedulerTask("0 9 * * *");
      install(driver.backend, binding);
      const expected = mutationExpectation(binding, "present", driver.currentFingerprint(binding));
      driver.addNormalizedPeer(binding, "case");
      const duplicatedSnapshot = snapshot(driver.backend, [binding.id]) as { artifacts: readonly unknown[] };
      expect(duplicatedSnapshot.artifacts).toHaveLength(2);
      const duplicated = driver.captureState();
      driver.resetActivity();

      expect(() => install(driver.backend, { ...binding, cron: "30 10 * * *" }, expected)).toThrow(
        /cardinality|duplicate|collision|exactly one/i,
      );
      expect(driver.captureState()).toEqual(duplicated);
      expect(driver.mutationCount()).toBe(0);
    });

    test("forged expected source is rejected before native backend access", () => {
      const driver = adapter.create();
      const binding = qualifiedSchedulerTask("0 9 * * *");
      const forged: SchedulerMutationExpectation = {
        ...mutationExpectation(binding, "absent"),
        logicalSource: { kind: "task", ref: "other//tasks/ping" },
        invocation: ["task", "run", "ping", "--bundle", "other", "--scheduled"],
      };
      const prior = driver.captureState();
      driver.resetActivity();

      expect(() => install(driver.backend, binding, forged)).toThrow(/expectation|identity|binding|source/i);
      expect(driver.accessCount()).toBe(0);
      expect(driver.captureState()).toEqual(prior);
    });

    test("higher-ordinal binding round-trips through its base public owner", () => {
      const driver = adapter.create();
      const binding = higherOrdinalBinding();

      install(driver.backend, binding);
      expect(list(driver.backend)).toEqual([
        expect.objectContaining({
          id: binding.id,
          nativeId: schedulerNativeBindingId(binding.id),
          invocation: binding.invocation,
        }),
      ]);
      expect(listNativeArtifacts(driver.backend)).toEqual([
        expect.objectContaining({
          nativeId: schedulerNativeBindingId(binding.id),
          bindingId: binding.id,
          invocation: binding.invocation,
        }),
      ]);

      expect(() => install(driver.backend, binding)).not.toThrow();
      const drifted = { ...binding, cron: "30 2 * * *" };
      expect(() => install(driver.backend, drifted)).not.toThrow();
      expect(list(driver.backend)[0]?.signature).toBe(driver.backend.expectedSignature?.(drifted));
    });

    test.each([
      "foreign",
      "malformed",
      "fingerprint",
    ] as const)("higher-ordinal removal rechecks %s owner state immediately before mutation", (replacement) => {
      const driver = adapter.create();
      const binding = higherOrdinalBinding();
      install(driver.backend, binding);
      const expected = removalExpectation(binding, driver.currentFingerprint(binding));
      driver.driftArtifact(binding, replacement);
      const swapped = driver.captureState();
      driver.resetActivity();

      expect(() => uninstall(driver.backend, expected)).toThrow(/changed|owner|malformed|refusing/i);
      expect(driver.captureState()).toEqual(swapped);
      expect(driver.mutationCount()).toBe(0);
    });

    test("binding snapshot restores the exact disabled native definition", () => {
      const driver = adapter.create();
      const prior = qualifiedSchedulerTask("0 9 * * *", "ping", false);
      install(driver.backend, prior);
      const saved = snapshot(driver.backend, [prior.id]);
      const priorState = driver.captureState();

      install(driver.backend, { ...prior, cron: "30 10 * * *", enabled: true });
      restore(driver.backend, saved);

      expect(driver.captureState()).toEqual(priorState);
    });

    test("rollback CAS never clobbers a concurrent same-native edit", () => {
      const driver = adapter.create();
      const binding = qualifiedSchedulerTask("0 9 * * *");
      const saved = snapshot(driver.backend, [binding.id]);
      install(driver.backend, binding);
      const fingerprint = driver.currentFingerprint(binding);
      driver.driftArtifact(binding, "fingerprint");
      const concurrent = driver.captureState();
      driver.resetActivity();

      expect(() =>
        restore(driver.backend, saved, [
          rollbackExpectation(binding, [
            { state: "absent" },
            {
              state: "present",
              bindingId: binding.id,
              invocation: binding.invocation,
              fingerprint,
            },
          ]),
        ]),
      ).toThrow(/restore|rollback|changed|concurrent|fingerprint/i);
      expect(driver.captureState()).toEqual(concurrent);
      expect(driver.mutationCount()).toBe(0);
    });

    test.each([
      ["case", "absent"],
      ["trailing-dot", "present"],
    ] as const)("rollback rejects a %s peer beside a transaction-%s artifact", (peer, initial) => {
      const driver = adapter.create();
      const prior = qualifiedSchedulerTask("0 9 * * *");
      if (initial === "present") install(driver.backend, prior);
      const saved = snapshot(driver.backend, [prior.id]);
      const current = initial === "present" ? { ...prior, cron: "30 10 * * *" } : prior;
      install(driver.backend, current);
      const fingerprint = driver.currentFingerprint(current);
      driver.addNormalizedPeer(current, peer);
      const duplicated = driver.captureState();
      driver.resetActivity();

      expect(() =>
        restore(driver.backend, saved, [
          rollbackExpectation(current, [
            ...(initial === "absent" ? ([{ state: "absent" }] as const) : []),
            {
              state: "present",
              bindingId: current.id,
              invocation: current.invocation,
              fingerprint,
            },
          ]),
        ]),
      ).toThrow(/restore|rollback|cardinality|duplicate|collision|exactly one/i);
      expect(driver.captureState()).toEqual(duplicated);
      expect(driver.mutationCount()).toBe(0);
    });

    test("expected signature changes with the resolved AKM context", () => {
      const binding = qualifiedSchedulerTask("0 9 * * *");
      const original = adapter.create(adapter.scheduledContext);
      const moved = adapter.create(adapter.movedContext);

      expect(original.backend.expectedSignature?.(binding)).not.toBe(moved.backend.expectedSignature?.(binding));
    });
  });
}
