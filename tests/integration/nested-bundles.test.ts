// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Bundles whose directories nest (`a` at `st/`, `s` at `st/team/`) keep working as they did at 1f2e58c9: the index files
 * a shared file under the first bundle only, and a read (`env list`, `show`, `search`) never moves a row from one
 * bundle to the other, lists a file once, or makes the next `akm index` rescan.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { closeDatabase, openReadonlyExistingDatabase } from "../../src/storage/repositories/index-connection";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function rows(): Array<{ item_ref: string; type: string }> {
  const db = openReadonlyExistingDatabase(getDbPath());
  if (!db) throw new Error("no index");
  try {
    return db.prepare("SELECT item_ref, type FROM entries ORDER BY item_ref").all() as never;
  } finally {
    closeDatabase(db);
  }
}

async function json<T>(...args: string[]): Promise<T> {
  const result = await runCliCapture([...args, "--format=json"]);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
}

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  const st = path.join(storage.root, "st");
  write(path.join(st, "knowledge", "outer.md"), "---\ndescription: outer note\n---\n\nOuter.\n");
  write(path.join(st, "env", "outer.env"), "OUTER=1\n");
  write(path.join(st, "team", "knowledge", "inner.md"), "---\ndescription: inner note\n---\n\nInner.\n");
  write(path.join(st, "team", "env", "inner.env"), "INNER=1\n");
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: { a: { path: st }, s: { path: path.join(st, "team") } },
    defaultBundle: "a",
  });
  resetConfigCache();
  expect((await runCliCapture(["index", "--full"])).code).toBe(0);
});

afterEach(() => {
  storage.cleanup();
});

describe("nested bundles", () => {
  test("the index files a shared file under the first bundle", () => {
    expect(rows().map((row) => row.item_ref)).toEqual([
      "a//env/outer",
      "a//knowledge/outer",
      "a//team/env/inner",
      "a//team/knowledge/inner",
    ]);
  });

  test("`env list` lists the nested bundle's env once and in its folder only", async () => {
    const { envs } = await json<{ envs: Array<{ ref: string }> }>("env", "list");
    expect(envs.map((env) => env.ref)).toEqual(["env/outer", "s//env/inner"]);
  }, 60_000);

  test("reads do not move index rows, and the next index rescans nothing", async () => {
    const before = rows();
    await runCliCapture(["env", "list"]);
    expect((await runCliCapture(["show", "s//knowledge/inner"])).code).toBe(0);
    const search = await json<{ hits: Array<{ ref: string }> }>("search", "note");
    expect(search.hits.map((hit) => hit.ref).sort()).toEqual(["knowledge/outer", "team/knowledge/inner"]);
    // A command that names the file under the second bundle may be refused; it must not re-file the row.
    await runCliCapture(["feedback", "s//knowledge/inner", "--positive"]);

    expect(rows()).toEqual(before);
    const again = await json<{ directoriesScanned: number }>("index");
    expect(again.directoriesScanned).toBe(0);
  }, 60_000);
});
