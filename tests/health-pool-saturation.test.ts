import { describe, expect, test } from "bun:test";
import { HEALTH_CHECKS, type HealthCheckContext } from "../src/commands/health/checks";

// #603 — pool-saturation advisory boundaries: informational below 10% new,
// warning below 2% new, healthy at/above 10%, and silent (no signal) when
// extract did not run. The check is a pure projection of
// ctx.sessionExtraction, so we drive it directly with synthetic counts.

const check = HEALTH_CHECKS.find((c) => c.name === "pool-saturation");

function run(sessionExtraction: Partial<HealthCheckContext["sessionExtraction"]>) {
  if (!check) throw new Error("pool-saturation check not registered");
  const sx = {
    ran: true,
    sessionsScanned: 0,
    sessionsExtracted: 0,
    sessionsSkipped: 0,
    proposalsCreated: 0,
    warnings: 0,
    durationMs: 0,
    ...sessionExtraction,
  };
  return check.run({ sessionExtraction: sx } as unknown as HealthCheckContext);
}

describe("#603 pool-saturation advisory", () => {
  test("is registered as an advisory check", () => {
    expect(check).toBeDefined();
    expect(check?.channel).toBe("advisory");
  });

  test("warns when new ratio is below 2% (possible pool exhaustion)", () => {
    // 1 new of 100 total = 1% < 2%
    const r = run({ sessionsScanned: 1, sessionsSkipped: 99 });
    expect(r.status).toBe("warn");
    expect(r.evidence?.saturationRatio).toBeCloseTo(0.01, 5);
    expect(r.evidence?.totalSessions).toBe(100);
    expect(r.evidence?.unseenSessions).toBe(1);
  });

  test("informational pass when new ratio is between 2% and 10%", () => {
    // 5 new of 100 = 5%
    const r = run({ sessionsScanned: 5, sessionsSkipped: 95 });
    expect(r.status).toBe("pass");
    expect(r.message).toMatch(/steady-state expected/);
    expect(r.evidence?.saturationRatio).toBeCloseTo(0.05, 5);
  });

  test("healthy pass at/above 10% new", () => {
    // 50 new of 100 = 50%
    const r = run({ sessionsScanned: 50, sessionsSkipped: 50 });
    expect(r.status).toBe("pass");
    expect(r.message).toMatch(/healthy/);
  });

  test("exactly 2% is not a warning (boundary is strict <2%)", () => {
    const r = run({ sessionsScanned: 2, sessionsSkipped: 98 });
    expect(r.status).toBe("pass");
  });

  test("no signal when extract did not run", () => {
    const r = run({ ran: false });
    expect(r.status).toBe("pass");
    expect(r.message).toMatch(/no signal/i);
    expect(r.evidence?.saturationRatio).toBeNull();
  });

  test("no signal when the session pool is empty", () => {
    const r = run({ ran: true, sessionsScanned: 0, sessionsSkipped: 0 });
    expect(r.status).toBe("pass");
    expect(r.evidence?.saturationRatio).toBeNull();
  });
});
