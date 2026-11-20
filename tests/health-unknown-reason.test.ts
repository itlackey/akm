import { describe, expect, test } from "bun:test";
import { HEALTH_CHECKS, type HealthCheckContext } from "../src/commands/health/checks";

// An `unknown` check says why it has no result, from the code path that knows.

function run(name: string, ctx: Record<string, unknown>) {
  const check = HEALTH_CHECKS.find((c) => c.name === name);
  if (!check) throw new Error(`${name} check not registered`);
  return check.run({ sessionExtractionLedger: { since: "", rows: [] }, ...ctx } as unknown as HealthCheckContext);
}

describe("session-extraction with no extraction recorded", () => {
  test.each([
    ["learning is off", { proposalQueue: { stashDir: "/s", extractEnabled: false } }, "off"],
    ["learning is on and nothing has run", { proposalQueue: { stashDir: "/s", extractEnabled: true } }, "idle"],
    ["the config could not be read", { proposalQueue: undefined }, "blocked"],
  ])("%s", (_label, ctx, reason) => {
    expect(run("session-extraction", ctx)).toMatchObject({ status: "unknown", reason });
  });
});

describe("proposal-queue", () => {
  test("an unreadable stash or config is blocked, learning off is off", () => {
    expect(run("proposal-queue", { proposalQueue: undefined })).toMatchObject({ status: "unknown", reason: "blocked" });
    expect(run("proposal-queue", { proposalQueue: { stashDir: "/s", extractEnabled: false } })).toMatchObject({
      status: "unknown",
      reason: "off",
    });
  });
});

describe("state-db-round-trip", () => {
  test("a skipped probe is not-probed; a result that ran has no reason", () => {
    expect(run("state-db-round-trip", { probe: { skipped: true } })).toMatchObject({
      status: "unknown",
      reason: "not-probed",
    });
    expect(run("state-db-round-trip", { probe: { ok: true } }).reason).toBeUndefined();
  });
});
