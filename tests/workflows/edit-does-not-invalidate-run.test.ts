// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #919: a run keeps executing its frozen plan after its source is edited.
 * Edit the source mid-run, resolve the same ref again, and the run finishes on
 * the ORIGINAL step text — with one warning saying the source changed since
 * the freeze (a resume re-reads the source only to say so).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import type { UnitDispatcher } from "../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../src/workflows/exec/run-workflow";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

function writeWorkflow(name: string, secondStepBody: string): string {
  const file = path.join(storage.stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      "---",
      "type: workflow",
      "description: issue 919 repro workflow",
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
      secondStepBody,
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

const okDispatcher: UnitDispatcher = async () => ({ ok: true, text: "done" });

describe("#919 repro — mid-run source edit does not bump plan_ir_version or invalidate the run", () => {
  test("a resume without an edit says nothing about the source", async () => {
    writeWorkflow("unedited", "Do the second thing.");
    const started = await runWorkflowSteps({ target: "workflows/unedited", maxSteps: 1, dispatcher: okDispatcher });
    expect(started.run.status).toBe("active");
    const resumed = await runWorkflowSteps({ target: "workflows/unedited", dispatcher: okDispatcher });
    expect(resumed.run.status).toBe("completed");
    expect(resumed.warnings ?? []).toEqual([]);
  });

  test("plan_ir_version stays the current version before and after an edit, and the resumed run keeps executing", async () => {
    const file = writeWorkflow("repro-919", "Do the ORIGINAL second thing.");

    // "akm workflow run workflows/repro-919 --max-steps=1"
    const started = await runWorkflowSteps({
      target: "workflows/repro-919",
      maxSteps: 1,
      dispatcher: okDispatcher,
    });
    expect(started.run.status).toBe("active");

    const before = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    expect(before?.plan_ir_version).toBe(6);

    // "edit ~/akm/workflows/repro-919.md — extend a step body"
    writeWorkflow("repro-919", "Do the EDITED second thing, now with more detail.");
    expect(fs.readFileSync(file, "utf8")).toContain("EDITED");

    // "akm workflow run workflows/repro-919" (no --max-steps: run to completion)
    const prompts: string[] = [];
    const resumed = await runWorkflowSteps({
      target: "workflows/repro-919",
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        return { ok: true, text: "done" };
      },
    });

    // The run resolves and finishes on the frozen plan.
    expect(resumed.run.id).toBe(started.run.id);
    expect(resumed.resumed).toBe(true);
    expect(resumed.done).toBe(true);
    expect(resumed.run.status).toBe("completed");

    // ...and says, once, that the source it was frozen from has changed.
    const drift = (resumed.warnings ?? []).filter((w) => w.includes("has changed since this run was frozen"));
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("continuing with the frozen plan");
    expect(drift[0]).toContain("--new");

    // The frozen plan dispatched — never the edited source.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Do the ORIGINAL second thing.");
    expect(prompts[0]).not.toContain("EDITED");

    const after = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    expect(after?.plan_ir_version).toBe(6);
  });
});
