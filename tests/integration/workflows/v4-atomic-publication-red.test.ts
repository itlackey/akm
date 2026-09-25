// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests-first contract for the WP7 durable-v4 publication boundary.
 *
 * The deliberately additive `publishWorkflowRunV4` repository method does not
 * exist at the checkpoint this suite is committed against. Keeping access to
 * it structural lets every contract report its own RED result instead of
 * stopping this file at module evaluation.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { type Database, openDatabase } from "../../../src/storage/database";
import { readStateEvents } from "../../../src/storage/repositories/events-repository";
import {
  type InsertRunInput,
  type InsertStepInput,
  WorkflowRunsRepository,
  withWorkflowRunsRepo,
} from "../../../src/storage/repositories/workflow-runs-repository";
import { canonicalJson, canonicalPlanJson, computePlanHash } from "../../../src/workflows/ir/plan-hash";
import { decodeWorkflowPlanV4, type WorkflowPlanGraphV4 } from "../../../src/workflows/ir/schema-v4";
import { frozenStepRows } from "../../../src/workflows/runtime/run-plan";
import { startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

const RUN_ID = "77777777-7777-4777-8777-777777777777";
const NOW = "2026-08-22T12:00:00.000Z";

interface PublishWorkflowRunV4InputContract {
  readonly workflowRefs: readonly string[];
  readonly force?: boolean;
  readonly run: InsertRunInput;
  readonly steps: InsertStepInput[];
  readonly planJson: string;
  readonly planHash: string;
  /** Final source CAS. It must run once, inside IMMEDIATE, before the first write. */
  readonly revalidateSources: () => void;
}

type PublishWorkflowRunV4Contract = (input: PublishWorkflowRunV4InputContract) => unknown;
type RepositoryWithV4Publisher = WorkflowRunsRepository & {
  publishWorkflowRunV4?: PublishWorkflowRunV4Contract;
};

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

function v4Plan(): WorkflowPlanGraphV4 {
  const sourceBytes = "durable atomic workflow source\n";
  return decodeWorkflowPlanV4({
    irVersion: 5,
    title: "atomic publication",
    sourceReadSet: [
      {
        identity: {
          ref: "fixture//workflows/atomic-publication",
          bundle: "fixture",
          adapter: "akm",
          file: "workflows/atomic-publication.md",
          hash: sha256(sourceBytes),
        },
        containmentPhysicalIdentity: "root-device:7/root-inode:100",
        physicalIdentity: "file-device:7/file-inode:200",
        size: Buffer.byteLength(sourceBytes),
      },
    ],
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

function publicationInput(plan: WorkflowPlanGraphV4, revalidateSources: () => void): PublishWorkflowRunV4InputContract {
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
    revalidateSources,
  };
}

function publishV4(repo: WorkflowRunsRepository, input: PublishWorkflowRunV4InputContract): unknown {
  const publisher = (repo as RepositoryWithV4Publisher).publishWorkflowRunV4;
  if (typeof publisher !== "function") {
    throw new Error("WorkflowRunsRepository.publishWorkflowRunV4 is required by the WP7 atomic-publication contract");
  }
  return publisher.call(repo, input);
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

function assertImmediateWriterIsHeld(dbPath: string): void {
  const contender = openDatabase(dbPath);
  try {
    contender.exec("PRAGMA busy_timeout = 0");
    let acquired = false;
    try {
      contender.exec("BEGIN IMMEDIATE");
      acquired = true;
    } catch {
      // Expected: the publisher already owns the IMMEDIATE writer lock.
    } finally {
      if (acquired) contender.exec("ROLLBACK");
    }
    expect(acquired).toBe(false);
  } finally {
    contender.close();
  }
}

function sourceRevalidator(sourcePath: string, expected: { dev: bigint; ino: bigint; hash: string }): () => void {
  return () => {
    const stat = fs.statSync(sourcePath, { bigint: true });
    if (stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error("stale source physical identity");
    if (sha256(fs.readFileSync(sourcePath)) !== expected.hash) throw new Error("mutated source content hash");
  };
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

describe("workflow v4 atomic repository publication", () => {
  test("publishes the canonical v4 plan, complete spine, and one start event in one IMMEDIATE transaction", () => {
    const dbPath = getStateDbPath();
    const db = openStateDatabase(dbPath);
    try {
      const repo = new WorkflowRunsRepository(db);
      const plan = v4Plan();
      let casCalls = 0;
      publishV4(
        repo,
        publicationInput(plan, () => {
          casCalls += 1;
          expect(db.inTransaction).toBe(true);
          expect(repo.getRunById(RUN_ID)).toBeUndefined();
          expect(repo.getStepsForRun(RUN_ID)).toEqual([]);
          expect(readStateEvents(db, { type: "workflow_started" }).events).toEqual([]);
          assertImmediateWriterIsHeld(dbPath);
        }),
      );

      expect(casCalls).toBe(1);
      const row = repo.getRunById(RUN_ID);
      expect(row?.plan_json).toBe(canonicalPlanJson(plan));
      expect(row?.plan_hash).toBe(computePlanHash(plan));
      expect(row?.plan_ir_version).toBe(5);
      expect(repo.getStepsForRun(RUN_ID).map((step) => step.step_id)).toEqual(["prepare", "publish"]);
      const source = plan.sourceReadSet[0];
      if (!source) throw new Error("v4 fixture requires its workflow source identity");
      const events = readStateEvents(db, { type: "workflow_started", ref: source.identity.ref }).events;
      expect(events).toHaveLength(1);
      expect(events[0]?.metadata).toEqual({ runId: RUN_ID, status: "active" });
    } finally {
      db.close();
    }
  });

  test.each([
    "replaced",
    "mutated",
    "deleted",
  ] as const)("rejects a %s source at final CAS before any durable mutation", (failure) => {
    const sourcePath = path.join(storage.stashDir, "workflows", "cas-source.md");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "original source\n", "utf8");
    const originalStat = fs.statSync(sourcePath, { bigint: true });
    const expected = { dev: originalStat.dev, ino: originalStat.ino, hash: sha256(fs.readFileSync(sourcePath)) };
    if (failure === "replaced") {
      fs.renameSync(sourcePath, `${sourcePath}.old`);
      fs.writeFileSync(sourcePath, "original source\n", "utf8");
    } else if (failure === "mutated") {
      fs.writeFileSync(sourcePath, "mutated source\n", "utf8");
    } else {
      fs.unlinkSync(sourcePath);
    }

    const db = openStateDatabase(getStateDbPath());
    try {
      const beforeTables = tableCounts(db);
      const beforeFiles = nonDatabaseFiles();
      expect(() =>
        publishV4(new WorkflowRunsRepository(db), publicationInput(v4Plan(), sourceRevalidator(sourcePath, expected))),
      ).toThrow(/source|ENOENT|no such file/i);
      expect(tableCounts(db)).toEqual(beforeTables);
      expect(nonDatabaseFiles()).toEqual(beforeFiles);
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
      `CREATE TRIGGER wp7_fail_plan AFTER UPDATE OF plan_json ON workflow_runs WHEN NEW.id = '${RUN_ID}' AND NEW.plan_ir_version = 5 BEGIN SELECT RAISE(ABORT, 'wp7-fail-plan'); END`,
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
      let casCalls = 0;
      expect(() =>
        publishV4(
          new WorkflowRunsRepository(db),
          publicationInput(v4Plan(), () => {
            casCalls += 1;
          }),
        ),
      ).toThrow(/wp7-fail/i);
      expect(casCalls).toBe(1);
      expect(tableCounts(db)).toEqual(beforeTables);
      expect(nonDatabaseFiles()).toEqual(beforeFiles);
    } finally {
      db.close();
    }
  });
});

describe("workflow v4 start publication", () => {
  test("fresh starts persist canonical IR v4 with the complete spine and exactly one start event", async () => {
    writeWorkflow("fresh-v4");
    const started = await startWorkflowRun("workflows/fresh-v4", {});
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    expect(row?.plan_ir_version).toBe(5);
    expect(row?.plan_json).not.toBeNull();
    const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));
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

  test("performs no authored-source read in publication outside the single final-CAS callback", async () => {
    writeWorkflow("no-reread");
    const prototype = WorkflowRunsRepository.prototype as RepositoryWithV4Publisher;
    const original = prototype.publishWorkflowRunV4;
    if (typeof original !== "function") {
      throw new Error(
        "WorkflowRunsRepository.publishWorkflowRunV4 is required by the WP7 source-read ordering contract",
      );
    }

    let inPublication = false;
    let inFinalCas = false;
    let finalCasCalls = 0;
    const forbiddenReads: string[] = [];
    const realReadFileSync = fs.readFileSync;
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (inPublication && !inFinalCas) forbiddenReads.push(String(args[0]));
      return realReadFileSync(...args);
    }) as typeof fs.readFileSync);
    const publishSpy = spyOn(prototype, "publishWorkflowRunV4").mockImplementation(function (
      this: WorkflowRunsRepository,
      input: PublishWorkflowRunV4InputContract,
    ) {
      const revalidate = input.revalidateSources;
      inPublication = true;
      try {
        return original.call(this, {
          ...input,
          revalidateSources: () => {
            finalCasCalls += 1;
            inFinalCas = true;
            try {
              revalidate();
            } finally {
              inFinalCas = false;
            }
          },
        });
      } finally {
        inPublication = false;
      }
    });
    try {
      await startWorkflowRun("workflows/no-reread", {});
      expect(finalCasCalls).toBe(1);
      expect(forbiddenReads).toEqual([]);
    } finally {
      publishSpy.mockRestore();
      readSpy.mockRestore();
    }
  });
});
