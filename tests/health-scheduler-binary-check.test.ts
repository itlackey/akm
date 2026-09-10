// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `scheduler-binary` (#953) as registered in HEALTH_CHECKS: a pure
 * pass-through of ctx.schedulerBinaryDrift, precomputed (process-spawn IO)
 * once in health.ts — the probe/backend logic itself is covered by
 * tests/commands/health/scheduler-binary.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { HEALTH_CHECKS, type HealthCheckContext } from "../src/commands/health/checks";
import type { HealthCheckResult } from "../src/commands/health/types";

const check = HEALTH_CHECKS.find((c) => c.name === "scheduler-binary");

describe("scheduler-binary check (#953)", () => {
  test("is registered as the last advisory in HEALTH_CHECKS — order is load-bearing", () => {
    expect(check).toBeDefined();
    expect(check?.channel).toBe("advisory");
    const names = HEALTH_CHECKS.map((c) => c.name);
    expect(names[names.length - 1]).toBe("scheduler-binary");
  });

  test("is a pure projection of ctx.schedulerBinaryDrift", () => {
    if (!check) throw new Error("scheduler-binary check not registered");
    const schedulerBinaryDrift: HealthCheckResult = {
      name: "scheduler-binary",
      kind: "deterministic",
      status: "warn",
      confidence: "high",
      message: "Scheduled tasks are bound to akm v0.9.14, but the running CLI is v0.9.15 — run `akm task sync`.",
      evidence: { scheduledVersion: "0.9.14", cliVersion: "0.9.15" },
    };
    const r = check.run({ schedulerBinaryDrift } as unknown as HealthCheckContext);
    expect(r).toBe(schedulerBinaryDrift);
  });
});
