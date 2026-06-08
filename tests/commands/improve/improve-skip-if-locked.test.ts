// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `--skip-if-locked` (0.8.4 hotfix). When another improve run already holds the
 * lock, a run started with `skipIfLocked: true` returns a clean no-op result
 * (ok:true, `skipped.reason === "lock-held"`) and exits 0 instead of throwing
 * the "already running" ConfigError (exit 78). Without the flag the hard error
 * is preserved.
 *
 * The lock is pre-created owned by THIS process's pid so `probeLock` classifies
 * it as held (live pid, within the staleness window) rather than stale.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmConfig } from "../../../src/core/config/config";
import { saveConfig } from "../../../src/core/config/config";
import { type Cleanup, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const TIMEOUT_MS = 20_000;

let cleanup: Cleanup = () => {};
let stashDir = "";

/** Cheap config — every heavy improve sub-process disabled. */
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
            triage: { enabled: false },
          },
        },
      },
    },
  } as unknown as AkmConfig;
}

/** Plant a live (held) lock owned by this process. */
function plantHeldLock(): string {
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
  test(
    "returns a skipped no-op result when the lock is held and skipIfLocked is set",
    async () => {
      const lockPath = plantHeldLock();

      const result = await akmImprove({
        scope: "memory",
        stashDir,
        config: quietConfig(),
        skipIfLocked: true,
      });

      expect(result.ok).toBe(true);
      expect(result.skipped?.reason).toBe("lock-held");
      // The other run's lock is left exactly as we planted it — never released.
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    },
    TIMEOUT_MS,
  );

  test(
    "throws 'already running' when the lock is held and skipIfLocked is NOT set",
    async () => {
      plantHeldLock();
      await expect(akmImprove({ scope: "memory", stashDir, config: quietConfig() })).rejects.toThrow(
        /already running/i,
      );
    },
    TIMEOUT_MS,
  );
});
