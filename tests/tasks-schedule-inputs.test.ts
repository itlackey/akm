// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Schedule-supplied inputs.
 *
 * A task source v4 `schedule[i].inputs` mapping is a PER-BINDING literal
 * override. It reaches an actual scheduled run through the scheduler argv —
 * `compileTaskSchedulerBindings` (`src/tasks/scheduler-binding.ts`) appends a
 * canonically-sorted `--<name> <value>` flag tail after `--scheduled` for
 * each declared input — and it is validated at SYNC time (in addition to the
 * existing PARSE-time check) against the task's own declared `inputs:`
 * contract.
 *
 * This file is deliberately separate from, and does not duplicate, its two
 * siblings that already own adjacent ground: tests/tasks-scheduler-sync-v4.test.ts
 * (the whole-set sync planner) and tests/tasks-scheduler-invocation.test.ts
 * (the existing round-trip/malformed-tail coverage this file extends in
 * spirit, not in place). Every fixture id below is chosen to be distinct from
 * both.
 *
 * Sync-time coverage goes through the REAL task source v4 YAML grammar via the
 * SAME `prepareSchedulerSyncSourceSet` / `finalizeSchedulerSyncPlan` seam
 * tests/tasks-scheduler-sync-v4.test.ts uses; the round-trip/malformed-tail
 * coverage drives the exported `buildScheduledInvocation` /
 * `parseScheduledInvocationArgv` with plain `string[]` argv literals; the
 * end-to-end delivery proof drives the REAL `akm task run` CLI with the exact
 * argv the scheduler would install.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundleSourceId } from "../src/core/config/config-sources";
import type { AkmConfig } from "../src/core/config/config-types";
import { ConfigError } from "../src/core/errors";
import { buildScheduledInvocation, parseScheduledInvocationArgv } from "../src/tasks/scheduler-invocation";
import { compileSchedulerSources } from "../src/tasks/scheduler-sync";
import { listWorkflowRuns } from "../src/workflows/runtime/runs";
import { runCliCapture } from "./_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";

// ── Part 1: sync-time compilation + validation (mirrors the seam ──────────
// ── tests/tasks-scheduler-sync-v4.test.ts uses exactly) ────────────────────

function root(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-schedule-inputs-"));
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe("schedule[].inputs compiles a sorted --<name> <value> flag tail after --scheduled", () => {
  test("two inputs authored out of alphabetical order, one boolean, compile a tail sorted by name — the boolean as `--alpha true`, never a bare flag", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "scoped-nightly.yml"),
      [
        "version: 4",
        "run: echo scoped",
        "shell: sh",
        "inputs:",
        "  zone:",
        "    type: string",
        "  alpha:",
        "    type: boolean",
        "schedule:",
        "  - cron: '0 8 * * 1'",
        "    inputs:",
        "      zone: west",
        "      alpha: true",
        "",
      ].join("\n"),
    );

    const plan = await compileSchedulerSources({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      backend: "cron",
    });

    expect(plan.desired).toHaveLength(1);
    expect(plan.desired[0]?.invocation).toEqual([
      "task",
      "run",
      "scoped-nightly",
      "--bundle",
      "team",
      "--scheduled",
      "--alpha",
      "true",
      "--zone",
      "west",
    ]);
  });

  test("an object/array-typed input's value is delivered as its canonical-JSON text (the JSON-shorthand round-trip path)", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "listy-nightly.yml"),
      [
        "version: 4",
        "run: echo listy",
        "shell: sh",
        "inputs:",
        "  tags:",
        "    type: array",
        "    items: { type: string }",
        "schedule:",
        "  - cron: '0 8 * * 1'",
        "    inputs:",
        "      tags: [a, b]",
        "",
      ].join("\n"),
    );

    const plan = await compileSchedulerSources({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      backend: "cron",
    });

    expect(plan.desired).toHaveLength(1);
    expect(plan.desired[0]?.invocation).toEqual([
      "task",
      "run",
      "listy-nightly",
      "--bundle",
      "team",
      "--scheduled",
      "--tags",
      '["a","b"]',
    ]);
  });

  test("empty/absent schedule[].inputs still compiles the fixed, zero-extra-token tail (byte-identical when there is nothing to add)", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "bare-nightly.yml"),
      [
        "version: 4",
        "run: echo bare",
        "shell: sh",
        "inputs:",
        "  zone:",
        "    type: string",
        "schedule: '0 8 * * 1'",
        "",
      ].join("\n"),
    );

    const plan = await compileSchedulerSources({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      backend: "cron",
    });

    expect(plan.desired).toHaveLength(1);
    expect(plan.desired[0]?.invocation).toEqual(["task", "run", "bare-nightly", "--bundle", "team", "--scheduled"]);
  });
});

describe("schedule[].inputs is validated against the declared contract, never silently accepted", () => {
  test("an unknown (undeclared) schedule[].inputs name is refused — the sync path never resolves it into a binding", async () => {
    const bundleRoot = root();
    write(
      path.join(bundleRoot, "tasks", "unknown-input-nightly.yml"),
      [
        "version: 4",
        "run: echo x",
        "shell: sh",
        "inputs:",
        "  scope:",
        "    type: string",
        "schedule:",
        "  - cron: '0 8 * * 1'",
        "    inputs:",
        "      not_a_declared_input: 1",
        "",
      ].join("\n"),
    );

    // #867: a per-source parse failure degrades — reported in `failures`,
    // excluded from `desired` — rather than rejecting the (here, empty)
    // whole set.
    const prepared = await compileSchedulerSources({
      sourceRoot: bundleRoot,
      adapterId: "akm",
      bundleName: "team",
      backend: "cron",
    });
    expect(prepared.desired).toEqual([]);
    expect(prepared.failures).toHaveLength(1);
    expect(prepared.failures[0]?.path).toContain("unknown-input-nightly.yml");
  });
});

// ── Part 2: the compiled tail round-trips; a malformed one is refused ──────

describe("a compiled input-flag tail round-trips through the public scheduler invocation parser", () => {
  test("buildScheduledInvocation accepts the sorted tail, and parseScheduledInvocationArgv recovers the identical public invocation plus target", () => {
    const invocation = [
      "task",
      "run",
      "scoped-nightly",
      "--bundle",
      "team",
      "--scheduled",
      "--alpha",
      "true",
      "--zone",
      "west",
    ];

    const parsed = parseScheduledInvocationArgv(buildScheduledInvocation(["/usr/bin/akm"], invocation));

    expect(parsed?.invocation).toEqual(invocation);
    expect(parsed?.target).toBe("team");
    expect(parsed?.binding).toEqual(["/usr/bin/akm"]);
  });
});

describe("a malformed input-flag tail is refused by the existing invalidSchedulerInvocation() ConfigError", () => {
  test.each([
    ["a bare flag with no trailing value", ["task", "run", "x", "--bundle", "team", "--scheduled", "--alpha"]],
    [
      "a value token that itself looks like a flag",
      ["task", "run", "x", "--bundle", "team", "--scheduled", "--alpha", "--not-a-value"],
    ],
    [
      "a repeated input name",
      ["task", "run", "x", "--bundle", "team", "--scheduled", "--alpha", "true", "--alpha", "false"],
    ],
    [
      "an odd (unpaired) token count",
      ["task", "run", "x", "--bundle", "team", "--scheduled", "--alpha", "true", "--zone"],
    ],
  ] as const)("%s is refused", (_label, invocation) => {
    expect(() => buildScheduledInvocation(["/usr/bin/akm"], invocation)).toThrow(ConfigError);
  });
});

// ── Part 3: the compiled tail, actually executed, reaches a real run ───────
// The "same path as `akm task run --<name>`" is proven through a
// workflow-target v4 task: the SAME src/tasks/runtime-v3.ts with->params seam
// serves both a workflow-step composition caller and a bare `akm task run`
// caller. This sidesteps any ambiguity about whether a DIRECT
// shell/script/command run's own declared inputs reach its child process env
// (out of scope here; that question belongs to
// tests/workflows/task-inputs-delivery.test.ts, which is scoped to
// workflow-STEP composition specifically).

describe("a scheduled run's compiled invocation tail delivers schedule-supplied inputs through the SAME materialization path as `akm task run --<name>`", () => {
  let storage: IsolatedAkmStorage;

  function setUp(): void {
    storage = withIsolatedAkmStorage();
    const base = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { fixture: { path: storage.stashDir, writable: true } },
      defaultBundle: "fixture",
    } as AkmConfig;
    writeSandboxConfig({
      ...base,
      scheduler: {
        enabled: [
          {
            kind: "task",
            ref: "fixture//tasks/delegate-scheduled",
            sourceId: bundleSourceId(base, "fixture"),
          },
        ],
      },
    });
  }

  function write2(relative: string, content: string): void {
    const file = path.join(storage.stashDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }

  test("running `akm task run <id> --bundle <b> --scheduled --scope urgent` — the exact tail a compiled schedule[].inputs binding would carry — delivers scope=urgent to the child workflow run's params", async () => {
    setUp();
    try {
      write2(
        "workflows/child.yml",
        [
          "name: Child",
          "on:",
          "  workflow_dispatch:",
          "jobs:",
          "  contract:",
          "    runs-on: [self-hosted]",
          "    steps:",
          "      - id: work",
          '        run: "true"',
          "        shell: sh",
          "",
        ].join("\n"),
      );
      write2(
        "tasks/delegate-scheduled.yml",
        [
          "version: 4",
          "name: Delegate scheduled",
          "inputs:",
          "  scope:",
          "    type: string",
          "    default: changed",
          "uses: workflows/child",
          "schedule:",
          "  - cron: '0 8 * * 1'",
          "    inputs:",
          "      scope: urgent",
          "",
        ].join("\n"),
      );

      // The scheduler would install and invoke exactly this tail (id, bundle,
      // --scheduled, then the sorted schedule[].inputs flags) — reproduced by
      // hand here rather than imported from the compiler, since this test's
      // job is the CLI-level materialization, not the compiler's own output
      // (Part 1 above already pins that). The run's own exit code is not the
      // load-bearing signal here (a real dispatch failure downstream of the
      // child run's creation would not undo it) — the child run's PARAMS,
      // queried independently below, are.
      await runCliCapture([
        "task",
        "run",
        "delegate-scheduled",
        "--bundle",
        "fixture",
        "--scheduled",
        "--scope",
        "urgent",
      ]);

      const { runs } = await listWorkflowRuns();
      const childRuns = runs.filter((run) => run.workflowRef.includes("child"));
      expect(childRuns).toHaveLength(1);
      expect(childRuns[0]?.params).toEqual({ scope: "urgent" });
    } finally {
      storage.cleanup();
    }
  });
});
