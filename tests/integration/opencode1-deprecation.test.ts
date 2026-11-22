// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode 1 is Deprecated and removed in 0.11: a run on it prints one stderr line, which `--quiet` and akm's own
 * invocations (a task, the scheduler) silence, and a run on OpenCode 2 prints none. The real CLI against a fake
 * `opencode` that reports its version and prints OpenCode 1's recorded output.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../_helpers/sandbox";

const CLI = path.resolve(import.meta.dir, "../../src/cli.ts");
const OK_OUTPUT = path.resolve(import.meta.dir, "../fixtures/opencode1-run/oc1-ok.out");

let storage: IsolatedAkmStorage;
let bins: SandboxedDir;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  bins = makeSandboxDir("akm-opencode1-deprecation-bin");
  fs.mkdirSync(path.join(storage.stashDir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(storage.stashDir, "agents", "reader.md"), "---\ntype: agent\n---\nA careful reader.\n");
});

afterEach(() => {
  bins.cleanup();
  storage.cleanup();
});

/** Configure a fake `opencode` that reports `version`, and run `akm run agents/reader` against it. */
function run(version: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const bin = path.join(bins.dir, "opencode");
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\ncat >/dev/null\ncat ${JSON.stringify(OK_OUTPUT)}\n`,
    { mode: 0o755 },
  );
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "fixture",
    bundles: { fixture: { path: storage.stashDir, components: { main: { root: ".", adapter: "akm" } } } },
    harnesses: { opencode: { platform: "opencode", bin } },
  });
  const spawn = (args: string[], more: NodeJS.ProcessEnv) =>
    spawnSync("bun", [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: undefined, AKM_EVENT_SOURCE: undefined, ...more },
      timeout: 60000,
    });
  spawn(["index", "--full"], {});
  return spawn(["run", "agents/reader", "--prompt", "x", "--format=json", ...extra], env);
}

const noticeLines = (stderr: string) => stderr.split("\n").filter((line) => line.includes("OpenCode 1"));

test("a run on OpenCode 1 prints one line naming the binary, its version and the removal in 0.11", () => {
  const result = run("1.18.25");
  expect(result.status).toBe(0);
  const lines = noticeLines(result.stderr);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("[deprecated] OpenCode 1");
  expect(lines[0]).toContain("1.18.25");
  expect(lines[0]).toContain("removed in 0.11");
  expect(lines[0]).toContain("install OpenCode 2");
});

test("--quiet and an akm-internal invocation print nothing", () => {
  for (const result of [run("1.18.25", ["--quiet"]), run("1.18.25", [], { AKM_EVENT_SOURCE: "task" })]) {
    expect(result.status).toBe(0);
    expect(noticeLines(result.stderr)).toHaveLength(0);
  }
});

test("a run on OpenCode 2 prints none", () => {
  const result = run("2.2.0");
  expect(result.status).toBe(0);
  expect(noticeLines(result.stderr)).toHaveLength(0);
});
