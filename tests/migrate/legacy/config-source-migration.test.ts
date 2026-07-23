// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-8.4 — the config-shape migration (`stashDir`/`sources[]`/`installed[]` →
 * `bundles`/`defaultBundle`). The load-bearing assertion is the D-R5
 * no-identity-shift proof: the emitted bundle KEYS equal a direct
 * `deriveInstallations` run over the same pre-cutover source list.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { registerBuiltinAdapters } from "../../../src/core/adapter/adapters";
import { resetAdapterRegistryForTests } from "../../../src/core/adapter/registry";
import { validateConfigShape } from "../../../src/core/config/config-schema";
import { bundleEntryToSourceEntry, installedSourceDescriptor } from "../../../src/core/config/config-sources";
import { deriveInstallations } from "../../../src/indexer/installations";
import {
  hasOldSourceShape,
  migrateConfigSourcesToBundles,
  migratedLockEntries,
  oldConfigToSearchSources,
} from "../../../src/migrate/legacy/config-source-migration";
import { makeSandboxDir } from "../../_helpers/sandbox";

beforeAll(() => {
  resetAdapterRegistryForTests();
  registerBuiltinAdapters();
});

/** An old-shape config with a stashDir primary, a registryId-named source, and an installed[] entry. */
function oldShapeConfig(): Record<string, unknown> {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "auto",
    stashDir: "/home/u/akm",
    sources: [
      { type: "filesystem", path: "/home/u/team", name: "team", writable: true },
      { type: "git", url: "https://example.test/catalog.git", name: "catalog" },
    ],
    installed: [
      {
        id: "github:owner/repo",
        source: "github",
        ref: "owner/repo",
        artifactUrl: "https://example.test/owner/repo",
        stashRoot: "/cache/repo",
        cacheDir: "/cache",
        installedAt: "2026-01-01T00:00:00Z",
      },
    ],
  };
}

describe("migrateConfigSourcesToBundles", () => {
  test("normalizes install locators into git provider URLs", () => {
    expect(installedSourceDescriptor("github", "github:owner/repo#v1", "/cache/repo")).toEqual({
      git: "https://github.com/owner/repo/tree/v1",
    });
    expect(installedSourceDescriptor("github", "https://github.com/owner/repo", "/cache/repo")).toEqual({
      git: "https://github.com/owner/repo",
    });
    expect(installedSourceDescriptor("git", "git+https://example.test/repo.git", "/cache/repo")).toEqual({
      git: "https://example.test/repo.git",
    });
    expect(bundleEntryToSourceEntry("repo", { git: "github:owner/repo" })).toMatchObject({
      type: "git",
      url: "https://github.com/owner/repo",
    });
  });

  test("emits bundle keys equal to a direct deriveInstallations run (D-R5 no-identity-shift proof)", () => {
    const raw = oldShapeConfig();
    const migrated = migrateConfigSourcesToBundles(raw) as { bundles: Record<string, unknown>; defaultBundle?: string };

    const derivedIds = deriveInstallations(oldConfigToSearchSources(raw)).map((i) => i.id);
    expect(Object.keys(migrated.bundles)).toEqual(derivedIds);

    // Concrete keys: stashDir slug, the two named sources, the slug-legal fallback
    // for the non-slug-legal installed id.
    expect(Object.keys(migrated.bundles)).toEqual(["akm", "team", "catalog", "repo"]);
    // defaultBundle is the primary (stashDir) bundle.
    expect(migrated.defaultBundle).toBe("akm");
  });

  test("emits faithful source descriptors and preserves the non-slug-legal registry id", () => {
    const migrated = migrateConfigSourcesToBundles(oldShapeConfig()) as {
      bundles: Record<string, Record<string, unknown>>;
    };
    expect(migrated.bundles.akm).toEqual({ path: "/home/u/akm", writable: true });
    expect(migrated.bundles.team).toEqual({ path: "/home/u/team", writable: true });
    expect(migrated.bundles.catalog).toEqual({ git: "https://example.test/catalog.git" });
    // WI-8.5 desired/resolved split (spec §10.2): the installed github entry emits
    // its DESIRED git locator (the re-installable ref), NOT the resolved cache
    // root; the original id is preserved. The materialized root belongs in the lock.
    expect(migrated.bundles.repo).toEqual({
      git: "https://github.com/owner/repo",
      registryId: "github:owner/repo",
    });
    // §10.2:453 — an installed bundle's config entry carries NO resolved cache path.
    expect(migrated.bundles.repo!.path).toBeUndefined();
  });

  test("emits §10.2 lock entries for installed git/npm bundles (resolved root out of config)", () => {
    const locks = migratedLockEntries(oldShapeConfig());
    // Only the installed github bundle needs a lock; its localRoot is the resolved
    // cache root, keyed by the SAME derived bundle id as the bundles map ("repo").
    expect(locks).toEqual([{ id: "repo", source: "github", ref: "owner/repo", localRoot: "/cache/repo" }]);
    // No lock entries for an already-migrated or old-shape-free config.
    expect(migratedLockEntries({ configVersion: "0.9.0", bundles: { a: { path: "/s" } } })).toEqual([]);
    expect(migratedLockEntries({ configVersion: "0.9.0", engines: {} })).toEqual([]);
  });

  test("removes the old source keys and the result verifies current", () => {
    const migrated = migrateConfigSourcesToBundles(oldShapeConfig()) as Record<string, unknown>;
    expect(migrated.stashDir).toBeUndefined();
    expect(migrated.sources).toBeUndefined();
    expect(migrated.installed).toBeUndefined();
    expect(hasOldSourceShape(migrated)).toBe(false);
    // Passes the strict 0.9.0 schema (no half-migrated leftovers).
    expect(validateConfigShape(migrated).ok).toBe(true);
  });

  test("website source with a primary marker → defaultBundle + website descriptor", () => {
    const raw = {
      configVersion: "0.9.0",
      sources: [
        { type: "filesystem", path: "/home/u/work", name: "work", primary: true, writable: true },
        { type: "website", url: "https://example.test/docs/", name: "docs", options: { maxPages: 42 } },
      ],
    };
    const migrated = migrateConfigSourcesToBundles(raw) as {
      bundles: Record<string, Record<string, unknown>>;
      defaultBundle?: string;
    };
    expect(Object.keys(migrated.bundles)).toEqual(["work", "docs"]);
    expect(migrated.defaultBundle).toBe("work");
    expect(migrated.bundles.docs).toEqual({ website: { url: "https://example.test/docs/", maxPages: 42 } });
  });

  test("is idempotent: a config with no old source keys (or already migrated) is unchanged", () => {
    const already = { configVersion: "0.9.0", bundles: { a: { path: "/s" } }, defaultBundle: "a" };
    expect(migrateConfigSourcesToBundles(already)).toBe(already);
    const none = { configVersion: "0.9.0", engines: {} };
    expect(migrateConfigSourcesToBundles(none)).toBe(none);
  });

  test("oldConfigToSearchSources resolves derivation paths and preserves priority order", () => {
    const sources = oldConfigToSearchSources(oldShapeConfig());
    expect(sources.map((s) => s.registryId)).toEqual([undefined, "team", "catalog", "github:owner/repo"]);
    expect(sources[0]!.path).toBe(path.resolve("/home/u/akm"));
    expect(sources[0]!.writable).toBe(true);
  });

  test("coalesces duplicate filesystem roots before deriving bundle identity", () => {
    const raw = {
      configVersion: "0.9.0",
      stashDir: "/home/u/work",
      sources: [{ type: "filesystem", path: "/home/u/work", name: "named-work", writable: true }],
    };
    const migrated = migrateConfigSourcesToBundles(raw) as {
      bundles: Record<string, Record<string, unknown>>;
      defaultBundle: string;
    };

    expect(Object.keys(migrated.bundles)).toEqual(["named-work"]);
    expect(migrated.defaultBundle).toBe("named-work");
    expect(migrated.bundles["named-work"]).toEqual({ path: "/home/u/work", writable: true });
  });

  test.skipIf(process.platform === "win32")("coalesces filesystem roots that resolve through a symlink", () => {
    const sandbox = makeSandboxDir("akm-config-source-realpath");
    try {
      const root = path.join(sandbox.dir, "work");
      const alias = path.join(sandbox.dir, "work-alias");
      fs.mkdirSync(root);
      fs.symlinkSync(root, alias, "dir");
      const migrated = migrateConfigSourcesToBundles({
        configVersion: "0.9.0",
        stashDir: root,
        sources: [{ type: "filesystem", path: alias, name: "named-work", writable: true }],
      }) as { bundles: Record<string, unknown>; defaultBundle: string };

      expect(Object.keys(migrated.bundles)).toEqual(["named-work"]);
      expect(migrated.defaultBundle).toBe("named-work");
    } finally {
      sandbox.cleanup();
    }
  });

  test("falls back to stashDir when an explicit primary source has no usable descriptor", () => {
    const migrated = migrateConfigSourcesToBundles({
      configVersion: "0.9.0",
      stashDir: "/custom/non-default/work",
      sources: [{ type: "git", name: "broken-primary", primary: true }],
    }) as {
      bundles: Record<string, Record<string, unknown>>;
      defaultBundle: string;
    };

    expect(migrated.bundles).toEqual({ work: { path: "/custom/non-default/work", writable: true } });
    expect(migrated.defaultBundle).toBe("work");
    expect(validateConfigShape(migrated).ok).toBe(true);
  });

  test("re-keys defaultWriteTarget through the generated bundle id", () => {
    const migrated = migrateConfigSourcesToBundles({
      configVersion: "0.9.0",
      sources: [
        {
          type: "filesystem",
          path: "/home/u/docs",
          name: "my.docs",
          primary: true,
          writable: true,
        },
      ],
      defaultWriteTarget: "my.docs",
    }) as Record<string, unknown>;

    expect(migrated.defaultBundle).toBe("docs");
    expect(migrated.defaultWriteTarget).toBe("docs");
    expect(validateConfigShape(migrated).ok).toBe(true);
  });
});
