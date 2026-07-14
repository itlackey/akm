// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Whole-run improve lock lifecycle invariants.
 *
 * Invariants pinned:
 *   1. No orphan lock files remain on disk after a completed run (acquire→release).
 *   2. The process.on("exit") backstop is removed after each run — listener count
 *      returns to baseline (no accumulation across runs).
 *   3. A stale lock (dead holder pid) is recovered: the run proceeds and an
 *      `improve_lock_recovered` event is emitted.
 *
 * Driven entirely in-process through akmImprove.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmConfig } from "../../../src/core/config/config";
import { saveConfig } from "../../../src/core/config/config";
import { readEvents } from "../../../src/core/events";
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

function lockFilesOnDisk(): string[] {
  const dir = path.join(stashDir, ".akm");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".lock"));
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

describe("akm improve — whole-run lock invariants", () => {
  test(
    "a completed run leaves no orphan lock files on disk",
    async () => {
      const result = await akmImprove({ scope: "memory", stashDir, config: quietConfig() });
      expect(result.ok).toBe(true);
      expect(lockFilesOnDisk()).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "the process exit backstop is removed after each run (no listener accumulation)",
    async () => {
      const baseline = process.listenerCount("exit");
      await akmImprove({ scope: "memory", stashDir, config: quietConfig() });
      await akmImprove({ scope: "memory", stashDir, config: quietConfig() });
      expect(process.listenerCount("exit")).toBe(baseline);
    },
    TIMEOUT_MS,
  );

  test(
    "a stale improve lock is recovered and emits improve_lock_recovered",
    async () => {
      // Plant a lock owned by a pid that cannot be alive → probeLock reports
      // state "stale" (reason pid_dead) regardless of mtime.
      const deadPid = 2_147_483_646;
      const lockPath = path.join(stashDir, ".akm", "improve.lock");
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() }), "utf8");

      const result = await akmImprove({ scope: "memory", stashDir, config: quietConfig() });
      expect(result.ok).toBe(true);

      const recovered = readEvents().events.filter((e) => e.eventType === "improve_lock_recovered");
      expect(recovered.length).toBeGreaterThanOrEqual(1);
      expect(recovered.at(-1)?.metadata?.lockName).toBe("improve");
      expect(lockFilesOnDisk()).toEqual([]);
    },
    TIMEOUT_MS,
  );
});
