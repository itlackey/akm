// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Test-review remediation (spec docs/plans/specs/p2a-task-source-v4.md §5.2,
 * D2-N6, B-38) for the finding recorded against
 * docs/plans/specs/p2a-task-source-v4.md:501: B-07 ("a `version: 4` task with
 * no `schedule:` parses, contributes ZERO scheduler bindings, records ZERO
 * failures, and emits no diagnostic through `akm task sync`") had no test
 * anywhere, even though §9 names it as an explicit acceptance bullet. This
 * file was originally deliberately new and separate from
 * tests/integration/tasks-scheduler-sync-v3.test.ts, which §7/F-4 required to
 * stay byte-unchanged at the time.
 *
 * P4 (docs/plans/specs/p4-deletions-closeout.md §3.2.7, F-A2.6) deleted
 * `tests/integration/tasks-scheduler-sync-v3.test.ts` along with task source
 * v3 acceptance — its 23 tests' SUBJECT was v3 parsing, but almost none of
 * their BEHAVIOR was actually about task source version: the whole-set CAS
 * mechanics, native-artifact collision detection, drift/removal diffing,
 * task+workflow composition, and poisoning behavior they proved are generic
 * `scheduler-sync.ts` invariants that a task source v4 fixture demonstrates
 * exactly as well as a v3 one did. Per F-A2.6's instruction, that behavior
 * ported here (fixtures converted to task source v4; assertions unchanged)
 * rather than being lost with the file. The one genuinely v3-specific case
 * (the GitHub Action locator's pre-signature rejection, F-A1.15) is replaced
 * by an equivalent `docker://` case below — the ordering invariant it pins
 * ("a workflow-step uses: rejection happens before any scheduler signature
 * call") is independent of which unsupported-ref shape triggers it, and the
 * locator grammar itself is already covered by
 * tests/execution/target-ref.test.ts and
 * tests/workflows/characterization-classification.test.ts (F-A1.7/F-A1.3).
 *
 * Structure mirrors the deleted file's `root()`/`write()`/`planSchedulerSync()`
 * helpers and `SchedulerSyncPlanInput` shape — only the fixtures differ.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _setWarnSinkForTests } from "../src/core/warn";
import { compileTaskSchedulerBindings, schedulerNativeBindingId } from "../src/tasks/scheduler-binding";
import {
  finalizeSchedulerSyncPlan,
  prepareSchedulerSyncSourceSet,
  type SchedulerSyncPlanInput,
} from "../src/tasks/scheduler-sync";
import { overrideSeam } from "./_helpers/seams";

async function planSchedulerSync(input: SchedulerSyncPlanInput) {
  return finalizeSchedulerSyncPlan(input, await prepareSchedulerSyncSourceSet(input));
}

function root(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-scheduler-sync-v4-"));
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const emptyInstalled = [] as const;

describe("whole-set task source v4 scheduler sync planning — B-07 (manual-only, D2-N6)", () => {
  test("a version: 4 task with no schedule: contributes ZERO bindings and records ZERO failures — prepareSchedulerSyncSourceSet does not reject", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "manual-only.yml"),
      ["version: 4", "run: echo manual-only", "shell: sh", ""].join("\n"),
    );

    // Today this REJECTS (see file header) — the assertion that it resolves
    // at all is the B-07 pin, independent of the shape assertions below.
    const prepared = await prepareSchedulerSyncSourceSet({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
    });
    expect(prepared.desired).toEqual([]);
  });

  test("a version: 4 task with no schedule: is a whole-set no-op: zero desired bindings, zero operations, on an otherwise-empty installed set", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "manual-only.yml"),
      ["version: 4", "run: echo manual-only", "shell: sh", ""].join("\n"),
    );

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
      expectedSignature: (binding) => `sig:${binding.id}`,
    });

    expect(plan.desired).toEqual([]);
    expect(plan.operations).toEqual([]);
    expect(plan.installed).toEqual([]);
    expect(plan.updated).toEqual([]);
    expect(plan.removed).toEqual([]);
    expect(plan.unchanged).toEqual([]);
  });

  // P4 FLIP (docs/plans/specs/p4-deletions-closeout.md §7.2, F-A2.33): the
  // "v3 alongside v4 coexistence" case this used to pin is no longer
  // expressible — task source v3 is gone, so both tasks in the mixed set are
  // now version: 4. The behavior proved (a manual-only task contributes
  // nothing while a scheduled sibling still installs) is unchanged.
  test("a manual-only version: 4 task alongside a normally-scheduled version: 4 task: the scheduled task still installs, the manual-only task contributes nothing", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "manual-only.yml"),
      ["version: 4", "run: echo manual-only", "shell: sh", ""].join("\n"),
    );
    write(
      path.join(bundleRoot, "tasks", "nightly.yml"),
      ["version: 4", "run: echo index", "shell: sh", "schedule: '@daily'", ""].join("\n"),
    );

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
      expectedSignature: (binding) => `sig:${binding.id}`,
    });

    expect(plan.desired).toHaveLength(1);
    expect(plan.desired[0]?.logicalSource).toEqual({ kind: "task", ref: "team//tasks/nightly" });
    expect(plan.operations).toHaveLength(1);
  });

  test("emits no diagnostic (no warn()) for a manual-only version: 4 task — B-38's warn is scoped to non-empty schedule[i].inputs only", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "manual-only.yml"),
      ["version: 4", "run: echo manual-only", "shell: sh", ""].join("\n"),
    );
    const warnCalls: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level !== "warn") return;
      warnCalls.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
    });

    await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
      expectedSignature: (binding) => `sig:${binding.id}`,
    });

    expect(warnCalls).toEqual([]);
  });
});

describe("whole-set task source v4 scheduler sync planning — locally activated scheduled bindings (B-08..B-10)", () => {
  test("a scheduled version: 4 task compiles exactly one binding via the SAME compileTaskSchedulerBindings seam as v3", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "nightly-v4.yml"),
      ["version: 4", "run: echo nightly", "shell: sh", "schedule: '0 8 * * 1'", ""].join("\n"),
    );

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
      expectedSignature: (binding) => `sig:${binding.id}`,
    });

    expect(plan.desired).toHaveLength(1);
    expect(plan.desired[0]?.id).toBe("nightly-v4");
    expect(plan.desired[0]?.nativeId).toBe(schedulerNativeBindingId("nightly-v4"));
    expect(plan.desired[0]?.cron).toBe("0 8 * * 1");
    expect(plan.desired[0]?.enabled).toBe(true);
    expect(plan.operations.map(({ kind }) => kind)).toEqual(["install"]);
  });
});

describe("whole-set task source v4 scheduler sync planning — B-45/F-B2 (schedule[i].inputs delivered as a sorted invocation tail)", () => {
  // P2b Lane B flip (spec docs/plans/specs/p2b-input-bindings.md §4.4, §7
  // F-B2): the P2a B-38 gap this describe block used to pin ("validated but
  // not yet delivered", single per-task warn, byte-identical fixed tail) is
  // now CLOSED — schedule[i].inputs are delivered through the compiled
  // binding's own invocation tail, so there is nothing left to warn about.
  test("schedule[i].inputs non-empty compiles a sorted --<name> <value> tail per entry — no warn, and each entry's tail reflects its OWN inputs", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "ticketed.yml"),
      [
        "version: 4",
        "run: echo ticketed",
        "shell: sh",
        "inputs:",
        "  scope:",
        "    type: string",
        "schedule:",
        // TWO entries with DIFFERENT inputs: — proves each entry's own tail
        // is compiled from its OWN inputs, never shared/collapsed.
        "  - cron: '0 8 * * 1'",
        "    inputs:",
        "      scope: all",
        "  - cron: '0 9 * * 2'",
        "    inputs:",
        "      scope: changed",
        "",
      ].join("\n"),
    );
    const warnCalls: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level !== "warn") return;
      warnCalls.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
    });

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
      expectedSignature: (binding) => `sig:${binding.id}`,
    });

    // No warn: the gap the old warn announced is closed.
    expect(warnCalls).toEqual([]);

    // Each compiled binding carries its OWN schedule entry's inputs as a
    // sorted `--<name> <value>` tail after `--scheduled`.
    expect(plan.desired).toHaveLength(2);
    const byOrdinal = [...plan.desired].sort((left, right) => left.ordinal - right.ordinal);
    expect(byOrdinal[0]?.invocation).toEqual([
      "task",
      "run",
      "ticketed",
      "--bundle",
      "team",
      "--scheduled",
      "--scope",
      "all",
    ]);
    expect(byOrdinal[1]?.invocation).toEqual([
      "task",
      "run",
      "ticketed",
      "--bundle",
      "team",
      "--scheduled",
      "--scope",
      "changed",
    ]);
  });

  test("schedule[i].inputs violating the declared input's schema still fails at PARSE time (TASK_SOURCE_INVALID), not silently at sync time", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "bad-schedule-inputs.yml"),
      [
        "version: 4",
        "run: echo bad",
        "shell: sh",
        "inputs:",
        "  scope:",
        "    type: string",
        "    enum: [changed, all]",
        "schedule:",
        "  - cron: '0 8 * * 1'",
        "    inputs:",
        "      scope: bogus",
        "",
      ].join("\n"),
    );

    // #867: compileTaskSources' per-source try/catch turns a per-file parse
    // failure into one `failures` entry. prepareSchedulerSyncSourceSet no
    // longer rejects the whole set over it — it degrades, reporting the
    // failure and reconciling every other source (none, here).
    const prepared = await prepareSchedulerSyncSourceSet({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
    });
    expect(prepared.desired).toEqual([]);
    expect(prepared.failures).toHaveLength(1);
    expect(prepared.failures[0]?.path).toContain("bad-schedule-inputs.yml");
    expect(prepared.failures[0]?.reason).toMatch(/schedule\[0\] inputs\.scope: value is not one of/);
  });

  test("a required, default-less input paired with the schedule: shorthand is rejected at PARSE time, before any scheduler mutation (0.9.2 review)", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "unrunnable-schedule.yml"),
      [
        "version: 4",
        "run: echo needs-a-ticket",
        "shell: sh",
        "inputs:",
        "  ticket:",
        "    type: string",
        "    required: true",
        "schedule: '0 8 * * 1'",
        "",
      ].join("\n"),
    );

    // The scheduled invocation tail carries only the entry's own
    // `schedule[i].inputs` (scheduler-binding.ts), and a `required: true`
    // declaration may not carry a `default`, so this schedule could never
    // run. sync's own projectability proof (scheduler-sync.ts) still holds
    // an independent copy of the check over the DEFAULTED view; what changed
    // is that the contradiction is now caught by `parseTaskSource` itself, so
    // the failure names the offending `schedule` FIELD PATH rather than only
    // the task ref, and an author sees it without running `akm task sync`.
    // #867: this is still a per-source parse failure — it degrades rather
    // than rejecting the whole (empty, here) desired set.
    const prepared = await prepareSchedulerSyncSourceSet({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
    });
    expect(prepared.desired).toEqual([]);
    expect(prepared.failures).toHaveLength(1);
    expect(prepared.failures[0]?.reason).toMatch(/inputs\.ticket: is required/);
  });
});

// ── Ported from the deleted tests/integration/tasks-scheduler-sync-v3.test.ts ──
// ── (spec docs/plans/specs/p4-deletions-closeout.md §3.2.7, F-A2.6): the ───────
// ── generic whole-set CAS/collision/composition mechanics below never depended ─
// ── on task source version — only the task fixtures convert to v4; every ───────
// ── assertion is unchanged from the deleted file. ───────────────────────────────

describe("whole-set scheduler sync planning — task+workflow composition and CAS mechanics (ported, F-A2.6)", () => {
  test("compiles task and workflow schedules together and never installs workflow_dispatch", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "nightly.yml"),
      "version: 4\nrun: echo index\nshell: sh\nschedule: '@daily'\n",
    );
    write(
      path.join(bundleRoot, "workflows", "release.yml"),
      [
        "name: release",
        "on:",
        "  schedule:",
        "    - cron: '0 8 * * 1'",
        "    - cron: '0 9 * * 2'",
        "  workflow_dispatch: {}",
        "jobs:",
        "  publish:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: publish",
        "        run: echo publish",
      ].join("\n"),
    );

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
      expectedSignature: (binding) => `sig:${binding.id}`,
    });

    expect(plan.desired).toHaveLength(3);
    expect(plan.desired.map(({ logicalSource }) => logicalSource)).toEqual([
      { kind: "task", ref: "team//tasks/nightly" },
      { kind: "workflow", ref: "team//workflows/release" },
      { kind: "workflow", ref: "team//workflows/release" },
    ]);
    expect(plan.operations.map(({ kind }) => kind)).toEqual(["install", "install", "install"]);
  });

  test("a valid multi-schedule task is an exact no-op on its identical second whole-set plan", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "nightly.yml"),
      [
        "version: 4",
        "run: echo index",
        "shell: sh",
        "schedule:",
        "  - cron: '0 1 * * *'",
        "  - cron: '0 2 * * *'",
        "",
      ].join("\n"),
    );
    const base = {
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron" as const,
      expectedSignature: (binding: { id: string; cron: string }) => `${binding.id}:${binding.cron}`,
    };
    const initial = await planSchedulerSync({ ...base, installed: emptyInstalled });
    const installed = initial.desired.map((binding) => ({
      id: binding.id,
      nativeId: schedulerNativeBindingId(binding.id),
      binding: ["/opt/akm"],
      contextPath: "/state/context.json",
      target: "team",
      invocation: binding.invocation,
      signature: `${binding.id}:${binding.cron}`,
    }));
    const nativeArtifacts = initial.desired.map((binding) => ({
      nativeId: schedulerNativeBindingId(binding.id),
      bindingId: binding.id,
      invocation: binding.invocation,
    }));

    const second = await planSchedulerSync({ ...base, installed, nativeArtifacts } as never);

    expect(second.unchanged).toEqual(initial.desired.map(({ id }) => id));
    expect(second.operations).toEqual([]);
  });

  test("multi-schedule drift updates only the changed higher ordinal binding", async () => {
    const bundleRoot = root();
    const file = path.join(bundleRoot, "tasks", "nightly.yml");
    const source = (second: string) =>
      [
        "version: 4",
        "run: echo index",
        "shell: sh",
        "schedule:",
        "  - cron: '0 1 * * *'",
        `  - cron: '${second}'`,
        "",
      ].join("\n");
    write(file, source("0 2 * * *"));
    const base = {
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron" as const,
      expectedSignature: (binding: { id: string; cron: string }) => `${binding.id}:${binding.cron}`,
    };
    const initial = await planSchedulerSync({ ...base, installed: emptyInstalled });
    const installed = initial.desired.map((binding) => ({
      id: binding.id,
      nativeId: schedulerNativeBindingId(binding.id),
      binding: ["/opt/akm"],
      contextPath: "/state/context.json",
      target: "team",
      invocation: binding.invocation,
      signature: `${binding.id}:${binding.cron}`,
    }));
    const nativeArtifacts = initial.desired.map((binding) => ({
      nativeId: schedulerNativeBindingId(binding.id),
      bindingId: binding.id,
      invocation: binding.invocation,
    }));
    write(file, source("30 2 * * *"));

    const drift = await planSchedulerSync({ ...base, installed, nativeArtifacts } as never);

    expect(drift.unchanged).toEqual([initial.desired[0]!.id]);
    expect(drift.updated).toEqual([initial.desired[1]!.id]);
  });

  test("higher-ordinal removal freezes the exact parsed owner and installed fingerprint", async () => {
    const bundleRoot = root();
    const file = path.join(bundleRoot, "tasks", "nightly.yml");
    write(file, "version: 4\nrun: echo index\nshell: sh\nschedule:\n  - cron: '0 1 * * *'\n  - cron: '0 2 * * *'\n");
    const base = {
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron" as const,
      expectedSignature: (binding: { id: string; cron: string }) => `${binding.id}:${binding.cron}`,
    };
    const initial = await planSchedulerSync({ ...base, installed: emptyInstalled });
    const installed = initial.desired.map((binding) => ({
      id: binding.id,
      nativeId: schedulerNativeBindingId(binding.id),
      binding: ["/opt/akm"],
      contextPath: "/state/context.json",
      target: "team",
      invocation: binding.invocation,
      signature: `${binding.id}:${binding.cron}`,
    }));
    const nativeArtifacts = initial.desired.map((binding) => ({
      nativeId: schedulerNativeBindingId(binding.id),
      bindingId: binding.id,
      invocation: binding.invocation,
    }));
    write(file, "version: 4\nrun: echo index\nshell: sh\nschedule:\n  - cron: '0 1 * * *'\n");

    const removal = await planSchedulerSync({ ...base, installed, nativeArtifacts } as never);
    const removed = initial.desired[1];
    if (!removed) throw new Error("missing higher-ordinal binding");
    expect(removal.operations).toContainEqual({
      kind: "remove",
      id: removed.id,
      nativeId: schedulerNativeBindingId(removed.id),
      expected: {
        state: "present",
        bindingId: removed.id,
        nativeId: schedulerNativeBindingId(removed.id),
        logicalSource: removed.logicalSource,
        ordinal: removed.ordinal,
        invocation: removed.invocation,
        fingerprint: `${removed.id}:${removed.cron}`,
      },
    });
  });

  test("freezes exact absence and exact prior CAS state on every planned mutation", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "create.yml"),
      "version: 4\nrun: echo create\nshell: sh\nschedule: '0 1 * * *'\n",
    );
    write(
      path.join(bundleRoot, "tasks", "update.yml"),
      "version: 4\nrun: echo update\nshell: sh\nschedule: '0 2 * * *'\n",
    );
    const existing = compileTaskSchedulerBindings({
      id: "update",
      qualifiedRef: "team//tasks/update",
      schedules: [{ cron: "30 2 * * *", source: "schedule", ordinal: 0 }],
    })[0]!;
    const installed = {
      id: existing.id,
      nativeId: existing.nativeId,
      binding: ["/opt/akm"],
      contextPath: "/state/context.json",
      target: "team",
      invocation: existing.invocation,
      signature: "installed-fingerprint",
    };

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      backend: "cron",
      installed: [installed],
      nativeArtifacts: [
        {
          nativeId: existing.nativeId!,
          bindingId: existing.id,
          invocation: existing.invocation,
          fingerprint: "installed-fingerprint",
        },
      ],
      expectedSignature: (item) => `desired:${item.id}:${item.cron}`,
    });

    const create = plan.operations.find((operation) => operation.kind === "install");
    const update = plan.operations.find((operation) => operation.kind === "update");
    expect(create).toMatchObject({
      expected: {
        state: "absent",
        bindingId: "create",
        nativeId: "create",
        logicalSource: { kind: "task", ref: "team//tasks/create" },
        ordinal: 0,
        invocation: ["task", "run", "create", "--bundle", "team", "--scheduled"],
      },
    });
    expect(update).toMatchObject({
      expected: {
        state: "present",
        bindingId: "update",
        nativeId: "update",
        logicalSource: { kind: "task", ref: "team//tasks/update" },
        ordinal: 0,
        invocation: ["task", "run", "update", "--bundle", "team", "--scheduled"],
        fingerprint: "installed-fingerprint",
      },
    });
  });

  test("rejects incoherent installed and native fingerprints instead of planning a false no-op", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "nightly.yml"),
      "version: 4\nrun: echo nightly\nshell: sh\nschedule: '0 1 * * *'\n",
    );
    const [desired] = compileTaskSchedulerBindings({
      id: "nightly",
      qualifiedRef: "team//tasks/nightly",
      schedules: [{ cron: "0 1 * * *", source: "schedule", ordinal: 0 }],
    });
    if (!desired) throw new Error("missing binding");

    await expect(
      planSchedulerSync({
        sourceRoot: bundleRoot,
        adapterId: "akm",
        bundleName: "team",
        backend: "cron",
        installed: [
          {
            id: desired.id,
            nativeId: desired.nativeId,
            binding: ["/opt/akm"],
            contextPath: "/state/context.json",
            target: "team",
            invocation: desired.invocation,
            signature: "stale-list-fingerprint",
          },
        ],
        nativeArtifacts: [
          {
            nativeId: desired.nativeId!,
            bindingId: desired.id,
            invocation: desired.invocation,
            fingerprint: "newer-native-fingerprint",
          },
        ],
        expectedSignature: () => "stale-list-fingerprint",
      }),
    ).rejects.toThrow(/coherent|fingerprint|changed/i);
  });

  test("a production coherent inspection cannot omit the native fingerprint behind a listed no-op", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "nightly.yml"),
      "version: 4\nrun: echo nightly\nshell: sh\nschedule: '0 1 * * *'\n",
    );
    const [desired] = compileTaskSchedulerBindings({
      id: "nightly",
      qualifiedRef: "team//tasks/nightly",
      schedules: [{ cron: "0 1 * * *", source: "schedule", ordinal: 0 }],
    });
    if (!desired) throw new Error("missing binding");
    const installed = {
      id: desired.id,
      nativeId: desired.nativeId,
      binding: ["/opt/akm"],
      contextPath: "/state/context.json",
      target: "team",
      invocation: desired.invocation,
      signature: "desired-fingerprint",
    };
    const artifact = {
      nativeId: desired.nativeId!,
      bindingId: desired.id,
      invocation: desired.invocation,
    };

    await expect(
      planSchedulerSync({
        sourceRoot: bundleRoot,
        adapterId: "akm",
        bundleName: "team",
        backend: "cron",
        installed: [installed],
        nativeArtifacts: [artifact],
        inspection: { installed: [installed], artifacts: [artifact] },
        expectedSignature: () => "desired-fingerprint",
      }),
    ).rejects.toThrow(/coherent|fingerprint|changed/i);
  });

  test("accepts the workflow-only tasks target through canonical step authority", async () => {
    const bundleRoot = root();
    // Manual-only (D2-N6): a task source v4 document with no schedule: is
    // reached only through a workflow step's uses: tasks/child, never
    // scheduled directly — the v3 fixture's `on: {workflow_dispatch: {}}`
    // meant exactly the same thing.
    write(path.join(bundleRoot, "tasks", "child.yml"), "version: 4\nrun: echo child\nshell: sh\n");
    write(
      path.join(bundleRoot, "workflows", "parent.yml"),
      [
        "name: parent",
        "on:",
        "  schedule:",
        "    - cron: '0 8 * * 1'",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: child",
        "        uses: tasks/child",
      ].join("\n"),
    );

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
    });

    expect(plan.desired).toHaveLength(1);
    expect(plan.desired[0]?.logicalSource).toEqual({ kind: "workflow", ref: "team//workflows/parent" });
  });

  // P4 (docs/plans/specs/p4-deletions-closeout.md §3.1, row B-05): the
  // GitHub Action locator grammar this used to pin
  // (`actions/checkout@v4` -> `remote-action-acquisition-out-of-scope`, then
  // F-A1.15's flip to `unsupported-uses-target`) is deleted along with this
  // file's v3 predecessor. `docker://` proves the SAME ordering invariant
  // (a workflow-step uses: rejection fires before any scheduler signature
  // call) using a still-generic, permanently-rejected ref shape (row
  // B-06..B-08, untouched by A1/A2) — the locator-specific rejection message
  // itself stays pinned in tests/execution/target-ref.test.ts and
  // tests/workflows/characterization-classification.test.ts.
  test("rejects an unsupported workflow-step uses: target before scheduler signatures or mutation preparation", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "workflows", "parent.yml"),
      [
        "name: parent",
        "on:",
        "  schedule:",
        "    - cron: '0 8 * * 1'",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: child",
        "        uses: docker://alpine:3",
      ].join("\n"),
    );
    let signatures = 0;

    // #867: an unsupported workflow-step target is a per-source failure —
    // it degrades (no bindings desired for this lone source, no signature
    // call) rather than rejecting the whole sync.
    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
      expectedSignature: () => {
        signatures += 1;
        return "sig";
      },
    });
    expect(plan.desired).toEqual([]);
    expect(plan.failures).toHaveLength(1);
    expect(plan.failures[0]?.reason).toMatch(/must be a canonical/);
    expect(signatures).toBe(0);
  });

  test("enumerates a standalone akm-task bundle with qualified logical refs", async () => {
    const bundleRoot = root();
    write(path.join(bundleRoot, "nightly.yml"), "version: 4\nrun: echo yes\nshell: sh\nschedule: '@daily'\n");

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm-task",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
    });

    expect(plan.desired).toHaveLength(1);
    expect(plan.desired[0]?.logicalSource).toEqual({ kind: "task", ref: "team//nightly" });
    expect(plan.desired[0]?.invocation).toEqual(["task", "run", "nightly", "--bundle", "team", "--scheduled"]);
  });

  test("preserves an arbitrary-depth standalone task concept id through the whole plan", async () => {
    const componentRoot = root();
    write(
      path.join(componentRoot, "sub", "deep", "nightly.yml"),
      "version: 4\nrun: echo nested\nshell: sh\nschedule: '@daily'\n",
    );

    const plan = await planSchedulerSync({
      sourceRoot: componentRoot,
      adapterId: "akm-task",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
    });

    expect(plan.desired).toHaveLength(1);
    expect(plan.desired[0]).toMatchObject({
      id: "sub/deep/nightly",
      logicalSource: { kind: "task", ref: "team//sub/deep/nightly" },
      invocation: ["task", "run", "sub/deep/nightly", "--bundle", "team", "--scheduled"],
    });
  });

  test("duplicate standalone basenames retain distinct canonical ids instead of colliding", async () => {
    const componentRoot = root();
    write(
      path.join(componentRoot, "alpha", "nightly.yml"),
      "version: 4\nrun: echo alpha\nshell: sh\nschedule: '@daily'\n",
    );
    write(
      path.join(componentRoot, "beta", "nightly.yml"),
      "version: 4\nrun: echo beta\nshell: sh\nschedule: '@daily'\n",
    );

    const plan = await planSchedulerSync({
      sourceRoot: componentRoot,
      adapterId: "akm-task",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
    });

    expect(plan.desired.map(({ id }) => id)).toEqual(["alpha/nightly", "beta/nightly"]);
    expect(plan.desired.map(({ logicalSource }) => logicalSource.ref)).toEqual([
      "team//alpha/nightly",
      "team//beta/nightly",
    ]);
  });

  test("rejects logical ids whose exact native scheduler artifacts collide before signatures", async () => {
    const componentRoot = root();
    write(
      path.join(componentRoot, "sub", "nightly.yml"),
      "version: 4\nrun: echo nested\nshell: sh\nschedule: '@daily'\n",
    );
    write(
      path.join(componentRoot, "task-5f14bc23cb233df4713f2e147b6c077f.yml"),
      "version: 4\nrun: echo flat\nshell: sh\nschedule: '@daily'\n",
    );
    let signatures = 0;

    await expect(
      planSchedulerSync({
        sourceRoot: componentRoot,
        adapterId: "akm-task",
        bundleName: "team",
        bundleTarget: "team",
        backend: "cron",
        installed: emptyInstalled,
        expectedSignature: () => {
          signatures += 1;
          return "signature";
        },
      }),
    ).rejects.toThrow(/native scheduler artifact|collision/i);
    expect(signatures).toBe(0);
  });

  test.each([
    ["case folding", "Nightly", "nightly"],
  ] as const)("rejects portable native artifact collisions caused by %s", async (_label, first, second) => {
    const componentRoot = root();
    write(path.join(componentRoot, `${first}.yml`), "version: 4\nrun: echo first\nshell: sh\nschedule: '@daily'\n");
    write(path.join(componentRoot, `${second}.yml`), "version: 4\nrun: echo second\nshell: sh\nschedule: '@daily'\n");
    let signatures = 0;

    await expect(
      planSchedulerSync({
        sourceRoot: componentRoot,
        adapterId: "akm-task",
        bundleName: "team",
        bundleTarget: "team",
        backend: "schtasks",
        installed: emptyInstalled,
        expectedSignature: () => {
          signatures += 1;
          return "signature";
        },
      }),
    ).rejects.toThrow(/native scheduler artifact|collision/i);
    expect(signatures).toBe(0);
  });

  test("rejects a single logical/native id ending in a period before signatures", async () => {
    const componentRoot = root();
    write(path.join(componentRoot, "nightly..yml"), "version: 4\nrun: echo unsafe\nshell: sh\nschedule: '@daily'\n");
    let signatures = 0;

    // #867: an unportable id is a per-source failure — it degrades (no
    // bindings desired for this lone source, no signature call) rather
    // than rejecting the whole sync.
    const plan = await planSchedulerSync({
      sourceRoot: componentRoot,
      adapterId: "akm-task",
      bundleName: "team",
      bundleTarget: "team",
      backend: "schtasks",
      installed: emptyInstalled,
      expectedSignature: () => {
        signatures += 1;
        return "signature";
      },
    });
    expect(plan.desired).toEqual([]);
    expect(plan.failures).toHaveLength(1);
    expect(plan.failures[0]?.reason).toMatch(/period|portable|native scheduler artifact/i);
    expect(signatures).toBe(0);
  });

  test.each([
    ["different logical owner", "task-5f14bc23cb233df4713f2e147b6c077f"],
    ["malformed source-absent owner", undefined],
  ] as const)("rejects an installed %s at the desired exact native artifact before signatures", async (_label, bindingId) => {
    const componentRoot = root();
    write(
      path.join(componentRoot, "sub", "nightly.yml"),
      "version: 4\nrun: echo nested\nshell: sh\nschedule: '@daily'\n",
    );
    let signatures = 0;
    const nativeArtifacts = [
      {
        nativeId: "task-5f14bc23cb233df4713f2e147b6c077f",
        ...(bindingId
          ? {
              bindingId,
              invocation: ["task", "run", bindingId, "--bundle", "team", "--scheduled"],
            }
          : {}),
      },
    ];

    await expect(
      planSchedulerSync({
        sourceRoot: componentRoot,
        adapterId: "akm-task",
        bundleName: "team",
        bundleTarget: "team",
        backend: "cron",
        installed: emptyInstalled,
        nativeArtifacts,
        expectedSignature: () => {
          signatures += 1;
          return "signature";
        },
      } as never),
    ).rejects.toThrow(/native scheduler artifact|collision|unproven owner/i);
    expect(signatures).toBe(0);
  });

  test("rejects a foreign fully-qualified workflow owner under the same binding and native id", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "workflows", "release.yml"),
      "name: release\non:\n  schedule:\n    - cron: '0 8 * * 1'\njobs:\n  main:\n    runs-on: [self-hosted]\n    steps:\n      - id: release\n        run: echo release\n",
    );
    const base = {
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron" as const,
    };
    const initial = await planSchedulerSync({ ...base, installed: emptyInstalled });
    const workflow = initial.desired.find((binding) => binding.logicalSource.kind === "workflow");
    if (!workflow) throw new Error("missing workflow binding");
    const foreignInvocation = ["workflow", "run", "team//workflows/other"] as const;

    await expect(
      planSchedulerSync({
        ...base,
        installed: [
          {
            id: workflow.id,
            nativeId: workflow.nativeId,
            binding: ["/opt/akm"],
            contextPath: "/state/context.json",
            target: "team",
            invocation: foreignInvocation,
          },
        ],
        nativeArtifacts: [
          { nativeId: workflow.nativeId ?? workflow.id, bindingId: workflow.id, invocation: foreignInvocation },
        ],
      }),
    ).rejects.toThrow(/native scheduler artifact|collision|team\/\/workflows\/other/i);
  });

  test("a proven source-absent nested owner removes by its exact enumerated native id", async () => {
    const componentRoot = root();
    const nativeId = "task-5f14bc23cb233df4713f2e147b6c077f";
    const installed = {
      id: "sub/nightly",
      nativeId,
      binding: ["/opt/akm"],
      contextPath: "/data/context.json",
      target: "team",
      invocation: ["task", "run", "sub/nightly", "--bundle", "team", "--scheduled"],
      signature: "installed-fingerprint",
    };

    const plan = await planSchedulerSync({
      sourceRoot: componentRoot,
      adapterId: "akm-task",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: [installed],
      nativeArtifacts: [
        {
          nativeId,
          bindingId: "sub/nightly",
          invocation: installed.invocation,
          fingerprint: "installed-fingerprint",
        },
      ],
    });

    expect(plan.removed).toEqual(["sub/nightly"]);
    expect(plan.operations).toEqual([
      {
        kind: "remove",
        id: "sub/nightly",
        nativeId,
        expected: {
          state: "present",
          bindingId: "sub/nightly",
          nativeId,
          logicalSource: { kind: "task", ref: "team//sub/nightly" },
          ordinal: 0,
          invocation: installed.invocation,
          fingerprint: "installed-fingerprint",
        },
      },
    ]);
  });

  // Was "a true standalone physical-source identity collision rejects before
  // diffing" (tier3-0917-r5, U3): the rejection this pinned was actually the
  // directory-manifest layer's former blanket refusal of ANY symbolic entry,
  // not a real physical-identity collision check — `beta/nightly.yml` here
  // is never opened as a task candidate at all. Per U3, an in-bundle symlink
  // that stays inside the bundle root is recorded as its own manifest kind
  // and is never made a task candidate. r2-1 restores the report: a symlink
  // classified as a task candidate is degraded into a per-source failure
  // (not silently dropped), while the real owner still syncs normally.
  test("an in-bundle symlink alias is reported as a per-source failure; the real owner still syncs", async () => {
    const componentRoot = root();
    const owner = path.join(componentRoot, "alpha", "nightly.yml");
    const alias = path.join(componentRoot, "beta", "nightly.yml");
    write(owner, "version: 4\nrun: echo owner\nshell: sh\nschedule: '@daily'\n");
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.symlinkSync(owner, alias);
    let signatures = 0;

    const plan = await planSchedulerSync({
      sourceRoot: componentRoot,
      adapterId: "akm-task",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
      expectedSignature: () => {
        signatures += 1;
        return "signature";
      },
    });

    expect(plan.desired.map((binding) => binding.id)).toEqual(["alpha/nightly"]);
    expect(plan.failures).toHaveLength(1);
    expect(plan.failures[0]?.path.endsWith("beta/nightly.yml")).toBe(true);
    expect(plan.failures[0]?.ref).toBe("team//beta/nightly");
    expect(plan.failures[0]?.reason).toMatch(/symbolic/);
    expect(signatures).toBe(1);
  });

  test("#867: one invalid desired task degrades (reported, excluded) instead of poisoning the whole plan; a valid peer still reconciles", async () => {
    const bundleRoot = root();
    write(path.join(bundleRoot, "tasks", "a-valid.yml"), "version: 4\nrun: echo yes\nshell: sh\nschedule: '@daily'\n");
    // B-15 (spec docs/plans/specs/p4-deletions-closeout.md §2.2): a
    // still-version-2 sibling that the deterministic migrator cannot convert
    // fails TASK_SCHEMA_VERSION_UNSUPPORTED (row B-14) — before #867, this
    // ONE bad sibling rejected the whole desired set; now it is dropped and
    // reported, and `a-valid` still reconciles.
    write(path.join(bundleRoot, "tasks", "b-invalid.yml"), "version: 2\nschedule: '@daily'\ncommand: echo no\n");
    let signatures = 0;

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
      expectedSignature: () => {
        signatures += 1;
        return "sig";
      },
    });
    expect(plan.desired.map((binding) => binding.id)).toEqual(["a-valid"]);
    expect(plan.failures).toHaveLength(1);
    expect(plan.failures[0]?.path).toContain("b-invalid.yml");
    expect(plan.failures[0]?.reason).toContain("akm migrate apply --dry-run");
    expect(signatures).toBe(1);
  });

  test("#867: an unresolved desired task target degrades (reported, excluded); a valid peer still reconciles", async () => {
    const bundleRoot = root();
    write(path.join(bundleRoot, "tasks", "a-valid.yml"), "version: 4\nrun: echo yes\nshell: sh\nschedule: '@daily'\n");
    write(
      path.join(bundleRoot, "tasks", "b-unresolved.yml"),
      "version: 4\nuses: scripts/does-not-exist\nschedule: '@daily'\n",
    );
    let signatures = 0;

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
      expectedSignature: () => {
        signatures += 1;
        return "sig";
      },
    });
    expect(plan.desired.map((binding) => binding.id)).toEqual(["a-valid"]);
    expect(plan.failures).toHaveLength(1);
    expect(plan.failures[0]?.path).toContain("b-unresolved.yml");
    expect(plan.failures[0]?.reason).toMatch(/not found|not present|no script assets/i);
    expect(signatures).toBe(1);
  });

  test("#867: a nonprojectable workflow degrades (reported, excluded) rather than poisoning the whole plan", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "workflows", "multi.yml"),
      [
        "name: multi",
        "on:",
        "  schedule:",
        "    - cron: '0 0 * * *'",
        "jobs:",
        "  first:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: first",
        "        run: echo first",
        "  second:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: second",
        "        run: echo second",
      ].join("\n"),
    );

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
    });
    expect(plan.desired).toEqual([]);
    expect(plan.failures).toHaveLength(1);
    expect(plan.failures[0]?.reason).toMatch(/exactly one (?:source-IR )?job|single-job|multi-job|cannot project/i);
  });

  test("#867: an unsupported workflow trigger degrades (reported, excluded); a valid task peer still reconciles", async () => {
    const bundleRoot = root();
    write(path.join(bundleRoot, "tasks", "valid.yml"), "version: 4\nrun: echo yes\nshell: sh\nschedule: '@daily'\n");
    write(
      path.join(bundleRoot, "workflows", "bad.yml"),
      "name: bad\non: { push: {} }\njobs: { main: { runs-on: [self-hosted], steps: [{ run: echo no }] } }\n",
    );

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: emptyInstalled,
    });
    expect(plan.desired.map((binding) => binding.id)).toEqual(["valid"]);
    expect(plan.failures).toHaveLength(1);
    expect(plan.failures[0]?.reason).toMatch(/unsupported|trigger/i);
  });

  test("#867: workflow collision domains degrade (reported, excluded) without reading or fingerprinting either candidate", async () => {
    const bundleRoot = root();
    const workflows = path.join(bundleRoot, "workflows");
    write(path.join(workflows, "same.md"), "---\ntype: workflow\n---\n# Same\n\n## Steps\n\n### one\nDo it.\n");
    write(
      path.join(workflows, "same.yml"),
      "name: same\non: { workflow_dispatch: null }\njobs: { main: { runs-on: [self-hosted], steps: [] } }\n",
    );
    let signatures = 0;

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      backend: "cron",
      installed: emptyInstalled,
      expectedSignature: () => {
        signatures += 1;
        return "sig";
      },
    });
    expect(plan.desired).toEqual([]);
    expect(plan.failures).toHaveLength(1);
    expect(plan.failures[0]?.reason).toMatch(/multiple workflow source files/i);
    expect(signatures).toBe(0);
  });

  test("preflights desired and foreign installed id collisions before diffing", async () => {
    const bundleRoot = root();
    write(path.join(bundleRoot, "tasks", "nightly.yml"), "version: 4\nrun: echo yes\nshell: sh\nschedule: '@daily'\n");

    await expect(
      planSchedulerSync({
        sourceRoot: bundleRoot,
        adapterId: "akm",
        bundleName: "team",
        bundleTarget: "team",
        backend: "cron",
        installed: [{ id: "nightly", target: "other", binding: ["/bin/akm"], contextPath: "/tmp/context.json" }],
      }),
    ).rejects.toThrow(/already scheduled|collision/i);
  });

  test("rejects desired sources that physically escape the bundle before diffing", async () => {
    const bundleRoot = root();
    const outsideRoot = root();
    const outside = path.join(outsideRoot, "escaped.yml");
    write(outside, "version: 4\nrun: echo escaped\nshell: sh\nschedule: '@daily'\n");
    fs.mkdirSync(path.join(bundleRoot, "tasks"), { recursive: true });
    fs.symlinkSync(outside, path.join(bundleRoot, "tasks", "escaped.yml"));
    let signatures = 0;

    await expect(
      planSchedulerSync({
        sourceRoot: bundleRoot,
        adapterId: "akm",
        bundleName: "team",
        backend: "cron",
        installed: emptyInstalled,
        expectedSignature: () => {
          signatures += 1;
          return "sig";
        },
      }),
    ).rejects.toThrow(/outside the bundle root/);
    expect(signatures).toBe(0);
  });
});

describe("#846: belongsToBundle scopes by resolved bundle path, not display name", () => {
  test("two bundles at different paths sharing the same display name: bundle A's sync does not compute bundle B's installed binding as removable", async () => {
    const componentRoot = root();
    const bundleAPath = "/home/user/work/akm";
    const bundleBPath = "/home/user/personal/akm";
    // Both bundles resolve to the same unconfigured display name ("akm" —
    // the lowercased directory basename, bundle-id.ts:10-18) because
    // ensureUniqueId only dedupes within its OWN config's bundle set
    // (bundle-id.ts:46) and has no visibility into the other bundle.
    const foreignInvocation = ["task", "run", "akm-dogfood-091-capture", "--bundle", "akm", "--scheduled"];
    const foreignEntry = {
      id: "akm-dogfood-091-capture",
      nativeId: "task-foreign",
      binding: ["/opt/akm"],
      contextPath: "/data/context-b.json",
      target: "akm",
      ownerBundlePath: bundleBPath,
      invocation: foreignInvocation,
      signature: "foreign-fingerprint",
    };

    const plan = await planSchedulerSync({
      sourceRoot: componentRoot,
      adapterId: "akm-task",
      bundleName: "akm",
      bundlePath: bundleAPath,
      backend: "cron",
      installed: [foreignEntry],
      nativeArtifacts: [
        {
          nativeId: "task-foreign",
          bindingId: "akm-dogfood-091-capture",
          invocation: foreignInvocation,
          fingerprint: "foreign-fingerprint",
        },
      ],
    });

    // Bundle A has zero task ids in common with bundle B — bundle B's real
    // binding must never show up as bundle A's drift to remove.
    expect(plan.removed).toEqual([]);
    expect(plan.operations).toEqual([]);
  });

  test("an installed binding whose owning path cannot be established is never treated as belonging to the invoking bundle", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "nightly.yml"),
      "version: 4\nrun: echo nightly\nshell: sh\nschedule: '@daily'\n",
    );

    // Same id and same legacy `target` name as the invoking bundle, but its
    // scheduler-context descriptor could not be read/validated (deleted,
    // corrupted, owned by another OS user, or predates the descriptor
    // mechanism) — ownerBundlePath is therefore absent. A missing owning
    // path must never be assumed to mean "mine".
    const installed = {
      id: "nightly",
      nativeId: "task-nightly",
      binding: ["/opt/akm"],
      contextPath: "/data/unreadable-context.json",
      target: "team",
      invocation: ["task", "run", "nightly", "--bundle", "team", "--scheduled"],
      signature: "installed-fingerprint",
    };

    await expect(
      planSchedulerSync({
        sourceRoot: bundleRoot,
        adapterId: "akm",
        bundleName: "team",
        bundlePath: "/home/user/work/akm",
        backend: "cron",
        installed: [installed],
        nativeArtifacts: [
          {
            nativeId: "task-nightly",
            bindingId: "nightly",
            invocation: installed.invocation,
            fingerprint: "installed-fingerprint",
          },
        ],
        expectedSignature: (binding) => `sig:${binding.id}`,
      }),
    ).rejects.toThrow(/already scheduled/i);
  });

  test("a binding genuinely owned by the invoking bundle (matching resolved path) is still removed as drift", async () => {
    const componentRoot = root();
    const nativeId = "task-owned";
    const bundlePath = "/home/user/work/akm";
    const installed = {
      id: "sub/nightly",
      nativeId,
      binding: ["/opt/akm"],
      contextPath: "/data/context-a.json",
      target: "team",
      ownerBundlePath: bundlePath,
      invocation: ["task", "run", "sub/nightly", "--bundle", "team", "--scheduled"],
      signature: "installed-fingerprint",
    };

    const plan = await planSchedulerSync({
      sourceRoot: componentRoot,
      adapterId: "akm-task",
      bundleName: "team",
      bundlePath,
      backend: "cron",
      installed: [installed],
      nativeArtifacts: [
        {
          nativeId,
          bindingId: "sub/nightly",
          invocation: installed.invocation,
          fingerprint: "installed-fingerprint",
        },
      ],
    });

    // No desired source declares "sub/nightly" — it is genuinely orphaned
    // drift owned by THIS bundle, and must still be reconciled away exactly
    // as before the path-scoping fix.
    expect(plan.removed).toEqual(["sub/nightly"]);
    expect(plan.operations).toEqual([
      {
        kind: "remove",
        id: "sub/nightly",
        nativeId,
        expected: {
          state: "present",
          bindingId: "sub/nightly",
          nativeId,
          logicalSource: { kind: "task", ref: "team//sub/nightly" },
          ordinal: 0,
          invocation: installed.invocation,
          fingerprint: "installed-fingerprint",
        },
        // #849: the remove operation now carries the removed binding's
        // owning bundle path (already known from #846's ownerBundlePath),
        // so a dry-run preview can attribute every removal without a
        // separate lookup.
        ownerBundlePath: bundlePath,
      },
    ]);
  });
});
