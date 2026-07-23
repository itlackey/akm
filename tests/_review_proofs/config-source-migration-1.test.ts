// Proof for candidate defect: an installed git/npm bundle's resolved localRoot
// is written ONLY by the best-effort (swallowed try/catch) mergeLockEntriesSync
// in runMigrationApply's cutover-applied block. If that write throws, the
// already-materialized content is silently orphaned: the migrated config for a
// git/npm bundle carries only the LOCATOR (no path), so with no lock entry the
// runtime cannot resolve the content dir. No rollback (post-cutover), and a
// re-run of migrate apply produces no lock entries (config already bundles-shape).
//
// This test drives the REAL producer (migratedLockEntries /
// migrateConfigSourcesToBundles), the REAL runtime mapping
// (bundlesToSourceEntries), the REAL resolver (resolveEntryContentDir /
// lockContentRootFor), and the REAL lock writer (mergeLockEntriesSync).

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bundlesToSourceEntries } from "../../src/core/config/config-sources";
import { resolveEntryContentDir } from "../../src/indexer/search/search-source";
import { lockContentRootFor, mergeLockEntriesSync, readLockfile } from "../../src/integrations/lockfile";
import {
  migrateConfigSourcesToBundles,
  migratedLockEntries,
} from "../../src/migrate/legacy/config-source-migration";
import { getLockfilePath } from "../../src/core/paths";
// Ensure the git source provider self-registers so the fallback path is the
// real provider-derived git cache path (not merely `undefined`).
import "../../src/sources/providers/git-provider";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => storage.cleanup());

/** Build a realistic 0.8.x old-shape config with one installed git entry whose
 * content is already materialized on disk at `stashRoot`. */
function buildOldConfigAndContent() {
  const resolvedRoot = path.join(storage.root, "installed-cache", "repo");
  fs.mkdirSync(resolvedRoot, { recursive: true });
  // Curated content the user holds locally (only reachable via the lock localRoot).
  fs.writeFileSync(path.join(resolvedRoot, "curated.md"), "# curated knowledge\n");

  const oldConfig: Record<string, unknown> = {
    configVersion: "0.8.5",
    installed: [
      {
        id: "git:https://github.com/owner/repo",
        source: "git",
        ref: "https://github.com/owner/repo.git",
        stashRoot: resolvedRoot,
        writable: false,
      },
    ],
  };
  return { oldConfig, resolvedRoot };
}

describe("migrate apply: swallowed lock-write orphans git/npm bundle content", () => {
  test("the git bundle's resolved root lives ONLY in the lock; config is locator-only", () => {
    const { oldConfig, resolvedRoot } = buildOldConfigAndContent();

    const migrated = migrateConfigSourcesToBundles(oldConfig);
    const bundles = (migrated.bundles as Record<string, Record<string, unknown>>) ?? {};
    const keys = Object.keys(bundles);
    expect(keys.length).toBe(1);
    const bundleKey = keys[0]!;

    // The migrated bundle descriptor is a git LOCATOR — it does NOT carry the
    // materialized cache root. So the config alone cannot reach `resolvedRoot`.
    expect(bundles[bundleKey]!.git).toBe("https://github.com/owner/repo.git");
    expect(bundles[bundleKey]!.path).toBeUndefined();

    // The resolved root is emitted SOLELY into the lock entry (same derived id).
    const lockEntries = migratedLockEntries(oldConfig);
    expect(lockEntries.length).toBe(1);
    expect(lockEntries[0]!.id).toBe(bundleKey);
    expect(lockEntries[0]!.localRoot).toBe(resolvedRoot);
  });

  test("mergeLockEntriesSync CAN throw (the swallowed catch in config-migrate is a live path)", () => {
    const { oldConfig } = buildOldConfigAndContent();
    const lockEntries = migratedLockEntries(oldConfig);

    // Simulate a lockfile write failure: make the lockfile path itself a
    // (non-empty) directory so the atomic rename onto it fails (EISDIR/ENOTEMPTY).
    const lockPath = getLockfilePath();
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "blocker"), "x");

    // config-migrate.ts wraps EXACTLY this call in `try { ... } catch { /* swallow */ }`.
    expect(() => mergeLockEntriesSync(lockEntries)).toThrow();
  });

  test("swallowed lock write => content orphaned; successful write => content reachable", () => {
    const { oldConfig, resolvedRoot } = buildOldConfigAndContent();

    const migrated = migrateConfigSourcesToBundles(oldConfig);
    const lockEntries = migratedLockEntries(oldConfig);

    // Runtime mapping the indexer/read path uses: bundles -> SourceConfigEntry[].
    const runtimeEntries = bundlesToSourceEntries({ bundles: migrated.bundles } as never)!;
    const gitEntry = runtimeEntries.find((e) => e.type === "git")!;
    expect(gitEntry).toBeDefined();

    // ── Case A: the lock write SUCCEEDED (happy path) ──────────────────────────
    mergeLockEntriesSync(lockEntries);
    expect(lockContentRootFor(gitEntry.name, "git")).toBe(resolvedRoot);
    const dirWithLock = resolveEntryContentDir(gitEntry);
    expect(dirWithLock).toBe(resolvedRoot); // content reachable

    // ── Case B: the lock write was SWALLOWED (the failure state migrate commits) ─
    // Delete the lock to reproduce the exact post-migration state after the empty
    // catch swallows the throw: config committed (bundles), no lock entry.
    fs.rmSync(getLockfilePath(), { force: true });
    expect(readLockfile()).toEqual([]);
    expect(lockContentRootFor(gitEntry.name, "git")).toBeUndefined();

    const dirNoLock = resolveEntryContentDir(gitEntry);
    // The user's materialized content at resolvedRoot is now unreachable: the
    // resolver falls back to the provider-derived git cache mirror (a DIFFERENT,
    // empty directory) or undefined. Either way it is NOT resolvedRoot.
    expect(dirNoLock).not.toBe(resolvedRoot);

    // And the orphaned content still physically exists on disk (silently lost,
    // not deleted) — recovery would need a network re-clone, impossible offline.
    expect(fs.existsSync(path.join(resolvedRoot, "curated.md"))).toBe(true);

    // Re-running the config migration over the now-committed (bundles-shape)
    // config produces NO lock entries — so `migrate apply` cannot backfill it.
    expect(migratedLockEntries(migrated)).toEqual([]);
  });
});
