// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../../../src/core/errors";
import { openStateDatabase } from "../../../src/core/state-db";
import { resolveStorageLocations } from "../../../src/storage/locations";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { getWorkflowStatus, listWorkflowRuns, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

/**
 * Reviewer #12: a program can declare `params.files: { type: array }`, but a
 * `--params '{"files":"not-an-array"}'` supplied at start used to flow silently
 * into unit prompts. The param schemas are now frozen into the plan and
 * validated at start (reject) and re-asserted when the engine loads the frozen
 * plan (loud corruption when the journaled params row was edited after the run
 * started).
 */

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

// Unified-format fixture (frontmatter graph + `## <id>` body — spec §2.2).
// Prose is never templated (spec §2.3): the review step refers to the
// `files`/`mode` params in plain language rather than a template expression.
const PARAM_GUARD_WF = `---
type: workflow
description: Param guard test
params:
  files: { type: array }
  mode: { type: string, enum: [fast, slow] }
steps:
  - id: review
---

## review

Review the files given by the \`files\` parameter, in the mode given by the \`mode\` parameter.
`;

function writeProgram(name: string, markdown: string): void {
  const file = path.join(storage.stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, markdown, "utf8");
}

/** Direct-SQL escape hatch for simulating a hand-edited params row. */
function tamperParams(runId: string, paramsJson: string): void {
  const db = openStateDatabase(resolveStorageLocations().stateDb);
  try {
    db.prepare("UPDATE workflow_runs SET params_json = ? WHERE id = ?").run(paramsJson, runId);
  } finally {
    db.close();
  }
}

describe("#12 — param schema validation at start", () => {
  test("rejects a param whose value violates its declared type, with an actionable error", async () => {
    writeProgram("param-guard", PARAM_GUARD_WF);
    let caught: unknown;
    try {
      await startWorkflowRun("workflows/param-guard", { files: "not-an-array", mode: "fast" });
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
    await expect(startWorkflowRun("workflows/param-guard", { files: ["a.ts"], mode: "turbo" })).rejects.toThrow(
      /params\.mode/,
    );
  });

  test("accepts params that satisfy every declared schema, and freezes the schemas into the plan", async () => {
    writeProgram("param-guard", PARAM_GUARD_WF);
    const started = await startWorkflowRun("workflows/param-guard", { files: ["a.ts", "b.ts"], mode: "slow" });
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
    const started = await startWorkflowRun("workflows/param-guard", {
      files: ["a.ts"],
      mode: "fast",
      extra: { anything: true },
    });
    expect(started.run.status).toBe("active");
  });

  test("workflow run surfaces the secret-shaped-param warning without leaking the value or retired driver prose", async () => {
    writeProgram("param-guard", PARAM_GUARD_WF);
    const secretValue = "sk-live-ABCD1234efgh5678IJKL9012mnop3456";
    const result = await runWorkflowSteps({
      target: "workflows/param-guard",
      params: { files: ["a.ts"], mode: "fast", apiKey: secretValue },
      summaryJudge: null,
      dispatcher: async () => ({ ok: true, text: "done" }),
    });

    const warning = result.warnings?.find((entry) => entry.includes('Run param "apiKey"'));
    expect(warning).toBeDefined();
    expect(warning).toContain("native unit execution context");
    expect(warning).toContain("akm workflow run");
    expect(warning).toContain("akm workflow status");
    expect(warning).not.toContain(secretValue);
    expect(warning).not.toMatch(/\bdrivers?\b|workflow brief|`brief`/i);
  });
});

describe("#12 — journaled params must still satisfy the frozen schemas (execution integrity)", () => {
  test("`workflow run` refuses a run whose params row was edited to violate a declared type", async () => {
    writeProgram("param-guard", PARAM_GUARD_WF);
    const started = await startWorkflowRun("workflows/param-guard", { files: ["a.ts"], mode: "fast" });
    tamperParams(started.run.id, JSON.stringify({ files: "no-longer-an-array", mode: "fast" }));

    let dispatches = 0;
    await expect(
      runWorkflowSteps({
        target: started.run.id,
        summaryJudge: null,
        dispatcher: async () => {
          dispatches++;
          return { ok: true, text: "must not run" };
        },
      }),
    ).rejects.toThrow(new RegExp(`${started.run.id}.*integrity check`));
    // The assert fires on plan load — before any unit prompt is resolved from
    // the schema-violating params, so nothing is dispatched (or paid for).
    expect(dispatches).toBe(0);
  });

  test("`workflow run` refuses a run whose params row was edited outside a declared enum", async () => {
    writeProgram("param-guard", PARAM_GUARD_WF);
    const started = await startWorkflowRun("workflows/param-guard", { files: ["a.ts"], mode: "fast" });
    tamperParams(started.run.id, JSON.stringify({ files: ["a.ts"], mode: "unknown-mode" }));

    let dispatches = 0;
    await expect(
      runWorkflowSteps({
        target: started.run.id,
        summaryJudge: null,
        dispatcher: async () => {
          dispatches++;
          return { ok: true, text: "must not run" };
        },
      }),
    ).rejects.toThrow(new RegExp(`${started.run.id}.*integrity check`));
    expect(dispatches).toBe(0);
  });

  test("a benign params edit that still satisfies the schema is NOT flagged as corruption", async () => {
    // Only a SCHEMA violation is loud corruption here; a same-type value change
    // is just the params the run now executes with.
    writeProgram("param-guard", PARAM_GUARD_WF);
    const started = await startWorkflowRun("workflows/param-guard", { files: ["a.ts"], mode: "fast" });
    const tampered = { files: ["a.ts", "b.ts"], mode: "slow" };
    tamperParams(started.run.id, JSON.stringify(tampered));

    // The engine no longer trips the param-integrity assert: the run executes
    // to completion instead of throwing the integrity-check corruption error …
    let dispatches = 0;
    const result = await runWorkflowSteps({
      target: started.run.id,
      summaryJudge: null,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "done" };
      },
    });
    expect(result.done).toBe(true);
    expect(dispatches).toBe(1);

    // … and the read surface reports the tampered (but schema-valid) params
    // verbatim rather than silently reverting to the originally-started values.
    const status = await getWorkflowStatus(started.run.id);
    expect(status.run.id).toBe(started.run.id);
    expect(status.run.params).toEqual(tampered);
  });
});
