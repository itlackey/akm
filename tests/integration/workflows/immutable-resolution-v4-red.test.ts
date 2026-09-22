// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests-first WP7 source-target resolution contract.
 *
 * New starts must compile one single-job GitHub-shaped workflow through the
 * same WP5/G command/task/script authorities used outside workflows, retain
 * fully-qualified provenance, and fail before durable mutation on every
 * target the 0.9.2 runtime cannot project.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { akmIndex } from "../../../src/indexer/indexer";
import {
  type PublishWorkflowRunV4Input,
  WorkflowRunsRepository,
  withWorkflowRunsRepo,
} from "../../../src/storage/repositories/workflow-runs-repository";
import { decodeWorkflowPlanV4, type FrozenWorkflowTarget } from "../../../src/workflows/ir/schema-v4";
import { listWorkflowRuns, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import {
  type IsolatedAkmStorage,
  withIsolatedAkmStorage,
  writeSandboxConfig,
  writeWorkflowTestConfig,
} from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

function write(root: string, relative: string, content: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function workflowYaml(steps: string, name = "Resolution"): string {
  return [
    `name: ${name}`,
    "on:",
    "  workflow_dispatch:",
    "jobs:",
    "  contract:",
    "    runs-on: [self-hosted]",
    "    steps:",
    steps,
    "",
  ].join("\n");
}

function writeWorkflow(name: string, steps: string, root = storage.stashDir): string {
  return write(root, `workflows/${name}.yml`, workflowYaml(steps, name));
}

function writeTask(name: string, targetLines: readonly string[], root = storage.stashDir): string {
  return write(root, `tasks/${name}.yml`, ["version: 4", ...targetLines, ""].join("\n"));
}

async function persistedPlan(runId: string) {
  const row = await withWorkflowRunsRepo((repo) => repo.getRunById(runId));
  return decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));
}

function targets(plan: Awaited<ReturnType<typeof persistedPlan>>): FrozenWorkflowTarget[] {
  return plan.steps.flatMap((step) => {
    const root = step.root;
    if (!root) return [];
    return [root.kind === "map" ? root.template.frozenTarget : root.frozenTarget];
  });
}

function mutationCounts(): Record<string, number> {
  const db = openStateDatabase(getStateDbPath());
  try {
    const names = [
      "workflow_runs",
      "workflow_run_steps",
      "workflow_run_units",
      "workflow_run_unit_attempts",
      "events",
      "usage_events",
    ];
    return Object.fromEntries(
      names.map((name) => {
        const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name);
        const count = exists
          ? (db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: number }).count
          : 0;
        return [name, count];
      }),
    );
  } finally {
    db.close();
  }
}

async function establishStateBaseline(): Promise<Record<string, number>> {
  await listWorkflowRuns();
  return mutationCounts();
}

function configureBundles(primaryRoot: string, sharedRoot: string, aliasRoot?: string): void {
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "primary",
    bundles: {
      primary: { path: primaryRoot, components: { main: { root: ".", adapter: "akm", writable: true } } },
      shared: { path: sharedRoot, components: { main: { root: ".", adapter: "akm", writable: false } } },
      ...(aliasRoot
        ? { alias: { path: aliasRoot, components: { main: { root: ".", adapter: "akm", writable: false } } } }
        : {}),
    },
    engines: { cli: { kind: "agent", platform: "claude", bin: "/bin/true" } },
    defaults: { engine: "cli" },
    workflow: { judgeEngine: "cli" },
  });
  resetConfigCache();
}

describe("workflow v4 common target resolution", () => {
  test("allows one GitHub-shaped job and persists the common resolved request plus runner transport", async () => {
    write(storage.stashDir, "commands/review.md", "Review $ARGUMENTS exactly.\n");
    writeWorkflow(
      "stored-command",
      [
        "      - id: review",
        "        uses: akm/command",
        "        with:",
        "          ref: commands/review",
        "          arguments: once",
      ].join("\n"),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/stored-command");
    const plan = await persistedPlan(started.run.id);
    const target = targets(plan)[0];
    expect(target?.kind).toBe("command");
    if (!target || target.kind !== "command") return;
    expect(target.ref).toMatch(/\/\/commands\/review$/);
    expect(target.request.command.content).toBe("Review once exactly.\n");
    expect(target.request.command.source).toMatchObject({ ref: target.ref, adapter: "akm" });
    expect(target.runner.engine).toBe(target.request.engine.name);
    expect(target.runner).toMatchObject({
      kind: "sdk",
      profile: { name: "test-agent", platform: "opencode-sdk", bin: "opencode" },
    });
  });

  test("preserves a qualified cross-bundle command owner through sourceReadSet, request, and target", async () => {
    const primary = path.join(storage.root, "primary");
    const shared = path.join(storage.root, "shared");
    fs.mkdirSync(primary, { recursive: true });
    fs.mkdirSync(shared, { recursive: true });
    configureBundles(primary, shared);
    write(shared, "commands/team/review.md", "Review shared provenance.\n");
    writeWorkflow("cross-bundle", "      - id: review\n        uses: shared//commands/team/review", primary);
    await akmIndex({ stashDir: primary, full: true });

    const started = await startWorkflowRun("primary//workflows/cross-bundle");
    const plan = await persistedPlan(started.run.id);
    const target = targets(plan)[0];
    expect(target?.kind).toBe("command");
    if (!target || target.kind !== "command") return;
    expect(target.ref).toBe("shared//commands/team/review");
    expect(target.request.command.source).toEqual({
      ref: "shared//commands/team/review",
      bundle: "shared",
      adapter: "akm",
      file: "commands/team/review.md",
      hash: target.contentHash,
    });
    expect(plan.sourceReadSet.some((entry) => entry.identity.ref === "shared//commands/team/review")).toBe(true);
  });

  test("projects a task step through the shared task-v3 command, run, and script authorities", async () => {
    write(storage.stashDir, "commands/review.md", "Review the task-composed command.\n");
    write(storage.stashDir, "scripts/exact.sh", "#!/bin/sh\nprintf task-script\n");
    writeTask("command-task", ["uses: commands/review"]);
    writeTask("run-task", ["run: printf task-run", "shell: sh"]);
    writeTask("script-task", ["uses: scripts/exact.sh"]);
    writeWorkflow(
      "task-composition",
      [
        "      - id: command",
        "        uses: tasks/command-task",
        "      - id: run",
        "        uses: tasks/run-task",
        "      - id: script",
        "        uses: tasks/script-task",
      ].join("\n"),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/task-composition");
    const plan = await persistedPlan(started.run.id);
    expect(targets(plan).map((target) => target.kind)).toEqual(["command", "shell", "script"]);
    expect(plan.sourceReadSet.map((entry) => entry.identity.ref)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/\/tasks\/command-task$/),
        expect.stringMatching(/\/\/tasks\/run-task$/),
        expect.stringMatching(/\/\/tasks\/script-task$/),
        expect.stringMatching(/\/\/commands\/review$/),
        expect.stringMatching(/\/\/scripts\/exact\.sh$/),
      ]),
    );
  });

  test("freezes a direct run and a script target without reconstructing either as anonymous agent prose", async () => {
    write(storage.stashDir, "scripts/exact.sh", "#!/bin/sh\nprintf exact-script\n");
    writeWorkflow(
      "native-targets",
      [
        "      - id: run",
        "        run: printf exact-run",
        "        shell: sh",
        "      - id: script",
        "        uses: scripts/exact.sh",
      ].join("\n"),
    );

    const started = await startWorkflowRun("workflows/native-targets");
    const plan = await persistedPlan(started.run.id);
    const [run, script] = targets(plan);
    expect(run).toMatchObject({
      kind: "shell",
      executable: expect.objectContaining({ absolutePath: expect.stringMatching(/^\//), sha256: expect.any(String) }),
    });
    expect(script).toMatchObject({
      kind: "script",
      ref: expect.stringMatching(/\/\/scripts\/exact\.sh$/),
      bytesBase64: Buffer.from("#!/bin/sh\nprintf exact-script\n").toString("base64"),
      materialization: "ephemeral-0700-delete",
      executable: expect.objectContaining({ absolutePath: expect.stringMatching(/^\//), sha256: expect.any(String) }),
    });
  });

  test("rejects a configured CLI whose executable cannot be frozen before creating a run", async () => {
    writeSandboxConfig({
      engines: { missing: { kind: "agent", platform: "claude", bin: "akm-wp7-definitely-missing" } },
      defaults: { engine: "missing" },
      workflow: { judgeEngine: "missing" },
    });
    resetConfigCache();
    write(
      storage.stashDir,
      "workflows/missing-bin.md",
      [
        "---",
        "type: workflow",
        "steps:",
        "  - id: run",
        "---",
        "",
        "## run",
        "",
        "Run with a missing executable.",
        "",
      ].join("\n"),
    );
    const before = await establishStateBaseline();
    await expect(startWorkflowRun("workflows/missing-bin")).rejects.toThrow(/executable|missing|PATH|resolve/i);
    expect(mutationCounts()).toEqual(before);
  });
});

describe("workflow v4 fail-closed source targets", () => {
  test.each([
    // P4 FLIP (docs/plans/specs/p4-deletions-closeout.md §3.3, row B-34,
    // F-A3.11 — discovered flip, recorded in the Review log): a 2-job
    // document now fails at PARSE, at the adapter boundary
    // (multi-job-unsupported), not at the freeze-time "job boundaries and
    // needs" check that row B-44 deletes.
    [
      "multi-job",
      [
        "name: Multi",
        "on: { workflow_dispatch: null }",
        "jobs:",
        "  one:",
        "    runs-on: [self-hosted]",
        "    steps: [{ id: one, run: printf one }]",
        "  two:",
        "    runs-on: [self-hosted]",
        "    steps: [{ id: two, run: printf two }]",
        "",
      ].join("\n"),
      /requires exactly one job/i,
    ],
    // P4 FLIP (docs/plans/specs/p4-deletions-closeout.md §3.1, row B-05,
    // F-A1.19): the locator grammar is deleted — this now rejects as an
    // unrecognized ref shape, not a recognized-but-out-of-scope one.
    ["remote-action", workflowYaml("      - id: remote\n        uses: actions/checkout@v4"), /target ref/i],
    [
      "nonprojectable-agent",
      workflowYaml("      - id: persona\n        uses: agents/reviewer"),
      /agent|persona|not executable|unsupported/i,
    ],
    [
      "secret-literal",
      workflowYaml(
        "      - id: leaked\n        run: printf no\n        env:\n          API_TOKEN: github_pat_012345678901234567890123456789",
      ),
      /secret|literal env|credential/i,
    ],
  ] as const)("rejects %s before run, journal, usage, event, or dispatch mutation", async (name, source, pattern) => {
    write(storage.stashDir, `workflows/${name}.yml`, source);
    const before = await establishStateBaseline();
    await expect(startWorkflowRun(`workflows/${name}`)).rejects.toThrow(pattern);
    expect(mutationCounts()).toEqual(before);
    expect((await listWorkflowRuns()).runs).toHaveLength(0);
  });

  test("fails closed when two qualified refs alias the same physical command file", async () => {
    const primary = path.join(storage.root, "primary-alias");
    const shared = path.join(storage.root, "shared-alias");
    fs.mkdirSync(primary, { recursive: true });
    fs.mkdirSync(shared, { recursive: true });
    configureBundles(primary, shared, shared);
    write(shared, "commands/same.md", "One physical command.\n");
    writeWorkflow(
      "aliased-command",
      "      - id: one\n        uses: shared//commands/same\n      - id: two\n        uses: alias//commands/same",
      primary,
    );
    const before = await establishStateBaseline();
    await expect(akmIndex({ stashDir: primary, full: true })).rejects.toThrow(/same physical content root/i);
    expect(mutationCounts()).toEqual(before);
  });
});

describe("workflow v4 target final-CAS coverage", () => {
  test.each([
    "target-bytes",
    "nested-directory",
  ] as const)("revalidates retained command bytes and ancestry for %s before the first durable write", async (mode) => {
    const command = write(storage.stashDir, "commands/group/review.md", "Original command bytes.\n");
    writeWorkflow("target-cas", "      - id: review\n        uses: commands/group/review");
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const before = await establishStateBaseline();
    const prototype = WorkflowRunsRepository.prototype;
    const original = prototype.publishWorkflowRunV4;
    let casCalls = 0;
    const publication = spyOn(prototype, "publishWorkflowRunV4").mockImplementation(function (
      this: WorkflowRunsRepository,
      input: PublishWorkflowRunV4Input,
    ) {
      return original.call(this, {
        ...input,
        revalidateSources: () => {
          casCalls++;
          if (mode === "target-bytes") {
            fs.writeFileSync(command, "Mutated before final CAS.\n", "utf8");
          } else {
            const group = path.dirname(command);
            fs.renameSync(group, `${group}.old`);
            fs.mkdirSync(group, { recursive: true });
            fs.writeFileSync(command, "Original command bytes.\n", "utf8");
          }
          input.revalidateSources();
        },
      });
    });
    try {
      await expect(startWorkflowRun("workflows/target-cas")).rejects.toThrow(/source|changed|identity|manifest|CAS/i);
    } finally {
      publication.mockRestore();
    }
    expect(casCalls).toBe(1);
    expect(mutationCounts()).toEqual(before);
  });
});
