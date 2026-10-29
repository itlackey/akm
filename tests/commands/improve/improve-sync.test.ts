// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pre-run and end-of-run auto-sync: before the index and plan stages the run
 * syncs the bundle like `akm sync` (#1091), and once it finishes the primary
 * stash is committed (and optionally pushed) in one BATCH via `saveGitStash`. Recognition
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
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmConfig } from "../../../src/core/config/config";
import { saveConfig } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import { GitStashPushError, type SaveGitStashResult } from "../../../src/sources/providers/git";
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
 * A cheap improve strategy: all heavy passes disabled so the loop stays
 * deterministic. No `sync` block here, so end-of-run sync defaults ON.
 */
function cheapConfig(sync?: { enabled?: boolean; push?: boolean }): AkmConfig {
  return {
    semanticSearchMode: "off",
    improve: {
      strategy: "sync-test",
      strategies: {
        "sync-test": {
          processes: {
            reflect: { enabled: false },
            distill: { enabled: false },
            consolidate: { enabled: false },
            memoryInference: { enabled: false },
            extract: { enabled: false },
            validation: { enabled: false },
            triage: { enabled: false },
            proactiveMaintenance: { enabled: false },
            recombine: { enabled: false },
            procedural: { enabled: false },
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
    "FIRES for a git-backed stash, before and after the run, with push:true",
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
      expect(saveGitStashFn).toHaveBeenCalledTimes(2);
      // Primary stash → name undefined; push defaults true.
      expect(calls.map((call) => call.name)).toEqual([undefined, undefined]);
      expect(calls.map((call) => call.push)).toEqual([true, true]);
      expect(calls[0]?.message).toBe("akm improve pre-run sync");
      expect(calls[1]?.message).toBe("akm improve auto-sync");
      expect(result.preRunSync).toEqual({ committed: true, pushed: true, skipped: false });
      expect(result.sync).toEqual({ committed: true, pushed: true, skipped: false });
    },
    TIMEOUT_MS,
  );

  test(
    "content-layout sync detects the repository root and scopes staging to content",
    async () => {
      const repoRoot = path.join(stashDir, "repo");
      const contentRoot = path.join(repoRoot, "content");
      fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
      fs.mkdirSync(path.join(contentRoot, "memories"), { recursive: true });
      fs.writeFileSync(
        path.join(contentRoot, "memories", "alpha.md"),
        "---\ndescription: alpha memory\n---\n\nAlpha.\n",
        "utf8",
      );
      await akmIndex({ stashDir: contentRoot, full: true });
      const calls: Array<{ writable?: boolean; push?: boolean; repoDir?: string; paths?: string[] }> = [];
      const saveGitStashFn = mock(
        (
          _name?: string,
          _message?: string,
          writable?: boolean,
          options?: { push?: boolean; repoDir?: string; paths?: string[] },
        ) => {
          calls.push({ writable, push: options?.push, repoDir: options?.repoDir, paths: options?.paths });
          return committedResult(false);
        },
      );

      await akmImprove({
        scope: "memory",
        stashDir: contentRoot,
        writeTarget: {
          source: { kind: "git", name: "team", path: contentRoot, repoPath: repoRoot },
          config: {
            type: "git",
            name: "team",
            url: "https://example.com/team/stash.git",
            writable: true,
            // Deprecated and now fully IGNORED (Decision 6, WI-9.6b): this no
            // longer suppresses push. Kept in the fixture to prove exactly
            // that — push resolves to the batch-sync default (true) via
            // `improveProfile.sync?.push ?? true`, NOT `false`.
            options: { pushOnCommit: false },
          },
        },
        config: cheapConfig(),
        saveGitStashFn: saveGitStashFn as never,
      });

      // Pre-run: only the content subdirectory is staged (nothing changed); end of run: the journaled paths.
      expect(calls).toEqual([
        { writable: true, push: true, repoDir: repoRoot, paths: [] },
        { writable: true, push: true, repoDir: repoRoot, paths: [] },
      ]);
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
      expect(result.preRunSync).toBeUndefined();
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
      expect(saveGitStashFn).toHaveBeenCalledTimes(2);
      expect(calls.map((call) => call.push)).toEqual([false, false]);
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

      expect(saveGitStashFn).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(true);
      expect(result.preRunSync?.skipped).toBe(true);
      expect(result.sync?.skipped).toBe(true);
      expect(result.sync?.committed).toBe(false);
      expect(result.sync?.reason).toContain("simulated push failure");
    },
    TIMEOUT_MS,
  );

  test(
    "a push failure after the commit landed is reported as committed",
    async () => {
      writeMemory("alpha", "Remember alpha details.");
      await akmIndex({ stashDir, full: true });
      makeGitBacked();

      const saveGitStashFn = mock(() => {
        throw new GitStashPushError("git push failed: rejected", "a".repeat(40));
      });

      const result = await akmImprove({
        scope: "memory",
        stashDir,
        config: cheapConfig(),
        saveGitStashFn: saveGitStashFn as never,
      });

      expect(result.ok).toBe(true);
      expect(result.sync).toMatchObject({ committed: true, pushed: false, skipped: true });
      expect(result.sync?.reason).toContain("git push failed");
    },
    TIMEOUT_MS,
  );
  test(
    "the pre-run sync runs before the index stage",
    async () => {
      writeMemory("alpha", "Remember alpha details.");
      await akmIndex({ stashDir, full: true });
      makeGitBacked();

      const order: string[] = [];
      const saveGitStashFn = mock(() => {
        order.push("sync");
        return committedResult(false);
      });

      await akmImprove({
        scope: "memory",
        stashDir,
        config: cheapConfig(),
        ensureIndexFn: async () => {
          order.push("index");
        },
        saveGitStashFn: saveGitStashFn as never,
      });

      expect(order.slice(0, 2)).toEqual(["sync", "index"]);
    },
    TIMEOUT_MS,
  );

  test(
    "a pre-run conflict warns, is recorded, and the run continues",
    async () => {
      writeMemory("alpha", "Remember alpha details.");
      await akmIndex({ stashDir, full: true });
      makeGitBacked();

      const conflict = "not pushed: merging upstream conflicts in memories/a.md; the merge was aborted";
      let calls = 0;
      const saveGitStashFn = mock(() => {
        calls += 1;
        return calls === 1
          ? { committed: true, pushed: false, skipped: false, reason: conflict, output: "" }
          : committedResult(true);
      });

      const result = await akmImprove({
        scope: "memory",
        stashDir,
        config: cheapConfig(),
        saveGitStashFn: saveGitStashFn as never,
      });

      expect(result.ok).toBe(true);
      expect(result.preRunSync).toEqual({ committed: true, pushed: false, skipped: false, reason: conflict });
      expect(result.sync).toEqual({ committed: true, pushed: true, skipped: false });
    },
    TIMEOUT_MS,
  );
});
