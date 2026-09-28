// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #986 — the predicate that scopes improve's fallback lanes and consolidation:
 * an asset retrieval returned inside the window, or newly captured material
 * (written inside the window) that no improve stage has processed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isInRetrievalScope, type RetrievalScope } from "../../../src/commands/improve/retrieval-scope";

const DAY_MS = 86_400_000;
const NOW = Date.now();
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function assetFile(ageDays: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-retrieval-scope-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "asset.md");
  fs.writeFileSync(filePath, "---\ndescription: x\n---\n\nBody.\n");
  const at = new Date(NOW - ageDays * DAY_MS);
  fs.utimesSync(filePath, at, at);
  return filePath;
}

function scope(used: string[], processed: string[]): RetrievalScope {
  return { used: new Set(used), processed: new Set(processed), sinceMs: NOW - 90 * DAY_MS };
}

describe("isInRetrievalScope", () => {
  test("an asset retrieval returned is in scope however old it is and whatever improve did to it", () => {
    expect(isInRetrievalScope(scope(["knowledge/a"], ["knowledge/a"]), "knowledge/a", assetFile(400))).toBe(true);
  });

  test("a bundle-qualified ref matches on its conceptId", () => {
    expect(isInRetrievalScope(scope(["knowledge/a"], []), "stash//knowledge/a", assetFile(400))).toBe(true);
  });

  test("new material improve never processed is in scope", () => {
    expect(isInRetrievalScope(scope([], []), "memories/fresh", assetFile(2))).toBe(true);
  });

  test("an asset improve already processed is out of scope until retrieval returns it", () => {
    expect(isInRetrievalScope(scope([], ["memories/fresh"]), "memories/fresh", assetFile(2))).toBe(false);
  });

  test("an unprocessed asset written before the window is not new material", () => {
    expect(isInRetrievalScope(scope([], []), "knowledge/old", assetFile(120))).toBe(false);
  });

  test("an unprocessed asset whose file cannot be read is left to the disk gate", () => {
    expect(isInRetrievalScope(scope([], []), "knowledge/gone", "/nonexistent/akm/gone.md")).toBe(true);
    expect(isInRetrievalScope(scope([], []), "knowledge/unknown")).toBe(true);
    expect(isInRetrievalScope(scope([], ["knowledge/gone"]), "knowledge/gone", "/nonexistent/akm/gone.md")).toBe(false);
  });

  test("without a scope (usage history unreadable) every asset stays eligible", () => {
    expect(isInRetrievalScope(undefined, "knowledge/old", assetFile(400))).toBe(true);
  });
});
