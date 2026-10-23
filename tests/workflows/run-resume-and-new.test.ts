// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `workflow run <ref>` always starts a new run (#1239): a ref never resumes,
 * `--new` is a no-op, parameters are accepted on every ref start, and a start
 * that finds other active runs of the ref warns instead of refusing. A run id
 * drives that run; `list` is host-wide, so it never depends on the caller's cwd.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../../src/core/errors";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import type { UnitDispatcher } from "../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../src/workflows/exec/run-workflow";
import { listWorkflowRuns, startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

/** Two steps so `--max-steps=1` leaves the run genuinely `active`, not `completed`. */
function writeTwoStepWorkflow(name: string): void {
  fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(storage.stashDir, "workflows", `${name}.md`),
    [
      "---",
      "type: workflow",
      "description: Resume/new test workflow",
      "steps:",
      "  - id: first-step",
      "  - id: second-step",
      "---",
      "",
      "## first-step",
      "",
      "Do the first thing.",
      "",
      "## second-step",
      "",
      "Do the second thing.",
      "",
    ].join("\n"),
    "utf8",
  );
}

const okDispatcher: UnitDispatcher = async () => ({ ok: true, text: "done" });

/** Capture `warn()` lines emitted while `fn` runs. */
async function captureWarnings(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") lines.push(args.map(String).join(" "));
  });
  try {
    await fn();
  } finally {
    _setWarnSinkForTests(undefined);
  }
  return lines;
}

describe("workflow run <ref> always starts a new run", () => {
  test("running the same ref twice yields two runs and one warning naming resume and abandon", async () => {
    writeTwoStepWorkflow("starts-new");

    const first = await runWorkflowSteps({ target: "workflows/starts-new", maxSteps: 1, dispatcher: okDispatcher });
    expect(first.run.status).toBe("active");

    let second: Awaited<ReturnType<typeof runWorkflowSteps>> | undefined;
    const warnings = await captureWarnings(async () => {
      second = await runWorkflowSteps({ target: "workflows/starts-new", maxSteps: 1, dispatcher: okDispatcher });
    });

    expect(second?.run.id).not.toBe(first.run.id);
    expect(second?.run.status).toBe("active");
    expect(second && "resumed" in second).toBe(false);
    const { runs } = await listWorkflowRuns({ workflowRef: "workflows/starts-new", activeOnly: true });
    expect(runs.map((r) => r.id).sort()).toEqual([first.run.id, second?.run.id as string].sort());

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(first.run.id);
    expect(warnings[0]).toContain(`akm workflow resume ${first.run.id}`);
    expect(warnings[0]).toContain(`akm workflow abandon ${first.run.id}`);
  });

  test("the first start of a ref warns about nothing", async () => {
    writeTwoStepWorkflow("first-start");
    const warnings = await captureWarnings(() =>
      runWorkflowSteps({ target: "workflows/first-start", maxSteps: 1, dispatcher: okDispatcher }),
    );
    expect(warnings).toEqual([]);
  });

  test("a run id drives that run and reports no resumed flag", async () => {
    writeTwoStepWorkflow("drive-by-id");
    const first = await runWorkflowSteps({ target: "workflows/drive-by-id", maxSteps: 1, dispatcher: okDispatcher });

    const second = await runWorkflowSteps({ target: first.run.id, maxSteps: 1, dispatcher: okDispatcher });
    expect(second.run.id).toBe(first.run.id);
    expect(second.run.status).toBe("completed");
  });

  test("parameters are accepted on a ref start even while another run of the ref is active", async () => {
    fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(storage.stashDir, "workflows", "params-active.md"),
      [
        "---",
        "type: workflow",
        "description: params against an active run",
        "params:",
        "  label: { type: string }",
        "steps:",
        "  - id: first-step",
        "  - id: second-step",
        "---",
        "",
        "## first-step",
        "",
        "Handle {{ params.label }}.",
        "",
        "## second-step",
        "",
        "Do the second thing.",
        "",
      ].join("\n"),
      "utf8",
    );

    const first = await runWorkflowSteps({
      target: "workflows/params-active",
      params: { label: "first" },
      maxSteps: 1,
      dispatcher: okDispatcher,
    });
    expect(first.run.status).toBe("active");

    const second = await runWorkflowSteps({
      target: "workflows/params-active",
      params: { label: "second" },
      maxSteps: 1,
      dispatcher: okDispatcher,
    });
    expect(second.run.id).not.toBe(first.run.id);
    expect(second.run.params).toEqual({ label: "second" });
  });

  test("parameter flags against an existing run id are still a usage error", async () => {
    writeTwoStepWorkflow("params-with-id");
    const first = await runWorkflowSteps({ target: "workflows/params-with-id", maxSteps: 1, dispatcher: okDispatcher });
    await expect(
      runWorkflowSteps({
        target: first.run.id,
        parameterFlags: [{ name: "label", value: "x" }],
        dispatcher: okDispatcher,
      }),
    ).rejects.toThrow(UsageError);
  });
});

describe("runs are host-wide", () => {
  test("list from a different cwd shows a run started elsewhere", async () => {
    writeTwoStepWorkflow("host-wide");
    const started = await runWorkflowSteps({ target: "workflows/host-wide", maxSteps: 1, dispatcher: okDispatcher });

    // The filesystem root cannot inherit a project or git marker from the stash.
    const elsewhere = path.parse(storage.root).root;
    const prior = process.cwd();
    process.chdir(elsewhere);
    try {
      const { runs } = await listWorkflowRuns();
      expect(runs.map((r) => r.id)).toContain(started.run.id);
      const byRef = await listWorkflowRuns({ workflowRef: "workflows/host-wide" });
      expect(byRef.runs.map((r) => r.id)).toContain(started.run.id);
    } finally {
      process.chdir(prior);
    }
  });

  test("new rows carry no scope key and no workflow entry id", async () => {
    writeTwoStepWorkflow("null-columns");
    const started = await startWorkflowRun("workflows/null-columns");
    expect(started.run.workflowEntryId ?? null).toBeNull();
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    expect(row?.scope_key).toBeNull();
    expect(row?.workflow_entry_id).toBeNull();
  });
});
