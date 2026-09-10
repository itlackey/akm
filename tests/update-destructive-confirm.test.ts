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
import { _setUpdateTransactionHookForTests, akmUpdate } from "../src/commands/sources/installed-stashes";
import { loadConfig, saveConfig } from "../src/core/config/config";
import { probeAssetMutationLease } from "../src/indexer/index-writer-lock";
import { _setAkmIndexForTests } from "../src/indexer/indexer";
import { readLockfile, writeLockfile } from "../src/integrations/lockfile";
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
let testCacheDir = "";

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  testCacheDir = cacheResult.dir;
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

describe("akm bundle update — destructive-branch confirmation gate (F1/R-058)", () => {
  test("resolved content dir MOVES, non-interactive, no --yes: BLOCKED, old root untouched", async () => {
    const oldRoot = createTmpDir("akm-update-confirm-old-");
    const newRoot = createTmpDir("akm-update-confirm-new-");
    fs.writeFileSync(path.join(oldRoot, "marker.txt"), "old content");
    configureManagedBundle("left-pad", oldRoot);

    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "left-pad",
      source: "npm",
      ref: "npm:left-pad",
      artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      resolvedVersion: "1.3.0",
      contentDir: newRoot,
      cacheDir: testCacheDir,
      extractedDir: newRoot,
      integrity: "sha512-fake",
      syncedAt: new Date().toISOString(),
      writable: false,
    });

    try {
      await withTTY(false, async () => {
        await expect(akmUpdate({ target: "left-pad", stashDir })).rejects.toMatchObject({
          code: "NON_INTERACTIVE_REQUIRES_YES",
        });
      });
    } finally {
      syncSpy.mockRestore();
    }

    // The gate must fire BEFORE cleanup: the old directory is still there.
    expect(fs.existsSync(path.join(oldRoot, "marker.txt"))).toBe(true);
    expect(loadConfig().bundles?.["left-pad"]?.npm).toBe("left-pad");
    expect(readLockfile().find((e) => e.id === "left-pad")?.localRoot).toBe(oldRoot);
  });

  test("resolved content dir MOVES, --yes passed: proceeds and deletes the old root", async () => {
    const oldRoot = createTmpDir("akm-update-confirm-old-");
    const newRoot = createTmpDir("akm-update-confirm-new-");
    fs.writeFileSync(path.join(oldRoot, "marker.txt"), "old content");
    configureManagedBundle("left-pad", oldRoot);

    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "left-pad",
      source: "npm",
      ref: "npm:left-pad",
      artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      resolvedVersion: "1.3.0",
      contentDir: newRoot,
      cacheDir: testCacheDir,
      extractedDir: newRoot,
      integrity: "sha512-fake",
      syncedAt: new Date().toISOString(),
      writable: false,
    });

    let result: Awaited<ReturnType<typeof akmUpdate>>;
    try {
      result = await withTTY(false, () => akmUpdate({ target: "left-pad", stashDir, yes: true }));
    } finally {
      syncSpy.mockRestore();
    }

    expect(result.processed).toHaveLength(1);
    expect(readLockfile().find((e) => e.id === "left-pad")?.localRoot).toBe(newRoot);
    // The confirmed deletion actually ran.
    expect(fs.existsSync(oldRoot)).toBe(false);
  });

  test("normal refresh (resolved content dir UNCHANGED) needs no --yes and prompts nothing", async () => {
    const root = createTmpDir("akm-update-confirm-stable-");
    fs.writeFileSync(path.join(root, "marker.txt"), "stable content");
    configureManagedBundle("left-pad", root);

    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "left-pad",
      source: "npm",
      ref: "npm:left-pad",
      artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      resolvedVersion: "1.3.0",
      contentDir: root,
      cacheDir: testCacheDir,
      extractedDir: root,
      integrity: "sha512-fake",
      syncedAt: new Date().toISOString(),
      writable: false,
    });

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
    // The (only) directory in play was never touched by any cleanup path.
    expect(fs.existsSync(path.join(root, "marker.txt"))).toBe(true);
  });

  test("holds the reentrant asset mutation lease while publishing and reindexing", async () => {
    const root = createTmpDir("akm-update-lease-");
    configureManagedBundle("left-pad", root);
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "left-pad",
      source: "npm",
      ref: "npm:left-pad",
      artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      resolvedVersion: "1.3.0",
      contentDir: root,
      cacheDir: testCacheDir,
      extractedDir: root,
      syncedAt: new Date().toISOString(),
      writable: false,
    });
    let leaseState: ReturnType<typeof probeAssetMutationLease>["state"] | undefined;
    overrideSeam(_setAkmIndexForTests, async () => {
      leaseState = probeAssetMutationLease().state;
      return {
        schemaVersion: 1,
        stashDir,
        mode: "incremental",
        totalEntries: 0,
        sourcesScanned: 0,
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
    const newRoot = createTmpDir("akm-update-shared-new-");
    fs.writeFileSync(path.join(oldRoot, "marker.txt"), "shared content");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        "left-pad": { npm: "left-pad" },
        shared: { path: oldRoot, components: { main: { root: ".", adapter: "akm" } } },
      },
    });
    seedLockEntries([{ id: "left-pad", source: "npm", ref: "npm:left-pad", localRoot: oldRoot }]);
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "left-pad",
      source: "npm",
      ref: "npm:left-pad",
      artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      resolvedVersion: "1.3.0",
      contentDir: newRoot,
      cacheDir: testCacheDir,
      extractedDir: newRoot,
      syncedAt: new Date().toISOString(),
      writable: false,
    });

    try {
      await akmUpdate({ target: "left-pad", stashDir, yes: true });
    } finally {
      syncSpy.mockRestore();
    }
    expect(fs.existsSync(path.join(oldRoot, "marker.txt"))).toBe(true);
  });

  test("skips old-root deletion when another configured bundle is nested beneath it", async () => {
    const oldRoot = createTmpDir("akm-update-nested-old-");
    const newRoot = createTmpDir("akm-update-nested-new-");
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
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "left-pad",
      source: "npm",
      ref: "npm:left-pad",
      artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      resolvedVersion: "1.3.0",
      contentDir: newRoot,
      cacheDir: testCacheDir,
      extractedDir: newRoot,
      syncedAt: new Date().toISOString(),
      writable: false,
    });

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
      const newRoot = createTmpDir("akm-update-symlink-new-");
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
      const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
        id: "left-pad",
        source: "npm",
        ref: "npm:left-pad",
        artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
        resolvedVersion: "1.3.0",
        contentDir: newRoot,
        cacheDir: testCacheDir,
        extractedDir: newRoot,
        syncedAt: new Date().toISOString(),
        writable: false,
      });

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
    const root = createTmpDir("akm-update-disabled-managed-");
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
    seedLockEntries([{ id: "left-pad", source: "npm", ref: "npm:left-pad", localRoot: root }]);
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "left-pad",
      source: "npm",
      ref: "npm:left-pad@2.0.0",
      artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-2.0.0.tgz",
      resolvedVersion: "2.0.0",
      contentDir: root,
      cacheDir: testCacheDir,
      extractedDir: root,
      syncedAt: new Date().toISOString(),
      writable: false,
    });

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

  test("reindex failure restores the prior lock generation and retains both roots", async () => {
    const oldRoot = createTmpDir("akm-update-compensate-old-");
    const newRoot = createTmpDir("akm-update-compensate-new-");
    fs.writeFileSync(path.join(oldRoot, "marker.txt"), "old content");
    fs.writeFileSync(path.join(newRoot, "marker.txt"), "new content");
    configureManagedBundle("left-pad", oldRoot);

    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "left-pad",
      source: "npm",
      ref: "npm:left-pad",
      artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      resolvedVersion: "1.3.0",
      contentDir: newRoot,
      cacheDir: testCacheDir,
      extractedDir: newRoot,
      integrity: "sha512-fake",
      syncedAt: new Date().toISOString(),
      writable: false,
    });
    let indexCalls = 0;
    overrideSeam(_setAkmIndexForTests, async () => {
      indexCalls += 1;
      if (indexCalls === 1) throw new Error("publish index failed");
      return {
        schemaVersion: 1,
        stashDir,
        mode: "incremental",
        totalEntries: 0,
        sourcesScanned: 0,
      } as never;
    });

    try {
      await expect(akmUpdate({ target: "left-pad", stashDir, yes: true })).rejects.toThrow(/publish index failed/);
    } finally {
      syncSpy.mockRestore();
    }

    expect(indexCalls).toBe(1);
    expect(readLockfile().find((e) => e.id === "left-pad")?.localRoot).toBe(oldRoot);
    expect(loadConfig().bundles?.["left-pad"]?.npm).toBe("left-pad");
    expect(fs.existsSync(oldRoot)).toBe(true);
    expect(fs.existsSync(newRoot)).toBe(true);
  });

  test("fault after lock publication restores the prior lock and leaves desired config unchanged", async () => {
    const oldRoot = createTmpDir("akm-update-lock-only-old-");
    const newRoot = createTmpDir("akm-update-lock-only-new-");
    fs.writeFileSync(path.join(oldRoot, "marker.txt"), "old content");
    fs.writeFileSync(path.join(newRoot, "marker.txt"), "new content");
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
    seedLockEntries([{ id: "left-pad", source: "npm", ref: "npm:left-pad", localRoot: oldRoot }]);
    const oldConfig = loadConfig();
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "left-pad",
      source: "npm",
      ref: "npm:left-pad",
      artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-2.0.0.tgz",
      resolvedVersion: "2.0.0",
      contentDir: newRoot,
      cacheDir: testCacheDir,
      extractedDir: newRoot,
      syncedAt: new Date().toISOString(),
      writable: false,
    });
    overrideSeam(_setAkmIndexForTests, async () => {
      throw new Error("crash after lock publication");
    });

    try {
      await expect(akmUpdate({ target: "left-pad", stashDir, yes: true })).rejects.toThrow(
        /crash after lock publication/,
      );
    } finally {
      syncSpy.mockRestore();
    }

    expect(loadConfig()).toEqual(oldConfig);
    expect(readLockfile().find((entry) => entry.id === "left-pad")?.localRoot).toBe(oldRoot);
    expect(fs.existsSync(oldRoot)).toBe(true);
    expect(fs.existsSync(newRoot)).toBe(true);
  });

  test("concurrent lock generation after reindex preserves that generation and deletes neither root", async () => {
    const oldRoot = createTmpDir("akm-update-lock-race-old-");
    const newRoot = createTmpDir("akm-update-lock-race-new-");
    const thirdRoot = createTmpDir("akm-update-lock-race-third-");
    fs.writeFileSync(path.join(oldRoot, "marker.txt"), "old content");
    fs.writeFileSync(path.join(newRoot, "marker.txt"), "new content");
    configureManagedBundle("left-pad", oldRoot);
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "left-pad",
      source: "npm",
      ref: "npm:left-pad",
      artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-2.0.0.tgz",
      resolvedVersion: "2.0.0",
      contentDir: newRoot,
      cacheDir: testCacheDir,
      extractedDir: newRoot,
      syncedAt: new Date().toISOString(),
      writable: false,
    });
    overrideSeam(_setAkmIndexForTests, async () => {
      await writeLockfile([{ id: "left-pad", source: "npm", ref: "npm:left-pad", localRoot: thirdRoot }]);
      return {
        schemaVersion: 1,
        stashDir,
        mode: "incremental",
        totalEntries: 0,
        sourcesScanned: 0,
      } as never;
    });

    try {
      await expect(akmUpdate({ target: "left-pad", stashDir, yes: true })).rejects.toThrow(/changed concurrently/);
    } finally {
      syncSpy.mockRestore();
    }

    expect(readLockfile().find((entry) => entry.id === "left-pad")?.localRoot).toBe(thirdRoot);
    expect(fs.existsSync(oldRoot)).toBe(true);
    expect(fs.existsSync(newRoot)).toBe(true);
  });

  test("concurrent config mutation is preserved while a failed update restores its prior lock", async () => {
    const oldRoot = createTmpDir("akm-update-concurrent-old-");
    const newRoot = createTmpDir("akm-update-concurrent-new-");
    fs.writeFileSync(path.join(oldRoot, "marker.txt"), "old content");
    fs.writeFileSync(path.join(newRoot, "marker.txt"), "new content");
    configureManagedBundle("left-pad", oldRoot);
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "left-pad",
      source: "npm",
      ref: "npm:left-pad",
      artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      resolvedVersion: "1.3.0",
      contentDir: newRoot,
      cacheDir: testCacheDir,
      extractedDir: newRoot,
      syncedAt: new Date().toISOString(),
      writable: false,
    });
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point !== "audited") return;
      const concurrent = loadConfig();
      saveConfig({
        ...concurrent,
        bundles: { ...concurrent.bundles, concurrent: { path: oldRoot } },
      });
    });
    overrideSeam(_setAkmIndexForTests, async () => {
      throw new Error("publish index failed");
    });

    try {
      await expect(akmUpdate({ target: "left-pad", stashDir, yes: true })).rejects.toThrow(/publish index failed/);
    } finally {
      syncSpy.mockRestore();
    }

    expect(loadConfig().bundles?.concurrent?.path).toBe(oldRoot);
    expect(loadConfig().bundles?.["left-pad"]?.npm).toBe("left-pad");
    expect(readLockfile().find((e) => e.id === "left-pad")?.localRoot).toBe(oldRoot);
    expect(fs.existsSync(oldRoot)).toBe(true);
    expect(fs.existsSync(newRoot)).toBe(true);
  });

  test("failed reindex restores the prior lock and retains both roots", async () => {
    const oldRoot = createTmpDir("akm-update-degraded-old-");
    const newRoot = createTmpDir("akm-update-degraded-new-");
    fs.writeFileSync(path.join(oldRoot, "marker.txt"), "old content");
    fs.writeFileSync(path.join(newRoot, "marker.txt"), "new content");
    configureManagedBundle("left-pad", oldRoot);
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "left-pad",
      source: "npm",
      ref: "npm:left-pad",
      artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      resolvedVersion: "1.3.0",
      contentDir: newRoot,
      cacheDir: testCacheDir,
      extractedDir: newRoot,
      syncedAt: new Date().toISOString(),
      writable: false,
    });
    overrideSeam(_setAkmIndexForTests, async () => {
      throw new Error("index unavailable");
    });

    try {
      await expect(akmUpdate({ target: "left-pad", stashDir, yes: true })).rejects.toThrow(/index unavailable/);
    } finally {
      syncSpy.mockRestore();
    }

    expect(readLockfile().find((e) => e.id === "left-pad")?.localRoot).toBe(oldRoot);
    expect(fs.existsSync(oldRoot)).toBe(true);
    expect(fs.existsSync(newRoot)).toBe(true);
  });
});
