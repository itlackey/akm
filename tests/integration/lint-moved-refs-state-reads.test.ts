// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm lint` asks for the recorded moves only for a ref that did not resolve, and reads them through the caller's
 * connection: a bundle with no broken ref never touches state.db, and an ordinary run with one reads it read-only and
 * changes nothing in it. Real databases, so it lives under tests/integration/.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../../src/commands/lint";
import { resetConfigCache } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

function put(rel: string, content: string): string {
  const file = path.join(storage.stashDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** The files under the data directory with their sizes and hashes. */
function dataFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        files.set(
          path.relative(storage.dataDir, full),
          createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
        );
    }
  };
  walk(storage.dataDir);
  return files;
}

const NOTE = (body: string, xref = ""): string =>
  `---\ndescription: Note\nupdated: 2026-11-01\n${xref}---\n\n${body}\n`;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "stash",
    bundles: { stash: { path: storage.stashDir, writable: true, components: { main: { root: ".", adapter: "akm" } } } },
  });
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

/** A linker whose xref names `memories/old`, which was moved to `memories/new` after the index knew it. */
async function movedFixture(): Promise<string> {
  put("memories/old.md", NOTE("Target."));
  const linker = put("memories/linker.md", NOTE("Links.", "xrefs:\n  - memories/old\n"));
  await akmIndex({ stashDir: storage.stashDir, full: true });
  fs.renameSync(path.join(storage.stashDir, "memories/old.md"), path.join(storage.stashDir, "memories/new.md"));
  await akmIndex({ stashDir: storage.stashDir });
  return linker;
}

describe("lint reads the recorded moves only for a ref that did not resolve", () => {
  test("a bundle with no unresolved ref never asks for them and leaves the data directory identical", async () => {
    put("memories/a.md", NOTE("No refs here."));
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const before = dataFiles();
    let reads = 0;

    await akmLint({
      dir: storage.stashDir,
      readMoves: () => {
        reads++;
        return [];
      },
    });

    expect(reads).toBe(0);
    expect(dataFiles()).toEqual(before);
  });

  test("an unresolved ref reads them once, and an ordinary run changes nothing in state.db", async () => {
    await movedFixture();
    const before = dataFiles();
    let reads = 0;
    const { readRecordedMoves } = await import("../../src/commands/lint/moved-refs");

    const result = await akmLint({
      dir: storage.stashDir,
      rule: "missing-ref",
      readMoves: () => {
        reads++;
        return readRecordedMoves();
      },
    });

    expect(reads).toBe(1);
    expect(result.flagged.map((f) => f.movedTo)).toEqual(["stash//memories/new"]);
    const after = dataFiles();
    const added = [...after.keys()].filter((file) => !before.has(file));
    expect(added.every((file) => /state\.db-(shm|wal)$/.test(file))).toBe(true);
    for (const [file, hash] of before) expect(after.get(file)).toBe(hash);
  });

  test("an ordinary --fix rewrites the moved link", async () => {
    const linker = await movedFixture();

    await akmLint({ dir: storage.stashDir, fix: true });

    expect(fs.readFileSync(linker, "utf8")).toContain("memories/new");
    expect(fs.readFileSync(linker, "utf8")).not.toContain("memories/old");
  });
});
