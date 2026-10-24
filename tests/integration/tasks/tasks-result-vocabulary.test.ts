// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Result-vocabulary re-code and attempt-error allowlist coverage.
 *
 * This file covers:
 *
 *  - the `targetVocab: 2` marker itself, inside the RAW `metadata_json`
 *    column, for every NEW row;
 *  - the exit-78 rewire: `src/commands/tasks/tasks.ts`'s
 *    `result.target.kind === "command"` branch must be
 *    `"shell" || "script"`, or `akm task run` silently stops preserving
 *    configuration failures as exit 78;
 *  - the attempt-error allowlist (`SAFE_TASK_ATTEMPT_ERROR_CODES` includes
 *    `TASK_SOURCE_INVALID` and `COMPOSITION_INVALID`), observed through
 *    `recordTaskAttemptFailure`'s only externally-visible effect (the stored
 *    `detail.error` code) since the allowlist itself is not exported.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../../../src/core/errors";
import { openStateDatabase } from "../../../src/core/state-db";
import type { SpawnFn } from "../../../src/core/subprocess";
import { getTaskHistory } from "../../../src/storage/repositories/task-history-repository";
import { recordTaskAttemptFailure } from "../../../src/tasks/run/attempt-lifecycle";
import { runTask } from "../../../src/tasks/run/run-task";
import { readTaskHistory } from "../../../src/tasks/run/task-history";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let tasksDir: string;
let workflowsDir: string;
let scriptsDir: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  tasksDir = path.join(storage.stashDir, "tasks");
  workflowsDir = path.join(storage.stashDir, "workflows");
  scriptsDir = path.join(storage.stashDir, "scripts");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowsDir, "noop.md"),
    "---\ntype: workflow\nsteps:\n  - id: work\n---\n\n## work\n\nDo it.\n",
    "utf8",
  );
  writeSandboxConfig({
    bundles: { fixture: { path: storage.stashDir, writable: true } },
    defaultBundle: "fixture",
    semanticSearchMode: "off",
    engines: { opencode: { kind: "agent", platform: "opencode" } },
    defaults: { engine: "opencode" },
  });
});

afterEach(() => storage.cleanup());

function writeTask(id: string, yaml: string): void {
  fs.writeFileSync(path.join(tasksDir, `${id}.yml`), yaml, "utf8");
}

function closedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

/** Crib of tests/tasks-runtime-v3-runner.test.ts's `completedSpawn`. */
function completedSpawn(exitCode: number): ReturnType<SpawnFn> {
  return {
    exitCode,
    exited: Promise.resolve(exitCode),
    stdout: closedStream(),
    stderr: closedStream(),
    stdin: null,
    kill() {},
  };
}

/** The raw, decoded `metadata_json` column for a task's most recent history row. */
function rawMetadata(taskId: string): Record<string, unknown> | undefined {
  const db = openStateDatabase();
  try {
    const row = getTaskHistory(db, taskId);
    return row ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : undefined;
  } finally {
    db.close();
  }
}

describe("F-2 (D8) — every NEW history row carries the targetVocab: 2 marker", () => {
  test('a prepared workflow run stores targetVocab: 2 alongside target_kind "workflow"', async () => {
    writeTask("vocab-workflow", "version: 4\nuses: workflows/noop\n");

    const result = await runTask("vocab-workflow", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      runWorkflowStepsImpl: (async ({ target, params = {} }: { target: string; params?: Record<string, unknown> }) => ({
        run: {
          id: "run-vocab-workflow",
          workflowRef: target,
          workflowTitle: "Noop",
          status: "completed" as const,
          params,
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
          completedAt: "2025-01-01T00:00:00Z",
          currentStepId: null,
        },
        executed: [],
      })) as never,
    });

    expect(result.status).toBe("completed");
    expect(rawMetadata("vocab-workflow")).toMatchObject({ targetVocab: 2 });
  });

  test('a prepared command (agent/LLM) run stores targetVocab: 2, target_kind "command", and engine in metadata', async () => {
    writeTask(
      "vocab-command",
      ["version: 4", "uses: akm/command", "with:", "  content: say hi", "engine: opencode", ""].join("\n"),
    );

    const result = await runTask("vocab-command", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      runAgentImpl: (async () => ({ ok: true, exitCode: 0, stdout: "hi", stderr: "", durationMs: 1 })) as never,
    });

    expect(result.status).toBe("completed");
    expect(result.target).toEqual({ kind: "command", engine: "opencode" });
    expect(rawMetadata("vocab-command")).toMatchObject({ targetVocab: 2, engine: "opencode" });
  });

  test('a prepared shell (run:) run stores targetVocab: 2 and target_kind "shell"', async () => {
    writeTask("vocab-shell", "version: 4\nrun: printf ok\nshell: sh\n");

    const result = await runTask("vocab-shell", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      spawnFn: () => completedSpawn(0),
    });

    expect(result.status).toBe("completed");
    expect(result.target.kind).toBe("shell");
    expect(rawMetadata("vocab-shell")).toMatchObject({ targetVocab: 2 });
  });

  test('a prepared script run stores targetVocab: 2 and target_kind "script" (distinguishable from shell)', async () => {
    fs.writeFileSync(path.join(scriptsDir, "vocab-script.sh"), "#!/bin/sh\nprintf ok\n");
    writeTask("vocab-script", "version: 4\nuses: scripts/vocab-script.sh\n");

    const result = await runTask("vocab-script", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      spawnFn: () => completedSpawn(0),
    });

    expect(result.status).toBe("completed");
    expect(result.target.kind).toBe("script");
    expect(rawMetadata("vocab-script")).toMatchObject({ targetVocab: 2 });
  });
});

describe("§5.6 C-7 — the exit-78 rewire survives the vocabulary re-code", () => {
  // A shell task whose command exits 78 -> CLI exit 78, pinned as a code path,
  // not merely as prose (the documented-behavior prose pin is
  // tests/cli/exit-code-hints.test.ts).
  //
  // src/commands/tasks/tasks.ts's exit-78 passthrough branch reads
  // `(result.target.kind === "shell" || result.target.kind === "script")`:
  // "command" means the agent/LLM arm and the native arm reports
  // "shell"/"script", so a branch that still tested "command" would make
  // `akm task run` silently stop preserving configuration failures as exit 78.
  // This test pins BOTH halves at once: the vocabulary in the JSON result AND
  // the preserved exit-78 passthrough.
  test("a shell task whose command exits 78 exits the CLI with 78, and its JSON result reports the new vocabulary", async () => {
    writeTask("vocab-exit-78", 'version: 4\nrun: "exit 78"\nshell: sh\n');

    const { code, stdout, stderr } = await runCliCapture(["task", "run", "vocab-exit-78"]);

    expect(code, stderr).toBe(78);
    const parsed = JSON.parse(stdout) as { result: { target: { kind: string }; detail?: { exitCode?: number } } };
    expect(parsed.result.target.kind).toBe("shell");
    expect(parsed.result.detail?.exitCode).toBe(78);
  });
});

describe("F-4 (P1a advisory) — SAFE_TASK_ATTEMPT_ERROR_CODES gains TASK_SOURCE_INVALID and COMPOSITION_INVALID", () => {
  // The allowlist itself (SAFE_TASK_ATTEMPT_ERROR_CODES in
  // src/tasks/run/attempt-lifecycle.ts) is not exported — its membership is
  // observed the same way production code observes it: through
  // recordTaskAttemptFailure's only externally-visible effect, the stored
  // history row's `detail.error` code. recordTaskAttemptFailure is called
  // directly here (it is itself exported and part of the compat surface,
  // unlike the allowlist) rather than via the workflow-arm dispatch path; the
  // allowlist's OWN effect is exactly what this test pins.
  test.each([
    "TASK_SOURCE_INVALID",
    "COMPOSITION_INVALID",
  ] as const)('a %s dispatch failure records its REAL code in history detail, not "INTERNAL"', (code) => {
    const taskId = `vocab-attempt-${code.toLowerCase()}`;
    recordTaskAttemptFailure({
      taskId,
      reason: "task_dispatch_failed",
      failure: new UsageError(`synthetic ${code} failure for F-4`, code),
      startedAt: new Date("2025-01-01T00:00:00.000Z"),
      finishedAt: new Date("2025-01-01T00:00:00.500Z"),
    });

    const rows = readTaskHistory({ id: taskId });
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.detail?.error).toBe(code);
  });
});
