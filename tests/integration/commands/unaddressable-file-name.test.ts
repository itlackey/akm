// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A file whose name is no valid concept id (`knowledge/guide#section.md`: `#` is the fragment separator in a ref) does
 * not stop a walk of its bundle. `env list`, `secret list`, `lint` and `index` print what 0.10.261130 printed for the
 * same bundle: the file is listed, linted and indexed under `knowledge/guide#section`, and no ref can show it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { runCliStatus as runCli } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(storage.stashDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(storage.stashDir, rel), content);
  };
  write("env/dev.env", "A=1\n");
  write("knowledge/ok.md", "---\ndescription: ok doc\n---\n# OK\nhello\n");
  write("knowledge/guide#section.md", "---\ndescription: guide section\n---\n# Guide\nsection body\n");
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: { b: { path: storage.stashDir, adapter: "akm", writable: true } },
    defaultBundle: "b",
  });
});

afterEach(() => storage.cleanup());

describe("a file whose name is no concept id", () => {
  test("env list and secret list list the bundle", async () => {
    const env = await runCli(["env", "list"]);
    expect(env.status).toBe(0);
    expect(JSON.parse(env.stdout).envs).toEqual([{ ref: "env/dev", keys: ["A"] }]);

    const secrets = await runCli(["secret", "list"]);
    expect(secrets.status).toBe(0);
    expect(JSON.parse(secrets.stdout).secrets).toEqual([]);
  });

  test("lint lints it with the other assets", async () => {
    const { status, stdout } = await runCli(["lint"]);
    expect(status).toBe(0);
    const report = JSON.parse(stdout) as { ok: boolean; flagged: Array<{ file: string; issue: string; ref: string }> };
    expect(report.ok).toBe(true);
    expect(report.flagged.map(({ file, issue, ref }) => ({ file, issue, ref }))).toEqual([
      { file: "knowledge/ok.md", issue: "missing-updated", ref: "knowledge/ok" },
      { file: "knowledge/guide#section.md", issue: "missing-updated", ref: "knowledge/guide#section" },
    ]);
  });

  test("index indexes it, search finds it, and its ref reads as a fragment", async () => {
    const index = await runCli(["index"]);
    expect(index.status).toBe(0);
    expect(JSON.parse(index.stdout).totalEntries).toBe(3);

    const search = await runCli(["search", "section"]);
    expect(search.status).toBe(0);
    expect(JSON.parse(search.stdout).hits.map((hit: { ref: string }) => hit.ref)).toEqual(["knowledge/guide#section"]);

    const show = await runCli(["show", "knowledge/guide#section"]);
    expect(show.status).toBe(1);
    expect(JSON.parse(show.stderr).code).toBe("ASSET_NOT_FOUND");
  });
});
