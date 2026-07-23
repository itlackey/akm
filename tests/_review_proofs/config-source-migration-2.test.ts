import { test, expect, describe } from "bun:test";
import {
  migrateConfigSourcesToBundles,
  oldConfigMigratableSources,
} from "../../src/migrate/legacy/config-source-migration";

describe("config-source-migration: unbuildable primary suppresses stashDir fallback", () => {
  test("BASELINE: stashDir alone migrates to a bundle + defaultBundle (correct)", () => {
    const migrated = migrateConfigSourcesToBundles({
      configVersion: "0.9.0",
      stashDir: "/home/u/akm",
    });
    const bundles = migrated.bundles as Record<string, { path?: string }>;
    const paths = Object.values(bundles).map((b) => b.path);
    // The working stash IS present and IS the default.
    expect(paths).toContain("/home/u/akm");
    expect(migrated.defaultBundle).toBeDefined();
    expect((bundles as Record<string, { path?: string }>)[migrated.defaultBundle as string]?.path).toBe(
      "/home/u/akm",
    );
  });

  test("DEFECT: stashDir + unbuildable primary git source (no url) DROPS the working stash", () => {
    const raw = {
      configVersion: "0.9.0",
      stashDir: "/home/u/akm",
      // Schema-valid 0.8 source: type=git, no url, marked primary.
      sources: [{ type: "git", name: "x", primary: true }],
    };

    // oldConfigMigratableSources yields NOTHING: the malformed primary produces
    // no descriptor, and the stashDir fallback is unreachable because a
    // primaryEntry exists.
    const migratable = oldConfigMigratableSources(raw);
    expect(migratable.length).toBe(0);

    const migrated = migrateConfigSourcesToBundles(raw);
    const bundles = migrated.bundles as Record<string, { path?: string }>;
    const paths = Object.values(bundles).map((b) => b.path);

    // The real working stash /home/u/akm has vanished from bundles...
    expect(paths).not.toContain("/home/u/akm");
    // ...bundles is empty...
    expect(Object.keys(bundles).length).toBe(0);
    // ...and there is no defaultBundle, so readStashDirFromConfig() returns
    // undefined post-migration and resolveStashDir falls to the platform default.
    expect(migrated.defaultBundle).toBeUndefined();

    // And the old keys are gone, so the stash reference is unrecoverable from the
    // migrated config itself (only the pre-migration backup still holds it).
    expect("stashDir" in migrated).toBe(false);
    expect("sources" in migrated).toBe(false);
  });

  test("DEFECT variant: filesystem primary with no path also drops the stash", () => {
    const raw = {
      configVersion: "0.9.0",
      stashDir: "/home/u/akm",
      sources: [{ type: "filesystem", primary: true }],
    };
    const migrated = migrateConfigSourcesToBundles(raw);
    const bundles = migrated.bundles as Record<string, { path?: string }>;
    expect(Object.values(bundles).map((b) => b.path)).not.toContain("/home/u/akm");
    expect(migrated.defaultBundle).toBeUndefined();
  });

  test("CONTRAST: a WELL-FORMED primary git source (with url) migrates fine — proves the drop is caused by unbuildability, not by the presence of a primary source", () => {
    const raw = {
      configVersion: "0.9.0",
      stashDir: "/home/u/akm",
      sources: [{ type: "git", name: "x", url: "https://example.com/x.git", primary: true }],
    };
    const migrated = migrateConfigSourcesToBundles(raw);
    const bundles = migrated.bundles as Record<string, { git?: string }>;
    // A well-formed primary DOES produce a bundle and a defaultBundle.
    expect(Object.keys(bundles).length).toBeGreaterThan(0);
    expect(migrated.defaultBundle).toBeDefined();
  });
});
