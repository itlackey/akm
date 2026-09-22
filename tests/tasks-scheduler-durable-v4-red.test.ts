// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksSync } from "../src/commands/tasks/tasks";
import { withWorkflowRunsRepo } from "../src/storage/repositories/workflow-runs-repository";
import { setSchedulerRefEnabled } from "../src/tasks/activation-config";
import type { SchedulerBackend } from "../src/tasks/backends/types";
import { type PreparedSchedulerSourceSet, prepareSchedulerSyncSourceSet } from "../src/tasks/scheduler-sync";
import { startWorkflowRun } from "../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";

type ExecutableWorkflowEvidence = Readonly<{
  ref: string;
  irVersion: 5;
  planHash: string;
  sourceReadSet: readonly Readonly<{ identity: Readonly<{ ref: string; hash: string }> }>[];
}>;

type DurablePreparedSet = PreparedSchedulerSourceSet & {
  readonly executableWorkflows: readonly ExecutableWorkflowEvidence[];
};

let storage: IsolatedAkmStorage;
let assetsRoot: string;

function write(root: string, relative: string, content: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function workflow(name: string, stepLines: readonly string[]): string {
  return [
    `name: ${name}`,
    "on:",
    "  schedule:",
    "    - cron: '0 8 * * 1'",
    "jobs:",
    "  main:",
    "    runs-on: [self-hosted]",
    "    steps:",
    ...stepLines,
    "",
  ].join("\n");
}

function executableWorkflows(prepared: PreparedSchedulerSourceSet): readonly ExecutableWorkflowEvidence[] {
  return (prepared as DurablePreparedSet).executableWorkflows;
}

function recordingBackend() {
  const calls = { runtime: 0, signatures: 0, snapshots: 0, installs: 0, removes: 0 };
  const backend = {
    name: "cron",
    inspectBindings: () => ({ installed: [], artifacts: [] }),
    expectedSignature(binding: unknown) {
      calls.signatures += 1;
      return JSON.stringify(binding);
    },
    snapshotBindings(nativeIds: readonly string[]) {
      calls.snapshots += 1;
      return { nativeIds: [...nativeIds], artifacts: [] };
    },
    restoreBindings() {},
    install() {
      calls.installs += 1;
    },
    uninstall() {
      calls.removes += 1;
    },
    list: () => [],
    setEnabled() {},
  } as unknown as SchedulerBackend;
  return { backend, calls };
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  assetsRoot = path.join(storage.root, "assets");
  fs.mkdirSync(assetsRoot, { recursive: true });
  writeSandboxConfig({
    defaultBundle: "team",
    bundles: {
      team: { path: storage.stashDir, components: { main: { root: ".", adapter: "akm" } } },
      assets: { path: assetsRoot, components: { main: { root: ".", adapter: "akm" } } },
    },
    defaults: { engine: "fixture" },
    engines: { fixture: { kind: "agent", platform: "claude", bin: "/bin/true" } },
  });
});

afterEach(() => storage.cleanup());

describe("WP7 scheduler desired-set durable v4 RED", () => {
  test("dry-freezes the complete sorted set as v4 hash/read-set evidence without retaining plan JSON", async () => {
    write(storage.stashDir, "workflows/zeta.yml", workflow("zeta", ["      - id: zeta", "        run: echo zeta"]));
    write(storage.stashDir, "workflows/alpha.yml", workflow("alpha", ["      - id: alpha", "        run: echo alpha"]));

    const prepared = await prepareSchedulerSyncSourceSet({
      sourceRoot: storage.stashDir,
      adapterId: "akm",
      bundleName: "team",
      bundleTarget: "team",
      backend: "cron",
      installed: [],
      nativeArtifacts: [],
    });
    const evidence = executableWorkflows(prepared);

    expect(evidence.map(({ ref }) => ref)).toEqual(["team//workflows/alpha", "team//workflows/zeta"]);
    for (const item of evidence) {
      expect(item.irVersion).toBe(5);
      expect(item.planHash).toMatch(/^[a-f0-9]{64}$/);
      expect(item.sourceReadSet.map(({ identity }) => identity.ref)).toContain(item.ref);
      expect(item).not.toHaveProperty("planJson");
    }
  });

  test.each([
    [
      "missing composed task",
      workflow("invalid", ["      - id: missing", "        uses: tasks/does-not-exist"]),
      /not found|not present|missing/i,
    ],
    [
      "multi-job workflow",
      [
        "name: invalid",
        "on:",
        "  schedule:",
        "    - cron: '0 8 * * 1'",
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
        "",
      ].join("\n"),
      /exactly one (?:source-IR )?job|single-job|multi-job|cannot project/i,
    ],
    // P4 FLIP (docs/plans/specs/p4-deletions-closeout.md §3.1, row B-05,
    // F-A1.19): the locator grammar is deleted — this now rejects as an
    // unrecognized ref shape (unsupported-uses-target), not the old
    // remote-action-acquisition reason.
    [
      "remote action",
      workflow("invalid", ["      - id: remote", "        uses: actions/checkout@v4"]),
      /unsupported-uses-target/,
    ],
  ] as const)("#867: invalid %s degrades — reported and excluded — while the valid peer is still installed", async (_label, invalidSource, message) => {
    write(storage.stashDir, "workflows/a-valid.yml", workflow("valid", ["      - id: ok", "        run: echo ok"]));
    write(storage.stashDir, "workflows/z-invalid.yml", invalidSource);
    setSchedulerRefEnabled("workflow", "team//workflows/a-valid", true);
    setSchedulerRefEnabled("workflow", "team//workflows/z-invalid", true);
    const { backend, calls } = recordingBackend();

    const result = await akmTasksSync(
      {
        backend,
        schedulerRuntime() {
          calls.runtime += 1;
          return { binding: ["/test/akm"], contextPath: "/test/context.json" };
        },
      },
      "team",
    );

    expect(result.installed).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toMatch(message);
    expect(calls.installs).toBe(1);
  });

  test("source changed after sync is fresh-frozen by the scheduled start, not reused from sync evidence", async () => {
    const file = write(
      storage.stashDir,
      "workflows/release.yml",
      workflow("release", ["      - id: ship", "        run: echo before-sync"]),
    );
    setSchedulerRefEnabled("workflow", "team//workflows/release", true);
    const { backend } = recordingBackend();
    await akmTasksSync(
      { backend, schedulerRuntime: () => ({ binding: ["/test/akm"], contextPath: "/test/context.json" }) },
      "team",
    );

    fs.writeFileSync(file, workflow("release", ["      - id: ship", "        run: echo after-sync"]));
    const started = await startWorkflowRun("team//workflows/release", {}, { force: true });
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));

    expect(row?.plan_ir_version).toBe(5);
    expect(row?.plan_json).toContain("echo after-sync");
    expect(row?.plan_json).not.toContain("echo before-sync");
  });

  test("final whole-set CAS covers cross-bundle task/script reads before the first backend operation", async () => {
    write(assetsRoot, "tasks/child.yml", "version: 4\nuses: assets//scripts/release.sh\n");
    const script = write(assetsRoot, "scripts/release.sh", "#!/bin/sh\nprintf frozen\n");
    write(
      storage.stashDir,
      "workflows/release.yml",
      workflow("release", ["      - id: child", "        uses: assets//tasks/child"]),
    );
    setSchedulerRefEnabled("workflow", "team//workflows/release", true);
    const { backend, calls } = recordingBackend();
    let caught: unknown;

    try {
      await akmTasksSync(
        {
          backend,
          schedulerRuntime() {
            calls.runtime += 1;
            fs.writeFileSync(script, "#!/bin/sh\nprintf raced\n");
            return { binding: ["/test/akm"], contextPath: "/test/context.json" };
          },
        },
        "team",
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toMatch(/source|read set|manifest|changed/i);
    expect(calls.runtime).toBe(1);
    expect(calls.snapshots).toBe(0);
    expect(calls.installs).toBe(0);
    expect(calls.removes).toBe(0);
  });
});
