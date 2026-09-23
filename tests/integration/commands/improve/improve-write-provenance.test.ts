// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Run-scoped write provenance for the improve auto-sync commit (#652).
 *
 * These tests drive the REAL `saveGitStash` against a REAL git repo, so every
 * assertion is about the commit that actually landed — not about the arguments
 * a seam observed.
 *
 * The contract under test: the end-of-run commit contains exactly the paths the
 * run itself wrote (as recorded by the write-provenance journal, through the
 * production write paths), and nothing else:
 *
 *   - a managed-directory edit made by someone else DURING the run stays dirty,
 *   - a path that was ALREADY dirty when the run started and is then rewritten
 *     by the run IS committed (the pre-#652 dirty-diff subtracted it out),
 *   - a deletion the run performed lands as a staged deletion,
 *   - a path written and then removed again produces no commit at all,
 *   - callers that pass NO explicit path list (`akm sync`, `akm push`) still get
 *     the managed-pathspec fallback.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmImprove, resolveSyncPathSet } from "../../../../src/commands/improve/improve";
import { parseRefInput } from "../../../../src/core/asset/resolve-ref";
import type { AkmConfig, SourceConfigEntry } from "../../../../src/core/config/config";
import { getDistillRejectedDir } from "../../../../src/core/paths";
import { recordWrittenPath } from "../../../../src/core/write-provenance";
import { deleteAssetFromSource, type WriteTargetSource, writeAssetToSource } from "../../../../src/core/write-source";
import { saveGitStash } from "../../../../src/sources/providers/git";
import { type Cleanup, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

let cleanup: Cleanup = () => {};
let stashDir = "";

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  stashDir = storage.stashDir;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  stashDir = "";
});

const config = {
  semanticSearchMode: "off",
  defaults: { improveStrategy: "provenance-test" },
  improve: {
    strategies: {
      "provenance-test": {
        processes: Object.fromEntries(
          [
            "reflect",
            "distill",
            "consolidate",
            "memoryInference",
            "graphExtraction",
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

function git(...args: string[]): string {
  const result = spawnSync("git", ["-C", stashDir, ...args], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout;
}

/** A committed git-backed stash: `memories/human.md` is tracked at HEAD. */
function initRepo(): void {
  expect(spawnSync("git", ["init", "--initial-branch=main", stashDir], { encoding: "utf8" }).status).toBe(0);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  fs.mkdirSync(path.join(stashDir, "memories"), { recursive: true });
  fs.writeFileSync(path.join(stashDir, "memories", "human.md"), "---\ntype: memory\n---\n\nHuman note.\n", "utf8");
  git("add", "-A");
  git("commit", "-m", "seed");
}

function writeSource(): { source: WriteTargetSource; config: SourceConfigEntry } {
  return {
    source: { kind: "filesystem", name: "stash", path: stashDir },
    config: { type: "filesystem", name: "stash", path: stashDir, writable: true } as SourceConfigEntry,
  };
}

/** Write an asset through the production write path (which journals it). */
async function writeAsset(ref: string, body: string): Promise<void> {
  const target = writeSource();
  await writeAssetToSource(target.source, target.config, parseRefInput(ref), `---\ntype: memory\n---\n\n${body}\n`);
}

/** Names touched by the newest commit, relative to its parent. */
function lastCommitPaths(): string[] {
  return git("show", "--name-status", "--format=", "HEAD")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trim().replace(/^\w+\s+/, ""))
    .sort();
}

function statusPaths(): string[] {
  return git("status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .sort();
}

function headCount(): number {
  return git("rev-list", "--count", "HEAD").trim().length > 0 ? Number(git("rev-list", "--count", "HEAD").trim()) : 0;
}

/**
 * Drive a real improve run whose preparation stage performs `mutate()` — the
 * heavy passes are all disabled, so `mutate` is the only thing that writes.
 */
async function runImprove(
  mutate: () => Promise<void> | void,
  duringLoop?: () => void,
): Promise<Awaited<ReturnType<typeof akmImprove>>> {
  return akmImprove({
    scope: "memory",
    stashDir,
    config,
    ensureIndexFn: async () => undefined,
    collectEligibleRefsFn: (async () => ({
      plannedRefs: [{ ref: "memories/human" }],
      memorySummary: { eligible: 1, derived: 0 },
      strategyFilteredRefs: [],
    })) as never,
    runImprovePreparationStageFn: (async (args: { plannedRefs: Array<{ ref: string }> }) => {
      await mutate();
      return {
        actionableRefs: args.plannedRefs,
        loopRefs: args.plannedRefs,
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
        consolidationRan: false,
      };
    }) as never,
    runImproveLoopStageFn: (async () => {
      duringLoop?.();
      return { reflectsWithErrorContext: 0, memoryRefsForInference: new Set() };
    }) as never,
    runImprovePostLoopStageFn: (async () => ({
      allWarnings: [],
      memoryInferenceDurationMs: 0,
      graphExtractionDurationMs: 0,
    })) as never,
  });
}

test("auto-sync commits only what the run wrote, leaving a concurrent managed edit dirty", async () => {
  initRepo();

  const result = await runImprove(
    async () => {
      await writeAsset("memories/alpha", "Alpha.");
      await writeAsset("memories/beta", "Beta.");
    },
    () => {
      // A human (or another tool) edits a DIFFERENT managed file mid-run. The
      // pre-#652 dirty-diff swept this into akm's commit because it was not in
      // the start-of-run baseline.
      fs.writeFileSync(path.join(stashDir, "memories", "human.md"), "---\ntype: memory\n---\n\nEdited by hand.\n");
    },
  );

  expect(result.ok).toBe(true);
  expect(result.sync?.committed).toBe(true);
  expect(lastCommitPaths()).toEqual(["memories/alpha.md", "memories/beta.md"]);
  // The concurrent edit was never staged and is still sitting in the worktree.
  expect(statusPaths()).toContain("memories/human.md");
  expect(fs.readFileSync(path.join(stashDir, "memories", "human.md"), "utf8")).toContain("Edited by hand.");
  // …and the run reports exactly what it wrote.
  expect(result.writtenPaths).toEqual(["memories/alpha.md", "memories/beta.md"]);
});

test("the crash-path commit also stages only the run's own writes", async () => {
  initRepo();

  await expect(
    runImprove(
      async () => {
        await writeAsset("memories/alpha", "Alpha.");
      },
      () => {
        fs.writeFileSync(path.join(stashDir, "memories", "human.md"), "---\ntype: memory\n---\n\nEdited by hand.\n");
        throw new Error("simulated mid-run crash");
      },
    ),
  ).rejects.toThrow("simulated mid-run crash");

  // #662's crash safety net banks the run's writes before rethrowing — under
  // #652 it banks exactly those, not the edit that raced it.
  expect(lastCommitPaths()).toEqual(["memories/alpha.md"]);
  expect(statusPaths()).toContain("memories/human.md");
});

test("auto-sync commits a path that was already dirty before the run and rewritten by it", async () => {
  initRepo();
  // Pre-existing WIP on a tracked managed file — dirty BEFORE improve starts.
  fs.writeFileSync(path.join(stashDir, "memories", "human.md"), "---\ntype: memory\n---\n\nUncommitted WIP.\n");

  const result = await runImprove(async () => {
    await writeAsset("memories/human", "Rewritten by improve.");
  });

  expect(result.sync?.committed).toBe(true);
  // The pre-#652 baseline subtraction dropped this path entirely; the run wrote
  // it, so the run owns it.
  expect(lastCommitPaths()).toEqual(["memories/human.md"]);
  expect(result.writtenPaths).toEqual(["memories/human.md"]);
  expect(statusPaths()).not.toContain("memories/human.md");
});

test("auto-sync stages a deletion the run performed", async () => {
  initRepo();

  const result = await runImprove(async () => {
    const target = writeSource();
    await deleteAssetFromSource(target.source, target.config, parseRefInput("memories/human"));
  });

  expect(result.sync?.committed).toBe(true);
  expect(lastCommitPaths()).toEqual(["memories/human.md"]);
  expect(git("show", "--name-status", "--format=", "HEAD").trim().startsWith("D")).toBe(true);
  expect(fs.existsSync(path.join(stashDir, "memories", "human.md"))).toBe(false);
  expect(result.writtenPaths).toEqual(["memories/human.md"]);
});

test("a quality-rejected lesson lands under $STATE, not the stash, is still reported as written, and is never auto-synced (itlackey/akm#890)", async () => {
  initRepo();
  const before = headCount();

  // Same out-of-stash write shape `writeQualityRejection` (quality-gate.ts)
  // uses in production: mkdir + writeFileSync under $STATE, then journal it.
  const rejectDir = getDistillRejectedDir(stashDir);
  const rejectPath = path.join(rejectDir, "human-rejected.md");
  const result = await runImprove(() => {
    fs.mkdirSync(rejectDir, { recursive: true });
    fs.writeFileSync(rejectPath, "---\nscore: 2\nreason: rejected\n---\n\nRejected.\n", "utf8");
    recordWrittenPath(rejectPath);
  });

  // Written under $STATE/improve/distill-rejected/<stash>/, never under
  // $STASH/.akm/.
  expect(fs.existsSync(rejectPath)).toBe(true);
  expect(fs.existsSync(path.join(stashDir, ".akm", "distill-rejected"))).toBe(false);
  // Still journaled and reported on the result — but as an absolute path,
  // since describeRunWrittenPaths only reports a stash-relative path for a
  // write that landed INSIDE the stash.
  expect(result.writtenPaths).toEqual([rejectPath]);
  // It lives outside the stash's git repo entirely, so auto-sync's own
  // containment check drops it and there is nothing to commit.
  expect(result.sync?.committed).toBe(false);
  expect(headCount()).toBe(before);
});

test("a path written then removed again during the run produces no commit", async () => {
  initRepo();
  const before = headCount();

  const result = await runImprove(async () => {
    const target = writeSource();
    await writeAsset("memories/scratch", "Transient.");
    // A downstream pass reverts the write (proposal rollback / orphan purge).
    await deleteAssetFromSource(target.source, target.config, parseRefInput("memories/scratch"));
  });

  // Journaled, but the final on-disk state is identical to HEAD — the exact-path
  // commit short-circuits instead of creating an empty commit.
  expect(result.writtenPaths).toEqual(["memories/scratch.md"]);
  expect(result.sync?.committed).toBe(false);
  expect(headCount()).toBe(before);
});

test("a run that writes nothing commits nothing — an empty set is not the managed fallback", async () => {
  initRepo();
  const before = headCount();
  // Dirty managed content the run did not touch. `saveGitStash`'s managed
  // pathspec fallback would sweep this up; an EMPTY explicit path list must not.
  fs.writeFileSync(path.join(stashDir, "memories", "human.md"), "---\ntype: memory\n---\n\nSomeone else's WIP.\n");

  const result = await runImprove(() => {});

  expect(result.ok).toBe(true);
  expect(result.writtenPaths).toBeUndefined();
  expect(result.sync?.committed).toBe(false);
  expect(headCount()).toBe(before);
  expect(statusPaths()).toContain("memories/human.md");
});

test("saveGitStash with no explicit path list still falls back to managed pathspecs", () => {
  initRepo();
  fs.writeFileSync(path.join(stashDir, "memories", "human.md"), "---\ntype: memory\n---\n\nManaged edit.\n");
  fs.writeFileSync(path.join(stashDir, "stray-report.html"), "<html></html>", "utf8");

  const result = saveGitStash(undefined, "akm sync", true, { repoDir: stashDir, push: false });

  expect(result.committed).toBe(true);
  expect(lastCommitPaths()).toEqual(["memories/human.md"]);
  // The stray non-akm file is neither committed nor a reason to refuse.
  expect(statusPaths()).toEqual(["stray-report.html"]);
});

test("resolveSyncPathSet: provenance is authoritative, the dirty diff is the fallback", () => {
  const repoDir = "/repo";
  const changedPaths = ["memories/written.md", "memories/human.md", "memories/pre-existing.md", ".akm/improve.lock"];
  const initialPaths = new Set(["memories/pre-existing.md"]);
  const writtenPaths = [
    "/repo/memories/written.md",
    // Journaled but no longer different from HEAD (or ignored) — dropped.
    "/repo/memories/no-op.md",
    // Journaled outside the repo (a --target bundle) — out of staging scope.
    "/elsewhere/memories/other.md",
  ];

  expect(
    resolveSyncPathSet({ repoDir, assetPrefix: "", changedPaths, initialPaths, writtenPaths, provenance: true }),
  ).toEqual({ paths: ["memories/written.md"], unattributed: ["memories/human.md"] });

  // Without a journal the pre-#652 behaviour is preserved verbatim: everything
  // dirty that was not dirty at start, minus lock files.
  expect(
    resolveSyncPathSet({ repoDir, assetPrefix: "", changedPaths, initialPaths, writtenPaths, provenance: false }),
  ).toEqual({ paths: ["memories/written.md", "memories/human.md"], unattributed: [] });
});

test("resolveSyncPathSet: journaled paths outside the content root are not staged", () => {
  expect(
    resolveSyncPathSet({
      repoDir: "/repo",
      assetPrefix: "content",
      changedPaths: ["content/memories/a.md", "docs/notes.md"],
      initialPaths: new Set<string>(),
      writtenPaths: ["/repo/content/memories/a.md", "/repo/docs/notes.md"],
      provenance: true,
    }),
  ).toEqual({ paths: ["content/memories/a.md"], unattributed: [] });
});
