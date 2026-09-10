// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #951: `akm task list` is a pure, zero-logic delegating alias for
 * `akm search --type task` — 0.9.0 removed `task list` as redundant LOGIC
 * (CHANGELOG.md, "akm task list, akm task show, and akm task remove are
 * removed as redundant with the generic asset commands"), not because the
 * SPELLING was off-limits. A second spelling of the identical `akmSearch`
 * call reintroduces no logic, so it does not reopen that decision — and
 * five independently-operated instances report reaching for `list` first.
 * `task show`/`task remove` stay retired; the issue only asks for `list`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
  const tasksDir = path.join(storage.stashDir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(
    path.join(tasksDir, "ping.yml"),
    ["version: 4", "name: Ping", "description: A demo task for the task list alias.", "run: echo ping", ""].join("\n"),
    "utf8",
  );
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

describe("akm task list", () => {
  test("returns the byte-identical envelope to akm search --type task", async () => {
    const list = await runCliCapture(["task", "list", "--format", "json"]);
    resetConfigCache();
    const search = await runCliCapture(["search", "--type", "task", "--format", "json"]);

    expect(list.code).toBe(0);
    expect(search.code).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual(JSON.parse(search.stdout));
  });

  test("finds the task by query, same as search --type task <query>", async () => {
    const list = await runCliCapture(["task", "list", "ping", "--format", "json"]);
    const json = JSON.parse(list.stdout) as { hits: Array<Record<string, unknown>> };

    expect(list.code).toBe(0);
    expect(json.hits.length).toBeGreaterThan(0);
    expect(json.hits.every((hit) => hit.type === "task")).toBe(true);
  });

  test("results alias is present, same as every list-returning command", async () => {
    const list = await runCliCapture(["task", "list", "--format", "json"]);
    const json = JSON.parse(list.stdout) as { hits: unknown; results: unknown };

    expect(list.code).toBe(0);
    expect(json.results).toEqual(json.hits);
  });

  test("passes --limit and --from through", async () => {
    const list = await runCliCapture(["task", "list", "--limit", "1", "--from", "local", "--format", "json"]);
    expect(list.code).toBe(0);
    const json = JSON.parse(list.stdout) as { hits: unknown[] };
    expect(json.hits.length).toBeLessThanOrEqual(1);
  });

  test("rejects the retired --source flag with the same message as search --type task", async () => {
    const list = await runCliCapture(["task", "list", "--source", "registry", "--format", "json"]);
    resetConfigCache();
    const search = await runCliCapture(["search", "--type", "task", "--source", "registry", "--format", "json"]);

    expect(list.code).toBe(2);
    expect(search.code).toBe(2);
    expect(list.stderr).toContain(
      "`--source` was renamed to `--from` in 0.9. Use `--from local|registry|all` instead.",
    );
    expect(JSON.parse(list.stderr)).toEqual(JSON.parse(search.stderr));
  });
});
