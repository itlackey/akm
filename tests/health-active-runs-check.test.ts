import { describe, expect, test } from "bun:test";
import { HEALTH_CHECKS, type HealthCheckContext } from "../src/commands/health/checks";

// `active-runs` projects ctx.stuckActiveTasks (runs whose akm process is gone, by `classifyAttempt`) and
// ctx.unverifiedActiveTasks (owner cannot be told). Elapsed time decides neither.

const check = HEALTH_CHECKS.find((c) => c.name === "active-runs");

type Tasks = { taskId: string; ageMs: number }[];

function run(stuckActiveTasks: Tasks, unverifiedActiveTasks: Tasks = []) {
  if (!check) throw new Error("active-runs check not registered");
  return check.run({
    stuckActiveRuns: stuckActiveTasks.length,
    stuckActiveTasks,
    unverifiedActiveTasks,
  } as unknown as HealthCheckContext);
}

describe("active-runs check", () => {
  test("is registered as a hard check", () => {
    expect(check).toBeDefined();
    expect(check?.channel).toBe("hard");
  });

  test("passes when nothing is stuck or unverified", () => {
    const r = run([]);
    expect(r.status).toBe("pass");
    expect(r.evidence?.stuckActiveTasks).toEqual([]);
  });

  test("names each task whose process is gone, oldest first", () => {
    const r = run([
      { taskId: "akm-improve", ageMs: 16 * 60_000 },
      { taskId: "nightly-sync", ageMs: 40 * 60_000 },
    ]);
    expect(r.status).toBe("warn");
    expect(r.message.indexOf("nightly-sync")).toBeLessThan(r.message.indexOf("akm-improve"));
    expect(r.message).toContain("nightly-sync (started 40m ago)");
    expect(r.message).toContain("2 active task run(s) whose akm process is gone");
  });

  test("a run whose owner cannot be checked is unknown, never pass", () => {
    const r = run([], [{ taskId: "elsewhere", ageMs: 60_000 }]);
    expect(r.status).toBe("unknown");
    expect(r.reason).toBe("blocked");
    expect(r.message).toContain("elsewhere");
  });
});
