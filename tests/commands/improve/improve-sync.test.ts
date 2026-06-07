// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * End-of-run auto-sync: once an improve run finishes, the primary stash is
 * committed (and optionally pushed) in one BATCH via `saveGitStash`. Recognition
 * is by `.git` presence (NOT by a remote), decoupled from the per-write path.
 *
 * These tests drive the real `akmImprove` with an injected `saveGitStashFn` seam
 * so the batch sync is observable without running real git:
 *
 *   - FIRES for a git-backed stash (default ON), called once with push:true,
 *   - SKIPPED when the stash is not git-backed (no `.git`),
 *   - SKIPPED on dry-run (the dry-run branch returns before the sync seam),
 *   - SKIPPED when sync is disabled (profile sync.enabled=false or --no-sync),
 *   - threads push:false when --no-push / sync.push=false,
 *   - NON-FATAL when the sync throws — improve still returns ok:true.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmImprove } from "../../../src/commands/improve";
import type { AkmConfig } from "../../../src/core/config";
import { saveConfig } from "../../../src/core/config";
import { akmIndex } from "../../../src/indexer/indexer";
import type { SaveGitStashResult } from "../../../src/sources/providers/git";
import { type Cleanup, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const TIMEOUT_MS = 20_000;

let cleanup: Cleanup = () => {};
let stashDir = "";

function writeMemory(name: string, body: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name} memory\n---\n\n${body}\n`, "utf8");
}

/** Mark the sandbox stash as git-backed (recognition is by `.git` presence). */
function makeGitBacked(): void {
  fs.mkdirSync(path.join(stashDir, ".git"), { recursive: true });
}

/**
 * A cheap improve profile: all heavy passes disabled so the loop stays
 * deterministic. No `sync` block here, so end-of-run sync defaults ON.
 */
function cheapConfig(sync?: { enabled?: boolean; push?: boolean }): AkmConfig {
  return {
    semanticSearchMode: "off",
    defaults: { improve: "sync-test" },
    profiles: {
      improve: {
        "sync-test": {
          processes: {
            reflect: { enabled: false },
            distill: { enabled: false },
            consolidate: { enabled: false },
            memoryInference: { enabled: false },
            graphExtraction: { enabled: false },
            triage: { enabled: false },
          },
          ...(sync ? { sync } : {}),
        },
      },
    },
  } as unknown as AkmConfig;
}

function committedResult(pushed: boolean): SaveGitStashResult {
  return { committed: true, pushed, skipped: false, output: "committed" };
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

describe("akm improve — end-of-run auto-sync", () => {
  test(
    "FIRES for a git-backed stash, called once with push:true",
    async () => {
      writeMemory("alpha", "Remember alpha details.");
      await akmIndex({ stashDir, full: true });
      makeGitBacked();

      const calls: Array<{ name?: string; message?: string; push?: boolean }> = [];
      const saveGitStashFn = mock(
        (name?: string, message?: string, _writable?: boolean, options?: { push?: boolean }) => {
          calls.push({ name, message, push: options?.push });
          return committedResult(true);
        },
      );

      const result = await akmImprove({
        scope: "memory",
        stashDir,
        config: cheapConfig(),
        saveGitStashFn: saveGitStashFn as never,
      });

      expect(result.ok).toBe(true);
      expect(saveGitStashFn).toHaveBeenCalledTimes(1);
      // Primary stash → name undefined; push defaults true.
      expect(calls[0]?.name).toBeUndefined();
      expect(calls[0]?.push).toBe(true);
      expect(result.sync).toEqual({ committed: true, pushed: true, skipped: false });
    },
    TIMEOUT_MS,
  );

  test(
    "SKIPPED when the stash is not git-backed (no .git)",
    async () => {
      writeMemory("alpha", "Remember alpha details.");
      await akmIndex({ stashDir, full: true });
      // Deliberately NOT git-backed: no makeGitBacked().

      const saveGitStashFn = mock(() => committedResult(true));

      const result = await akmImprove({
        scope: "memory",
        stashDir,
        config: cheapConfig(),
        saveGitStashFn: saveGitStashFn as never,
      });

      expect(result.ok).toBe(true);
      expect(saveGitStashFn).not.toHaveBeenCalled();
      expect(result.sync).toBeUndefined();
    },
    TIMEOUT_MS,
  );

  test(
    "SKIPPED on dry-run (saveGitStashFn never called)",
    async () => {
      writeMemory("alpha", "Remember alpha details.");
      await akmIndex({ stashDir, full: true });
      makeGitBacked();

      const saveGitStashFn = mock(() => committedResult(true));

      const result = await akmImprove({
        scope: "memory",
        stashDir,
        dryRun: true,
        config: cheapConfig(),
        saveGitStashFn: saveGitStashFn as never,
      });

      expect(result.ok).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(saveGitStashFn).not.toHaveBeenCalled();
    },
    TIMEOUT_MS,
  );

  test(
    "SKIPPED when sync.enabled=false in the profile",
    async () => {
      writeMemory("alpha", "Remember alpha details.");
      await akmIndex({ stashDir, full: true });
      makeGitBacked();

      const saveGitStashFn = mock(() => committedResult(true));

      const result = await akmImprove({
        scope: "memory",
        stashDir,
        config: cheapConfig({ enabled: false }),
        saveGitStashFn: saveGitStashFn as never,
      });

      expect(result.ok).toBe(true);
      expect(saveGitStashFn).not.toHaveBeenCalled();
    },
    TIMEOUT_MS,
  );

  test(
    "SKIPPED when --no-sync overrides an enabled profile",
    async () => {
      writeMemory("alpha", "Remember alpha details.");
      await akmIndex({ stashDir, full: true });
      makeGitBacked();

      const saveGitStashFn = mock(() => committedResult(true));

      const result = await akmImprove({
        scope: "memory",
        stashDir,
        config: cheapConfig({ enabled: true }),
        // CLI override: --no-sync.
        sync: { enabled: false },
        saveGitStashFn: saveGitStashFn as never,
      });

      expect(result.ok).toBe(true);
      expect(saveGitStashFn).not.toHaveBeenCalled();
    },
    TIMEOUT_MS,
  );

  test(
    "threads push:false when --no-push / sync.push=false",
    async () => {
      writeMemory("alpha", "Remember alpha details.");
      await akmIndex({ stashDir, full: true });
      makeGitBacked();

      const calls: Array<{ push?: boolean }> = [];
      const saveGitStashFn = mock(
        (_name?: string, _message?: string, _writable?: boolean, options?: { push?: boolean }) => {
          calls.push({ push: options?.push });
          return committedResult(false);
        },
      );

      const result = await akmImprove({
        scope: "memory",
        stashDir,
        config: cheapConfig(),
        // CLI override: --no-push.
        sync: { push: false },
        saveGitStashFn: saveGitStashFn as never,
      });

      expect(result.ok).toBe(true);
      expect(saveGitStashFn).toHaveBeenCalledTimes(1);
      expect(calls[0]?.push).toBe(false);
      expect(result.sync).toEqual({ committed: true, pushed: false, skipped: false });
    },
    TIMEOUT_MS,
  );

  test(
    "NON-FATAL when saveGitStashFn throws — improve still returns ok:true",
    async () => {
      writeMemory("alpha", "Remember alpha details.");
      await akmIndex({ stashDir, full: true });
      makeGitBacked();

      const saveGitStashFn = mock(() => {
        throw new Error("simulated push failure");
      });

      const result = await akmImprove({
        scope: "memory",
        stashDir,
        config: cheapConfig(),
        saveGitStashFn: saveGitStashFn as never,
      });

      expect(saveGitStashFn).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(true);
      expect(result.sync?.skipped).toBe(true);
      expect(result.sync?.committed).toBe(false);
      expect(result.sync?.reason).toContain("simulated push failure");
    },
    TIMEOUT_MS,
  );
});
