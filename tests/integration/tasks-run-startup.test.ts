// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getMigrationApplyJournalPath } from "../../src/core/migration-backup";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
});

afterEach(() => {
  storage.cleanup();
});

describe("tasks run startup", () => {
  test("pending migration blocks a command target before any side effect", async () => {
    fs.writeFileSync(path.join(storage.configDir, "akm", "config.json"), '{"configVersion":', "utf8");
    const sideEffectPath = path.join(storage.root, "command-side-effect");
    fs.writeFileSync(
      path.join(storage.stashDir, "tasks", "blocked-command.yml"),
      [
        "version: 2",
        'schedule: "@daily"',
        `command: ${JSON.stringify([
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(sideEffectPath)}, "ran")`,
        ])}`,
        "enabled: true",
        "",
      ].join("\n"),
      "utf8",
    );
    const journalPath = getMigrationApplyJournalPath();
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, "{}\n", { mode: 0o600 });

    const child = Bun.spawn(["bun", "src/cli.ts", "tasks", "run", "blocked-command", "--scheduled"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(code).toBe(78);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({ ok: false, code: "INVALID_CONFIG_FILE" });
    expect(stderr).toContain("recovery is pending");
    expect(fs.existsSync(sideEffectPath)).toBe(false);
  });
});
