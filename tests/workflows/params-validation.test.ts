// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../../src/core/errors";
import { resolveStorageLocations } from "../../src/storage/locations";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../src/workflows/db";
import { buildWorkflowBrief } from "../../src/workflows/exec/brief";
import { reportWorkflowUnit } from "../../src/workflows/exec/report";
import { listWorkflowRuns, startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

/**
 * Reviewer #12: a program can declare `params.files: { type: array }`, but a
 * `--params '{"files":"not-an-array"}'` supplied at start used to flow silently
 * into unit prompts. The param schemas are now frozen into the plan and
 * validated at start (reject) and re-asserted at brief/report plan-load (loud
 * corruption when the journaled params row was edited after the run started).
 */

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

const PARAM_GUARD_WF = `version: 2
name: param-guard
params:
  files: { type: array }
  mode: { type: string, enum: [fast, slow] }
steps:
  - id: review
    title: Review
    unit:
      instructions: Review \${{ params.files }} in \${{ params.mode }} mode.
`;

function writeProgram(name: string, yamlText: string): void {
  const file = path.join(storage.stashDir, "workflows", `${name}.yaml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yamlText, "utf8");
}

/** Direct-SQL escape hatch for simulating a hand-edited params row. */
function tamperParams(runId: string, paramsJson: string): void {
  const db = openWorkflowDatabase(resolveStorageLocations().workflowDb);
  try {
    db.prepare("UPDATE workflow_runs SET params_json = ? WHERE id = ?").run(paramsJson, runId);
  } finally {
    closeWorkflowDatabase(db);
  }
}

describe("#12 — param schema validation at start", () => {
  test("rejects a param whose value violates its declared type, with an actionable error", async () => {
    writeProgram("param-guard", PARAM_GUARD_WF);
    let caught: unknown;
    try {
      await startWorkflowRun("workflow:param-guard", { files: "not-an-array", mode: "fast" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UsageError);
    const message = (caught as UsageError).message;
    expect(message).toContain("params.files");
    expect(message).toContain("expected type array");
    // No run row was created (validation happens before the insert).
    const { runs } = await listWorkflowRuns();
    expect(runs).toHaveLength(0);
  });

  test("rejects a param outside its declared enum", async () => {
    writeProgram("param-guard", PARAM_GUARD_WF);
    await expect(startWorkflowRun("workflow:param-guard", { files: ["a.ts"], mode: "turbo" })).rejects.toThrow(
      /params\.mode/,
    );
  });

  test("accepts params that satisfy every declared schema, and freezes the schemas into the plan", async () => {
    writeProgram("param-guard", PARAM_GUARD_WF);
    const started = await startWorkflowRun("workflow:param-guard", { files: ["a.ts", "b.ts"], mode: "slow" });
    expect(started.run.status).toBe("active");

    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const plan = JSON.parse(row?.plan_json ?? "{}") as { paramSchemas?: Record<string, unknown> };
    expect(plan.paramSchemas).toEqual({
      files: { type: "array" },
      mode: { type: "string", enum: ["fast", "slow"] },
    });
  });

  test("undeclared params are not constrained (the schema map only names what it declares)", async () => {
    writeProgram("param-guard", PARAM_GUARD_WF);
    const started = await startWorkflowRun("workflow:param-guard", {
      files: ["a.ts"],
      mode: "fast",
      extra: { anything: true },
    });
    expect(started.run.status).toBe("active");
  });
});

describe("#12 — journaled params must still satisfy the frozen schemas (brief/report integrity)", () => {
  test("brief refuses a run whose params row was edited to violate the schema", async () => {
    writeProgram("param-guard", PARAM_GUARD_WF);
    const started = await startWorkflowRun("workflow:param-guard", { files: ["a.ts"], mode: "fast" });
    tamperParams(started.run.id, JSON.stringify({ files: "no-longer-an-array", mode: "fast" }));

    await expect(buildWorkflowBrief(started.run.id)).rejects.toThrow(new RegExp(`${started.run.id}.*integrity check`));
  });

  test("report refuses a run whose params row was edited to violate the schema", async () => {
    writeProgram("param-guard", PARAM_GUARD_WF);
    const started = await startWorkflowRun("workflow:param-guard", { files: ["a.ts"], mode: "fast" });
    tamperParams(started.run.id, JSON.stringify({ files: ["a.ts"], mode: "unknown-mode" }));

    await expect(
      reportWorkflowUnit({
        target: started.run.id,
        unitId: "review:solo",
        status: "completed",
        resultRaw: "done",
        summaryJudge: null,
      }),
    ).rejects.toThrow(new RegExp(`${started.run.id}.*integrity check`));
  });

  test("a benign params edit that still satisfies the schema is NOT flagged as corruption", async () => {
    // Consistent with the tampered-params replay-divergence contract: only a
    // SCHEMA violation is loud corruption here; a same-type value change stays a
    // (separately-detected) replay divergence, not a params integrity failure.
    writeProgram("param-guard", PARAM_GUARD_WF);
    const started = await startWorkflowRun("workflow:param-guard", { files: ["a.ts"], mode: "fast" });
    tamperParams(started.run.id, JSON.stringify({ files: ["a.ts", "b.ts"], mode: "slow" }));

    // brief no longer trips the param-integrity assert (it may still surface
    // other state, but must not throw the integrity-check corruption error).
    await expect(buildWorkflowBrief(started.run.id)).resolves.toBeDefined();
  });
});
