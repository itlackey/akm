// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `cli-version` (#950) as registered in HEALTH_CHECKS: a pure pass-through
 * of ctx.versionDrift, precomputed (network IO) once in health.ts — the
 * network/logic itself is covered by
 * tests/commands/health/version-drift.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { HEALTH_CHECKS, type HealthCheckContext } from "../src/commands/health/checks";
import type { HealthCheckResult } from "../src/commands/health/types";

const check = HEALTH_CHECKS.find((c) => c.name === "cli-version");

describe("cli-version check (#950)", () => {
  test("is registered as an advisory check, between thinking-control and engine-last-used", () => {
    expect(check).toBeDefined();
    expect(check?.channel).toBe("advisory");
    const names = HEALTH_CHECKS.map((c) => c.name);
    expect(names.indexOf("cli-version")).toBe(names.indexOf("thinking-control") + 1);
    expect(names.indexOf("cli-version")).toBe(names.indexOf("engine-last-used") - 1);
  });

  test("is a pure projection of ctx.versionDrift", () => {
    if (!check) throw new Error("cli-version check not registered");
    const versionDrift: HealthCheckResult = {
      name: "cli-version",
      kind: "deterministic",
      status: "warn",
      confidence: "high",
      message: "akm v0.9.12 is installed; v0.9.15 is available — run 'akm upgrade'.",
      evidence: { installedVersion: "0.9.12", latestVersion: "0.9.15" },
    };
    const r = check.run({ versionDrift } as unknown as HealthCheckContext);
    expect(r).toBe(versionDrift);
  });
});
