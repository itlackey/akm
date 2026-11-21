// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync as hostSpawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "../../src/runtime";
import { realNodeExecutable } from "../_helpers/node-runtime";

let dir: string | undefined;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("spawnSync", () => {
  test("returns all of a large output", () => {
    const result = spawnSync(["seq", "1", "600000"]);
    expect(result.success).toBe(true);
    expect(result.stdout.length).toBeGreaterThan(3_000_000);
    expect(result.stdout.toString("utf8").trimEnd().split("\n").length).toBe(600_000);
  });

  test("throws when the program cannot be started", () => {
    expect(() => spawnSync(["/nonexistent/akm-no-such-program"])).toThrow();
  });
});

describe("spawnSync on the Node build", () => {
  test("returns all of a large output and throws when the program cannot be started", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-spawnsync-"));
    const entry = path.join(dir, "entry.ts");
    fs.writeFileSync(
      entry,
      `import { spawnSync } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/runtime"))};
const big = spawnSync(["seq", "1", "600000"]);
let missing = "returned";
try { spawnSync(["/nonexistent/akm-no-such-program"]); } catch { missing = "threw"; }
console.log(JSON.stringify({ lines: big.stdout.toString("utf8").trimEnd().split("\\n").length, success: big.success, missing }));
`,
    );
    const bundle = path.join(dir, "entry.mjs");
    const built = hostSpawnSync("bun", ["build", "--target", "node", entry, "--outfile", bundle], { encoding: "utf8" });
    expect(built.status).toBe(0);
    const ran = hostSpawnSync(realNodeExecutable(), [bundle], { encoding: "utf8", maxBuffer: 1 << 20 });
    expect(JSON.parse(ran.stdout)).toEqual({ lines: 600_000, success: true, missing: "threw" });
  });
});
