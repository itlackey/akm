// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #884 — `akm lint --prune-dangling-edges`, the OPT-IN half of the fix.
 *
 * Resolving prune tombstones (see `lint-archived-memory-belief-edge.test.ts`)
 * stops NEW dangling edges appearing, but cannot help an edge whose target was
 * removed outside the prune path — a hand `git rm`, or a pre-fix release. That
 * is the shape of the 224 findings #884 reported, and clearing them deletes
 * user assertions, so it never happens implicitly: not on a bare `akm lint`,
 * and not on `--fix`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../../src/commands/lint";
import { resetMemoryArchiveCache } from "../../src/core/asset/memory-archive";
import { makeConfig } from "../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

function writeMemory(stashDir: string, slug: string, frontmatter: string): void {
  fs.writeFileSync(path.join(stashDir, "memories", `${slug}.md`), `---\n${frontmatter}---\n\nBody.\n`);
}

function read(stashDir: string, slug: string): string {
  return fs.readFileSync(path.join(stashDir, "memories", `${slug}.md`), "utf8");
}

describe("akm lint --prune-dangling-edges (#884)", () => {
  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    resetMemoryArchiveCache();
  });
  afterEach(() => {
    resetMemoryArchiveCache();
    storage.cleanup();
  });

  test("a plain lint reports the dangling edge and changes nothing on disk", async () => {
    const stashDir = storage.stashDir;
    writeMemory(stashDir, "holder", "description: h\ncontradictedBy:\n  - memories/gone\n");
    const before = read(stashDir, "holder");

    const result = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });

    expect(result.flagged.filter((f) => f.issue === "missing-ref").length).toBe(1);
    expect(read(stashDir, "holder")).toBe(before);
  });

  test("--fix alone does NOT drop the edge — the repair is not folded into it", async () => {
    const stashDir = storage.stashDir;
    writeMemory(stashDir, "holder", "description: h\ncontradictedBy:\n  - memories/gone\n");

    const result = await akmLint({ dir: stashDir, fix: true, config: makeConfig(stashDir) });

    expect(result.flagged.filter((f) => f.issue === "missing-ref").length).toBe(1);
    expect(read(stashDir, "holder")).toContain("memories/gone");
  });

  test("the flag drops the dangling edge and removes the now-empty key", async () => {
    const stashDir = storage.stashDir;
    writeMemory(stashDir, "holder", "description: h\ncontradictedBy:\n  - memories/gone\n");

    const result = await akmLint({ dir: stashDir, pruneDanglingEdges: true, config: makeConfig(stashDir) });

    expect(result.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
    expect(result.fixed.some((f) => f.detail.includes("dangling contradictedBy edge dropped"))).toBe(true);
    const after = read(stashDir, "holder");
    expect(after).not.toContain("memories/gone");
    expect(after).not.toContain("contradictedBy");
    expect(after).toContain("description: h");
    expect(after).toContain("Body.");
  });

  test("a surviving edge in the same list is preserved", async () => {
    const stashDir = storage.stashDir;
    writeMemory(stashDir, "live", "description: real target\n");
    writeMemory(stashDir, "holder", "description: h\ncontradictedBy:\n  - memories/gone\n  - memories/live\n");

    await akmLint({ dir: stashDir, pruneDanglingEdges: true, config: makeConfig(stashDir) });

    const after = read(stashDir, "holder");
    expect(after).not.toContain("memories/gone");
    expect(after).toContain("memories/live");
    expect(after).toContain("contradictedBy:");
  });

  test("inline-flow and scalar spellings are both repaired", async () => {
    const stashDir = storage.stashDir;
    writeMemory(stashDir, "live", "description: real target\n");
    writeMemory(stashDir, "flow", "description: h\ncontradictedBy: [memories/gone, memories/live]\n");
    writeMemory(stashDir, "scalar", "description: h\nsupersededBy: memories/gone\n");

    await akmLint({ dir: stashDir, pruneDanglingEdges: true, config: makeConfig(stashDir) });

    expect(read(stashDir, "flow")).toContain("contradictedBy: [memories/live]");
    expect(read(stashDir, "scalar")).not.toContain("supersededBy");
  });

  test("xrefs are NOT repaired — only the belief channels are in scope", async () => {
    const stashDir = storage.stashDir;
    writeMemory(stashDir, "holder", "description: h\nxrefs:\n  - memories/gone\n");

    const result = await akmLint({ dir: stashDir, pruneDanglingEdges: true, config: makeConfig(stashDir) });

    expect(result.flagged.filter((f) => f.issue === "missing-ref").length).toBe(1);
    expect(read(stashDir, "holder")).toContain("memories/gone");
  });

  test("an edge to an ARCHIVED memory is never dropped — it resolves, so it is not dangling", async () => {
    const stashDir = storage.stashDir;
    // A tombstone written in the prune path's layout.
    const archiveDir = path.join(stashDir, ".akm", "memory-cleanup", "archive", "2026-01-01-memory-pruned");
    fs.mkdirSync(path.join(archiveDir, "memories"), { recursive: true });
    fs.writeFileSync(path.join(archiveDir, "memories", "pruned.md"), "---\ndescription: archived\n---\n\nBody.\n");
    fs.writeFileSync(
      path.join(archiveDir, "cleanup.md"),
      "---\nkind: memory-cleanup-archive\nref: memory:pruned\noriginalPath: memories/pruned.md\n---\n\nArchived.\n",
    );
    writeMemory(stashDir, "holder", "description: h\ncontradictedBy:\n  - memories/pruned\n");
    resetMemoryArchiveCache();

    const result = await akmLint({ dir: stashDir, pruneDanglingEdges: true, config: makeConfig(stashDir) });

    expect(result.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
    expect(read(stashDir, "holder")).toContain("memories/pruned");
  });

  test("comments and unrelated keys survive the rewrite", async () => {
    const stashDir = storage.stashDir;
    fs.writeFileSync(
      path.join(stashDir, "memories", "holder.md"),
      "---\n# a comment\ndescription: h\ntags:\n  - one\ncontradictedBy:\n  - memories/gone\nupdated: 2026-01-01\n---\n\nBody.\n",
    );

    await akmLint({ dir: stashDir, pruneDanglingEdges: true, config: makeConfig(stashDir) });

    const after = read(stashDir, "holder");
    expect(after).toContain("# a comment");
    expect(after).toContain("tags:");
    expect(after).toContain("  - one");
    expect(after).toContain("updated: 2026-01-01");
    expect(after).not.toContain("contradictedBy");
  });
});
