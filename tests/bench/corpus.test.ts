/**
 * Unit tests for the bench corpus loader.
 *
 *   • `listTasks()` returns `[]` cleanly when the corpus dir is missing.
 *   • The shipped sample task at `_example/example-task` is excluded by
 *     default but loadable via `{ includeExamples: true }`.
 *   • The seeded corpus contains 17 tasks (issue #237) and every entry
 *     validates against the §13.1 schema.
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

  test("excludes `_example/` tasks by default", () => {
    const tasks = listTasks();
    expect(tasks.find((t) => t.id.startsWith("_example/"))).toBeUndefined();
  });

  test("loads `_example/` when includeExamples is set", () => {
    const tasks = listTasks({ includeExamples: true });
    const sample = tasks.find((t) => t.id === "_example/example-task");
    expect(sample).toBeDefined();
    expect(sample?.title).toContain("Example task");
    expect(sample?.stash).toBe("minimal");
    expect(sample?.verifier).toBe("script");
    expect(sample?.budget.tokens).toBe(1000);
    expect(sample?.budget.wallMs).toBe(30_000);
  });

  test("seeds 17 hand-authored tasks across three domains (issue #237)", () => {
    const tasks = listTasks();
    expect(tasks).toHaveLength(17);
    const byDomain = new Map<string, TaskMetadata[]>();
    for (const task of tasks) {
      const list = byDomain.get(task.domain) ?? [];
      list.push(task);
      byDomain.set(task.domain, list);
    }
    expect(new Set(byDomain.keys())).toEqual(new Set(["docker-homelab", "az-cli", "opencode"]));
    expect(byDomain.get("docker-homelab")).toHaveLength(6);
    expect(byDomain.get("az-cli")).toHaveLength(6);
    expect(byDomain.get("opencode")).toHaveLength(5);
  });

  test("every task validates against the §13.1 schema", () => {
    const ID_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
    for (const task of listTasks()) {
      expect(task.id).toMatch(ID_RE);
      expect(task.title.length).toBeGreaterThan(0);
      expect(["easy", "medium", "hard"]).toContain(task.difficulty);
      expect(["train", "eval"]).toContain(task.slice as string);
      expect(["pytest", "script", "regex"]).toContain(task.verifier);
      expect(typeof task.stash).toBe("string");
      expect(task.budget.tokens).toBeGreaterThan(0);
      expect(task.budget.wallMs).toBeGreaterThan(0);
      if (task.verifier === "regex") {
        expect(task.expectedMatch).toBeDefined();
        expect((task.expectedMatch ?? "").length).toBeGreaterThan(0);
      }
    }
  });

  test("filters by slice when requested", () => {
    const train = listTasks({ slice: "train" });
    const evalTasks = listTasks({ slice: "eval" });
    expect(train.every((t) => t.slice === "train")).toBe(true);
    expect(evalTasks.every((t) => t.slice === "eval")).toBe(true);
    // The seeded corpus is split 9 train / 8 eval.
    expect(train).toHaveLength(9);
    expect(evalTasks).toHaveLength(8);
  });
});

describe("loadTask", () => {
  test("loads a real corpus task by id", () => {
    const meta = loadTask("docker-homelab/redis-healthcheck");
    expect(meta.title).toContain("Redis healthcheck");
    expect(meta.taskDir).toContain("docker-homelab/redis-healthcheck");
    expect(meta.verifier).toBe("pytest");
  });

  test("loads the example task only with includeExamples", () => {
    expect(() => loadTask("_example/example-task")).toThrow();
    const meta = loadTask("_example/example-task", { includeExamples: true });
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

  test("partition of the real corpus is stable across calls", () => {
    const corpus = listTasks();
    const a = partitionSlice(corpus);
    const b = partitionSlice(corpus);
    expect(a.train.map((t) => t.id)).toEqual(b.train.map((t) => t.id));
    expect(a.eval.map((t) => t.id)).toEqual(b.eval.map((t) => t.id));
  });
});
