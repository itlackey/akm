// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * D8 — `akm task doctor` reports the autonomy gate.
 *
 * `tasks doctor` is where an operator checks what a scheduled `akm improve` will
 * actually do. Two requirements follow from that:
 *
 *  1. It must list the lanes the gate is suppressing.
 *  2. Its existing `improveTriage.applyMode` must report the EFFECTIVE mode, not
 *     the strategy's raw value. It resolved the raw strategy before D8, so a
 *     `promote` strategy under a review-first config would have reported
 *     "promote" while the run used "queue" — a doctor command lying about the
 *     thing it exists to diagnose.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmTasksDoctor } from "../src/commands/tasks/tasks";
import { resetConfigCache, saveConfig } from "../src/core/config/config";
import { IMPROVE_AUTONOMY_CONFIG_KEY } from "../src/core/config/experimental";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "./_helpers/sandbox";

let cleanup: Cleanup = () => {};

beforeEach(() => {
  const dataResult = sandboxXdgDataHome();
  const cacheResult = sandboxXdgCacheHome(dataResult.cleanup);
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  cleanup = stashResult.cleanup;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  resetConfigCache();
});

const PROMOTING = {
  strategies: { promoting: { processes: { triage: { enabled: true, applyMode: "promote" as const } } } },
};

describe("tasks doctor autonomy reporting", () => {
  test("reports autonomy off and names the gated lanes and the config key", async () => {
    saveConfig({ semanticSearchMode: "off", defaults: { improveStrategy: "consolidate" } });
    resetConfigCache();

    const result = await akmTasksDoctor();

    expect(result.improveAutonomy?.enabled).toBe(false);
    expect(result.improveAutonomy?.configKey).toBe(IMPROVE_AUTONOMY_CONFIG_KEY);
    expect(result.improveAutonomy?.gatedLanes.map((lane) => lane.lane)).toEqual(["memoryCleanup"]);
    expect(result.improveAutonomy?.gatedLanes.every((lane) => lane.reason.length > 0)).toBe(true);
  });

  test("does not report advisory consolidation operations as gated writers", async () => {
    saveConfig({
      semanticSearchMode: "off",
      defaults: { improveStrategy: "contradiction-report" },
      improve: {
        strategies: {
          "contradiction-report": {
            processes: {
              reflect: { enabled: false },
              distill: { enabled: false },
              consolidate: { enabled: true, contradictionDetection: { enabled: true } },
              memoryInference: { enabled: false },
              extract: { enabled: false },
              validation: { enabled: false },
              triage: { enabled: false },
              proactiveMaintenance: { enabled: false },
            },
          },
        },
      },
    });
    resetConfigCache();

    const result = await akmTasksDoctor();

    expect(result.improveAutonomy?.gatedLanes.map((lane) => lane.lane)).toEqual(["memoryCleanup"]);
  });

  test("reports autonomy on with no gated lanes", async () => {
    saveConfig({
      semanticSearchMode: "off",
      defaults: { improveStrategy: "consolidate" },
      experimental: { improveAutonomy: true },
    });
    resetConfigCache();

    const result = await akmTasksDoctor();

    expect(result.improveAutonomy?.enabled).toBe(true);
    expect(result.improveAutonomy?.gatedLanes).toEqual([]);
  });

  test("improveTriage.applyMode reports the effective mode, not the strategy's raw value", async () => {
    // A strategy that enables triage in promote mode. With autonomy off the run
    // uses queue, so doctor must say queue.
    saveConfig({ semanticSearchMode: "off", defaults: { improveStrategy: "promoting" }, improve: PROMOTING });
    resetConfigCache();

    const result = await akmTasksDoctor();

    expect(result.improveTriage?.applyMode).toBe("queue");
  });

  test("improveTriage.applyMode reports promote once autonomy is opted into", async () => {
    saveConfig({
      semanticSearchMode: "off",
      defaults: { improveStrategy: "promoting" },
      improve: PROMOTING,
      experimental: { improveAutonomy: true },
    });
    resetConfigCache();

    const result = await akmTasksDoctor();

    expect(result.improveTriage?.applyMode).toBe("promote");
  });
});
