// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Regression suite for #476 — `akm save` git add -A clobbering WIP.
// runUpstreamPush previously ran `git add -A` unconditionally, so any
// dirty file in the working tree was staged and pushed. The fix refuses
// the push when any dirty path is outside akm-managed subtrees (TYPE_DIRS
// + `.akm/`). This file tests the path-classifier in isolation; the
// integration path is exercised in git-provider tests.

import { describe, expect, it } from "bun:test";
import { collectNonAkmDirtyPaths } from "../src/sources/providers/git";

describe("collectNonAkmDirtyPaths (#476)", () => {
  it("returns empty when only akm-managed subtrees are dirty", () => {
    const porcelain = [
      " M skills/foo/skill.md",
      "A  commands/bar.md",
      "?? agents/new.md",
      " M .akm/state/index.lock",
    ].join("\n");
    expect(collectNonAkmDirtyPaths(porcelain)).toEqual([]);
  });

  it("flags top-level non-akm paths", () => {
    const porcelain = [
      " M skills/foo/skill.md", // akm — skip
      " M package.json", // not akm
      "?? README-DRAFT.md", // not akm
    ].join("\n");
    expect(collectNonAkmDirtyPaths(porcelain)).toEqual(["package.json", "README-DRAFT.md"]);
  });

  it("flags non-akm subtree paths", () => {
    const porcelain = [" M src/index.ts", "?? docs/scratch.md", "A  vendor/lib.js"].join("\n");
    expect(collectNonAkmDirtyPaths(porcelain)).toEqual(["src/index.ts", "docs/scratch.md", "vendor/lib.js"]);
  });

  it("uses the post-rename path for renames", () => {
    const porcelain = "R  src/old.ts -> src/new.ts";
    // src/new.ts is non-akm → should be flagged.
    expect(collectNonAkmDirtyPaths(porcelain)).toEqual(["src/new.ts"]);
  });

  it("strips surrounding quotes for paths with special characters", () => {
    const porcelain = ' M "skills/has space/file.md"\n M "external/with quote.txt"';
    expect(collectNonAkmDirtyPaths(porcelain)).toEqual(["external/with quote.txt"]);
  });

  it("handles trailing carriage returns (git on Windows)", () => {
    const porcelain = " M src/cli.ts\r\n M skills/ok.md\r";
    expect(collectNonAkmDirtyPaths(porcelain)).toEqual(["src/cli.ts"]);
  });

  it("ignores empty lines", () => {
    expect(collectNonAkmDirtyPaths("")).toEqual([]);
    expect(collectNonAkmDirtyPaths("\n\n")).toEqual([]);
  });
});
