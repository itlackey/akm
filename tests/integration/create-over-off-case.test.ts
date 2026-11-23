// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * §0.2 F1: a create without `--force` over an asset that exists under any spelling (`memories/mm.MD`,
 * `knowledge/kk.MD`, `tasks/tt.YML`) is refused like one over the standard spelling: exit 2, RESOURCE_ALREADY_EXISTS,
 * the command's own message, nothing written. With `--force` the file the asset is read from is rewritten (N19).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

const OLD = "---\ndescription: old\n---\n\nold body\n";

function put(rel: string, text: string): string {
  const file = path.join(storage.stashDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function names(dir: string): string[] {
  return fs.readdirSync(path.join(storage.stashDir, dir)).sort();
}

async function refused(args: string[], message: string): Promise<void> {
  const result = await runCliCapture(args);
  expect(result.code, result.stderr).toBe(2);
  const error = JSON.parse(result.stderr.slice(result.stderr.indexOf("{"))) as { code: string; error: string };
  expect(error.code).toBe("RESOURCE_ALREADY_EXISTS");
  expect(error.error).toBe(message);
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

describe("create without --force over an off-case spelling", () => {
  test("`remember` is refused and writes nothing; with --force it rewrites mm.MD", async () => {
    const file = put("memories/mm.MD", OLD);
    await refused(
      ["remember", "new body", "--name", "mm"],
      'Memory "mm" already exists. Re-run with --force to overwrite it.',
    );
    expect(names("memories")).toEqual(["mm.MD"]);
    expect(fs.readFileSync(file, "utf8")).toBe(OLD);

    const forced = await runCliCapture(["remember", "new body", "--name", "mm", "--force", "--format=json"]);
    expect(forced.code, forced.stderr).toBe(0);
    expect(names("memories")).toEqual(["mm.MD"]);
    expect(fs.readFileSync(file, "utf8")).toContain("new body");
    expect((JSON.parse(forced.stdout) as { path: string }).path).toBe(file);
  }, 60_000);

  test("`import` is refused and writes nothing; with --force it rewrites kk.MD", async () => {
    const file = put("knowledge/kk.MD", OLD);
    const source = path.join(storage.root, "kk.md");
    fs.writeFileSync(source, "---\ndescription: new\n---\n\nnew body\n");
    await refused(["import", source], 'Knowledge "kk" already exists. Re-run with --force to overwrite it.');
    expect(names("knowledge")).toEqual(["kk.MD"]);
    expect(fs.readFileSync(file, "utf8")).toBe(OLD);

    expect((await runCliCapture(["import", source, "--force"])).code).toBe(0);
    expect(names("knowledge")).toEqual(["kk.MD"]);
    expect(fs.readFileSync(file, "utf8")).toContain("new body");
  }, 60_000);

  test("`import --type task` is refused and writes nothing; with --force it rewrites tt.YML", async () => {
    const file = put("tasks/tt.YML", "version: 4\nrun: echo old\nname: tt\n");
    const source = path.join(storage.root, "tt.yml");
    fs.writeFileSync(source, "version: 4\nrun: echo new\nname: tt\n");
    await refused(["import", source, "--type", "task"], 'Task "tt" already exists. Pass --force to overwrite.');
    expect(names("tasks")).toEqual(["tt.YML"]);
    expect(fs.readFileSync(file, "utf8")).toContain("echo old");

    expect((await runCliCapture(["import", source, "--type", "task", "--force"])).code).toBe(0);
    expect(names("tasks")).toEqual(["tt.YML"]);
    expect(fs.readFileSync(file, "utf8")).toContain("echo new");
  }, 60_000);

  test("`task add` is refused and writes nothing", async () => {
    const file = put("tasks/tt.YML", "version: 4\nrun: echo old\nname: tt\n");
    await refused(
      ["task", "add", "tt", "--schedule", "@daily", "--command", "echo new"],
      'Task "tt" already exists. Pass --force to overwrite, or delete its file and run `akm doctor scheduler sync` first.',
    );
    expect(names("tasks")).toEqual(["tt.YML"]);
    expect(fs.readFileSync(file, "utf8")).toContain("echo old");
  }, 60_000);
});
