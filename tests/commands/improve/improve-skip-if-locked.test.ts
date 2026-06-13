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
import type { AkmConfig } from "../../../src/core/config/config";
import { saveConfig } from "../../../src/core/config/config";
import { type Cleanup, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const TIMEOUT_MS = 20_000;

let cleanup: Cleanup = () => {};
let stashDir = "";

function quietConfig(): AkmConfig {
  return {
    semanticSearchMode: "off",
    defaults: { improve: "quiet-test" },
    profiles: {
      improve: {
        "quiet-test": {
          processes: {
            reflect: { enabled: false },
            distill: { enabled: false },
            consolidate: { enabled: false },
            memoryInference: { enabled: false },
            graphExtraction: { enabled: false },
            extract: { enabled: false },
            triage: { enabled: true },
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
