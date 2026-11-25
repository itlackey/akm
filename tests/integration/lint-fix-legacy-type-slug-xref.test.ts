// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm lint --fix` migration of the retired `type:slug` xref grammar (see
 * `legacyTypeSlugParts` in `src/core/lint/base-linter.ts`) to conceptId
 * form in the frontmatter xref channels (`xrefs:` / `supersededBy:` /
 * `contradictedBy:`).
 *
 * A value is rewritten ONLY when the conceptId form still resolves to a real
 * asset — a dangling legacy ref must stay reported as `missing-ref` in its
 * ORIGINAL spelling, never rewritten into a differently-spelled dangling ref.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../../src/commands/lint";
import { resetArchiveCache } from "../../src/core/adapter/directory-archive";
import { makeConfig } from "../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

function writeMemory(stashDir: string, slug: string, frontmatter: string): void {
  fs.writeFileSync(path.join(stashDir, "memories", `${slug}.md`), `---\n${frontmatter}---\n\nBody.\n`);
}

function read(stashDir: string, slug: string): string {
  return fs.readFileSync(path.join(stashDir, "memories", `${slug}.md`), "utf8");
}

describe("akm lint --fix: legacy type:slug xref migration", () => {
  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    resetArchiveCache();
  });
  afterEach(() => {
    resetArchiveCache();
    storage.cleanup();
  });

  test("a plain lint (no --fix) reports the legacy ref as resolvable and changes nothing", async () => {
    const stashDir = storage.stashDir;
    writeMemory(stashDir, "live", "description: real target\n");
    writeMemory(stashDir, "holder", "description: h\nxrefs:\n  - memory:live\n");
    const before = read(stashDir, "holder");

    const result = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });

    expect(result.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
    expect(read(stashDir, "holder")).toBe(before);
  });

  test("--fix rewrites a resolvable legacy ref to conceptId form: block-list spelling", async () => {
    const stashDir = storage.stashDir;
    writeMemory(stashDir, "live", "description: real target\n");
    writeMemory(stashDir, "holder", "description: h\nxrefs:\n  - memory:live\n");

    const result = await akmLint({ dir: stashDir, fix: true, config: makeConfig(stashDir) });

    expect(result.fixed.some((f) => f.detail.includes("legacy xref grammar migrated"))).toBe(true);
    const after = read(stashDir, "holder");
    expect(after).toContain("memories/live");
    expect(after).not.toContain("memory:live");
  });

  test("--fix rewrites inline-flow and scalar spellings", async () => {
    const stashDir = storage.stashDir;
    writeMemory(stashDir, "live", "description: real target\n");
    writeMemory(stashDir, "flow", "description: h\nxrefs: [memory:live]\n");
    writeMemory(stashDir, "scalar", "description: h\nsupersededBy: memory:live\n");

    await akmLint({ dir: stashDir, fix: true, config: makeConfig(stashDir) });

    expect(read(stashDir, "flow")).toContain("xrefs: [memories/live]");
    expect(read(stashDir, "scalar")).toContain("supersededBy: memories/live");
  });

  test("a dangling legacy ref is NOT rewritten and stays reported as missing-ref", async () => {
    const stashDir = storage.stashDir;
    writeMemory(stashDir, "holder", "description: h\nxrefs:\n  - memory:gone\n");

    const result = await akmLint({ dir: stashDir, fix: true, config: makeConfig(stashDir) });

    expect(result.fixed.some((f) => f.detail.includes("legacy xref grammar migrated"))).toBe(false);
    const after = read(stashDir, "holder");
    expect(after).toContain("memory:gone");
    expect(after).not.toContain("memories/gone");
    expect(result.flagged.some((f) => f.issue === "missing-ref" && f.detail.includes("memory:gone"))).toBe(true);
  });

  test("a surviving legacy ref alongside a dangling one in the same list: only the resolvable one is rewritten", async () => {
    const stashDir = storage.stashDir;
    writeMemory(stashDir, "live", "description: real target\n");
    writeMemory(stashDir, "holder", "description: h\ncontradictedBy:\n  - memory:live\n  - memory:gone\n");

    const result = await akmLint({ dir: stashDir, fix: true, config: makeConfig(stashDir) });

    const after = read(stashDir, "holder");
    expect(after).toContain("memories/live");
    expect(after).toContain("memory:gone");
    expect(result.flagged.some((f) => f.issue === "missing-ref" && f.detail.includes("memory:gone"))).toBe(true);
  });

  test("comments and unrelated keys survive the rewrite byte-for-byte", async () => {
    const stashDir = storage.stashDir;
    writeMemory(stashDir, "live", "description: real target\n");
    fs.writeFileSync(
      path.join(stashDir, "memories", "holder.md"),
      "---\n# a comment\ndescription: h\ntags:\n  - one\nxrefs:\n  - memory:live\nupdated: 2026-01-01\n---\n\nBody.\n",
    );

    await akmLint({ dir: stashDir, fix: true, config: makeConfig(stashDir) });

    const after = read(stashDir, "holder");
    expect(after).toContain("# a comment");
    expect(after).toContain("tags:");
    expect(after).toContain("  - one");
    expect(after).toContain("updated: 2026-01-01");
    expect(after).toContain("xrefs:\n  - memories/live");
  });
});
