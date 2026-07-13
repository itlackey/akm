// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #607 per-process lock decomposition. The old single `improve.lock` is
 * replaced by three fine-grained locks (consolidate, reflect-distill, triage).
 * When a per-process lock is held:
 *   - With `skipIfLocked: true`: that process is skipped, the rest of the run continues.
 *   - Without `skipIfLocked`: throws ConfigError ("already running").
 *
 * These tests plant a triage.lock (the first lock acquired in the pipeline)
 * to verify the skip-if-locked behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmImprove, resetHeldProcessLocks } from "../../../src/commands/improve/improve";
import { withOptionalProcessLock } from "../../../src/commands/improve/locks";
import type { AkmConfig } from "../../../src/core/config/config";
import { saveConfig } from "../../../src/core/config/config";
import { acquireMaintenanceBarrier } from "../../../src/core/maintenance-barrier";
import { type Cleanup, withIsolatedAkmStorage } from "../../_helpers/sandbox";

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

function plantHeldTriageLock(): string {
  const lockPath = path.join(stashDir, ".akm", "triage.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
  return lockPath;
}

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
  cleanup = storage.cleanup;
  saveConfig({ semanticSearchMode: "off" });
  resetHeldProcessLocks();
});

afterEach(() => {
  resetHeldProcessLocks();
  cleanup();
  cleanup = () => {};
  stashDir = "";
});

describe("akm improve — skip-if-locked (#607 per-process locks)", () => {
  test("does not invoke a stage when its process lock is held", async () => {
    const lockPath = plantHeldTriageLock();
    let invoked = false;

    const result = await withOptionalProcessLock(
      {
        lockPath,
        staleAfterMs: 30 * 60 * 1000,
        skipIfLocked: true,
        label: "triage",
      },
      async () => {
        invoked = true;
        return "ran";
      },
    );

    expect(result).toBeUndefined();
    expect(invoked).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  test("does not invoke a stage when the maintenance barrier is held", async () => {
    const lockPath = path.join(stashDir, ".akm", "triage.lock");
    const releaseBarrier = acquireMaintenanceBarrier();
    let invoked = false;

    try {
      const result = await withOptionalProcessLock(
        {
          lockPath,
          staleAfterMs: 30 * 60 * 1000,
          skipIfLocked: true,
          label: "triage",
        },
        async () => {
          invoked = true;
          return "ran";
        },
      );

      expect(result).toBeUndefined();
      expect(invoked).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      releaseBarrier();
    }
  });

  test(
    "completes successfully when triage.lock is held and skipIfLocked is set (triage skipped)",
    async () => {
      const lockPath = plantHeldTriageLock();

      const result = await akmImprove({
        scope: "memory",
        stashDir,
        config: quietConfig(),
        skipIfLocked: true,
      });

      expect(result.ok).toBe(true);
      // The other run's lock is left exactly as we planted it — never released.
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    },
    TIMEOUT_MS,
  );

  test(
    "throws 'already running' when triage.lock is held and skipIfLocked is NOT set",
    async () => {
      plantHeldTriageLock();
      await expect(akmImprove({ scope: "memory", stashDir, config: quietConfig() })).rejects.toThrow(
        /already running/i,
      );
    },
    TIMEOUT_MS,
  );
});
