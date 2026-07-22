// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm bundle list/show/items` — the 0.9.0 CLI convergence read surface over the
 * `bundles`/`defaultBundle` config (spec §10.1), the resolved lock state (spec
 * §10.2), and the persisted index (`bundle_id` provenance). Exercises both the
 * pure logic functions and the wired citty commands in-process (sandboxed XDG,
 * no live network).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmBundleItems, akmBundleList, akmBundleShow } from "../../src/commands/bundle/bundle";
import { resetConfigCache } from "../../src/core/config/config";
import { AkmError } from "../../src/core/errors";
import { getDbPath } from "../../src/core/paths";
import type { IndexDocument } from "../../src/indexer/passes/metadata";
import { writeLockfile } from "../../src/integrations/lockfile";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import type { EntryProvenance } from "../../src/storage/repositories/index-entry-types";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
});

afterEach(() => {
  storage.cleanup();
  resetConfigCache();
});

/** Write a 0.9.0 bundles config and drop the config cache so it re-reads. */
function writeBundlesConfig(bundles: Record<string, unknown>, defaultBundle?: string): void {
  writeSandboxConfig({ bundles, ...(defaultBundle ? { defaultBundle } : {}) });
  resetConfigCache();
}

/** Insert an indexed row with `bundle_id`/`concept_id` provenance for a bundle. */
function indexItem(bundleId: string, type: string, name: string): void {
  const conceptId = `${type}s/${name}`;
  const provenance: EntryProvenance = {
    itemRef: `${bundleId}//${conceptId}`,
    bundleId,
    componentId: bundleId,
    conceptId,
    adapterId: "akm",
  };
  const entry: IndexDocument = { type, name, description: `${type} ${name}`, tags: [] };
  const db = openIndexDatabase(getDbPath());
  try {
    upsertEntry(
      db,
      `${bundleId}:${type}:${name}`,
      "/fake/dir",
      `/fake/dir/${name}`,
      storage.stashDir,
      entry,
      name,
      provenance,
    );
  } finally {
    closeDatabase(db);
  }
}

describe("akmBundleList", () => {
  test("reports an empty list with a migration note when no bundles are configured", () => {
    const result = akmBundleList();
    expect(result.bundles).toEqual([]);
    expect(result.totalBundles).toBe(0);
    expect(result.defaultBundle).toBeNull();
    expect(result.note).toMatch(/migrate apply/);
  });

  test("lists configured bundles, marks defaultBundle, and describes each source kind", () => {
    writeBundlesConfig(
      {
        primary: { path: "/home/u/akm", writable: true },
        catalog: { git: "https://example.test/catalog.git" },
        docs: { website: { url: "https://example.test/docs/", maxPages: 25 } },
        pkg: { npm: "@scope/stash" },
      },
      "primary",
    );

    const result = akmBundleList();
    expect(result.totalBundles).toBe(4);
    expect(result.defaultBundle).toBe("primary");
    expect(result.note).toBeUndefined();

    const byId = new Map(result.bundles.map((b) => [b.id, b]));
    expect(byId.get("primary")).toMatchObject({
      default: true,
      writable: true,
      source: { kind: "path", locator: "/home/u/akm" },
    });
    expect(byId.get("catalog")).toMatchObject({
      default: false,
      source: { kind: "git", locator: "https://example.test/catalog.git" },
    });
    expect(byId.get("docs")?.source).toEqual({
      kind: "website",
      locator: "https://example.test/docs/",
      maxPages: 25,
    });
    expect(byId.get("pkg")?.source).toEqual({ kind: "npm", locator: "@scope/stash" });
    // No lockfile written yet — lock is null, never undefined.
    for (const b of result.bundles) expect(b.lock).toBeNull();
  });

  test("joins resolved lock state by bundle id (spec §10.2)", async () => {
    writeBundlesConfig({ catalog: { git: "https://example.test/catalog.git" } }, "catalog");
    await writeLockfile([
      {
        id: "catalog",
        source: "git",
        ref: "git:https://example.test/catalog.git",
        resolvedRevision: "abc123",
        localRoot: "/cache/catalog",
        installedAt: "2026-07-20T00:00:00Z",
        adapterIds: ["akm"],
      },
    ]);
    resetConfigCache();

    const result = akmBundleList();
    const catalog = result.bundles.find((b) => b.id === "catalog");
    expect(catalog?.lock).toMatchObject({
      source: "git",
      resolvedRevision: "abc123",
      localRoot: "/cache/catalog",
      installedAt: "2026-07-20T00:00:00Z",
      adapterIds: ["akm"],
    });
  });
});

describe("akmBundleShow", () => {
  test("throws not-found (exit-1 class) for an unknown bundle", () => {
    writeBundlesConfig({ primary: { path: "/home/u/akm" } }, "primary");
    try {
      akmBundleShow({ id: "nope" });
      throw new Error("expected akmBundleShow to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AkmError);
      expect((err as AkmError).kind).toBe("not-found");
    }
  });

  test("throws usage error for a blank bundle id", () => {
    writeBundlesConfig({ primary: { path: "/home/u/akm" } }, "primary");
    try {
      akmBundleShow({ id: "  " });
      throw new Error("expected akmBundleShow to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AkmError);
      expect((err as AkmError).kind).toBe("usage");
    }
  });

  test("returns the source, writable flag, components, and indexed item count", () => {
    writeBundlesConfig(
      {
        primary: {
          path: "/home/u/akm",
          writable: true,
          components: { main: { root: ".", adapter: "akm" } },
        },
      },
      "primary",
    );
    indexItem("primary", "skill", "code-review");
    indexItem("primary", "knowledge", "http-caching");

    const result = akmBundleShow({ id: "primary" });
    expect(result).toMatchObject({
      id: "primary",
      default: true,
      writable: true,
      source: { kind: "path", locator: "/home/u/akm" },
      itemCount: 2,
    });
    expect(result.components).toEqual([{ name: "main", root: ".", adapter: "akm" }]);
  });
});

describe("akmBundleItems", () => {
  test("throws not-found for an unknown bundle", () => {
    writeBundlesConfig({ primary: { path: "/home/u/akm" } }, "primary");
    expect(() => akmBundleItems({ id: "ghost" })).toThrow(AkmError);
  });

  test("lists only the target bundle's items, keyed by canonical ref, with per-type counts", () => {
    writeBundlesConfig({ primary: { path: "/home/u/akm" }, catalog: { git: "https://example.test/c.git" } }, "primary");
    indexItem("primary", "skill", "code-review");
    indexItem("primary", "skill", "deploy");
    indexItem("primary", "knowledge", "http-caching");
    indexItem("catalog", "skill", "other");

    const result = akmBundleItems({ id: "primary" });
    expect(result.bundle).toBe("primary");
    expect(result.totalItems).toBe(3);
    expect(result.byType).toEqual({ knowledge: 1, skill: 2 });
    // Canonical bundle//conceptId refs; deterministic (type, then conceptId) order.
    expect(result.items.map((i) => i.ref)).toEqual([
      "primary//knowledges/http-caching",
      "primary//skills/code-review",
      "primary//skills/deploy",
    ]);
    // The catalog item never leaks into primary's listing.
    expect(result.items.some((i) => i.name === "other")).toBe(false);
  });

  test("returns an empty item list (no throw) when the index has not been built", () => {
    writeBundlesConfig({ primary: { path: "/home/u/akm" } }, "primary");
    const result = akmBundleItems({ id: "primary" });
    expect(result.items).toEqual([]);
    expect(result.totalItems).toBe(0);
    expect(result.byType).toEqual({});
  });
});

describe("akm bundle (CLI wiring, --format parity)", () => {
  test("`bundle list` emits a valid JSON envelope (exit 0)", async () => {
    writeBundlesConfig({ primary: { path: "/home/u/akm", writable: true } }, "primary");
    const res = await runCliCapture(["bundle", "list", "--format", "json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.totalBundles).toBe(1);
    expect(parsed.bundles[0].id).toBe("primary");
    expect(parsed.shape).toBe("bundle-list");
  });

  test("bare `bundle` defaults to the list view", async () => {
    writeBundlesConfig({ primary: { path: "/home/u/akm" } }, "primary");
    // Bare group invocation: default --format is json (config output.format). The
    // `--format json` space-form is NOT used here — citty mis-parses a
    // space-separated flag value on a group command as a subcommand token (same
    // behavior as the existing `akm graph` group); `--format=json` is the form
    // that works on the bare group.
    const res = await runCliCapture(["bundle", "--format=json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.defaultBundle).toBe("primary");
    expect(parsed.shape).toBe("bundle-list");
  });

  test("`bundle show <id>` returns the bundle over both json and text (exit 0)", async () => {
    writeBundlesConfig({ primary: { path: "/home/u/akm" } }, "primary");
    const json = await runCliCapture(["bundle", "show", "primary", "--format", "json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout).id).toBe("primary");
    // No dedicated text renderer for this read command — `--format text` falls
    // back to the JSON envelope (still valid, still exit 0). --format parity is
    // the json contract; the text fallback must not error.
    const text = await runCliCapture(["bundle", "show", "primary", "--format", "text"]);
    expect(text.code).toBe(0);
    expect(JSON.parse(text.stdout).id).toBe("primary");
  });

  test("`bundle show <unknown>` exits 1 (not found)", async () => {
    writeBundlesConfig({ primary: { path: "/home/u/akm" } }, "primary");
    const res = await runCliCapture(["bundle", "show", "missing"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("No bundle named");
  });

  test("`bundle show` with no id exits 2 (usage)", async () => {
    writeBundlesConfig({ primary: { path: "/home/u/akm" } }, "primary");
    const res = await runCliCapture(["bundle", "show"]);
    expect(res.code).toBe(2);
  });

  test("`bundle items <id>` lists indexed items (exit 0)", async () => {
    writeBundlesConfig({ primary: { path: "/home/u/akm" } }, "primary");
    indexItem("primary", "skill", "code-review");
    const res = await runCliCapture(["bundle", "items", "primary", "--format", "json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.totalItems).toBe(1);
    expect(parsed.items[0].ref).toBe("primary//skills/code-review");
  });
});
