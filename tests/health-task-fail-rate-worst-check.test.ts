import { describe, expect, test } from "bun:test";
import { HEALTH_CHECKS, type HealthCheckContext } from "../src/commands/health/checks";

// Item 6: `task-fail-rate` used to warn only off the aggregate rate, which
// hides a single consistently-failing task inside a large, mostly-healthy
// population. It now also warns when the worst single task_id (with enough
// rows to be a real signal) crosses the same threshold. The check is a pure
// projection of ctx.taskFailRate / ctx.taskRowCount / ctx.worstTaskFailRate,
// so we drive it directly with synthetic inputs (the task_id grouping itself
// is covered end-to-end in tests/integration/health-task-fail-rate.test.ts).

const check = HEALTH_CHECKS.find((c) => c.name === "task-fail-rate");

function run(
  taskFailRate: number,
  taskRowCount: number,
  worstTaskFailRate: { taskId: string; rate: number; rows: number } | null,
) {
  if (!check) throw new Error("task-fail-rate check not registered");
  return check.run({
    taskFailRate,
    taskRowCount,
    since: "2026-01-01T00:00:00.000Z",
    worstTaskFailRate,
  } as unknown as HealthCheckContext);
}

describe("task-fail-rate check worst-single-task signal (item 6)", () => {
  test("stays pass when the aggregate is below threshold and no task qualifies", () => {
    const r = run(0.01, 100, null);
    expect(r.status).toBe("pass");
  });

  test("warns off the worst single task even when the aggregate stays below threshold", () => {
    const r = run(0.01, 100, { taskId: "flaky-task", rate: 0.2, rows: 5 });
    expect(r.status).toBe("warn");
    expect(r.message).toContain('task "flaky-task" fails 20.0%');
    expect(r.message).toContain("5 run(s)");
    expect(r.evidence?.worstTaskFailRate).toEqual({ taskId: "flaky-task", rate: 0.2, rows: 5 });
  });

  test("still warns off the aggregate when no single task qualifies", () => {
    const r = run(0.15, 20, null);
    expect(r.status).toBe("warn");
    expect(r.message).toContain("aggregate 15.0%");
    expect(r.message).not.toContain('task "');
  });

  test("warns with both reasons named when aggregate and worst task both cross the threshold", () => {
    const r = run(0.1, 20, { taskId: "flaky-task", rate: 0.5, rows: 6 });
    expect(r.status).toBe("warn");
    expect(r.message).toContain("aggregate 10.0%");
    expect(r.message).toContain('task "flaky-task" fails 50.0%');
  });

  test("no signal when no cron tasks ran, regardless of worstTaskFailRate", () => {
    const r = run(0, 0, null);
    expect(r.status).toBe("pass");
    expect(r.message).toContain("No cron tasks ran");
  });
});
