import { describe, expect, test } from "bun:test";
import {
  compileTaskSchedulerBindings,
  type SchedulerBackend,
  type SchedulerBinding,
  schedulerNativeBindingId,
} from "../../src/tasks/scheduler-binding";
import type { ScheduledTaskContext } from "../../src/tasks/scheduler-invocation";

/**
 * One backend under the shared scheduler contract, plus a view of its native
 * storage (crontab text, LaunchAgents plists, Task Scheduler XML) so the
 * contract asserts what was written rather than how. Parser, encoding and OS
 * command details stay in each backend's own suite.
 */
export interface SchedulerBackendContractDriver {
  readonly backend: SchedulerBackend;
  /** Everything the backend has written, in a comparable form. */
  captureState(): unknown;
  /** The native definition of one row (crontab block body, plist XML, task XML); undefined when absent. */
  rowText(nativeId: string): string | undefined;
  /** Plant a row a person wrote by hand, outside akm's markers, label prefix, or task folder. Returns a reader for it. */
  addForeignRow(): () => unknown;
  /** Plant an akm-marked row akm cannot parse, when the backend refuses to write around one. */
  addMalformedRow?(nativeId: string): void;
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

function higherOrdinalBinding(): SchedulerBinding {
  const binding = compileTaskSchedulerBindings({
    id: "ping",
    qualifiedRef: "stash//tasks/ping",
    schedules: [
      { cron: "0 1 * * *", source: "akm.schedule[0]", ordinal: 0 },
      { cron: "0 2 * * *", source: "akm.schedule[1]", ordinal: 1 },
    ],
  })[1];
  if (!binding) throw new Error("missing higher-ordinal scheduler binding fixture");
  return binding;
}

const nativeIdOf = (binding: SchedulerBinding) => binding.nativeId ?? schedulerNativeBindingId(binding.id);

/** Register the native-scheduler behaviour that is identical on every backend. */
export function schedulerBackendConformance(adapter: SchedulerBackendContractAdapter): void {
  describe(`${adapter.name} shared scheduler backend contract`, () => {
    test("install renders the row the binding describes and lists it back", async () => {
      const { backend, rowText } = adapter.create();
      const binding = qualifiedSchedulerTask("0 9 * * *");

      await backend.install(binding);

      const text = rowText(nativeIdOf(binding));
      expect(text).toContain("--scheduler-context");
      expect(text).toContain("--scheduled");
      const rows = await backend.list();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: "ping",
        nativeId: "ping",
        enabled: true,
        invocation: binding.invocation,
        signature: backend.expectedSignature?.(binding),
      });
      expect(rows[0]?.binding.length).toBeGreaterThan(0);
      expect(rows[0]?.contextPath).toMatch(/\.json$/);
    });

    test("re-installing the same binding is idempotent", async () => {
      const driver = adapter.create();
      const binding = qualifiedSchedulerTask("0 9 * * *");
      await driver.backend.install(binding);
      const first = driver.captureState();

      await driver.backend.install(binding);

      expect(driver.captureState()).toEqual(first);
      expect(await driver.backend.list()).toHaveLength(1);
    });

    test("installing a changed binding replaces its row", async () => {
      const { backend, rowText } = adapter.create();
      const binding = qualifiedSchedulerTask("0 9 * * *");
      await backend.install(binding);
      const before = rowText(nativeIdOf(binding));
      const changed = { ...binding, cron: "30 10 * * *" };

      await backend.install(changed);

      const rows = await backend.list();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.signature).toBe(backend.expectedSignature?.(changed));
      expect(rows[0]?.signature).not.toBe(backend.expectedSignature?.(binding));
      expect(rowText(nativeIdOf(binding))).not.toBe(before);
    });

    test("uninstall removes exactly that row, and a row already gone is not an error", async () => {
      const { backend, rowText } = adapter.create();
      const ping = qualifiedSchedulerTask("0 9 * * *", "ping");
      const pong = qualifiedSchedulerTask("0 10 * * *", "pong");
      await backend.install(ping);
      await backend.install(pong);
      const pongText = rowText("pong");

      await backend.uninstall("ping");
      await backend.uninstall("ping");

      expect((await backend.list()).map((row) => row.id)).toEqual(["pong"]);
      expect(rowText("ping")).toBeUndefined();
      expect(rowText("pong")).toBe(pongText);
    });

    test("setEnabled toggles a row off and back on", async () => {
      const { backend } = adapter.create();
      await backend.install(qualifiedSchedulerTask("0 9 * * *"));

      await backend.setEnabled("ping", false);
      expect((await backend.list())[0]?.enabled).toBe(false);

      await backend.setEnabled("ping", true);
      expect((await backend.list())[0]?.enabled).toBe(true);
    });

    test("a binding installed disabled lists as disabled and renders differently", async () => {
      const { backend } = adapter.create();
      const disabled = qualifiedSchedulerTask("0 9 * * *", "ping", false);

      await backend.install(disabled);

      expect((await backend.list())[0]?.enabled).toBe(false);
      expect(backend.expectedSignature?.(disabled)).not.toBe(
        backend.expectedSignature?.(qualifiedSchedulerTask("0 9 * * *")),
      );
    });

    test("a row a person added by hand is never listed or touched", async () => {
      const driver = adapter.create();
      const readForeign = driver.addForeignRow();
      const foreign = readForeign();
      const binding = qualifiedSchedulerTask("0 9 * * *");

      await driver.backend.install(binding);
      await driver.backend.install({ ...binding, cron: "30 10 * * *" });
      await driver.backend.setEnabled("ping", false);
      await driver.backend.uninstall("ping");

      expect(await driver.backend.list()).toEqual([]);
      expect(readForeign()).toEqual(foreign);
    });

    test("a higher-ordinal binding round-trips through its digest id", async () => {
      const { backend } = adapter.create();
      const binding = higherOrdinalBinding();

      await backend.install(binding);

      expect(await backend.list()).toEqual([
        expect.objectContaining({ id: binding.id, nativeId: nativeIdOf(binding), invocation: binding.invocation }),
      ]);
    });

    test("the expected signature follows the scheduler context the row references", () => {
      const binding = qualifiedSchedulerTask("0 9 * * *");
      const original = adapter.create(adapter.scheduledContext);
      const moved = adapter.create(adapter.movedContext);

      expect(original.backend.expectedSignature?.(binding)).not.toBe(moved.backend.expectedSignature?.(binding));
    });

    test("an akm-marked row akm cannot parse is refused, not rewritten", async () => {
      const driver = adapter.create();
      if (!driver.addMalformedRow) return;
      driver.addMalformedRow("ping");
      const before = driver.captureState();

      expect(() => driver.backend.install(qualifiedSchedulerTask("0 9 * * *"))).toThrow(/malformed/i);
      expect(driver.captureState()).toEqual(before);
    });
  });
}
