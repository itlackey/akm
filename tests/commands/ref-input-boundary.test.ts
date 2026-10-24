// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The CLI/API input boundaries route raw refs through `parseRefInput`, which
 * accepts the `[bundle//]conceptId` grammar. The pre-0.9.0
 * `[origin//]type:name` colon grammar is retired — it is NOT accepted here,
 * and it must never be re-accepted by any parser.
 *
 * This drives representative commands (`show`, `feedback`) at the
 * command level and proves that the SAME asset resolves through both surviving
 * spellings of its ref — the short `conceptId` and the fully-qualified
 * `bundle//conceptId`.
 *
 * The asset lives ONLY in an installed source whose id (`catalog`) is a legal
 * bundle slug, so the `catalog//…` spelling exercises real origin resolution
 * (registryId match), not a primary-stash shortcut.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmShowUnified } from "../../src/commands/read/show";
import { saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { akmIndex } from "../../src/indexer/indexer";
import { runCliCapture } from "../_helpers/cli";
import { seedLockEntries } from "../_helpers/lockfile";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let catalogRoot = "";
let guidePath = "";

/**
 * The two surviving spellings of the SAME `knowledge/guide` concept in the
 * `catalog` bundle: the short conceptId and the fully-qualified
 * `bundle//conceptId` form. The retired colon `type:name` grammar is
 * deliberately NOT included — its rejection is pinned in
 * `tests/resolve-ref.test.ts`.
 */
const SPELLINGS = ["knowledge/guide", "catalog//knowledge/guide"] as const;

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  catalogRoot = path.join(storage.root, "catalog");
  guidePath = path.join(catalogRoot, "knowledge", "guide.md");
  fs.mkdirSync(path.dirname(guidePath), { recursive: true });
  fs.writeFileSync(guidePath, "---\ndescription: http caching guide\n---\n\n# Guide\n\nHTTP caching notes.\n", "utf8");

  // The asset lives only in the `catalog` installed source. Its id is a legal
  // bundle slug, so `deriveInstallations` mints the bundle id `catalog` and
  // `resolveSourcesForOrigin("catalog", …)` matches it by registryId.
  saveConfig({
    semanticSearchMode: "off",
    bundles: { catalog: { npm: "catalog" } },
  });
  seedLockEntries([
    {
      id: "catalog",
      source: "npm",
      ref: "catalog",
      localRoot: catalogRoot,
      installedAt: new Date().toISOString(),
    },
  ]);

  await akmIndex({ stashDir: storage.stashDir });
});

afterEach(() => {
  storage.cleanup();
  catalogRoot = "";
  guidePath = "";
});

describe("F1b input boundaries accept both ref grammars (command level)", () => {
  test("`akm show` resolves the same file via conceptId and bundle//conceptId", async () => {
    const paths: string[] = [];
    for (const ref of SPELLINGS) {
      const result = await akmShowUnified({ ref });
      expect(result.type, `show ${ref} type`).toBe("knowledge");
      expect(result.name, `show ${ref} name`).toBe("guide");
      paths.push(result.path ?? "");
    }
    // Every spelling resolves to the SAME on-disk file.
    expect(paths[0]).toBe(guidePath);
    expect(paths[1]).toBe(guidePath);
  });

  test("`akm feedback` records against the same asset via both spellings", async () => {
    // Sanity: the index the beforeEach built must be present for feedback.
    expect(fs.existsSync(getDbPath())).toBe(true);
    for (const ref of SPELLINGS) {
      const res = await runCliCapture(["feedback", ref, "--positive"]);
      expect(res.code, `feedback ${ref} exit (stderr: ${res.stderr})`).toBe(0);
    }
  });
});
