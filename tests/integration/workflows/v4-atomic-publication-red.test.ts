// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The run publication boundary: `publishWorkflowRunV4` writes the run row, its
 * whole step spine, the frozen plan, and the start event in one IMMEDIATE
 * transaction, or nothing at all.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import type { Database } from "../../../src/storage/database";
import { readStateEvents } from "../../../src/storage/repositories/events-repository";
import {
  type PublishWorkflowRunV4Input,
  WorkflowRunsRepository,
  withWorkflowRunsRepo,
} from "../../../src/storage/repositories/workflow-runs-repository";
import { canonicalJson, canonicalPlanJson, computePlanHash } from "../../../src/workflows/ir/plan-hash";
import type { WorkflowPlan } from "../../../src/workflows/plan";
import { decodeWorkflowPlan, frozenStepRows } from "../../../src/workflows/runtime/run-plan";
import { startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

const RUN_ID = "77777777-7777-4777-8777-777777777777";
const NOW = "2026-08-22T12:00:00.000Z";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function cwdIdentity() {
  return {
    requestedRoot: storage.stashDir,
    realRoot: storage.stashDir,
    rootDevice: "7",
    rootInode: "100",
    requestedCwd: storage.stashDir,
    realCwd: storage.stashDir,
    cwdDevice: "7",
    cwdInode: "100",
  };
}

function v4ExecUnit(id: string, script: string) {
  const exec = { command: ["/bin/sh", "-lc", script] as [string, ...string[]], timeoutMs: 10_000 };
  const environment = [{ kind: "literal" as const, name: "AKM_TEST_REGION", value: "central" }];
  const directory = cwdIdentity();
  const contentHash = sha256(`akm.workflow.shell.v1\0${canonicalJson({ exec, environment, cwdIdentity: directory })}`);
  return {
    kind: "unit" as const,
    id,
    instructions: `Execute frozen ${id}.`,
    frozenTarget: { kind: "shell" as const, contentHash, exec, cwdIdentity: directory },
    environment,
    onError: "fail" as const,
    isolation: "none" as const,
  };
}

function v4Plan(): WorkflowPlan {
  return decodeWorkflowPlan({
    irVersion: 6,
    title: "atomic publication",
    sourceHash: sha256("durable atomic workflow source\n"),
    execution: { maxConcurrency: 1 },
    steps: [
      {
        stepId: "prepare",
        title: "prepare",
        sequenceIndex: 0,
        root: v4ExecUnit("prepare", "printf prepare"),
        gate: {
          kind: "gate",
          id: "prepare.gate",
          stepId: "prepare",
          criteria: [],
          maxLoops: 1,
          frozenJudge: null,
        },
      },
      {
        stepId: "publish",
        title: "publish",
        sequenceIndex: 1,
        root: v4ExecUnit("publish", "printf publish"),
        gate: {
          kind: "gate",
          id: "publish.gate",
          stepId: "publish",
          criteria: [],
          maxLoops: 1,
          frozenJudge: null,
        },
      },
    ],
  });
}

function publicationInput(plan: WorkflowPlan): PublishWorkflowRunV4Input {
  const steps = frozenStepRows(plan).map((step) => ({
    runId: RUN_ID,
    stepId: step.stepId,
    stepTitle: step.stepTitle,
    instructions: step.instructions,
    completionJson: step.completionJson,
    sequenceIndex: step.sequenceIndex,
  }));
  return {
    workflowRefs: ["fixture//workflows/atomic-publication"],
    run: {
      id: RUN_ID,
      workflowRef: "fixture//workflows/atomic-publication",
      scopeKey: "dir:v1:atomic-publication",
      workflowEntryId: null,
      workflowTitle: "atomic publication",
      paramsJson: "{}",
      currentStepId: "prepare",
      createdAt: NOW,
      updatedAt: NOW,
      agentHarness: null,
      agentSessionId: null,
    },
    steps,
    planJson: canonicalPlanJson(plan),
    planHash: computePlanHash(plan),
  };
}

function tableCounts(db: Database): Record<string, number> {
  const tables = db
    .prepare<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return Object.fromEntries(
    tables.map(({ name }) => {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const row = db.prepare<{ count: number }>(`SELECT COUNT(*) AS count FROM ${quoted}`).get();
      return [name, row?.count ?? 0];
    }),
  );
}

function nonDatabaseFiles(): string[] {
  const out: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (!entry.name.startsWith("state.db")) out.push(path.relative(storage.root, absolute));
    }
  };
  visit(storage.root);
  return out.sort();
}

function writeWorkflow(name: string): string {
  const file = path.join(storage.stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      "---",
      "type: workflow",
      "description: Atomic v4 publication fixture",
      "steps:",
      "  - id: publish",
      "---",
      "",
      "## publish",
      "",
      "Publish from frozen bytes.",
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

describe("workflow run atomic repository publication", () => {
  test("publishes the plan, complete spine, and one start event together", () => {
    const db = openStateDatabase(getStateDbPath());
    try {
      const repo = new WorkflowRunsRepository(db);
      const plan = v4Plan();
      repo.publishWorkflowRunV4(publicationInput(plan));
      const row = repo.getRunById(RUN_ID);
      expect(row?.plan_json).toBe(canonicalPlanJson(plan));
      expect(row?.plan_hash).toBe(computePlanHash(plan));
      expect(row?.plan_ir_version).toBe(6);
      expect(repo.getStepsForRun(RUN_ID).map((step) => step.step_id)).toEqual(["prepare", "publish"]);
      const events = readStateEvents(db, {
        type: "workflow_started",
        ref: "fixture//workflows/atomic-publication",
      }).events;
      expect(events).toHaveLength(1);
      expect(events[0]?.metadata).toEqual({ runId: RUN_ID, status: "active" });
    } finally {
      db.close();
    }
  });

  test.each([
    [
      "run insert",
      `CREATE TRIGGER wp7_fail_run AFTER INSERT ON workflow_runs WHEN NEW.id = '${RUN_ID}' BEGIN SELECT RAISE(ABORT, 'wp7-fail-run'); END`,
    ],
    [
      "partial spine insert",
      "CREATE TRIGGER wp7_fail_steps AFTER INSERT ON workflow_run_steps WHEN NEW.step_id = 'publish' BEGIN SELECT RAISE(ABORT, 'wp7-fail-steps'); END",
    ],
    [
      "plan attachment",
      `CREATE TRIGGER wp7_fail_plan AFTER UPDATE OF plan_json ON workflow_runs WHEN NEW.id = '${RUN_ID}' AND NEW.plan_ir_version = 6 BEGIN SELECT RAISE(ABORT, 'wp7-fail-plan'); END`,
    ],
    [
      "workflow_started insert",
      "CREATE TRIGGER wp7_fail_event AFTER INSERT ON events WHEN NEW.event_type = 'workflow_started' BEGIN SELECT RAISE(ABORT, 'wp7-fail-event'); END",
    ],
  ] as const)("rolls back every table and non-DB artifact when %s fails", (_label, triggerSql) => {
    const db = openStateDatabase(getStateDbPath());
    try {
      db.exec(triggerSql);
      const beforeTables = tableCounts(db);
      const beforeFiles = nonDatabaseFiles();
      expect(() => new WorkflowRunsRepository(db).publishWorkflowRunV4(publicationInput(v4Plan()))).toThrow(
        /wp7-fail/i,
      );
      expect(tableCounts(db)).toEqual(beforeTables);
      expect(nonDatabaseFiles()).toEqual(beforeFiles);
    } finally {
      db.close();
    }
  });
});

describe("workflow v4 start publication", () => {
  test("fresh starts persist the canonical plan with the complete spine and exactly one start event", async () => {
    writeWorkflow("fresh-v4");
    const started = await startWorkflowRun("workflows/fresh-v4", {});
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    expect(row?.plan_ir_version).toBe(6);
    expect(row?.plan_json).not.toBeNull();
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
    expect(row?.plan_json).toBe(canonicalPlanJson(plan));
    expect(row?.plan_hash).toBe(computePlanHash(plan));
    const steps = await withWorkflowRunsRepo((repo) => repo.getStepsForRun(started.run.id));
    expect(steps.map((step) => step.step_id)).toEqual(plan.steps.map((step) => step.stepId));

    const db = openStateDatabase(getStateDbPath());
    try {
      const events = readStateEvents(db, { type: "workflow_started", ref: row?.workflow_ref }).events.filter(
        (event) => (event.metadata as { runId?: string }).runId === started.run.id,
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.metadata).toEqual({ runId: started.run.id, status: "active" });
    } finally {
      db.close();
    }
  });

  test("a start-event failure cannot leave a committed run in the post-commit event gap", async () => {
    writeWorkflow("event-gap");
    const db = openStateDatabase(getStateDbPath());
    let before: Record<string, number>;
    try {
      db.exec(
        "CREATE TRIGGER wp7_fail_start_event BEFORE INSERT ON events WHEN NEW.event_type = 'workflow_started' BEGIN SELECT RAISE(ABORT, 'wp7-fail-start-event'); END",
      );
      before = tableCounts(db);
    } finally {
      db.close();
    }

    let failure: unknown;
    try {
      await startWorkflowRun("workflows/event-gap", {});
    } catch (error) {
      failure = error;
    }

    const afterDb = openStateDatabase(getStateDbPath());
    try {
      expect(String(failure)).toMatch(/wp7-fail-start-event/i);
      expect(tableCounts(afterDb)).toEqual(before);
    } finally {
      afterDb.close();
    }
  });

  test("performs no authored-source read during publication", async () => {
    writeWorkflow("no-reread");
    const prototype = WorkflowRunsRepository.prototype;
    const original = prototype.publishWorkflowRunV4;
    let inPublication = false;
    const forbiddenReads: string[] = [];
    const realReadFileSync = fs.readFileSync;
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (inPublication) forbiddenReads.push(String(args[0]));
      return realReadFileSync(...args);
    }) as typeof fs.readFileSync);
    const publishSpy = spyOn(prototype, "publishWorkflowRunV4").mockImplementation(function (
      this: WorkflowRunsRepository,
      input: PublishWorkflowRunV4Input,
    ) {
      inPublication = true;
      try {
        return original.call(this, input);
      } finally {
        inPublication = false;
      }
    });
    try {
      await startWorkflowRun("workflows/no-reread", {});
      expect(publishSpy).toHaveBeenCalledTimes(1);
      expect(forbiddenReads).toEqual([]);
    } finally {
      publishSpy.mockRestore();
      readSpy.mockRestore();
    }
  });
});
