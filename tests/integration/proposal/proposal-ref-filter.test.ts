// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `proposal list --ref` matches every proposal for the same asset, whatever spelling the filter or the stored ref was
 * written in (§0.2 N15), finds all it found before, and warns about nothing the stored refs hold.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { listProposals } from "../../../src/commands/proposal/repository";
import { resetConfigCache } from "../../../src/core/config/config";
import { getStateDbPath, openStateDatabase, stateBundleId } from "../../../src/core/state-db";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../../src/core/warn";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let stash: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  stash = path.resolve(storage.stashDir);
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "stash",
    bundles: { stash: { path: storage.stashDir, writable: true, adapter: "akm" } },
  });
  resetConfigCache();
  _resetWarnOnceForTests();
  for (const file of ["knowledge/guide.md", "reports/quarterly.md"]) {
    fs.mkdirSync(path.dirname(path.join(stash, file)), { recursive: true });
    fs.writeFileSync(path.join(stash, file), "# x\n");
  }
});

afterEach(() => {
  storage.cleanup();
  _resetWarnOnceForTests();
});

let counter = 0;
/** A pending proposal stored under `ref` exactly as written. */
function seed(ref: string): string {
  const id = `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  const file = getStateDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = openStateDatabase(file);
  try {
    db.prepare(
      `INSERT INTO proposals
         (id, bundle_id, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json)
       VALUES (?, ?, ?, 'pending', 'distill', ?, ?, 'x', NULL, '{}')`,
    ).run(id, stateBundleId(stash), ref, "2026-07-05T03:03:28.486Z", "2026-07-05T03:03:28.486Z");
  } finally {
    db.close();
  }
  return id;
}

function warningsOf(run: () => unknown): string[] {
  const warnings: string[] = [];
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  try {
    run();
  } finally {
    _setWarnSinkForTests();
  }
  return warnings;
}

describe("proposal --ref filter (N15)", () => {
  test("a stored ref as written is still found, in a bundle the config does not name", () => {
    const exact = seed("elsewhere//knowledge/guide.md");
    const same = seed("stash//knowledge/guide.md");
    const ids = listProposals(stash, { status: "pending", ref: "knowledge/guide.md" }).map((p) => p.id);
    expect(ids.sort()).toEqual([exact, same].sort());
  });

  test("a stored ref whose bundle is not configured is found by the asset's other spellings", () => {
    const stored = seed("gone//knowledge/guide.md");
    seed("gone//knowledge/other.md");
    expect(listProposals(stash, { status: "pending", ref: "knowledge/guide" }).map((p) => p.id)).toEqual([stored]);
  });

  test("the filter without the file's extension finds a proposal stored under the file spelling", () => {
    const stored = seed("stash//knowledge/guide.md");
    seed("stash//knowledge/other.md");
    expect(listProposals(stash, { status: "pending", ref: "knowledge/guide" }).map((p) => p.id)).toEqual([stored]);
    expect(listProposals(stash, { status: "pending", ref: "stash//knowledge/guide" }).map((p) => p.id)).toEqual([
      stored,
    ]);
  });

  test("resolving the stored refs prints no outdated-ref warning", () => {
    seed("stash//knowledge/reports/quarterly");
    const wanted = seed("stash//knowledge/guide.md");
    let found: string[] = [];
    const warnings = warningsOf(() => {
      found = listProposals(stash, { status: "pending", ref: "knowledge/guide" }).map((p) => p.id);
    });
    expect(found).toEqual([wanted]);
    expect(warnings.filter((warning) => warning.includes("outdated"))).toEqual([]);
  });
});
