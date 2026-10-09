// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * D8 — the autonomy gate's decision layer.
 *
 * `akm improve` stays on; what is gated is the lanes that mutate assets without
 * review. The shipped `default` strategy enables several of those, so with the
 * opt-in absent the gate must downgrade the strategy rather than trust it.
 *
 * The property these pin is that a gated lane is never a SILENT no-op: every
 * downgrade is reported back to the caller so it can be turned into an event, a
 * doctor line, and a health advisory. A gate that quietly disabled work would
 * reproduce the exact failure that made a blanket experimental gate on
 * `akm improve` unacceptable.
 */

import { describe, expect, test } from "bun:test";
import { AUTONOMY_LANES, applyAutonomyGate, isAutonomyLaneAllowed } from "../src/commands/improve/autonomy-gate";
import { IMPROVE_AUTONOMY_CONFIG_KEY } from "../src/core/config/experimental";

const AUTONOMOUS = { experimental: { improveAutonomy: true } };
const REVIEW_FIRST = {};

/** The shipped `default` strategy's autonomy-relevant shape. */
const DEFAULT_STRATEGY = {
  processes: {
    reflect: { enabled: true },
    distill: { enabled: true },
    consolidate: { enabled: true, allowedTypes: ["memory"] },
    memoryInference: { enabled: true },
    validation: { enabled: true },
    triage: { enabled: true, applyMode: "promote" as const, policy: "personal-stash" },
  },
  sync: { enabled: true, push: true },
};

/** The same strategy with the triage judgment tier on — the only gated triage promote (#1143). */
const JUDGED_STRATEGY = {
  ...DEFAULT_STRATEGY,
  processes: {
    ...DEFAULT_STRATEGY.processes,
    triage: { ...DEFAULT_STRATEGY.processes.triage, judgment: { enabled: true } },
  },
};

describe("applyAutonomyGate with autonomy OFF", () => {
  test("keeps review-only consolidate planning enabled and disables memoryInference", () => {
    const { config } = applyAutonomyGate(DEFAULT_STRATEGY, REVIEW_FIRST);

    expect(config.processes?.consolidate?.enabled).toBe(true);
    expect(config.processes?.memoryInference?.enabled).toBe(false);
  });

  test("downgrades a judged triage promote to queue instead of disabling triage", () => {
    // Triage still runs — queued proposals are still triaged, they just are not
    // auto-accepted into the stash. Disabling triage outright would remove
    // review work the user asked for.
    const { config, gated } = applyAutonomyGate(JUDGED_STRATEGY, REVIEW_FIRST);

    expect(config.processes?.triage?.enabled).toBe(true);
    expect(config.processes?.triage?.applyMode).toBe("queue");
    expect(gated.map((g) => g.lane)).toContain("triagePromote");
  });

  test("leaves a deterministic-only triage promote alone and does not report it (#1143)", () => {
    for (const judgment of [undefined, { enabled: false }] as const) {
      const strategy =
        judgment === undefined
          ? DEFAULT_STRATEGY
          : {
              ...DEFAULT_STRATEGY,
              processes: { ...DEFAULT_STRATEGY.processes, triage: { ...DEFAULT_STRATEGY.processes.triage, judgment } },
            };
      const { config, gated } = applyAutonomyGate(strategy, REVIEW_FIRST);

      expect(config.processes?.triage?.applyMode).toBe("promote");
      expect(gated.map((g) => g.lane)).not.toContain("triagePromote");
      // memoryInference is still gated and still reported.
      expect(config.processes?.memoryInference?.enabled).toBe(false);
      expect(gated.map((g) => g.lane)).toContain("memoryInference");
    }
  });

  test("leaves review-first lanes and sync.push untouched", () => {
    const { config } = applyAutonomyGate(DEFAULT_STRATEGY, REVIEW_FIRST);

    expect(config.processes?.reflect?.enabled).toBe(true);
    expect(config.processes?.distill?.enabled).toBe(true);
    expect(config.processes?.validation?.enabled).toBe(true);
    // sync.push is deliberately outside this gate.
    expect(config.sync?.push).toBe(true);
  });

  test("reports every downgraded lane, each naming the config key", () => {
    const { gated } = applyAutonomyGate(JUDGED_STRATEGY, REVIEW_FIRST);
    const lanes = gated.map((g) => g.lane);

    expect(lanes).not.toContain("consolidate");
    expect(lanes).toContain("memoryInference");
    expect(lanes).toContain("triagePromote");
    for (const entry of gated) {
      expect(entry.configKey).toBe(IMPROVE_AUTONOMY_CONFIG_KEY);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  test("reports nothing for a strategy that was already review-first", () => {
    const quiet = { processes: { reflect: { enabled: true }, triage: { enabled: true, applyMode: "queue" as const } } };
    const { gated } = applyAutonomyGate(quiet, REVIEW_FIRST);

    expect(gated).toEqual([]);
  });

  test("blocks the plan-bypassing cleanup lane", () => {
    expect(isAutonomyLaneAllowed("memoryCleanup", REVIEW_FIRST)).toBe(false);
  });
});

describe("applyAutonomyGate with autonomy ON", () => {
  test("passes the strategy through unchanged", () => {
    const { config, gated } = applyAutonomyGate(DEFAULT_STRATEGY, AUTONOMOUS);

    expect(config.processes?.consolidate?.enabled).toBe(true);
    expect(config.processes?.memoryInference?.enabled).toBe(true);
    expect(config.processes?.triage?.applyMode).toBe("promote");
    expect(gated).toEqual([]);
  });

  test("allows the plan-bypassing cleanup lane", () => {
    expect(isAutonomyLaneAllowed("memoryCleanup", AUTONOMOUS)).toBe(true);
  });
});

describe("lane inventory", () => {
  test("covers exactly the three lanes D8 gates, and not advisory consolidation or sync.push", () => {
    expect([...(AUTONOMY_LANES as readonly string[])].sort()).toEqual([
      "memoryCleanup",
      "memoryInference",
      "triagePromote",
    ]);
    expect(AUTONOMY_LANES as readonly string[]).not.toContain("push");
  });
});
