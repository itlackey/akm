// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
    expect(error.hint).toContain("use `akm judge reflect.quality`");
    expect(result.stdout).not.toContain("scope");
  });

  test("a normal scope still reaches the improve run (here: its no-connection stop, so no model is called)", async () => {
    const result = await runCliCapture(["improve", "lesson", "--dry-run", "--format=json"]);
    expect(result.code).toBe(78);
    expect((JSON.parse(result.stderr.trim()) as { code?: string }).code).toBe("LLM_NOT_CONFIGURED");
  });
});
