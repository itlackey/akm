// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `updateManagedInstall` (installed-stashes.ts) prunes the install's older
 * `<rev>` directories when the resolved content directory (`synced.contentDir`)
 * differs from the locked one, the source isn't "local", and the install isn't
 * writable. Read-only git and npm installs are keyed per resolved revision, so
 * that happens on every upstream change. The immediately previous revision is
 * kept (#1235).
 *
 * F1/R-058 once put a `confirmDestructive` gate on that branch, which made
 * every real non-interactive update fail with NON_INTERACTIVE_REQUIRES_YES
 * (#1096). The directories are a re-fetchable cache, and one still referenced
 * by another bundle or lock entry is kept, so the gate was removed. These tests
 * pin that the pruning never prompts, that it runs, and that a referenced
 * directory survives.
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

// Env/temp-dir isolation goes through the sandbox helpers rather than raw
// mkdtempSync + process.env writes — the helpers restore a previously
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

/** The install directory holding one `<rev>` directory per revision. */
function installDir(): string {
  return path.join(getRegistryCacheDir(), "npm-left-pad");
}

/** Where an update publishes the staged left-pad content. */
function liveContentDir(): string {
  return path.join(installDir(), "1.3.0", "content");
}

/** Mock `syncFromRef` to fetch left-pad into the update's staging cache root, as the npm provider does. */
function mockStagedSync(opts: { ref?: string; version?: string } = {}): ReturnType<typeof spyOn> {
  return spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) => {
    if (!options?.cacheRootDir) throw new Error("update did not provide a staging cache root");
    const cacheDir = path.join(options.cacheRootDir, "npm-left-pad", "1.3.0");
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

describe("akm bundle update — a moved content directory never prompts (#1096)", () => {
  test("resolved content dir MOVES, non-interactive, no --yes: succeeds and keeps the previous root", async () => {
    const oldRoot = createTmpDir("akm-update-confirm-old-");
    fs.writeFileSync(path.join(oldRoot, "marker.txt"), "old content");
    configureManagedBundle("left-pad", oldRoot);

    const syncSpy = mockStagedSync();
    let result: Awaited<ReturnType<typeof akmUpdate>>;
    try {
      // No TTY and no --yes: a scheduled `bundle update --all` must not fail
      // with NON_INTERACTIVE_REQUIRES_YES on an ordinary upstream change.
      result = await withTTY(false, () => akmUpdate({ target: "left-pad", stashDir }));
    } finally {
      syncSpy.mockRestore();
    }

    expect(result.processed).toHaveLength(1);
    expect(loadConfig().bundles?.["left-pad"]?.npm).toBe("left-pad");
    expect(readLockfile().find((e) => e.id === "left-pad")?.localRoot).toBe(liveContentDir());
    expect(fs.readFileSync(path.join(liveContentDir(), "marker.txt"), "utf8")).toBe("new content");
    expect(fs.existsSync(oldRoot)).toBe(true);
  });

  test("normal refresh (resolved content dir UNCHANGED) never prompts and keeps its directory", async () => {
    const root = liveContentDir();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "marker.txt"), "stable content");
    configureManagedBundle("left-pad", root);

    const syncSpy = mockStagedSync();
    let result: Awaited<ReturnType<typeof akmUpdate>>;
    try {
      // Non-interactive: must NOT throw, and nothing is deleted because the
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

  /**
   * Lay out three revisions of left-pad (the lock names 1.0.0, the previous
   * one), let `referenceOlder` make another bundle use the oldest, update, and
   * return the install's surviving `<rev>` directories plus the oldest's marker.
   */
  async function updateWithReferencedOlderRevision(
    referenceOlder: (olderDir: string) => Record<string, unknown>,
  ): Promise<{ revisions: string[]; olderMarker: string }> {
    const olderDir = path.join(installDir(), "0.8.0");
    const previousRoot = path.join(installDir(), "1.0.0", "content");
    fs.mkdirSync(olderDir, { recursive: true });
    fs.mkdirSync(path.join(installDir(), "0.9.0"), { recursive: true });
    fs.mkdirSync(previousRoot, { recursive: true });
    const olderMarker = path.join(olderDir, "marker.txt");
    fs.writeFileSync(olderMarker, "user content");
    saveConfig({
      semanticSearchMode: "off",
      bundles: { "left-pad": { npm: "left-pad" }, shared: referenceOlder(olderDir) },
    });
    seedLockEntries([{ id: "left-pad", source: "npm", ref: "npm:left-pad", localRoot: previousRoot }]);
    const syncSpy = mockStagedSync();
    try {
      await akmUpdate({ target: "left-pad", stashDir });
    } finally {
      syncSpy.mockRestore();
    }
    return { revisions: fs.readdirSync(installDir()).sort(), olderMarker };
  }

  test("prunes older revisions but keeps the previous one and any another configured bundle references", async () => {
    const { revisions, olderMarker } = await updateWithReferencedOlderRevision((olderDir) => ({
      path: olderDir,
      components: { main: { root: ".", adapter: "akm" } },
    }));
    expect(revisions).toEqual(["0.8.0", "1.0.0", "1.3.0"]);
    expect(fs.readFileSync(olderMarker, "utf8")).toBe("user content");
  });

  test("keeps an older revision when another configured bundle is nested beneath it", async () => {
    const { revisions, olderMarker } = await updateWithReferencedOlderRevision((olderDir) => {
      const nestedRoot = path.join(olderDir, "..notes");
      fs.mkdirSync(nestedRoot);
      return { path: nestedRoot };
    });
    expect(revisions).toEqual(["0.8.0", "1.0.0", "1.3.0"]);
    expect(fs.readFileSync(olderMarker, "utf8")).toBe("user content");
  });

  test.skipIf(process.platform === "win32")(
    "keeps an older revision when a configured source is a nested symlink",
    async () => {
      const externalRoot = createTmpDir("akm-update-symlink-external-");
      const { revisions } = await updateWithReferencedOlderRevision((olderDir) => {
        fs.symlinkSync(externalRoot, path.join(olderDir, "linked-notes"), "dir");
        return { path: path.join(olderDir, "linked-notes") };
      });
      expect(revisions).toEqual(["0.8.0", "1.0.0", "1.3.0"]);
      expect(fs.readdirSync(externalRoot)).toEqual([]);
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

  test("a reindex failure after publication keeps the new lock and never prunes an older revision", async () => {
    const oldRoot = createTmpDir("akm-update-index-fail-old-");
    fs.writeFileSync(path.join(oldRoot, "marker.txt"), "old content");
    configureManagedBundle("left-pad", oldRoot);
    const syncSpy = mockStagedSync();
    overrideSeam(_setAkmIndexForTests, async () => {
      throw new Error("index unavailable");
    });

    try {
      await expect(akmUpdate({ target: "left-pad", stashDir })).rejects.toThrow(/index unavailable/);
    } finally {
      syncSpy.mockRestore();
    }

    // Content and lock were published before indexing; the next `akm index`
    // catches up. Older revisions are only pruned after a successful index.
    expect(readLockfile().find((e) => e.id === "left-pad")?.localRoot).toBe(liveContentDir());
    expect(fs.readFileSync(path.join(liveContentDir(), "marker.txt"), "utf8")).toBe("new content");
    expect(fs.readFileSync(path.join(oldRoot, "marker.txt"), "utf8")).toBe("old content");
  });
});
