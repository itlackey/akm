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
import { startWorkflowRun } from "../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;

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

function recordingBackend() {
  const calls = { installs: 0, removes: 0 };
  const backend: SchedulerBackend = {
    name: "cron",
    expectedSignature: (binding) => JSON.stringify(binding),
    install() {
      calls.installs += 1;
    },
    uninstall() {
      calls.removes += 1;
    },
    list: () => [],
    setEnabled() {},
  };
  return { backend, calls };
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    defaultBundle: "team",
    bundles: {
      team: { path: storage.stashDir, components: { main: { root: ".", adapter: "akm" } } },
    },
    defaults: { engine: "fixture" },
    engines: { fixture: { kind: "agent", platform: "claude", bin: "/bin/true" } },
  });
});

afterEach(() => storage.cleanup());

describe("scheduled workflows under task sync", () => {
  test.each([
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
    setSchedulerRefEnabled("team//workflows/a-valid", true);
    setSchedulerRefEnabled("team//workflows/z-invalid", true);
    const { backend, calls } = recordingBackend();

    const result = await akmTasksSync(
      { backend, schedulerRuntime: () => ({ binding: ["/test/akm"], contextPath: "/test/context.json" }) },
      "team",
    );

    expect(result.installed).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toMatch(message);
    expect(calls.installs).toBe(1);
  });

  test("a source changed after sync is frozen fresh by the scheduled start", async () => {
    const file = write(
      storage.stashDir,
      "workflows/release.yml",
      workflow("release", ["      - id: ship", "        run: echo before-sync"]),
    );
    setSchedulerRefEnabled("team//workflows/release", true);
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
});
