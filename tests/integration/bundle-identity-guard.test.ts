// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-8.4 — §11.5 bundle-rename startup guard: warn (never silently re-mint) when
 * a configured bundle id has no indexed rows but the index holds rows under a
 * bundle id that is no longer configured (the hand-rename signature).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { resetBundleIdentityGuardForTests, warnOnBundleRenameDrift } from "../../src/indexer/bundle-identity-guard";
import { type Cleanup, sandboxXdgDataHome } from "../_helpers/sandbox";

let cleanup: Cleanup = () => {};
let warnCalls: string[] = [];

beforeEach(() => {
  cleanup = sandboxXdgDataHome().cleanup;
  warnCalls = [];
  resetBundleIdentityGuardForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnCalls.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  _setWarnSinkForTests(undefined);
  resetBundleIdentityGuardForTests();
  cleanup();
  cleanup = () => {};
});

/** Seed an index.db `entries` table whose rows carry the given bundle prefixes. */
function seedIndexBundles(bundleIds: string[]): void {
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, entry_key TEXT, bundle_id TEXT)");
  const ins = db.prepare("INSERT INTO entries (entry_key, bundle_id) VALUES (?, ?)");
  for (const [i, bundleId] of bundleIds.entries()) ins.run(`k${i}`, bundleId);
  db.close();
}

function bundlesConfig(...ids: string[]): AkmConfig {
  const bundles: Record<string, { path: string }> = {};
  for (const id of ids) bundles[id] = { path: `/s/${id}` };
  return { configVersion: "0.9.0", semanticSearchMode: "auto", bundles } as unknown as AkmConfig;
}

describe("§11.5 bundle-rename startup guard", () => {
  test("warns on the hand-rename signature (configured id missing, unconfigured id indexed)", () => {
    seedIndexBundles(["oldname"]);
    warnOnBundleRenameDrift(bundlesConfig("newname"));
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain("bundle identity drift");
    expect(warnCalls[0]).toContain('"newname"');
    expect(warnCalls[0]).toContain('"oldname"');
  });

  test("stays silent when the configured bundle ids match the indexed prefixes", () => {
    seedIndexBundles(["primary"]);
    warnOnBundleRenameDrift(bundlesConfig("primary"));
    expect(warnCalls).toHaveLength(0);
  });

  test("stays silent when a configured bundle is simply not yet indexed (all index ids configured)", () => {
    // `primary` is indexed and configured; `extra` is configured but unindexed —
    // no UNCONFIGURED indexed id, so this is a fresh bundle, not a rename.
    seedIndexBundles(["primary"]);
    warnOnBundleRenameDrift(bundlesConfig("primary", "extra"));
    expect(warnCalls).toHaveLength(0);
  });

  test("no-op for an old-shape config (no bundles) and for an absent index", () => {
    seedIndexBundles(["oldname"]);
    warnOnBundleRenameDrift({ configVersion: "0.9.0", semanticSearchMode: "auto" } as AkmConfig);
    expect(warnCalls).toHaveLength(0);

    resetBundleIdentityGuardForTests();
    fs.rmSync(getDbPath(), { force: true });
    warnOnBundleRenameDrift(bundlesConfig("newname"));
    expect(warnCalls).toHaveLength(0);
  });

  test("warns only once per process until re-armed", () => {
    seedIndexBundles(["oldname"]);
    warnOnBundleRenameDrift(bundlesConfig("newname"));
    warnOnBundleRenameDrift(bundlesConfig("newname"));
    expect(warnCalls).toHaveLength(1);
  });
});
