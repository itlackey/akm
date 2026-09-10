// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #919 — `workflow run <ref>` resolving to an existing active run (the #485
 * concurrency guard) must say so, and `--new` must be able to start a fresh
 * run without touching the one already active.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../../src/core/errors";
import { getCurrentWorkflowScopeKey } from "../../src/workflows/authoring/scope-key";
import type { UnitDispatcher } from "../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../src/workflows/exec/run-workflow";
import { getWorkflowStatus, listWorkflowRuns, startWorkflowRun } from "../../src/workflows/runtime/runs";
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

describe("#919 — `workflow run <ref>` announces a silent resume", () => {
  test("re-running the same ref resumes the active run and reports resumed: true", async () => {
    writeTwoStepWorkflow("silent-resume");

    const first = await runWorkflowSteps({
      target: "workflows/silent-resume",
      maxSteps: 1,
      dispatcher: okDispatcher,
    });
    expect(first.run.status).toBe("active");
    expect(first.resumed).toBeUndefined();

    const second = await runWorkflowSteps({
      target: "workflows/silent-resume",
      maxSteps: 1,
      dispatcher: okDispatcher,
    });

    // Same run, resumed by REF — not a second run, and clearly labeled.
    expect(second.run.id).toBe(first.run.id);
    expect(second.resumed).toBe(true);
    expect(second.run.status).toBe("completed");
  });
});

describe("#919 — `--new` starts a fresh run without touching the active one", () => {
  test("--new creates a second active run; the first stays untouched", async () => {
    writeTwoStepWorkflow("new-flag");

    const first = await runWorkflowSteps({
      target: "workflows/new-flag",
      maxSteps: 1,
      dispatcher: okDispatcher,
    });
    expect(first.run.status).toBe("active");

    const second = await runWorkflowSteps({
      target: "workflows/new-flag",
      newRun: true,
      maxSteps: 1,
      dispatcher: okDispatcher,
    });

    expect(second.run.id).not.toBe(first.run.id);
    expect(second.resumed).toBeUndefined();

    // Both runs are active and independently tracked — the first was never
    // abandoned on the user's behalf (Defensive Code: never auto-abandon).
    const { runs } = await listWorkflowRuns({ workflowRef: "workflows/new-flag", activeOnly: true });
    const ids = runs.map((r) => r.id).sort();
    expect(ids).toEqual([first.run.id, second.run.id].sort());

    const firstStatus = await getWorkflowStatus(first.run.id);
    expect(firstStatus.run.status).toBe("active");
    expect(firstStatus.run.currentStepId).toBe(first.run.currentStepId);
  });

  test("--new against a run id (not a ref) is a usage error", async () => {
    writeTwoStepWorkflow("new-with-id");
    const started = await runWorkflowSteps({
      target: "workflows/new-with-id",
      maxSteps: 1,
      dispatcher: okDispatcher,
    });
    expect(started.run.status).toBe("active");

    await expect(runWorkflowSteps({ target: started.run.id, newRun: true, dispatcher: okDispatcher })).rejects.toThrow(
      UsageError,
    );
  });

  test("parameter flags are allowed together with --new (it is a new run)", async () => {
    fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(storage.stashDir, "workflows", "new-with-params.md"),
      [
        "---",
        "type: workflow",
        "description: --new with params",
        "params:",
        "  label: { type: string }",
        "steps:",
        "  - id: only-step",
        "---",
        "",
        "## only-step",
        "",
        "Handle {{ params.label }}.",
        "",
      ].join("\n"),
      "utf8",
    );

    const first = await runWorkflowSteps({
      target: "workflows/new-with-params",
      params: { label: "first" },
      dispatcher: okDispatcher,
    });
    expect(first.run.status).toBe("completed");

    // The ref has no active run left (it completed), so plain params would be
    // fine too — the point under test is that --new does not reject params.
    const second = await runWorkflowSteps({
      target: "workflows/new-with-params",
      newRun: true,
      params: { label: "second" },
      dispatcher: okDispatcher,
    });
    expect(second.run.id).not.toBe(first.run.id);
    expect(second.run.status).toBe("completed");
  });

  test("parameter flags without --new against an active run name the remedy: --new or `akm workflow abandon <id>`", async () => {
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

    const error = await runWorkflowSteps({
      target: "workflows/params-active",
      params: { label: "second" },
      dispatcher: okDispatcher,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UsageError);
    if (!(error instanceof UsageError)) throw new Error("unreachable");
    expect(error.hint()).toContain("--new");
    expect(error.hint()).toContain(`akm workflow abandon ${first.run.id}`);
    // #942: the message itself (not just the hint) names the blocking run's
    // id and scope, so an operator sees which run and where without having
    // to also print the hint.
    expect(error.message).toContain(first.run.id);
    expect(error.message).toContain(getCurrentWorkflowScopeKey());
  });
});

describe("#942 — publishWorkflowRunV4's own scope-local guard names the blocking run's id and scope", () => {
  test("a direct second startWorkflowRun (bypassing the resolveRunSpecifier resume path) fails with id + scope", async () => {
    writeTwoStepWorkflow("direct-guard");

    const first = await startWorkflowRun("workflows/direct-guard");
    expect(first.run.status).toBe("active");

    const error = await startWorkflowRun("workflows/direct-guard").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    if (!(error instanceof UsageError)) throw new Error("unreachable");
    expect(error.code).toBe("RESOURCE_ALREADY_EXISTS");
    expect(error.message).toContain(first.run.id);
    expect(error.message).toContain(getCurrentWorkflowScopeKey());
  });
});
