// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration (real CLI processes): B10-41 and B10-46.

import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getConfigPath } from "../../src/core/paths";
import { withIsolatedAkmStorage } from "../_helpers/sandbox";

const CLI = path.resolve(import.meta.dir, "../../src/cli.ts");
let cleanup = () => {};
afterEach(() => cleanup());

function cli(args: string[]) {
  return spawnSync("bun", [CLI, ...args], { encoding: "utf8", env: { ...process.env }, timeout: 60000 });
}

function writeConfig(value: unknown): void {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(value));
}

test("akm migrate status prints an unknown key's warning once", () => {
  cleanup = withIsolatedAkmStorage().cleanup;
  // usage.report false returns before any network call; CI/NODE_ENV/BUN_TEST are removed so the report path is reached.
  writeConfig({ configVersion: "0.9.0", usage: { report: false }, fooBar: 1 });
  const env = { ...process.env };
  for (const name of ["CI", "NODE_ENV", "BUN_TEST"]) delete env[name];
  const result = spawnSync("bun", [CLI, "migrate", "status"], { encoding: "utf8", env, timeout: 60000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr.split("\n").filter((line) => line.includes("Unknown config key"))).toHaveLength(1);
});

test("config set refuses an unknown key and leaves the file as it was; config unset removes a hand-written one", () => {
  cleanup = withIsolatedAkmStorage().cleanup;
  writeConfig({ configVersion: "0.9.0", semanticSearchMode: "off" });
  const before = fs.readFileSync(getConfigPath(), "utf8");
  const refused = cli(["config", "set", "fooBar", "1"]);
  expect(refused.status).toBe(2);
  expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);

  writeConfig({ configVersion: "0.9.0", semanticSearchMode: "off", fooBar: 1 });
  const removed = cli(["config", "unset", "fooBar"]);
  expect(removed.status, removed.stderr).toBe(0);
  expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).fooBar).toBeUndefined();
});

test("migrate apply names the task file it rewrote and the backup, in JSON and in text", () => {
  const storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  writeConfig({
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    defaultBundle: "local",
    bundles: {
      local: {
        path: storage.stashDir,
        adapter: "akm",
        writable: true,
      },
    },
  });
  const taskPath = path.join(storage.stashDir, "tasks", "legacy.yml");
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  const original = 'version: 2\nschedule: "@daily"\nprompt: Say hello\n';
  fs.writeFileSync(taskPath, original);
  const applied = cli(["migrate", "apply"]);
  expect(applied.status, applied.stderr).toBe(0);
  const result = JSON.parse(applied.stdout);
  expect(result.taskFiles.changed).toBe(1);
  expect(result.taskFiles.files).toMatchObject([{ filePath: taskPath, status: "changed" }]);
  expect(fs.existsSync(result.backupPath)).toBe(true);

  fs.writeFileSync(taskPath, original);
  const text = cli(["migrate", "apply", "--format", "text"]);
  expect(text.status, text.stderr).toBe(0);
  expect(text.stdout).toContain(taskPath);
  expect(text.stdout).toContain("backup:");
});
