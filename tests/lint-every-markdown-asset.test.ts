// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm lint` covers every Markdown asset the indexer would index in an akm bundle, wherever it sits, not only the type
 * folders: the files come from the indexer's walk and each file's type from its classification. `env/` and `secrets/`
 * are never read, a type left out of search by default stays out, and the bundle's `lint.skip` globs apply.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../src/commands/lint";
import type { AkmConfig } from "../src/core/config/config";
import { makeConfig } from "./_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => storage.cleanup());

/** Frontmatter without `updated`, so every file the sweep reaches reports `missing-updated`. */
const NOTE = "---\ndescription: Note\n---\n\nBody.\n";

function put(rel: string, content = NOTE): string {
  const file = path.join(storage.stashDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const flaggedFiles = async (config: AkmConfig = makeConfig(storage.stashDir), rule = "missing-updated") =>
  (await akmLint({ dir: storage.stashDir, config })).flagged
    .filter((finding) => finding.issue === rule)
    .map((finding) => finding.file)
    .sort();

describe("lint reaches every Markdown asset of an akm bundle", () => {
  test("a file under a wiki folder, a loose folder or the bundle root is linted like a type-folder file", async () => {
    put("knowledge/typed.md");
    put("wikis/notes/pages/page.md");
    put("reports/2026/q3.md");
    put("loose.md");

    expect(await flaggedFiles()).toEqual([
      "knowledge/typed.md",
      "loose.md",
      "reports/2026/q3.md",
      "wikis/notes/pages/page.md",
    ]);
  });

  test("the per-type checks follow the type the indexer gives the file, wherever it sits", async () => {
    // A command by its body, outside commands/: the command check (a name or a type) applies.
    put("recipes/deploy.md", "---\ndescription: Deploy\nupdated: 2026-11-01\n---\n\nRun $ARGUMENTS now.\n");
    put("recipes/plain.md", "---\ndescription: Plain\nupdated: 2026-11-01\n---\n\nNothing to run.\n");

    expect(await flaggedFiles(undefined, "missing-name-or-type")).toEqual(["recipes/deploy.md"]);
  });

  test("a file the indexer's walk skips is not linted", async () => {
    put(".hidden/note.md");
    put("node_modules/pkg/readme.md");
    put(".scratch/draft.md");

    expect(await flaggedFiles()).toEqual([]);
  });

  test("env/ and secrets/ are never read", async () => {
    put("env/notes.md");
    put("secrets/token.md");
    put("knowledge/typed.md");
    const read = spyOn(fs, "readFileSync");
    try {
      expect(await flaggedFiles()).toEqual(["knowledge/typed.md"]);
      const reads = read.mock.calls.map((call) => String(call[0]));
      expect(reads.some((file) => /[\\/](env|secrets)[\\/]/.test(file))).toBe(false);
    } finally {
      read.mockRestore();
    }
  });

  test("a type left out of search by default stays out of the sweep unless named", async () => {
    put("sessions/claude/s1.md");

    expect(await flaggedFiles()).toEqual([]);
    const named = await akmLint({
      dir: storage.stashDir,
      config: makeConfig(storage.stashDir),
      typeFilter: "sessions",
    });
    expect(named.flagged.map((finding) => finding.file)).toEqual(["sessions/claude/s1.md"]);
  });

  test("the bundle's lint.skip globs apply to a loose asset", async () => {
    put("reports/a.md");
    put("wikis/notes/pages/b.md");
    const config = makeConfig(storage.stashDir);
    config.bundles = {
      stash: { ...config.bundles?.stash, lint: { skip: { "missing-updated": ["reports/**"] } } },
    } as AkmConfig["bundles"];

    expect(await flaggedFiles(config)).toEqual(["wikis/notes/pages/b.md"]);
  });

  test("--fix repairs a loose asset the same way as a typed one", async () => {
    const file = put("reports/a.md");

    await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir), fix: true });

    expect(fs.readFileSync(file, "utf8")).toMatch(/^---\ndescription: Note\nupdated: \d{4}-\d{2}-\d{2}\n---/);
  });
});
