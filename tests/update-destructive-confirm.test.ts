// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression tests for F1/R-058: `akm bundle update` could `rm -rf` a previous
 * install directory with NO confirmation gate and NO `--yes` flag at all,
 * while `akm bundle remove` already refused in non-interactive mode without
 * `--yes`. The asymmetry: `updateManagedInstall` (installed-stashes.ts)
 * deletes `managed.localRoot` via `cleanupDirectoryBestEffort` whenever the
 * resolved content directory (`synced.contentDir`) differs from it, the
 * source isn't "local", and the install isn't writable.
 *
 * The fix gates ONLY that branch with `confirmDestructive` (same helper
 * `remove` uses) and a new `-y/--yes` flag threaded through `akmUpdate`. A
 * normal refresh — the overwhelming majority of `akm bundle update` invocations,
 * where the resolved content directory does NOT move — must stay completely
 * unaffected: no prompt, no flag required, unchanged exit code. These tests
 * pin BOTH halves: the gated destructive path AND the untouched normal path.
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmUpdate } from "../src/commands/sources/installed-stashes";
import { loadConfig, saveConfig } from "../src/core/config/config";
import { getRegistryCacheDir } from "../src/core/paths";
import { probeAssetMutationLease } from "../src/indexer/index-writer-lock";
import { _setAkmIndexForTests } from "../src/indexer/indexer";
import { readLockfile } from "../src/integrations/lockfile";
import * as syncFromRefModule from "../src/sources/providers/sync-from-ref";
import { seedLockEntries } from "./_helpers/lockfile";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  sandboxXdgStateHome,
} from "./_helpers/sandbox";
import { overrideSeam } from "./_helpers/seams";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-update-confirm-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ── stdin.isTTY override (matches tests/confirm-destructive.test.ts) ──────────
function withTTY<T>(isTTY: boolean, fn: () => Promise<T>): Promise<T> {
  const original = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
  return fn().finally(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: original, configurable: true });
  });
}

// Env/temp-dir isolation goes through the allowlisted sandbox helpers rather
// than raw mkdtempSync + process.env writes — `scripts/lint-tests-isolation.ts`
// rejects the hand-rolled form, and the helpers already restore a previously
// ABSENT var by deleting it rather than setting it to "undefined".
// `sandboxStashDir` also creates the stash skeleton subdirs for us.
let envCleanup: Cleanup = () => {};
let stashDir = "";

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const dataResult = sandboxXdgDataHome(cfgResult.cleanup);
  const stateResult = sandboxXdgStateHome(dataResult.cleanup);
  const stashResult = sandboxStashDir(stateResult.cleanup);
  stashDir = stashResult.dir;
  envCleanup = stashResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

/** Configure a non-local, non-writable managed bundle whose lock localRoot is `oldRoot`. */
function configureManagedBundle(id: string, oldRoot: string): void {
  saveConfig({
    semanticSearchMode: "off",
    bundles: {
      [id]: { npm: id },
    },
  });
  seedLockEntries([
    {
      id,
      source: "npm",
      ref: `npm:${id}`,
      localRoot: oldRoot,
      installedAt: "2026-04-22T16:39:07.564Z",
    },
  ]);
}

/** Where an update publishes the staged left-pad content. */
function liveContentDir(): string {
  return path.join(getRegistryCacheDir(), "left-pad-cache", "content");
}

/** Mock `syncFromRef` to fetch left-pad into the update's staging cache root, as the npm provider does. */
function mockStagedSync(opts: { ref?: string; version?: string } = {}): ReturnType<typeof spyOn> {
  return spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) => {
    if (!options?.cacheRootDir) throw new Error("update did not provide a staging cache root");
    const cacheDir = path.join(options.cacheRootDir, "left-pad-cache");
    const contentDir = path.join(cacheDir, "content");
    fs.mkdirSync(contentDir, { recursive: true });
    fs.writeFileSync(path.join(contentDir, "marker.txt"), "new content");
    return {
      id: "left-pad",
      source: "npm",
      ref: opts.ref ?? "npm:left-pad",
      artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      resolvedVersion: opts.version ?? "1.3.0",
      contentDir,
      cacheDir,
      extractedDir: contentDir,
      integrity: "sha512-fake",
      syncedAt: new Date().toISOString(),
      writable: false,
    };
  });
}

describe("akm bundle update — destructive-branch confirmation gate (F1/R-058)", () => {
  test("resolved content dir MOVES, non-interactive, no --yes: BLOCKED, old root untouched", async () => {
    const oldRoot = createTmpDir("akm-update-confirm-old-");
    fs.writeFileSync(path.join(oldRoot, "marker.txt"), "old content");
    configureManagedBundle("left-pad", oldRoot);

    const syncSpy = mockStagedSync();
    try {
      await withTTY(false, async () => {
        await expect(akmUpdate({ target: "left-pad", stashDir })).rejects.toMatchObject({
          code: "NON_INTERACTIVE_REQUIRES_YES",
        });
      });
    } finally {
      syncSpy.mockRestore();
    }

    // The gate fires BEFORE publication and cleanup: nothing moved.
    expect(fs.existsSync(path.join(oldRoot, "marker.txt"))).toBe(true);
    expect(fs.existsSync(liveContentDir())).toBe(false);
    expect(loadConfig().bundles?.["left-pad"]?.npm).toBe("left-pad");
    expect(readLockfile().find((e) => e.id === "left-pad")?.localRoot).toBe(oldRoot);
  });

  test("resolved content dir MOVES, --yes passed: proceeds and deletes the old root", async () => {
    const oldRoot = createTmpDir("akm-update-confirm-old-");
    fs.writeFileSync(path.join(oldRoot, "marker.txt"), "old content");
    configureManagedBundle("left-pad", oldRoot);

    const syncSpy = mockStagedSync();
    let result: Awaited<ReturnType<typeof akmUpdate>>;
    try {
      result = await withTTY(false, () => akmUpdate({ target: "left-pad", stashDir, yes: true }));
    } finally {
      syncSpy.mockRestore();
    }

    expect(result.processed).toHaveLength(1);
    expect(readLockfile().find((e) => e.id === "left-pad")?.localRoot).toBe(liveContentDir());
    expect(fs.readFileSync(path.join(liveContentDir(), "marker.txt"), "utf8")).toBe("new content");
    // The confirmed deletion actually ran.
    expect(fs.existsSync(oldRoot)).toBe(false);
  });

  test("normal refresh (resolved content dir UNCHANGED) needs no --yes and prompts nothing", async () => {
    const root = liveContentDir();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "marker.txt"), "stable content");
    configureManagedBundle("left-pad", root);

    const syncSpy = mockStagedSync();
    let result: Awaited<ReturnType<typeof akmUpdate>>;
    try {
      // Non-interactive AND no --yes: must NOT throw, because the
      // destructive branch is never reached (contentDir === localRoot).
      result = await withTTY(false, () => akmUpdate({ target: "left-pad", stashDir }));
    } finally {
      syncSpy.mockRestore();
    }

    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]?.changed.version).toBe(true);
    expect(readLockfile().find((e) => e.id === "left-pad")?.localRoot).toBe(root);
    expect(fs.readFileSync(path.join(root, "marker.txt"), "utf8")).toBe("new content");
  });

  test("holds the reentrant asset mutation lease while publishing and reindexing", async () => {
    configureManagedBundle("left-pad", liveContentDir());
    const syncSpy = mockStagedSync();
    let leaseState: ReturnType<typeof probeAssetMutationLease>["state"] | undefined;
    overrideSeam(_setAkmIndexForTests, async () => {
      leaseState = probeAssetMutationLease().state;
      return {
        schemaVersion: 1,
        stashDir,
        mode: "incremental",
        totalEntries: 0,
        directoriesScanned: 0,
        directoriesSkipped: 0,
      } as never;
    });

    try {
      await akmUpdate({ target: "left-pad", stashDir });
    } finally {
      syncSpy.mockRestore();
    }
    expect(leaseState).toBe("held");
  });

  test("skips old-root deletion when another configured bundle still references it", async () => {
    const oldRoot = createTmpDir("akm-update-shared-old-");
    fs.writeFileSync(path.join(oldRoot, "marker.txt"), "shared content");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        "left-pad": { npm: "left-pad" },
        shared: { path: oldRoot, components: { main: { root: ".", adapter: "akm" } } },
      },
    });
    seedLockEntries([{ id: "left-pad", source: "npm", ref: "npm:left-pad", localRoot: oldRoot }]);
    const syncSpy = mockStagedSync();

    try {
      await akmUpdate({ target: "left-pad", stashDir, yes: true });
    } finally {
      syncSpy.mockRestore();
    }
    expect(fs.existsSync(path.join(oldRoot, "marker.txt"))).toBe(true);
  });

  test("skips old-root deletion when another configured bundle is nested beneath it", async () => {
    const oldRoot = createTmpDir("akm-update-nested-old-");
    const nestedRoot = path.join(oldRoot, "..notes");
    fs.mkdirSync(nestedRoot);
    const marker = path.join(nestedRoot, "marker.txt");
    fs.writeFileSync(marker, "user content");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        "left-pad": { npm: "left-pad" },
        notes: { path: nestedRoot },
      },
    });
    seedLockEntries([{ id: "left-pad", source: "npm", ref: "npm:left-pad", localRoot: oldRoot }]);
    const syncSpy = mockStagedSync();

    try {
      await akmUpdate({ target: "left-pad", stashDir, yes: true });
    } finally {
      syncSpy.mockRestore();
    }
    expect(fs.readFileSync(marker, "utf8")).toBe("user content");
  });

  test.skipIf(process.platform === "win32")(
    "skips old-root deletion when a configured source is a nested symlink",
    async () => {
      const oldRoot = createTmpDir("akm-update-symlink-old-");
      const externalRoot = createTmpDir("akm-update-symlink-external-");
      const linkedRoot = path.join(oldRoot, "linked-notes");
      const marker = path.join(externalRoot, "marker.txt");
      fs.writeFileSync(marker, "external content");
      fs.symlinkSync(externalRoot, linkedRoot, "dir");
      saveConfig({
        semanticSearchMode: "off",
        bundles: {
          "left-pad": { npm: "left-pad" },
          notes: { path: linkedRoot },
        },
      });
      seedLockEntries([{ id: "left-pad", source: "npm", ref: "npm:left-pad", localRoot: oldRoot }]);
      const syncSpy = mockStagedSync();

      try {
        await akmUpdate({ target: "left-pad", stashDir, yes: true });
      } finally {
        syncSpy.mockRestore();
      }
      expect(fs.lstatSync(linkedRoot).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(marker, "utf8")).toBe("external content");
    },
  );

  test("explicit disabled managed update preserves enabled and passthrough policy fields", async () => {
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        "left-pad": {
          npm: "left-pad",
          enabled: false,
          policy: { channel: "stable" },
          components: { main: { root: ".", adapter: "akm", writable: false } },
        },
      },
    });
    seedLockEntries([{ id: "left-pad", source: "npm", ref: "npm:left-pad", localRoot: liveContentDir() }]);
    const syncSpy = mockStagedSync({ ref: "npm:left-pad@2.0.0", version: "2.0.0" });

    try {
      await akmUpdate({ target: "left-pad", stashDir });
    } finally {
      syncSpy.mockRestore();
    }
    const bundle = loadConfig().bundles?.["left-pad"] as Record<string, unknown> | undefined;
    expect(bundle?.enabled).toBe(false);
    expect(bundle?.policy).toEqual({ channel: "stable" });
    expect(bundle?.npm).toBe("left-pad");
  });

  test("a reindex failure after publication keeps the new lock and never deletes the old root", async () => {
    const oldRoot = createTmpDir("akm-update-index-fail-old-");
    fs.writeFileSync(path.join(oldRoot, "marker.txt"), "old content");
    configureManagedBundle("left-pad", oldRoot);
    const syncSpy = mockStagedSync();
    overrideSeam(_setAkmIndexForTests, async () => {
      throw new Error("index unavailable");
    });

    try {
      await expect(akmUpdate({ target: "left-pad", stashDir, yes: true })).rejects.toThrow(/index unavailable/);
    } finally {
      syncSpy.mockRestore();
    }

    // Content and lock were published before indexing; the next `akm index`
    // catches up. The previous root is only removed after a successful index.
    expect(readLockfile().find((e) => e.id === "left-pad")?.localRoot).toBe(liveContentDir());
    expect(fs.readFileSync(path.join(liveContentDir(), "marker.txt"), "utf8")).toBe("new content");
    expect(fs.readFileSync(path.join(oldRoot, "marker.txt"), "utf8")).toBe("old content");
  });
});
