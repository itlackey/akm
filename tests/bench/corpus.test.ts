/**
 * Unit tests for the bench corpus loader.
 *
 *   • `listTasks()` returns `[]` cleanly when the corpus dir is missing.
 *   • The shipped sample task at `_example/example-task` is excluded by
 *     default but loadable via `{ includeExamples: true }`.
 *   • The seeded corpus contains 23 tasks (issue #237 seeded 17 across
 *     three domains; #259 added six workflow-compliance tasks) and every
 *     entry validates against the §13.1 schema.
 *   • `partitionSlice` is deterministic — same input → same partitioning
 *     across calls.
 */

import { describe, expect, test } from "bun:test";

import fs from "node:fs";
import path from "node:path";

import {
  computeTaskCorpusHash,
  effectiveSlice,
  getTasksRoot,
  listTasks,
  loadTask,
  MEMORY_ABILITY_VALUES,
  parseTaskYaml,
  partitionSlice,
  readTaskBody,
  type TaskMetadata,
} from "./corpus";
import { benchMkdtemp } from "./tmp";

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

  test("seeds hand-authored tasks across all domains", () => {
    const tasks = listTasks();
    expect(tasks).toHaveLength(40);
    const byDomain = new Map<string, TaskMetadata[]>();
    for (const task of tasks) {
      const list = byDomain.get(task.domain) ?? [];
      list.push(task);
      byDomain.set(task.domain, list);
    }
    expect(new Set(byDomain.keys())).toEqual(
      new Set(["docker-homelab", "az-cli", "opencode", "workflow-compliance", "drillbit", "inkwell"]),
    );
    expect(byDomain.get("docker-homelab")).toHaveLength(6);
    expect(byDomain.get("az-cli")).toHaveLength(6);
    expect(byDomain.get("opencode")).toHaveLength(6);
    expect(byDomain.get("workflow-compliance")).toHaveLength(6);
    expect(byDomain.get("drillbit")).toHaveLength(7);
    expect(byDomain.get("inkwell")).toHaveLength(9);
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
    // 23 train (19 + 2 drillbit train + 2 inkwell train)
    // 17 eval  (15 prior + 2 new: inkwell/full-config + opencode/select-correct-skill)
    expect(train).toHaveLength(23);
    expect(evalTasks).toHaveLength(17);
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

  test("computeTaskCorpusHash is deterministic and order-independent (#250)", () => {
    const bodies = new Map<string, string>([
      ["a/one", "id: a/one\ntitle: One\n"],
      ["b/two", "id: b/two\ntitle: Two\n"],
    ]);
    const h1 = computeTaskCorpusHash(["a/one", "b/two"], bodies);
    const h2 = computeTaskCorpusHash(["b/two", "a/one"], bodies);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);

    // Body change → hash change.
    const altBodies = new Map(bodies);
    altBodies.set("a/one", "id: a/one\ntitle: Different\n");
    const h3 = computeTaskCorpusHash(["a/one", "b/two"], altBodies);
    expect(h3).not.toBe(h1);

    // ID-set change → hash change.
    const h4 = computeTaskCorpusHash(["a/one"], bodies);
    expect(h4).not.toBe(h1);

    // readTaskBody returns "" for a missing taskDir without throwing.
    expect(readTaskBody("/does/not/exist")).toBe("");
  });

  test("a task without explicit slice is bucketed deterministically and goes to exactly one slice", () => {
    // This guards against the regression where `listTasks({ slice })` would
    // pass an unsliced task through *both* the train and eval filters because
    // the early code only excluded tasks whose explicit slice differed.
    const synthetic: TaskMetadata = {
      id: "synthetic/no-slice-task",
      title: "Synthetic task with no explicit slice",
      domain: "synthetic",
      difficulty: "easy",
      stash: "minimal",
      verifier: "regex",
      budget: { tokens: 1000, wallMs: 1000 },
      taskDir: "/tmp/none",
    };
    const slice = effectiveSlice(synthetic);
    expect(["train", "eval"]).toContain(slice);
    // Re-running must give the same bucket.
    expect(effectiveSlice(synthetic)).toBe(slice);
    // partitionSlice and effectiveSlice must agree.
    const { train, eval: evalSlice } = partitionSlice([synthetic]);
    if (slice === "train") {
      expect(train.map((t) => t.id)).toEqual([synthetic.id]);
      expect(evalSlice).toEqual([]);
    } else {
      expect(evalSlice.map((t) => t.id)).toEqual([synthetic.id]);
      expect(train).toEqual([]);
    }
  });
});

// ── Memory-operation tags (#262) ───────────────────────────────────────────

describe("memory-operation tags (#262)", () => {
  test("MEMORY_ABILITY_VALUES is the documented closed set", () => {
    expect(new Set(MEMORY_ABILITY_VALUES)).toEqual(
      new Set([
        "procedural_lookup",
        "multi_asset_composition",
        "temporal_update",
        "conflict_resolution",
        "abstention",
        "noisy_retrieval",
      ]),
    );
  });

  test("loader leaves tag fields undefined for legacy tasks (without new fields)", () => {
    // The shipped `_example/example-task` carries no #262 tags — it
    // continues to load cleanly with every new field undefined.
    const meta = loadTask("_example/example-task", { includeExamples: true });
    expect(meta.memoryAbility).toBeUndefined();
    expect(meta.taskFamily).toBeUndefined();
    expect(meta.workflowFocus).toBeUndefined();
    expect(meta.expectedTransferFrom).toBeUndefined();
    expect(meta.abstentionCase).toBeUndefined();
    expect(meta.conflictCase).toBeUndefined();
    expect(meta.staleGuidanceCase).toBeUndefined();
  });

  test("loader parses memory_ability + task_family from a tagged task", () => {
    // Every seeded corpus task is tagged with at least these two fields by
    // #262. Pick a representative entry and assert the round-trip.
    const meta = loadTask("docker-homelab/restart-policy");
    expect(meta.memoryAbility).toBe("procedural_lookup");
    expect(meta.taskFamily).toBe("docker-homelab/compose-basics");
  });

  test("every seeded corpus task carries memory_ability + task_family", () => {
    for (const task of listTasks()) {
      expect(task.memoryAbility).toBeDefined();
      expect(MEMORY_ABILITY_VALUES as readonly string[]).toContain(task.memoryAbility as string);
      expect(task.taskFamily).toBeDefined();
      expect(task.taskFamily).toMatch(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/);
    }
  });

  test("invalid memory_ability values are dropped (loader stays permissive)", () => {
    const dir = benchMkdtemp("akm-bench-tag-");
    try {
      const taskDir = path.join(dir, "_example", "bad-tag");
      fs.mkdirSync(taskDir, { recursive: true });
      // Write a clone of `_example/example-task` augmented with a bogus tag.
      const yaml = [
        "id: _example/bad-tag",
        'title: "Bogus tag"',
        "domain: _example",
        "difficulty: easy",
        "slice: train",
        "stash: minimal",
        "verifier: script",
        "budget:",
        "  tokens: 1000",
        "  wallMs: 30000",
        "memory_ability: not_a_real_ability",
        "task_family: _example/bad",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(taskDir, "task.yaml"), yaml, "utf8");
      const parsed = parseTaskYaml(readTaskBody(taskDir), taskDir);
      expect(parsed).toBeDefined();
      expect(parsed?.id).toBe("_example/bad-tag");
      expect(parsed?.memoryAbility).toBeUndefined();
      expect(parsed?.taskFamily).toBe("_example/bad");
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
