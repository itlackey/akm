// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * D8 — `resolveImprovePlan` applies the autonomy gate.
 *
 * `tests/improve-autonomy-gate.test.ts` pins the gate's decisions in isolation.
 * This pins that the plan resolver actually USES it — the wiring, which a gate
 * with perfect unit tests can still be missing.
 *
 * The `consolidate` strategy is the discriminating fixture: consolidate is its
 * only LLM-backed process, so with autonomy OFF the gate disables it and the
 * plan resolves with no engine configured at all. With autonomy ON the same
 * call demands an engine and throws `LLM_NOT_CONFIGURED`. That asymmetry is
 * only possible if the gate runs BEFORE the LLM preflight, which is the
 * ordering the choke point depends on.
 */

import { describe, expect, test } from "bun:test";
import { resolveImprovePlan } from "../src/commands/improve/improve-strategies";

const BASE = { configVersion: "0.9.0" } as unknown as Parameters<typeof resolveImprovePlan>[1];

function configWith(
  experimental?: { improveAutonomy?: boolean },
  withEngine = false,
): Parameters<typeof resolveImprovePlan>[1] {
  return {
    ...BASE,
    ...(experimental ? { experimental } : {}),
    ...(withEngine
      ? {
          engines: { test: { kind: "llm", endpoint: "http://localhost:1/v1/chat/completions", model: "test" } },
          defaults: { llmEngine: "test" },
        }
      : {}),
  } as Parameters<typeof resolveImprovePlan>[1];
}

describe("resolveImprovePlan applies the autonomy gate", () => {
  test("autonomy OFF keeps review-only consolidate planning enabled", () => {
    const plan = resolveImprovePlan("consolidate", configWith(undefined, true));

    expect(plan.processes.consolidate.enabled).toBe(true);
    expect(plan.autonomyGated).toEqual([]);
  });

  test("autonomy OFF still requires the planner's engine", () => {
    expect(() => resolveImprovePlan("consolidate", configWith())).toThrow(/requires an engine/);
  });

  test("autonomy ON does not change the review-only planner's engine requirement", () => {
    expect(() => resolveImprovePlan("consolidate", configWith({ improveAutonomy: true }))).toThrow(
      /requires an engine/,
    );
  });

  // The "already review-first strategy reports no downgrades" case lives in
  // tests/improve-autonomy-gate.test.ts: asserting it here would need an
  // `engines` fixture purely to get past the preflight for reflect, which adds
  // setup without adding signal the three cases above do not already give.
});
