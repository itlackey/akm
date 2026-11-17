// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Commands take their asset types and folders from the modules that own them
 * (`KNOWN_TYPES`, the placement registry, the walker's directory rules), so a
 * type added there is accepted here without a second edit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../src/commands/lint/index";
import { documentFormatForStashDir, documentStashDirs, stashDirFor } from "../src/core/asset/asset-placement";
import { UsageError } from "../src/core/errors";
import { KNOWN_TYPES } from "../src/core/recognition-util";
import { buildFileContext } from "../src/indexer/walk/file-context";
import { declaredTypeForPath } from "../src/indexer/walk/matchers";
import { makeConfig } from "./_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

const NEEDS_UPDATED = "---\ndescription: needs a date\n---\n\nBody.\n";

function write(root: string, rel: string, content: string): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

/** A file the walker's directory rules would place in `type`'s folder. */
function sampleFile(type: string, dir: string): string {
  if (type === "skill") return `${dir}/x/SKILL.md`;
  return `${dir}/x${documentFormatForStashDir(dir) === "yaml" ? ".yml" : ".md"}`;
}

describe("lint folders come from the placement registry", () => {
  test("every known type is either linted as a document folder or one lint never reads", () => {
    const neverRead = KNOWN_TYPES.filter((type) => {
      const dir = stashDirFor(type);
      return dir === undefined || documentFormatForStashDir(dir) === undefined;
    });
    expect([...neverRead].sort()).toEqual(["env", "script", "secret"]);
  });

  test("the walker declares each document folder's type for a file in it", () => {
    for (const type of KNOWN_TYPES) {
      const dir = stashDirFor(type);
      if (dir === undefined || !documentStashDirs().includes(dir)) continue;
      const declared = declaredTypeForPath(buildFileContext("/bundle", `/bundle/${sampleFile(type, dir)}`));
      expect({ type, declared }).toEqual({ type, declared: type });
    }
  });

  describe("sweep and single file", () => {
    let storage: IsolatedAkmStorage;
    beforeEach(() => {
      storage = withIsolatedAkmStorage();
    });
    afterEach(() => storage.cleanup());
    const lint = (extra: Record<string, unknown> = {}) =>
      akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir), ...extra });

    test("rules/ and instructions/ files are swept and linted singly", async () => {
      const rule = write(storage.stashDir, "rules/proj/a.md", NEEDS_UPDATED);
      const instruction = write(storage.stashDir, "instructions/b.md", NEEDS_UPDATED);
      const swept = await lint();
      expect(swept.flagged.map((i) => i.file).sort()).toEqual(["instructions/b.md", "rules/proj/a.md"]);
      expect((await lint({ file: rule })).flagged.map((i) => i.file)).toEqual(["rules/proj/a.md"]);
      expect((await lint({ file: instruction })).flagged.map((i) => i.file)).toEqual(["instructions/b.md"]);
    });

    test("--type rules narrows the sweep to rules/", async () => {
      write(storage.stashDir, "rules/a.md", NEEDS_UPDATED);
      write(storage.stashDir, "knowledge/b.md", NEEDS_UPDATED);
      expect((await lint({ typeFilter: "rules" })).flagged.map((i) => i.file)).toEqual(["rules/a.md"]);
    });

    test("a file under env/ or secrets/ is refused and not read", async () => {
      const secret = write(storage.stashDir, "secrets/token.md", NEEDS_UPDATED);
      const env = write(storage.stashDir, "env/prod.env", "KEY=value\n");
      for (const file of [secret, env]) {
        await expect(lint({ file })).rejects.toBeInstanceOf(UsageError);
        await expect(lint({ file, typeFilter: "knowledge" })).rejects.toBeInstanceOf(UsageError);
      }
    });
  });
});
