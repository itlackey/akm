// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Whole-run improve lock behavior for scheduled overlap. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmImprove } from "../../../../src/commands/improve/improve";
import type { AkmConfig } from "../../../../src/core/config/config";
import { saveConfig } from "../../../../src/core/config/config";
import { readEvents } from "../../../../src/core/events";
import { acquireMaintenanceBarrier } from "../../../../src/core/maintenance-barrier";
import { LLM_USAGE_SUMMARY_EVENT } from "../../../../src/llm/usage-persist";
import { hasLlmUsageSink } from "../../../../src/llm/usage-telemetry";
import { type Cleanup, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

const TIMEOUT_MS = 20_000;

let cleanup: Cleanup = () => {};
let stashDir = "";

function quietConfig(): AkmConfig {
  return {
    semanticSearchMode: "off",
    defaults: { improveStrategy: "quiet-test" },
    improve: {
      strategies: {
        "quiet-test": {
          processes: {
            reflect: { enabled: false },
            distill: { enabled: false },
            consolidate: { enabled: false },
            memoryInference: { enabled: false },
            graphExtraction: { enabled: false },
            extract: { enabled: false },
            validation: { enabled: false },
            triage: { enabled: true },
            proactiveMaintenance: { enabled: false },
            recombine: { enabled: false },
            procedural: { enabled: false },
          },
        },
      },
    },
  } as unknown as AkmConfig;
}

function plantHeldImproveLock(): string {
  const lockPath = path.join(stashDir, ".akm", "improve.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
  return lockPath;
}

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
  cleanup = storage.cleanup;
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  stashDir = "";
});

describe("akm improve — skip-if-locked", () => {
  test("returns a whole-run no-op without invoking planning", async () => {
    const lockPath = plantHeldImproveLock();
    let planningInvoked = false;

    const result = await akmImprove({
      scope: "memory",
      stashDir,
      config: quietConfig(),
      skipIfLocked: true,
      collectEligibleRefsFn: (async () => {
        planningInvoked = true;
        throw new Error("planning must not run");
      }) as never,
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toEqual({ reason: "lock-held" });
    expect(result.plannedRefs).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(planningInvoked).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(hasLlmUsageSink()).toBe(false);
    expect(readEvents({ type: LLM_USAGE_SUMMARY_EVENT }).events).toHaveLength(0);
  });

  test("returns the same no-op when the maintenance barrier is held", async () => {
    const lockPath = path.join(stashDir, ".akm", "improve.lock");
    const releaseBarrier = acquireMaintenanceBarrier();

    try {
      const result = await akmImprove({
        scope: "memory",
        stashDir,
        config: quietConfig(),
        skipIfLocked: true,
      });

      expect(result.ok).toBe(true);
      expect(result.skipped).toEqual({ reason: "lock-held" });
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      releaseBarrier();
    }
  });

  test(
    "preserves the existing owner when the run skips",
    async () => {
      const lockPath = plantHeldImproveLock();

      const result = await akmImprove({
        scope: "memory",
        stashDir,
        config: quietConfig(),
        skipIfLocked: true,
      });

      expect(result.ok).toBe(true);
      expect(result.skipped).toEqual({ reason: "lock-held" });
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    },
    TIMEOUT_MS,
  );

  test(
    "throws 'already running' when the lock is held and skipIfLocked is not set",
    async () => {
      plantHeldImproveLock();
      await expect(akmImprove({ scope: "memory", stashDir, config: quietConfig() })).rejects.toThrow(
        /already running/i,
      );
    },
    TIMEOUT_MS,
  );
});
