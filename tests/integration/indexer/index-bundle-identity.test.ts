// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmSearch } from "../../../src/commands/read/search";
import { akmShowUnified } from "../../../src/commands/read/show";
import { resetConfigCache } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import {
  type IsolatedAkmStorage,
  makeStashDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let secondary: SandboxedDir;

function writeSharedConcept(root: string, bundleLabel: string): string {
  const filePath = path.join(root, "knowledge", "shared.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `---\ndescription: crossbundlemarker from ${bundleLabel}\n---\n\n# Shared\n\n${bundleLabel}\n`,
    "utf8",
  );
  return filePath;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  secondary = makeStashDir();
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: {
      primary: { path: storage.stashDir, writable: true },
      team: { path: secondary.dir },
    },
    defaultBundle: "primary",
  });
  resetConfigCache();
});

afterEach(() => {
  secondary.cleanup();
  storage.cleanup();
});

describe("full-index bundle identity", () => {
  test("keeps the same concept in two bundles searchable and showable by qualified ref", async () => {
    const primaryPath = writeSharedConcept(storage.stashDir, "primary");
    const teamPath = writeSharedConcept(secondary.dir, "team");

    await akmIndex({ stashDir: storage.stashDir, full: true });

    const result = await akmSearch({ query: "crossbundlemarker", skipLogging: true });
    const refs = result.hits.flatMap((hit) => ("ref" in hit ? [hit.ref] : [])).sort();
    expect(refs).toEqual(["knowledge/shared", "team//knowledge/shared"]);

    const primary = await akmShowUnified({ ref: "primary//knowledge/shared", skipLogging: true });
    const team = await akmShowUnified({ ref: "team//knowledge/shared", skipLogging: true });
    expect({ ref: primary.ref, path: primary.path }).toEqual({
      ref: "knowledge/shared",
      path: primaryPath,
    });
    expect({ ref: team.ref, path: team.path }).toEqual({ ref: "team//knowledge/shared", path: teamPath });
  });
});
