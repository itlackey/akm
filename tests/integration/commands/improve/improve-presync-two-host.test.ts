// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pre-run sync (#1091) against a real shared remote: host A's `akmImprove` runs the same sync
 * `akm sync` does before the index and plan stages, so a change host B pushed is on disk before
 * anything reads the bundle. A conflict warns and the run continues on the local state. Model
 * stages are stubbed out; only the sync is real.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmImprove } from "../../../../src/commands/improve/improve";
import type { AkmConfig } from "../../../../src/core/config/config";
import { seedIgnoredTrackedChanges } from "../../../_helpers/git-ignored-tracked";
import { type Cleanup, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

let cleanup: Cleanup = () => {};
let stashDir = "";
const tempDirs: string[] = [];

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  stashDir = storage.stashDir;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.replace(/\n$/, "");
}

function configure(cwd: string): void {
  git(cwd, "config", "user.email", "test@akm.local");
  git(cwd, "config", "user.name", "akm test");
}

function commitFile(cwd: string, file: string, content: string, subject: string): void {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", subject);
}

/** A bare remote seeded with `memories/shared.md`; host A is the sandbox stash, host B a separate clone. */
function setup(): { remote: string; b: string } {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "akm-presync-remote-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "akm-presync-b-"));
  tempDirs.push(remote, b);
  git(remote, "init", "--bare", "--initial-branch=main");
  git(b, "init", "--initial-branch=main");
  configure(b);
  git(b, "remote", "add", "origin", remote);
  commitFile(b, "memories/shared.md", "one\ntwo\nthree\n", "seed");
  git(b, "push", "-u", "origin", "main");
  git(stashDir, "init", "--initial-branch=main");
  configure(stashDir);
  git(stashDir, "remote", "add", "origin", remote);
  git(stashDir, "fetch", "origin");
  git(stashDir, "checkout", "-B", "main", "--track", "origin/main");
  return { remote, b };
}

const config = {
  semanticSearchMode: "off",
  improve: {
    strategy: "presync-test",
    strategies: {
      "presync-test": {
        processes: Object.fromEntries(
          [
            "reflect",
            "distill",
            "consolidate",
            "memoryInference",
            "extract",
            "validation",
            "triage",
            "proactiveMaintenance",
            "recombine",
            "procedural",
          ].map((name) => [name, { enabled: false }]),
        ),
      },
    },
  },
} as unknown as AkmConfig;

/** A real `akmImprove` with every model stage stubbed; `atIndex` runs when the index stage starts. */
function runImprove(atIndex: () => void, options: { sync?: { push?: boolean } } = {}) {
  return akmImprove({
    scope: "memory",
    stashDir,
    config,
    ...options,
    ensureIndexFn: async () => {
      atIndex();
    },
    collectEligibleRefsFn: (async () => ({
      plannedRefs: [],
      memorySummary: { eligible: 0, derived: 0 },
      strategyFilteredRefs: [],
    })) as never,
    runImprovePreparationStageFn: (async () => ({
      actionableRefs: [],
      loopRefs: [],
      distillOnlyRefs: [],
      distillCooledRefs: new Set(),
      signalBearingSet: new Set(),
      utilityMap: new Map(),
      actions: [],
      cleanupWarnings: [],
      validationFailures: [],
      schemaRepairs: [],
      coverageGaps: [],
      recentErrors: {},
      consolidation: {
        schemaVersion: 1,
        ok: true,
        shape: "consolidate-result",
        dryRun: false,
        previewOnly: false,
        target: "memory",
        processed: 0,
        merged: 0,
        deleted: 0,
        promoted: [],
        contradicted: 0,
        warnings: [],
      },
    })) as never,
    runImproveLoopStageFn: (async () => ({
      reflectsWithErrorContext: 0,
      memoryRefsForInference: new Set(),
    })) as never,
    runImprovePostLoopStageFn: (async () => ({
      allWarnings: [],
      memoryInferenceDurationMs: 0,
    })) as never,
  });
}

describe("improve pre-run sync across two hosts", () => {
  test("host B's pushed change is on disk before the index stage", async () => {
    const { b } = setup();
    commitFile(b, "memories/from-b.md", "from b\n", "host B change");
    git(b, "push", "origin", "main");
    let seenAtIndex: boolean | undefined;

    const result = await runImprove(() => {
      seenAtIndex = fs.existsSync(path.join(stashDir, "memories", "from-b.md"));
    });

    expect(result.ok).toBe(true);
    expect(seenAtIndex).toBe(true);
    expect(result.preRunSync).toMatchObject({ committed: false, pushed: false, skipped: false });
    expect(result.preRunSync?.reason).toBeUndefined();
  });

  test("tracked files under a git-ignored directory do not skip the sync", async () => {
    const { b } = setup();
    commitFile(b, "memories/from-b.md", "from b\n", "host B change");
    git(b, "push", "origin", "main");
    seedIgnoredTrackedChanges(stashDir);

    const result = await runImprove(() => {});

    expect(result.ok).toBe(true);
    expect(result.preRunSync?.reason).toBeUndefined();
    expect(result.preRunSync).toMatchObject({ committed: true, skipped: false });
    // Host B's change was merged in, and the managed change was committed.
    expect(fs.existsSync(path.join(stashDir, "memories", "from-b.md"))).toBe(true);
    expect(git(stashDir, "show", "--name-only", "--format=", "HEAD^")).toBe("skills/skill.md");
  });

  test("a conflicting upstream change warns and the run continues on the local state", async () => {
    const { remote, b } = setup();
    commitFile(b, "memories/shared.md", "one\nTWO FROM B\nthree\n", "host B edits shared");
    git(b, "push", "origin", "main");
    const remoteBefore = git(remote, "rev-parse", "main");
    // Host A's own hand edit to the same line, left uncommitted.
    fs.writeFileSync(path.join(stashDir, "memories", "shared.md"), "one\nTWO FROM A\nthree\n");
    let indexed = false;

    const result = await runImprove(() => {
      indexed = true;
    });

    expect(result.ok).toBe(true);
    expect(indexed).toBe(true);
    expect(result.preRunSync).toMatchObject({ committed: true, pushed: false, skipped: false });
    expect(result.preRunSync?.reason).toContain("memories/shared.md");
    expect(fs.readFileSync(path.join(stashDir, "memories", "shared.md"), "utf8")).toBe("one\nTWO FROM A\nthree\n");
    expect(fs.existsSync(path.join(stashDir, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(remote, "rev-parse", "main")).toBe(remoteBefore);
  });

  test("an unreachable remote warns and the run continues", async () => {
    const { remote } = setup();
    fs.rmSync(remote, { recursive: true, force: true });
    let indexed = false;

    const result = await runImprove(() => {
      indexed = true;
    });

    expect(result.ok).toBe(true);
    expect(indexed).toBe(true);
    expect(result.preRunSync?.reason).toContain("could not fetch");
  });

  test("a stash that is not a git repository is left alone", async () => {
    fs.mkdirSync(path.join(stashDir, "memories"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "memories", "note.md"), "note\n");

    const result = await runImprove(() => {});

    expect(result.ok).toBe(true);
    expect(result.preRunSync).toBeUndefined();
    expect(result.sync).toBeUndefined();
    expect(fs.existsSync(path.join(stashDir, ".git"))).toBe(false);
  });
});
