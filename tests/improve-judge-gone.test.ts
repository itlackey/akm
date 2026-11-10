// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmIndex } from "../src/indexer/indexer";
import { runCliCapture } from "./_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "fixture",
    bundles: { fixture: { path: storage.stashDir, components: { main: { root: ".", adapter: "akm" } } } },
  });
});

afterEach(() => storage.cleanup());

describe("akm improve judge (removed)", () => {
  test("exits 2 naming `akm judge reflect.quality` and does no improve work", async () => {
    const result = await runCliCapture(["improve", "judge", "--format=json"]);
    expect(result.code).toBe(2);
    const error = JSON.parse(result.stderr.trim()) as { code?: string; hint?: string };
    expect(error.code).toBe("UNKNOWN_COMMAND");
    expect(error.hint).toContain("akm judge reflect.quality");
    expect(result.stdout).toBe("");
  });

  test("a root asset named `judge` is still a scope", async () => {
    fs.writeFileSync(path.join(storage.stashDir, "judge.md"), "---\ndescription: a root note\n---\nbody\n");
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const result = await runCliCapture(["improve", "judge", "--dry-run", "--format=json"]);
    expect(result.code).toBe(78);
    expect((JSON.parse(result.stderr.trim()) as { code?: string }).code).toBe("LLM_NOT_CONFIGURED");
  });
});
