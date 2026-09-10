// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `engine-last-used` (#950): a pure projection of
 * ctx.activeImproveStrategyEngines / ctx.engineLastUsed /
 * ctx.improveRunsInLookbackWindow, computed once in health.ts. Driven
 * directly here (mirrors tests/health-thinking-control-check.test.ts) — no
 * IO, no database.
 */

import { describe, expect, test } from "bun:test";
import { HEALTH_CHECKS, type HealthCheckContext } from "../src/commands/health/checks";
import { ENGINE_LAST_USED_LOOKBACK_DAYS } from "../src/commands/health/engine-usage";

const check = HEALTH_CHECKS.find((c) => c.name === "engine-last-used");

function run(
  activeImproveStrategyEngines: Record<string, string>,
  engineLastUsed: Map<string, { lastUsedAt: string; process?: string }>,
  improveRunsInLookbackWindow: number,
) {
  if (!check) throw new Error("engine-last-used check not registered");
  return check.run({
    activeImproveStrategyEngines,
    engineLastUsed,
    improveRunsInLookbackWindow,
  } as unknown as HealthCheckContext);
}

describe("engine-last-used check (#950)", () => {
  test("is registered as an advisory check, directly before the #953 scheduler-binary advisory", () => {
    expect(check).toBeDefined();
    expect(check?.channel).toBe("advisory");
    expect(HEALTH_CHECKS.at(-1)?.name).toBe("scheduler-binary");
    expect(HEALTH_CHECKS.at(-2)?.name).toBe("engine-last-used");
  });

  test("unknown when no engine is bound to an enabled improve process", () => {
    const r = run({}, new Map(), 5);
    expect(r.status).toBe("unknown");
    expect(r.evidence?.engines).toEqual([]);
  });

  test("unknown (not warn) when no improve run has completed in the lookback window", () => {
    const r = run({ reflect: "local" }, new Map(), 0);
    expect(r.status).toBe("unknown");
    expect(r.message).toContain(`${ENGINE_LAST_USED_LOOKBACK_DAYS} days`);
  });

  test("warn names the idle engine and its bound process when runs exist but the engine was never used", () => {
    const r = run({ reflect: "local" }, new Map(), 3);
    expect(r.status).toBe("warn");
    expect(r.message).toContain('Engine "local"');
    expect(r.message).toContain('process "reflect"');
    expect(r.message).toContain(`${ENGINE_LAST_USED_LOOKBACK_DAYS} days`);
  });

  test("pass names who last used the engine and when", () => {
    const r = run(
      { reflect: "local" },
      new Map([["local", { lastUsedAt: "2026-08-01T00:00:00.000Z", process: "reflect" }]]),
      3,
    );
    expect(r.status).toBe("pass");
    expect(r.message).toContain('Engine "local"');
    expect(r.message).toContain('last used by "reflect"');
    expect(r.message).toContain("2026-08-01T00:00:00.000Z");
  });

  test("warn wins even when a second bound engine passes", () => {
    const r = run(
      { reflect: "local", distill: "remote" },
      new Map([["remote", { lastUsedAt: "2026-08-01T00:00:00.000Z", process: "distill" }]]),
      3,
    );
    expect(r.status).toBe("warn");
    expect(r.message).toContain('Engine "local"');
  });

  test("pluralises 'processes' (each individually quoted) when one idle engine binds to more than one process", () => {
    const r = run({ consolidate: "local", reflect: "local" }, new Map(), 3);
    expect(r.status).toBe("warn");
    expect(r.message).toContain('processes "consolidate", "reflect"');
    expect(r.message).not.toContain('process "consolidate, reflect"');
  });
});
