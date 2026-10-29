// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `--help` of the commands that take `--no-probe`: probing is the default, so
 * only the opt-out is offered. (The in-process harness answers `--help` with
 * the root overview, so the real CLI is spawned.)
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const cli = path.resolve(import.meta.dir, "..", "..", "src", "cli.ts");
const helpOf = (...args: string[]) =>
  spawnSync("bun", [cli, ...args, "--help"], { encoding: "utf8", timeout: 20_000 }).stdout ?? "";

describe("--no-probe in --help", () => {
  for (const command of [["setup"], ["models"], ["models", "set"]]) {
    test(`akm ${command.join(" ")} lists --no-probe and no --probe`, () => {
      const help = helpOf(...command);
      expect(help).toContain("--no-probe");
      expect(help).not.toContain("--probe");
    });
  }
});
