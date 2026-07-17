// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-2.2 — parity tests for the `task` `BundleAdapter`
 * (`src/core/adapter/adapters/task-adapter.ts`) against the Chunk 0b goldens
 * (`tests/fixtures/goldens/{recognition,placement,lint}/all-types.json`).
 * See `skill-adapter.test.ts`'s header for the shared byte-for-byte-parity
 * rationale.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { taskAdapter } from "../../../src/core/adapter/adapters/task-adapter";
import type { BundleComponent } from "../../../src/core/adapter/types";
import { buildFileContext } from "../../../src/indexer/walk/file-context";
import { walkStashFlat } from "../../../src/indexer/walk/walker";
import { makeFsValidateContext } from "./_helpers/validate-context";

const ALL_TYPES_ROOT = path.resolve(__dirname, "../../fixtures/stashes/all-types");
const TASKS_ROOT = path.join(ALL_TYPES_ROOT, "tasks");

const RECOGNITION_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/recognition/all-types.json"), "utf8"),
);
const PLACEMENT_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/placement/all-types.json"), "utf8"),
);
const LINT_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/lint/all-types.json"), "utf8"),
);

const TASK_REL_PATH = "tasks/all-types-task.yml";

function tasksComponent(): BundleComponent {
  return { id: "tasks", adapter: "task", root: TASKS_ROOT, writable: true };
}

describe("task adapter — recognition parity vs recognition/all-types.json", () => {
  test(
    "recognizes tasks/all-types-task.yml as type task (golden: " +
      RECOGNITION_GOLDEN.byRelPath[TASK_REL_PATH].type +
      ")",
    () => {
      const component = tasksComponent();
      const file = buildFileContext(TASKS_ROOT, path.join(ALL_TYPES_ROOT, TASK_REL_PATH));
      const doc = taskAdapter.recognize(component, file);
      expect(doc).not.toBeNull();
      expect(doc?.type).toBe(RECOGNITION_GOLDEN.byRelPath[TASK_REL_PATH].type);
      expect(doc?.adapterId).toBe("task");
      expect(doc?.conceptId).toBe("all-types-task");
      expect(doc?.path).toBe(path.join(ALL_TYPES_ROOT, TASK_REL_PATH));
    },
  );

  test("folds applyTaskMetadata: tags gain task/scheduled and searchHints gain schedule:/prompt: (refined-D2-7, not pinned by the golden — see file header)", () => {
    const component = tasksComponent();
    const file = buildFileContext(TASKS_ROOT, path.join(ALL_TYPES_ROOT, TASK_REL_PATH));
    const doc = taskAdapter.recognize(component, file);
    expect(doc?.tags?.sort()).toEqual(["scheduled", "task"]);
    // Fixture: schedule: "@daily", enabled: false, prompt: "Say hello...".
    expect(doc?.searchHints).toContain("schedule:@daily");
    expect(doc?.searchHints).toContain("prompt:Say hello from the all-types fixture task.");
    // No description contributor exists for task (applyTaskMetadata does not
    // set entry.description) — verified against the actual code, not the
    // WI-2.2 brief's "name/description" paraphrase (see file header).
    expect(doc?.description).toBeUndefined();
  });

  test("abstains (returns null) on every other all-types fixture file", () => {
    const component = tasksComponent();
    const files = walkStashFlat(ALL_TYPES_ROOT).filter(
      (f) => f.relPath !== TASK_REL_PATH && f.relPath !== "MANIFEST.json",
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const doc = taskAdapter.recognize(component, file);
      expect(doc, `expected task adapter to abstain on ${file.relPath}`).toBeNull();
    }
  });
});

describe("task adapter — placement parity vs placement/all-types.json", () => {
  test("placeNew reproduces the task .yml placement", () => {
    const golden = PLACEMENT_GOLDEN.byType.task;
    expect(golden.stashDir).toBe("tasks");
    const component: BundleComponent = {
      id: "tasks",
      adapter: "task",
      root: path.join(ALL_TYPES_ROOT, golden.stashDir),
      writable: true,
    };
    const result = taskAdapter.placeNew?.(component, golden.name);
    expect(result).toBeDefined();
    const relResult = path
      .relative(ALL_TYPES_ROOT, result as string)
      .split(path.sep)
      .join("/");
    expect(relResult).toBe(golden.assetPath);
  });

  test("placeNew is idempotent for an already-.yml-suffixed conceptId (edgeCases.taskAlreadySuffixedNameIsIdempotent)", () => {
    const golden = PLACEMENT_GOLDEN.edgeCases.taskAlreadySuffixedNameIsIdempotent;
    const component: BundleComponent = { id: "tasks", adapter: "task", root: TASKS_ROOT, writable: true };
    const result = taskAdapter.placeNew?.(component, golden.name);
    const relResult = path
      .relative(ALL_TYPES_ROOT, result as string)
      .split(path.sep)
      .join("/");
    expect(relResult).toBe(golden.assetPath);
  });
});

describe("task adapter — validate() parity vs lint/all-types.json perType.task", () => {
  test("validate() returns [] for the lint-clean fixture task.yml (matches perType.task.issues, linterUsed: TaskLinter)", async () => {
    const golden = LINT_GOLDEN.perType.task;
    expect(golden.issues).toEqual([]);
    expect(golden.linterUsed).toBe("TaskLinter");

    const component = tasksComponent();
    const raw = fs.readFileSync(path.join(ALL_TYPES_ROOT, TASK_REL_PATH), "utf8");
    const ctx = makeFsValidateContext(TASKS_ROOT);
    const diagnostics = await taskAdapter.validate(
      component,
      [{ path: "all-types-task.yml", op: "update", after: raw }],
      ctx,
    );
    expect(diagnostics).toEqual([]);
  });

  test("validate() flags invalid-task-yaml for missing required fields", async () => {
    const component = tasksComponent();
    const ctx = makeFsValidateContext(TASKS_ROOT);
    const diagnostics = await taskAdapter.validate(
      component,
      [{ path: "broken.yml", op: "create", after: 'schedule: "@daily"\n' }],
      ctx,
    );
    expect(diagnostics).toEqual([
      {
        file: "broken.yml",
        issue: "invalid-task-yaml",
        detail: "missing required fields: enabled (must be a boolean), prompt, workflow, or command",
        fixed: false,
      },
    ]);
  });

  test("validate() skips the field checks (but still runs base checks) when the YAML fails to parse — mirrors TaskLinter's 'ctx.data empty' short-circuit", async () => {
    const component = tasksComponent();
    const ctx = makeFsValidateContext(TASKS_ROOT);
    const diagnostics = await taskAdapter.validate(
      component,
      [{ path: "unparsable.yml", op: "create", after: "not: valid: yaml: [" }],
      ctx,
    );
    expect(diagnostics).toEqual([]);
  });
});
