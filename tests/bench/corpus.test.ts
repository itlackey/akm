/**
 * Unit tests for the bench corpus loader.
 *
 *   • `listTasks()` returns `[]` cleanly when the corpus dir is missing.
 *   • The shipped sample task at `_example/example-task` loads correctly.
 *   • `partitionSlice` is deterministic — same input → same partitioning
 *     across calls.
 */

import { describe, expect, test } from "bun:test";

import { getTasksRoot, listTasks, loadTask, partitionSlice, type TaskMetadata } from "./corpus";

describe("listTasks", () => {
  test("the corpus root resolves under tests/fixtures/bench/tasks", () => {
    expect(getTasksRoot()).toMatch(/tests[\\/]+fixtures[\\/]+bench[\\/]+tasks$/);
  });

  test("returns an array (possibly empty) without throwing", () => {
    const tasks = listTasks();
    expect(Array.isArray(tasks)).toBe(true);
  });

  test("includes the shipped sample task", () => {
    const tasks = listTasks();
    const sample = tasks.find((t) => t.id === "_example/example-task");
    expect(sample).toBeDefined();
    expect(sample?.title).toContain("Example task");
    expect(sample?.stash).toBe("minimal");
    expect(sample?.verifier).toBe("script");
    expect(sample?.budget.tokens).toBe(1000);
    expect(sample?.budget.wallMs).toBe(30_000);
  });

  test("filters by slice when requested", () => {
    const train = listTasks({ slice: "train" });
    expect(train.every((t) => t.slice === "train" || t.slice === undefined)).toBe(true);
    const evalTasks = listTasks({ slice: "eval" });
    // No eval-only task ships in #236, so this is allowed to be []. We just
    // assert the call shape.
    expect(Array.isArray(evalTasks)).toBe(true);
  });
});

describe("loadTask", () => {
  test("loads the sample task by id", () => {
    const meta = loadTask("_example/example-task");
    expect(meta.title).toContain("Example task");
    expect(meta.taskDir).toContain("_example/example-task");
  });

  test("throws on unknown id", () => {
    expect(() => loadTask("does/not/exist")).toThrow();
  });
});

describe("partitionSlice", () => {
  function fakeTask(id: string, slice?: "train" | "eval"): TaskMetadata {
    return {
      id,
      title: id,
      domain: "test",
      difficulty: "easy",
      stash: "minimal",
      verifier: "regex",
      budget: { tokens: 1000, wallMs: 1000 },
      taskDir: "/tmp/none",
      ...(slice ? { slice } : {}),
    };
  }

  test("explicit slice fields are honoured", () => {
    const tasks = [fakeTask("a", "train"), fakeTask("b", "eval"), fakeTask("c", "train")];
    const { train, eval: evalSlice } = partitionSlice(tasks);
    expect(train.map((t) => t.id).sort()).toEqual(["a", "c"]);
    expect(evalSlice.map((t) => t.id)).toEqual(["b"]);
  });

  test("tasks without explicit slice get a deterministic assignment", () => {
    const tasks = [fakeTask("alpha"), fakeTask("beta"), fakeTask("gamma"), fakeTask("delta"), fakeTask("epsilon")];
    const a = partitionSlice(tasks);
    const b = partitionSlice(tasks);
    expect(a.train.map((t) => t.id)).toEqual(b.train.map((t) => t.id));
    expect(a.eval.map((t) => t.id)).toEqual(b.eval.map((t) => t.id));
    // Sanity: every task ends up in exactly one slice.
    expect(a.train.length + a.eval.length).toBe(tasks.length);
  });
});
