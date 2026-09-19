// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-8.4 — §11.5 bundle-rename startup guard: warn (never silently re-mint) when
 * a configured bundle id has no indexed rows but the index holds rows under a
 * bundle id that is no longer configured (the hand-rename signature).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import type { AkmConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { resetBundleIdentityGuardForTests, warnOnBundleRenameDrift } from "../../src/indexer/bundle-identity-guard";
import { openDatabase } from "../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
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
  const db = openIndexDatabase(dbPath);
  try {
    for (const [i, bundleId] of bundleIds.entries()) {
      const conceptId = `knowledge/k${i}`;
      upsertEntry(db, `/s/${bundleId}/k${i}.md`, { name: `k${i}`, type: "knowledge" }, `k${i}`, {
        itemRef: `${bundleId}//${conceptId}`,
        bundleId,
        componentId: bundleId,
        conceptId,
        adapterId: "akm",
      });
    }
  } finally {
    closeDatabase(db);
  }
}

function bundlesConfig(...ids: string[]): AkmConfig {
  const bundles: Record<string, { path: string }> = {};
  for (const id of ids) bundles[id] = { path: `/s/${id}` };
  return { configVersion: "0.9.0", semanticSearchMode: "auto", bundles } as unknown as AkmConfig;
}

function bundleConfigAt(id: string, bundlePath: string): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "auto",
    bundles: { [id]: { path: bundlePath } },
  } as unknown as AkmConfig;
}

describe("§11.5 bundle-rename startup guard", () => {
  test("warns on the hand-rename signature (configured id missing, unconfigured id indexed)", () => {
    seedIndexBundles(["oldname"]);
    warnOnBundleRenameDrift(bundleConfigAt("newname", "/s/oldname"));
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain("bundle identity drift");
    expect(warnCalls[0]).toContain('"newname"');
    expect(warnCalls[0]).toContain('"oldname"');
  });

  test("stays silent for a genuinely new bundle while unrelated stale rows remain (#971)", () => {
    seedIndexBundles(["oldname"]);
    warnOnBundleRenameDrift(bundleConfigAt("newname", "/s/newname"));
    expect(warnCalls).toHaveLength(0);
  });

  test("stays silent when the configured bundle ids match the indexed prefixes", () => {
    seedIndexBundles(["primary"]);
    warnOnBundleRenameDrift(bundlesConfig("primary"));
    expect(warnCalls).toHaveLength(0);
  });

  test("skips the rename-drift comparison for a stamped v22 index with a hidden generated legacy column", () => {
    seedIndexBundles(["oldname"]);
    const raw = openDatabase(getDbPath());
    try {
      raw.exec("ALTER TABLE entries ADD COLUMN entry_key TEXT GENERATED ALWAYS AS (item_ref) VIRTUAL");
    } finally {
      raw.close();
    }

    warnOnBundleRenameDrift(bundlesConfig("newname"));

    // The read boundary rejects the non-canonical index before the guard can
    // query it. This best-effort heuristic stays quiet; the command-level
    // INDEX_SCHEMA_INCOMPATIBLE error is the one actionable diagnostic.
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
    warnOnBundleRenameDrift(bundleConfigAt("newname", "/s/oldname"));
    warnOnBundleRenameDrift(bundleConfigAt("newname", "/s/oldname"));
    expect(warnCalls).toHaveLength(1);
  });
});
