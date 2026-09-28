// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Scheduler sync planning for task source v4 (and the workflow sources that
 * share its native rows): what one bundle's sources compile to, and how that
 * desired set diffs against the rows installed in the native scheduler —
 * install, update, remove, leave alone — including per-source failure
 * isolation (#867) and ownership attribution by resolved bundle path (#846).
 * The helper below builds one bundle's plan exactly as `akm task sync` does.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _setWarnSinkForTests } from "../src/core/warn";
import {
  type InstalledSchedulerBinding,
  type SchedulerBinding,
  type SchedulerInstallOptions,
  schedulerNativeBindingId,
} from "../src/tasks/scheduler-binding";
import {
  type CompileSchedulerSourcesInput,
  compileSchedulerSources,
  planSchedulerSync as planInstalledRows,
} from "../src/tasks/scheduler-sync";
import { overrideSeam } from "./_helpers/seams";

interface PlanInput extends CompileSchedulerSourcesInput {
  readonly installed: readonly InstalledSchedulerBinding[];
  /** Set for the primary bundle, which proves its rows by resolved path (#846). */
  readonly bundlePath?: string;
  /** The inline environment of the bundle's rows; `AKM_BUNDLE_DIR` marks the env-selected working stash. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly expectedSignature?: (binding: SchedulerBinding, options?: SchedulerInstallOptions) => string;
}

/** One bundle's plan, built the way `akm task sync` builds it: compile the sources, then diff the installed rows. */
async function planSchedulerSync(input: PlanInput) {
  const compiled = await compileSchedulerSources(input);
  const plan = planInstalledRows({
    desired: compiled.desired,
    installed: input.installed,
    scopes: [
      {
        bundleName: input.bundleName,
        adapterId: input.adapterId,
        ...(input.bundlePath ? { bundlePath: input.bundlePath, primary: true } : {}),
        ...(input.environment ? { environment: input.environment } : {}),
      },
    ],
    ...(input.expectedSignature ? { expectedSignature: input.expectedSignature } : {}),
    keepRefs: new Set(compiled.failures.flatMap((failure) => (failure.ref ? [failure.ref] : []))),
  });
  return { ...plan, failures: [...compiled.failures, ...plan.failures] };
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
  test("a version: 4 task with no schedule: contributes ZERO bindings and records ZERO failures — compileSchedulerSources does not reject", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "manual-only.yml"),
      ["version: 4", "run: echo manual-only", "shell: sh", ""].join("\n"),
    );

    // Today this REJECTS (see file header) — the assertion that it resolves
    // at all is the B-07 pin, independent of the shape assertions below.
    const prepared = await compileSchedulerSources({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      backend: "cron",
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

// The runtime reads only task source v4 (#987). A granted v3 task, or a
// granted v4 task still carrying the retired `schedule[].enabled`, is one
// source that fails — reported with `akm migrate apply` as the remedy — while
// every other source still compiles. An ungranted source is never read, so it
// is absent from BOTH `desired` and `failures`.
describe("whole-set task source v4 scheduler sync planning — sources `akm migrate apply` rewrites are per-file failures", () => {
  test("a granted v3 task and a granted v4 task with a retired schedule[].enabled fail on their own, naming `akm migrate apply`; a v4 peer still compiles", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "legacy-v3.yml"),
      ["version: 3", "run: echo legacy", "shell: sh", "akm:", "  schedule: '0 3 * * *'", ""].join("\n"),
    );
    write(
      path.join(bundleRoot, "tasks", "retired-enabled-v4.yml"),
      [
        "version: 4",
        "run: echo nightly",
        "shell: sh",
        "schedule:",
        "  - cron: '0 4 * * *'",
        "    enabled: false",
        "",
      ].join("\n"),
    );
    write(
      path.join(bundleRoot, "tasks", "current-v4.yml"),
      ["version: 4", "run: echo current", "shell: sh", "schedule: '0 5 * * *'", ""].join("\n"),
    );

    const baseInput = {
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      backend: "cron" as const,
    };

    const ungranted = await compileSchedulerSources({ ...baseInput, enabledRefs: new Set() });
    expect(ungranted.desired).toEqual([]);
    expect(ungranted.failures).toEqual([]);

    const granted = await compileSchedulerSources({
      ...baseInput,
      enabledRefs: new Set(["team//tasks/legacy-v3", "team//tasks/retired-enabled-v4", "team//tasks/current-v4"]),
    });
    expect(granted.desired.map((binding) => binding.logicalSource.ref)).toEqual(["team//tasks/current-v4"]);
    expect(granted.failures.map((failure) => failure.ref)).toEqual([
      "team//tasks/legacy-v3",
      "team//tasks/retired-enabled-v4",
    ]);
    for (const failure of granted.failures) expect(failure.reason).toContain("akm migrate apply");
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
    // failure into one `failures` entry. compileSchedulerSources no
    // longer rejects the whole set over it — it degrades, reporting the
    // failure and reconciling every other source (none, here).
    const prepared = await compileSchedulerSources({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      backend: "cron",
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
    const prepared = await compileSchedulerSources({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      backend: "cron",
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

    const second = await planSchedulerSync({ ...base, installed });

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
    write(file, source("30 2 * * *"));

    const drift = await planSchedulerSync({ ...base, installed });

    expect(drift.unchanged).toEqual([initial.desired[0]!.id]);
    expect(drift.updated).toEqual([initial.desired[1]!.id]);
  });

  test("a row whose schedule entry was deleted is removed; the remaining entry is unchanged", async () => {
    const bundleRoot = root();
    const file = path.join(bundleRoot, "tasks", "nightly.yml");
    write(file, "version: 4\nrun: echo index\nshell: sh\nschedule:\n  - cron: '0 1 * * *'\n  - cron: '0 2 * * *'\n");
    const base = {
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
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
    write(file, "version: 4\nrun: echo index\nshell: sh\nschedule:\n  - cron: '0 1 * * *'\n");

    const removal = await planSchedulerSync({ ...base, installed });
    const removed = initial.desired[1];
    if (!removed) throw new Error("missing higher-ordinal binding");
    expect(removal.operations).toEqual([
      { kind: "remove", id: removed.id, nativeId: schedulerNativeBindingId(removed.id) },
    ]);
    expect(removal.unchanged).toEqual([initial.desired[0]!.id]);
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
      backend: "cron",
      installed: emptyInstalled,
    });

    expect(plan.desired.map(({ id }) => id)).toEqual(["alpha/nightly", "beta/nightly"]);
    expect(plan.desired.map(({ logicalSource }) => logicalSource.ref)).toEqual([
      "team//alpha/nightly",
      "team//beta/nightly",
    ]);
  });

  test("two sources claiming one native row are both reported and neither is installed", async () => {
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

    const plan = await planSchedulerSync({
      sourceRoot: componentRoot,
      adapterId: "akm-task",
      bundleName: "team",
      backend: "cron",
      installed: emptyInstalled,
      expectedSignature: () => {
        signatures += 1;
        return "signature";
      },
    });
    expect(plan.operations).toEqual([]);
    expect(plan.failures.map((failure) => failure.ref).sort()).toEqual([
      "team//sub/nightly",
      "team//task-5f14bc23cb233df4713f2e147b6c077f",
    ]);
    expect(plan.failures[0]?.reason).toMatch(/is claimed by/);
    expect(signatures).toBe(0);
  });

  test.each([
    ["case folding", "Nightly", "nightly"],
  ] as const)("native ids that differ only by %s are one row: both are reported", async (_label, first, second) => {
    const componentRoot = root();
    write(path.join(componentRoot, `${first}.yml`), "version: 4\nrun: echo first\nshell: sh\nschedule: '@daily'\n");
    write(path.join(componentRoot, `${second}.yml`), "version: 4\nrun: echo second\nshell: sh\nschedule: '@daily'\n");
    let signatures = 0;

    const plan = await planSchedulerSync({
      sourceRoot: componentRoot,
      adapterId: "akm-task",
      bundleName: "team",
      backend: "schtasks",
      installed: emptyInstalled,
      expectedSignature: () => {
        signatures += 1;
        return "signature";
      },
    });
    expect(plan.operations).toEqual([]);
    expect(plan.failures).toHaveLength(2);
    expect(plan.failures.every((failure) => /is claimed by/.test(failure.reason))).toBe(true);
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

  test("a nested task whose source is gone is removed by its native id", async () => {
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
      backend: "cron",
      installed: [installed],
    });

    expect(plan.removed).toEqual(["sub/nightly"]);
    expect(plan.operations).toEqual([{ kind: "remove", id: "sub/nightly", nativeId }]);
  });

  test("an in-bundle symlink alias is read through like any other source file", async () => {
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
      backend: "cron",
      installed: emptyInstalled,
      expectedSignature: () => {
        signatures += 1;
        return "signature";
      },
    });

    expect(plan.desired.map((binding) => binding.id)).toEqual(["alpha/nightly", "beta/nightly"]);
    expect(plan.failures).toEqual([]);
    expect(signatures).toBe(2);
  });

  test("#867: one invalid desired task degrades (reported, excluded) instead of poisoning the whole plan; a valid peer still reconciles", async () => {
    const bundleRoot = root();
    write(path.join(bundleRoot, "tasks", "a-valid.yml"), "version: 4\nrun: echo yes\nshell: sh\nschedule: '@daily'\n");
    // A still-version-2 sibling fails TASK_SCHEMA_VERSION_UNSUPPORTED — before
    // #867, this ONE bad sibling rejected the whole desired set; now it is
    // dropped and reported, and `a-valid` still reconciles.
    write(path.join(bundleRoot, "tasks", "b-invalid.yml"), "version: 2\nschedule: '@daily'\ncommand: echo no\n");
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
    expect(plan.desired.map((binding) => binding.id)).toEqual(["a-valid"]);
    expect(plan.failures).toHaveLength(1);
    expect(plan.failures[0]?.path).toContain("b-invalid.yml");
    // The runtime reads only v4 (#987): the failure names the migrator.
    expect(plan.failures[0]?.reason).toContain("akm migrate apply");
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

  // A desired binding whose id collides with a DIFFERENT bundle's real
  // installed entry is a per-item anomaly, not a whole-sync abort — this
  // one binding is excluded and reported in `failures` instead of refusing
  // to reconcile every other binding in the same sync.
  test("a desired/foreign installed id collision excludes just that binding and reports it, instead of aborting the sync", async () => {
    const bundleRoot = root();
    write(path.join(bundleRoot, "tasks", "nightly.yml"), "version: 4\nrun: echo yes\nshell: sh\nschedule: '@daily'\n");
    const foreignInvocation = ["task", "run", "nightly", "--bundle", "other", "--scheduled"];

    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      backend: "cron",
      installed: [
        {
          id: "nightly",
          nativeId: "nightly",
          target: "other",
          binding: ["/bin/akm"],
          contextPath: "/tmp/context.json",
          invocation: foreignInvocation,
          signature: "foreign-fingerprint",
        },
      ],
    });

    expect(plan.operations).toEqual([]);
    expect(plan.failures).toHaveLength(1);
    expect(plan.failures[0]?.ref).toBe("team//tasks/nightly");
    expect(plan.failures[0]?.reason).toMatch(/already scheduled|collide/i);
  });

  test("a task source symlinked from outside the bundle is read through, not refused", async () => {
    const bundleRoot = root();
    const outsideRoot = root();
    const outside = path.join(outsideRoot, "escaped.yml");
    write(outside, "version: 4\nrun: echo escaped\nshell: sh\nschedule: '@daily'\n");
    fs.mkdirSync(path.join(bundleRoot, "tasks"), { recursive: true });
    fs.symlinkSync(outside, path.join(bundleRoot, "tasks", "escaped.yml"));
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
    expect(plan.desired.map((binding) => binding.id)).toEqual(["escaped"]);
    expect(plan.failures).toEqual([]);
    expect(signatures).toBe(1);
  });
});

describe("#846: the primary bundle owns rows by resolved bundle path, not display name", () => {
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
      nativeId: "nightly",
      binding: ["/opt/akm"],
      contextPath: "/data/unreadable-context.json",
      target: "team",
      invocation: ["task", "run", "nightly", "--bundle", "team", "--scheduled"],
      signature: "installed-fingerprint",
    };

    // Excluded and reported, not a whole-sync throw — see the
    // "collision excludes just that binding" test above.
    const plan = await planSchedulerSync({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      bundlePath: "/home/user/work/akm",
      backend: "cron",
      installed: [installed],
      expectedSignature: (binding) => `sig:${binding.id}`,
    });

    expect(plan.operations).toEqual([]);
    expect(plan.failures).toHaveLength(1);
    expect(plan.failures[0]?.reason).toMatch(/already scheduled/i);
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
    });

    // No desired source declares "sub/nightly" — it is genuinely orphaned
    // drift owned by THIS bundle, and is removed. The operation carries the
    // owning bundle path (#849) so a dry-run preview can attribute it.
    expect(plan.removed).toEqual(["sub/nightly"]);
    expect(plan.operations).toEqual([{ kind: "remove", id: "sub/nightly", nativeId, ownerBundlePath: bundlePath }]);
  });

  test("the env-selected stash owns the current rows whose inline AKM_BUNDLE_DIR names it, and the older rows whose descriptor does", async () => {
    const componentRoot = root();
    const stash = "/home/user/stash";
    const row = (id: string, extra: Partial<InstalledSchedulerBinding>) => ({
      id,
      nativeId: id,
      binding: ["/opt/akm"],
      target: "stash",
      invocation: ["task", "run", id, "--bundle", "stash", "--scheduled"],
      signature: `sig-${id}`,
      ...extra,
    });

    const plan = await planSchedulerSync({
      sourceRoot: componentRoot,
      adapterId: "akm-task",
      bundleName: "stash",
      bundlePath: stash,
      environment: { AKM_BUNDLE_DIR: stash },
      backend: "cron",
      installed: [
        row("inline-mine", { environment: { AKM_BUNDLE_DIR: stash }, ownerBundlePath: stash }),
        row("inline-other", { environment: { AKM_BUNDLE_DIR: "/other/stash" }, ownerBundlePath: "/other/stash" }),
        row("configured-elsewhere", {}),
        row("legacy-mine", { contextPath: "/data/ctx-a.json", ownerBundlePath: stash }),
        row("legacy-other", { contextPath: "/data/ctx-b.json", ownerBundlePath: "/other/stash" }),
      ],
    });

    // No source is desired, so every row this stash owns is drift; the rest are another installation's.
    expect(plan.removed).toEqual(["inline-mine", "legacy-mine"]);
  });

  test("a configured bundle owns its rows by name, and a row carrying AKM_BUNDLE_DIR inline only when it names its path", async () => {
    const componentRoot = root();
    const bundlePath = "/home/user/work/akm";
    const row = (id: string, extra: Partial<InstalledSchedulerBinding>) => ({
      id,
      nativeId: id,
      binding: ["/opt/akm"],
      target: "team",
      invocation: ["task", "run", id, "--bundle", "team", "--scheduled"],
      signature: `sig-${id}`,
      ...extra,
    });

    const plan = await planSchedulerSync({
      sourceRoot: componentRoot,
      adapterId: "akm-task",
      bundleName: "team",
      bundlePath,
      backend: "cron",
      installed: [
        row("by-name", {}),
        // An env-selected stash at this path that has since been configured.
        row("inline-same-dir", { environment: { AKM_BUNDLE_DIR: bundlePath }, ownerBundlePath: bundlePath }),
        // Another installation's env-selected stash that happens to share the name.
        row("inline-other-dir", { environment: { AKM_BUNDLE_DIR: "/tmp/x/team" }, ownerBundlePath: "/tmp/x/team" }),
      ],
    });

    expect(plan.removed).toEqual(["by-name", "inline-same-dir"]);
  });

  test("a row that reads another config (inline AKM_CONFIG_DIR) is another installation's, in both directions", async () => {
    const componentRoot = root();
    const bundlePath = "/home/user/akm";
    const row = (id: string, environment?: Record<string, string>) => ({
      id,
      nativeId: id,
      binding: ["/opt/akm"],
      target: "stash",
      invocation: ["task", "run", id, "--bundle", "stash", "--scheduled"],
      signature: `sig-${id}`,
      ...(environment ? { environment } : {}),
    });
    const installed = [row("default-config"), row("other-config", { AKM_CONFIG_DIR: "/opt/b/config" })];
    const plan = (environment?: Record<string, string>) =>
      planSchedulerSync({
        sourceRoot: componentRoot,
        adapterId: "akm-task",
        bundleName: "stash",
        bundlePath,
        ...(environment ? { environment } : {}),
        backend: "cron",
        installed,
      });

    // No source is desired, so each sync removes exactly the rows it owns.
    expect((await plan()).removed).toEqual(["default-config"]);
    expect((await plan({ AKM_CONFIG_DIR: "/opt/b/config" })).removed).toEqual(["other-config"]);
    expect((await plan({ AKM_CONFIG_DIR: "/opt/c/config" })).removed).toEqual([]);
  });

  test("an orphaned row without a listed signature is removed like any other", async () => {
    const componentRoot = root();
    const bundlePath = "/home/user/work/akm";
    const healthy = {
      id: "healthy-orphan",
      nativeId: "task-healthy-orphan",
      binding: ["/opt/akm"],
      contextPath: "/data/context-a.json",
      target: "team",
      ownerBundlePath: bundlePath,
      invocation: ["task", "run", "healthy-orphan", "--bundle", "team", "--scheduled"],
      signature: "healthy-fingerprint",
    };
    const poisoned = {
      id: "poisoned-orphan",
      nativeId: "task-poisoned-orphan",
      binding: ["/opt/akm"],
      contextPath: "/data/context-b.json",
      target: "team",
      ownerBundlePath: bundlePath,
      invocation: ["task", "run", "poisoned-orphan", "--bundle", "team", "--scheduled"],
    };

    const plan = await planSchedulerSync({
      sourceRoot: componentRoot,
      adapterId: "akm-task",
      bundleName: "team",
      bundlePath,
      backend: "cron",
      installed: [healthy, poisoned],
    });

    // No desired source declares either id — both are orphaned drift.
    expect(plan.removed).toEqual(["healthy-orphan", "poisoned-orphan"]);
    expect(plan.failures).toEqual([]);
  });
});
