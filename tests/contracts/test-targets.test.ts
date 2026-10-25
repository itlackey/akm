// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The unit target is every test outside `tests/integration/`.
 * A test that runs the real embedded OpenCode (its own SQLite database and shell
 * tools) or serves a loopback fake model belongs in the integration target, so
 * the unit target stays the fast one. The fake host (`tests/_helpers/fake-opencode-host.ts`)
 * is what unit tests use in their place.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const testsRoot = path.resolve(import.meta.dir, "..");

/** What a test imports or calls when it runs the real SDK or serves the loopback fake model. */
const REAL_RESOURCES = /@opencode\/(?:sdk|core)|\bcreateSdkHost\b|\bstartFakeModel\b/;

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full !== path.join(testsRoot, "integration")) testFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("the unit test target", () => {
  test("holds no test that runs the real embedded OpenCode or serves a loopback fake model", () => {
    const offenders = testFiles(testsRoot)
      .filter((file) => REAL_RESOURCES.test(fs.readFileSync(file, "utf8").replace(/^\s*(?:\/\/|\*).*$/gm, "")))
      .map((file) => path.relative(testsRoot, file));
    expect(offenders).toEqual([]);
  });
});
