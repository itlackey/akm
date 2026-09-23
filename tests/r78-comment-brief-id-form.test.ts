// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * tier1-0917 r4-2 (brief item r2-3): four test-file comments referenced the
 * brief item id as `#R78`, which reads as a GitHub issue link. Pin the
 * rewritten `R78 (tier1-0917)` form so a future edit can't silently drift
 * back to the issue-link-looking spelling.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

const FILES = [
  "tests/integration/commands/improve/state-gc.test.ts",
  "tests/integration/commands/improve/improve-db-locking.test.ts",
  "tests/integration/commands/improve-memory.test.ts",
  "tests/integration/memory-inference.test.ts",
];

describe("R78 (tier1-0917) brief-item-id comment form", () => {
  for (const file of FILES) {
    test(`${file} uses "R78 (tier1-0917)", not "#R78"`, () => {
      const content = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      expect(content).toContain("R78 (tier1-0917)");
      expect(content).not.toContain("#R78");
    });
  }
});
