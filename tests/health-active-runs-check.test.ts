import { describe, expect, test } from "bun:test";
import { HEALTH_CHECKS, type HealthCheckContext } from "../src/commands/health/checks";

// Item 7: `active-runs` used to report only a count of stuck task runs. It now
// names WHICH task_ids are stuck (deduped, oldest-first) so an operator knows
// where to look — no pid/liveness detection, purely a projection of the rows
// already read. The check is a pure projection of ctx.stuckActiveRuns /
// ctx.stuckActiveTasks, so we drive it directly with synthetic counts.

const check = HEALTH_CHECKS.find((c) => c.name === "active-runs");

function run(stuckActiveRuns: number, stuckActiveTasks: { taskId: string; ageMs: number }[]) {
  if (!check) throw new Error("active-runs check not registered");
  return check.run({ stuckActiveRuns, stuckActiveTasks } as unknown as HealthCheckContext);
}

describe("active-runs check (item 7)", () => {
  test("is registered as a hard check", () => {
    expect(check).toBeDefined();
    expect(check?.channel).toBe("hard");
  });

  test("passes with no message detail when nothing is stuck", () => {
    const r = run(0, []);
    expect(r.status).toBe("pass");
    expect(r.message).toBe("No active task runs exceeded the stale threshold.");
    expect(r.evidence?.stuckActiveTasks).toEqual([]);
  });

  test("names each stuck task_id and its age, oldest first", () => {
    const r = run(2, [
      { taskId: "akm-improve", ageMs: 16 * 60_000 },
      { taskId: "nightly-sync", ageMs: 40 * 60_000 },
    ]);
    expect(r.status).toBe("warn");
    // Oldest (nightly-sync, 40m) is named before the newer one (akm-improve, 16m).
    expect(r.message.indexOf("nightly-sync")).toBeLessThan(r.message.indexOf("akm-improve"));
    expect(r.message).toContain("nightly-sync (40m)");
    expect(r.message).toContain("akm-improve (16m)");
    expect(r.message).toContain("2 active task run(s)");
    expect(r.evidence?.stuckActiveRuns).toBe(2);
    expect(r.evidence?.stuckActiveTasks).toEqual([
      { taskId: "akm-improve", ageMs: 16 * 60_000 },
      { taskId: "nightly-sync", ageMs: 40 * 60_000 },
    ]);
  });

  test("dedupes to one entry per distinct task_id (caller's responsibility, but the check trusts it)", () => {
    const r = run(1, [{ taskId: "solo-task", ageMs: 20 * 60_000 }]);
    expect(r.status).toBe("warn");
    expect(r.message).toContain("solo-task (20m)");
  });
});
