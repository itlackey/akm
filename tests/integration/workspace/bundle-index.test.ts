// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: a real index in isolated storage.
/** `bundles.index` runs the incremental build, which pairs a file renamed on disk with the asset it was. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { bundles } from "../../../src/workspace";
import { makeConfig } from "../../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ ...makeConfig(storage.stashDir), semanticSearchMode: "off" });
  resetConfigCache();
});
afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

test("a file renamed on disk is reported as moved by the next index", async () => {
  const from = path.join(storage.stashDir, "knowledge/old-name.md");
  fs.mkdirSync(path.dirname(from), { recursive: true });
  fs.writeFileSync(from, "---\ndescription: A note\nupdated: 2026-11-01\n---\n\n# A note\n");
  await bundles.index();
  fs.mkdirSync(path.join(storage.stashDir, "knowledge/archive"));
  fs.renameSync(from, path.join(storage.stashDir, "knowledge/archive/old-name.md"));
  const result = await bundles.index();
  expect(result.moves?.moved).toHaveLength(1);
  expect(result.moves?.moved[0]?.to).toContain("knowledge/archive/old-name");
  expect(result.moves?.unpaired).toBe(0);
});
