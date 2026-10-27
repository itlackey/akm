// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A retired flag still parses, so a scheduled command written for 0.9 keeps
 * running, and `--help` does not advertise it. (The in-process harness answers
 * `--help` with the root overview, so the real CLI is spawned.)
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const cli = path.resolve(import.meta.dir, "..", "..", "src", "cli.ts");
const helpOf = (...args: string[]) =>
  spawnSync("bun", [cli, ...args, "--help"], { encoding: "utf8", timeout: 20_000 }).stdout ?? "";

describe("--help leaves out the retired flags and lists their replacements", () => {
  test("akm improve leaves out --require-engines, which has no replacement", () => {
    const help = helpOf("improve");
    expect(help).not.toContain("--require-engines");
    expect(help).not.toContain("--require-targets");
  });

  test.each([
    [["agent"], "--engine", "--harness"],
    [["command", "run"], "--engine", "--harness"],
    [["proposal", "new"], "--engine", "--harness"],
    [["proposal", "extract"], "--engine", "--harness"],
    [["task", "add"], "--engine", "--harness"],
  ])("akm %p", (command, retired, replacement) => {
    const help = helpOf(...command);
    expect(help).toContain(replacement);
    expect(help).not.toContain(retired);
  });
});
