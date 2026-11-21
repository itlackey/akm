// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Links to an asset that was moved on disk: `akm lint` reports a `missing-ref` for a ref the index recorded as moved
 * with the new ref, `--fix` rewrites it, and the workspace lists and rewrites exactly those links per bundle. A
 * missing ref with no recorded move is never touched. Real databases, so it lives under tests/integration/.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../../src/commands/lint";
import { resetConfigCache } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { assets } from "../../src/workspace";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let other: string;
let readonly: string;

function put(root: string, rel: string, content: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function rename(root: string, from: string, to: string, toRoot = root): void {
  fs.mkdirSync(path.dirname(path.join(toRoot, to)), { recursive: true });
  fs.renameSync(path.join(root, from), path.join(toRoot, to));
}

const TARGET = "---\ndescription: Target\nupdated: 2026-11-01\n---\n\n# Target\n";

/** A linker with the target named in frontmatter lists, in prose, and inside a code fence that must stay as written. */
const linker = (frontmatterRef: string, proseRef: string, fenceRef = proseRef): string =>
  [
    "---",
    "description: Linker",
    "updated: 2026-11-01",
    "xrefs:",
    `  - ${frontmatterRef}`,
    "---",
    "",
    `See ${proseRef} for details.`,
    "",
    "```",
    `${fenceRef}`,
    "```",
    "",
  ].join("\n");

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
  other = path.join(storage.root, "other");
  readonly = path.join(storage.root, "readonly");
  fs.mkdirSync(other, { recursive: true });
  fs.mkdirSync(readonly, { recursive: true });
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "stash",
    bundles: {
      stash: { path: storage.stashDir, writable: true, components: { main: { root: ".", adapter: "akm" } } },
      other: { path: other, writable: true, components: { main: { root: ".", adapter: "akm" } } },
      ro: { path: readonly, writable: false, components: { main: { root: ".", adapter: "akm" } } },
    },
  });
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

const missingRefs = async (dir: string) => (await akmLint({ dir, rule: "missing-ref" })).flagged;

/** Index the fixture, then move `knowledge/target.md` to `knowledge/archive/target.md` and index again. */
async function moveTarget(): Promise<void> {
  await akmIndex({ stashDir: storage.stashDir });
  rename(storage.stashDir, "knowledge/target.md", "knowledge/archive/target.md");
  await akmIndex({ stashDir: storage.stashDir });
}

describe("lint on a link to a moved asset", () => {
  test("a missing ref the index recorded as moved carries the new ref", async () => {
    put(storage.stashDir, "knowledge/target.md", TARGET);
    put(storage.stashDir, "knowledge/linker.md", linker("knowledge/target", "stash//knowledge/target"));
    await moveTarget();

    const flagged = await missingRefs(storage.stashDir);

    expect(flagged.map((issue) => [issue.file, issue.movedFrom, issue.movedTo])).toEqual([
      ["knowledge/linker.md", "stash//knowledge/target", "stash//knowledge/archive/target"],
      ["knowledge/linker.md", "knowledge/target", "stash//knowledge/archive/target"],
    ]);
  });

  test("a missing ref with no recorded move is reported as it is and never rewritten", async () => {
    const file = put(
      storage.stashDir,
      "knowledge/linker.md",
      linker("knowledge/never-existed", "stash//knowledge/gone"),
    );
    await akmIndex({ stashDir: storage.stashDir });
    const before = fs.readFileSync(file, "utf8");

    const result = await akmLint({ dir: storage.stashDir, fix: true });

    expect(result.flagged.filter((issue) => issue.issue === "missing-ref")).toHaveLength(2);
    expect(result.flagged.every((issue) => issue.movedTo === undefined)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  test("--fix rewrites the link in frontmatter and prose, leaves a code fence alone, and a second run changes nothing", async () => {
    put(storage.stashDir, "knowledge/target.md", TARGET);
    const file = put(storage.stashDir, "knowledge/linker.md", linker("knowledge/target", "stash//knowledge/target"));
    await moveTarget();

    const fixed = await akmLint({ dir: storage.stashDir, fix: true });

    expect(fixed.fixed.filter((issue) => issue.issue === "missing-ref")).toHaveLength(2);
    // A bare link stays bare; the fenced example is as written.
    expect(fs.readFileSync(file, "utf8")).toBe(
      linker("knowledge/archive/target", "stash//knowledge/archive/target", "stash//knowledge/target"),
    );
    const again = await akmLint({ dir: storage.stashDir, fix: true });
    expect(again.fixed).toEqual([]);
    expect(again.flagged.filter((issue) => issue.issue === "missing-ref")).toEqual([]);
  });

  test("a link to an asset outside the type folders is followed when it moves", async () => {
    put(storage.stashDir, "notes/loose.md", TARGET);
    const file = put(storage.stashDir, "knowledge/linker.md", linker("stash//notes/loose", "stash//notes/loose"));
    await akmIndex({ stashDir: storage.stashDir });
    expect(await missingRefs(storage.stashDir)).toEqual([]);
    rename(storage.stashDir, "notes/loose.md", "notes/archive/loose.md");
    await akmIndex({ stashDir: storage.stashDir });

    const flagged = await missingRefs(storage.stashDir);
    expect(flagged.map((issue) => issue.movedTo)).toEqual(["stash//notes/archive/loose", "stash//notes/archive/loose"]);

    await akmLint({ dir: storage.stashDir, fix: true });
    expect(fs.readFileSync(file, "utf8")).toContain("  - stash//notes/archive/loose\n");
    expect(await missingRefs(storage.stashDir)).toEqual([]);
  });

  test("a link in another bundle is rewritten to the new ref", async () => {
    put(storage.stashDir, "knowledge/target.md", TARGET);
    const file = put(other, "knowledge/cross.md", linker("stash//knowledge/target", "stash//knowledge/target"));
    await moveTarget();

    await akmLint({ dir: other, fix: true });

    expect(fs.readFileSync(file, "utf8")).toContain("  - stash//knowledge/archive/target\n");
  });

  test("a qualified link to an asset moved to the same path in another bundle is reported and followed", async () => {
    put(storage.stashDir, "knowledge/target.md", TARGET);
    const file = put(
      storage.stashDir,
      "knowledge/linker.md",
      linker("stash//knowledge/target", "stash//knowledge/target"),
    );
    await akmIndex({ stashDir: storage.stashDir });
    rename(storage.stashDir, "knowledge/target.md", "knowledge/target.md", other);
    await akmIndex({ stashDir: storage.stashDir });

    expect((await missingRefs(storage.stashDir)).map((issue) => issue.movedTo)).toEqual([
      "other//knowledge/target",
      "other//knowledge/target",
    ]);
    await akmLint({ dir: storage.stashDir, fix: true });
    expect(fs.readFileSync(file, "utf8")).toContain("  - other//knowledge/target\n");
  });

  test("a link follows an asset moved to another bundle, bare links become qualified", async () => {
    put(storage.stashDir, "knowledge/target.md", TARGET);
    const file = put(storage.stashDir, "knowledge/linker.md", linker("knowledge/target", "stash//knowledge/target"));
    await akmIndex({ stashDir: storage.stashDir });
    rename(storage.stashDir, "knowledge/target.md", "knowledge/moved-target.md", other);
    await akmIndex({ stashDir: storage.stashDir });

    await akmLint({ dir: storage.stashDir, fix: true });

    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("  - other//knowledge/moved-target\n");
    expect(text).toContain("See other//knowledge/moved-target for details.");
  });
});

describe("the workspace lists and rewrites the links to moved assets", () => {
  test("lists the links per bundle, a read-only bundle's included, and rewrites exactly those in writable ones", async () => {
    put(storage.stashDir, "knowledge/target.md", TARGET);
    // No `updated`: a full --fix would stamp it; updating the moved links must not.
    const own = put(
      storage.stashDir,
      "knowledge/linker.md",
      "---\ndescription: Linker\nxrefs:\n  - knowledge/target\n---\n\nBody.\n",
    );
    const cross = put(other, "knowledge/cross.md", linker("stash//knowledge/target", "stash//knowledge/target"));
    const locked = put(readonly, "knowledge/locked.md", linker("stash//knowledge/target", "stash//knowledge/target"));
    await moveTarget();

    const listed = await assets.movedLinks({});

    expect(listed.total).toBe(5);
    expect(listed.bundles.map((bundle) => [bundle.bundle, bundle.writable, bundle.links.length]).sort()).toEqual([
      ["other", true, 2],
      ["ro", false, 2],
      ["stash", true, 1],
    ]);
    expect(listed.bundles.find((bundle) => bundle.bundle === "stash")?.links[0]).toEqual({
      ref: "knowledge/linker",
      file: "knowledge/linker.md",
      from: "knowledge/target",
      to: "stash//knowledge/archive/target",
    });

    const lockedBefore = fs.readFileSync(locked, "utf8");
    await expect(assets.updateMovedLinks({ bundle: "ro" })).rejects.toThrow(/writable/);
    expect(fs.readFileSync(locked, "utf8")).toBe(lockedBefore);

    const result = await assets.updateMovedLinks({ bundle: "stash" });
    expect(result).toMatchObject({ bundle: "stash", rewritten: 1 });
    expect(fs.readFileSync(own, "utf8")).toBe(
      "---\ndescription: Linker\nxrefs:\n  - knowledge/archive/target\n---\n\nBody.\n",
    );
    await assets.updateMovedLinks({ bundle: "other" });
    expect(fs.readFileSync(cross, "utf8")).toContain("  - stash//knowledge/archive/target\n");
    expect(fs.readFileSync(cross, "utf8")).toContain("See stash//knowledge/archive/target for details.");
    const after = await assets.movedLinks({});
    expect(after.bundles.map((bundle) => [bundle.bundle, bundle.links.length]).sort()).toEqual([
      ["other", 0],
      ["ro", 2],
      ["stash", 0],
    ]);
  });
});
