// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Phase 4 (proposal-triage): the triage drain runs as an improve PRE-pass,
 * under the hoisted `improve.lock`, gated on the `triage` process being enabled
 * and on a whole-stash / type-scoped run.
 *
 * These tests drive the real `akmImprove` with an injected `drainProposalsFn`
 * seam so the pre-pass is observable without seeding a real proposal queue:
 *
 *   - fires on a whole-stash (type-scoped) run when triage is enabled,
 *   - is skipped when `scope.mode === "ref"` (single-ref runs never drain),
 *   - is skipped on `dryRun` (the dry-run branch takes no lock and no triage),
 *   - is non-fatal: a thrown drain error must not abort the improve run.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { DrainResult } from "../../../src/commands/proposal/drain";
import type { AkmConfig } from "../../../src/core/config/config";
import { saveConfig } from "../../../src/core/config/config";
import type { GetAllEntries } from "../../../src/indexer/db/entry-reader";
import { type Cleanup, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { type SeededEntries, seedEntries } from "../../_helpers/seed-entries";

const TIMEOUT_MS = 20_000;

let cleanup: Cleanup = () => {};
let stashDir = "";
const seededDbs: SeededEntries[] = [];

function writeMemory(name: string, body: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name} memory\n---\n\n${body}\n`, "utf8");
}

// #664 Seam 2: these tests drive the triage pre-pass; the planner only needs the
// `entries` table, so seed `alpha` into an in-memory index DB and write its
// backing file instead of running a full on-disk FTS rebuild
// (`akmIndex({full:true})`). Returns the injectable `getAllEntries` reader.
function seedAlpha(): GetAllEntries {
  writeMemory("alpha", "Remember alpha details.");
  const s = seedEntries([
    {
      name: "alpha",
      type: "memory",
      description: "alpha memory",
      stashDir,
      filePath: path.join(stashDir, "memories", "alpha.md"),
    },
  ]);
  seededDbs.push(s);
  return s.getAllEntries;
}

/**
 * Config selecting a `triage-test` profile that enables triage but disables the
 * heavy full-pass siblings so the improve loop stays cheap and deterministic.
 */
function triageEnabledConfig(enabled: boolean): AkmConfig {
  return {
    semanticSearchMode: "off",
    defaults: { improve: "triage-test" },
    profiles: {
      improve: {
        "triage-test": {
          processes: {
            reflect: { enabled: false },
            distill: { enabled: false },
            consolidate: { enabled: false },
            memoryInference: { enabled: false },
            graphExtraction: { enabled: false },
            triage: { enabled, applyMode: "queue", policy: "personal-stash", maxAcceptsPerRun: 25 },
          },
        },
      },
    },
  } as unknown as AkmConfig;
}

function emptyDrainResult(): DrainResult {
  return { promoted: [], rejected: [], deferred: [], skippedByCap: [], staged: [] };
}

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
  cleanup = storage.cleanup;
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  for (const s of seededDbs.splice(0)) s.close();
  cleanup();
  cleanup = () => {};
  stashDir = "";
});

describe("akm improve — triage pre-pass", () => {
  test(
    "fires on a whole-stash run when triage is enabled",
    async () => {
      const getAllEntries = seedAlpha();

      const captured: Array<import("../../../src/commands/proposal/drain").DrainOptions> = [];
      const drainProposalsFn = mock(async (opts: import("../../../src/commands/proposal/drain").DrainOptions) => {
        captured.push(opts);
        return emptyDrainResult();
      });

      const result = await akmImprove({
        scope: "memory",
        stashDir,
        getAllEntries,
        ensureIndexFn: async () => false,
        config: triageEnabledConfig(true),
        drainProposalsFn: drainProposalsFn as never,
      });

      expect(result.ok).toBe(true);
      expect(drainProposalsFn).toHaveBeenCalledTimes(1);
      const opts = captured[0];
      expect(opts?.dryRun).toBe(false);
      // Decision #2: no fresh ids exist pre-improve, so excludeIds is empty.
      expect(opts?.excludeIds?.size).toBe(0);
      expect(opts?.applyMode).toBe("queue");
    },
    TIMEOUT_MS,
  );

  test(
    "does NOT fire when triage is disabled",
    async () => {
      const getAllEntries = seedAlpha();

      const drainProposalsFn = mock(async () => emptyDrainResult());

      const result = await akmImprove({
        scope: "memory",
        stashDir,
        getAllEntries,
        ensureIndexFn: async () => false,
        config: triageEnabledConfig(false),
        drainProposalsFn: drainProposalsFn as never,
      });

      expect(result.ok).toBe(true);
      expect(drainProposalsFn).not.toHaveBeenCalled();
    },
    TIMEOUT_MS,
  );

  test(
    "is skipped when scope.mode === 'ref'",
    async () => {
      const getAllEntries = seedAlpha();

      const drainProposalsFn = mock(async () => emptyDrainResult());

      const result = await akmImprove({
        scope: "memory:alpha",
        stashDir,
        getAllEntries,
        ensureIndexFn: async () => false,
        config: triageEnabledConfig(true),
        drainProposalsFn: drainProposalsFn as never,
      });

      expect(result.ok).toBe(true);
      expect(result.scope.mode).toBe("ref");
      expect(drainProposalsFn).not.toHaveBeenCalled();
    },
    TIMEOUT_MS,
  );

  test(
    "is skipped on dry-run (no lock, no triage)",
    async () => {
      const getAllEntries = seedAlpha();

      const drainProposalsFn = mock(async () => emptyDrainResult());

      const result = await akmImprove({
        scope: "memory",
        stashDir,
        getAllEntries,
        ensureIndexFn: async () => false,
        dryRun: true,
        config: triageEnabledConfig(true),
        drainProposalsFn: drainProposalsFn as never,
      });

      expect(result.ok).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(drainProposalsFn).not.toHaveBeenCalled();
    },
    TIMEOUT_MS,
  );

  test(
    "a thrown drain error is non-fatal — improve still completes",
    async () => {
      const getAllEntries = seedAlpha();

      const drainProposalsFn = mock(async () => {
        throw new Error("simulated triage failure");
      });

      const result = await akmImprove({
        scope: "memory",
        stashDir,
        getAllEntries,
        ensureIndexFn: async () => false,
        config: triageEnabledConfig(true),
        drainProposalsFn: drainProposalsFn as never,
      });

      expect(drainProposalsFn).toHaveBeenCalledTimes(1);
      // The drain threw, but improve must complete successfully.
      expect(result.ok).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "lock-leak guard: improve.lock is released and a second run is not blocked",
    async () => {
      // Regression guard for the Phase 4 lock hoist (§7): the lock is now
      // acquired ABOVE the pre-index region (ensureIndex / collectEligibleRefs /
      // contradiction-detection / memory-cleanup analysis) so the triage pre-pass
      // runs under it. A throw anywhere in that region must release the lock
      // (lock-leak guard try/catch) rather than leak `improve.lock`. We assert the
      // user-visible post-condition: after a real (non-dry-run) triage-enabled
      // run the lock file is gone, and a back-to-back second run is NOT rejected
      // by a stale/leaked lock.
      const getAllEntries = seedAlpha();

      const lockPath = path.join(stashDir, ".akm", "improve.lock");

      const result1 = await akmImprove({
        scope: "memory",
        stashDir,
        getAllEntries,
        ensureIndexFn: async () => false,
        config: triageEnabledConfig(true),
        drainProposalsFn: (async () => emptyDrainResult()) as never,
      });
      expect(result1.ok).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);

      const result2 = await akmImprove({
        scope: "memory",
        stashDir,
        getAllEntries,
        ensureIndexFn: async () => false,
        config: triageEnabledConfig(true),
        drainProposalsFn: (async () => emptyDrainResult()) as never,
      });
      expect(result2.ok).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "lock-leak guard (FIX 2): a throw from the end-of-run sync region does not leak the lock",
    async () => {
      // FIX-2 regression: the lock is now held by a single try/finally that spans
      // the budget-timer setup, openStateDatabase(), the profileFilteredRefs
      // audit loop, AND the main run through the end-of-run sync. The finally
      // releases `improve.lock` exactly once. The end-of-run sync swallows its own
      // failures (non-fatal), so this run still resolves ok — but the key
      // assertion is that the lock file is gone afterward and a back-to-back run
      // is not blocked. (Pre-fix, a throw in the post-acquire/pre-mainTry gap
      // leaked the lock; this asserts the unified finally always releases it.)
      const getAllEntries = seedAlpha();

      const lockPath = path.join(stashDir, ".akm", "improve.lock");

      // Make the primary stash git-backed so the end-of-run sync gate fires, then
      // inject a throwing saveGitStashFn to exercise the sync error path inside
      // the unified try/finally.
      fs.mkdirSync(path.join(stashDir, ".git"), { recursive: true });

      const result1 = await akmImprove({
        scope: "memory",
        stashDir,
        getAllEntries,
        ensureIndexFn: async () => false,
        config: triageEnabledConfig(true),
        drainProposalsFn: (async () => emptyDrainResult()) as never,
        saveGitStashFn: (() => {
          throw new Error("simulated sync failure");
        }) as never,
      });
      // Sync failure is non-fatal, run completes ok, and the lock is released.
      expect(result1.ok).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);

      const result2 = await akmImprove({
        scope: "memory",
        stashDir,
        getAllEntries,
        ensureIndexFn: async () => false,
        config: triageEnabledConfig(true),
        drainProposalsFn: (async () => emptyDrainResult()) as never,
      });
      expect(result2.ok).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);
    },
    TIMEOUT_MS,
  );
});
