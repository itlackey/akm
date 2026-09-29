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
 *   4. A lock whose holder pid is still ALIVE is NEVER recovered, no matter how
 *      old the sentinel's mtime is (#872-shaped hazard: an age-based
 *      stale-reclaim window let a live-but-wedged holder's lease be silently
 *      taken away purely because a clock elapsed — removed, no replacement).
 *
 * Driven entirely in-process through akmImprove.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmImprove } from "../../../../src/commands/improve/improve";
import { isProcessAlive } from "../../../../src/core/common";
import type { AkmConfig } from "../../../../src/core/config/config";
import { saveConfig } from "../../../../src/core/config/config";
import { readEvents } from "../../../../src/core/events";
import { getStashLocksDir } from "../../../../src/core/paths";
import { type Cleanup, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

const TIMEOUT_MS = 20_000;

/**
 * Plant an improve lock owned by a real, foreign, genuinely LIVE pid (our parent
 * process — alive for the whole run and never equal to `process.pid`), aged by
 * `ageMs`. The improve-lock acquire path calls `probeLock` with no
 * `staleAfterMs`, so a live holder is always classified `held`, regardless of
 * `ageMs` — `ageMs` exists only to prove age is irrelevant.
 */
function plantLiveHolderImproveLock(lockDir: string, ageMs: number): { lockPath: string; holderPid: number } {
  const lockPath = path.join(getStashLocksDir(lockDir), "improve.lock");
  const holderPid = process.ppid;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const lockedAt = new Date(Date.now() - ageMs);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: holderPid, startedAt: lockedAt.toISOString() }), "utf8");
  fs.utimesSync(lockPath, lockedAt, lockedAt);
  return { lockPath, holderPid };
}

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
  const dir = getStashLocksDir(stashDir);
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
      const lockPath = path.join(getStashLocksDir(stashDir), "improve.lock");
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

  test(
    "a very old lock whose holder is still alive is NEVER recovered (#872: no age-based reclaim)",
    async () => {
      // #872 removed the index-writer lease's 12h age-based stale-reclaim
      // window because a live-but-wedged holder passed the PID-liveness check
      // forever, so only the age clock could ever free it. The improve lock
      // shared the same primitive and the same hazard (#757 previously
      // exercised the age-reclaim path here) — this pins the opposite,
      // corrected invariant: however old the sentinel's mtime, a genuinely
      // live holder's lock is never taken away from it.
      const { lockPath, holderPid } = plantLiveHolderImproveLock(stashDir, 24 * 60 * 60 * 1000);
      expect(isProcessAlive(holderPid)).toBe(true);
      expect(holderPid).not.toBe(process.pid);

      await expect(akmImprove({ scope: "memory", stashDir, config: quietConfig() })).rejects.toThrow(
        /akm improve is already running/,
      );

      expect(readEvents().events.filter((e) => e.eventType === "improve_lock_recovered")).toEqual([]);
      // The live holder's sentinel survives untouched.
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(holderPid);
    },
    TIMEOUT_MS,
  );

  test(
    "a fresh lock whose holder is still alive is not recovered",
    async () => {
      const { lockPath, holderPid } = plantLiveHolderImproveLock(stashDir, 0);

      await expect(akmImprove({ scope: "memory", stashDir, config: quietConfig() })).rejects.toThrow(
        /akm improve is already running/,
      );

      expect(readEvents().events.filter((e) => e.eventType === "improve_lock_recovered")).toEqual([]);
      // The live holder's sentinel survives untouched.
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(holderPid);
    },
    TIMEOUT_MS,
  );
});
