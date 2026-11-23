// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The unit target is every test outside `tests/integration/`. A file stays in it only if none of its tests, directly,
 * through a helper or through the `src/` code it calls, starts a process, runs a CLI entry, opens a server or socket,
 * opens a SQLite file, or writes anything to disk. Injected doubles, env changes and read-only reads of checked-in
 * files are allowed. The full rule is "Where a test goes" in docs/architecture/testing/testing-workflow.md.
 *
 * This guard checks the markers a test file shows itself; product code or a helper that does the I/O is not visible
 * here, and `scripts/test-unit.sh` timings are what catch it.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const testsRoot = path.resolve(import.meta.dir, "..");

/** What a test imports or calls when it runs a process, a CLI entry, a server, a SQLite file or real disk I/O. */
const REAL_RESOURCES = [
  /\bfetchSharedOpencode\b/,
  /\bstartFakeModel\b/,
  /\brunCliCapture\b/,
  /\brunCliStatus\b/,
  /\bwithIsolatedAkmStorage\b/,
  /\bmakeSandboxDir\b/,
  /\bmakeStashDir\b/,
  /\bmkdtempSync\b/,
  /\bwriteSandboxConfig\b/,
  /\bseedLockEntries\b/,
  /\bloadFixtureStash\b/,
  /\bwriteFakeHarness\b/,
  /\bwithOpencodeOnPath\b/,
  /\bakmIndex\b/,
  /\bBun\.serve\b/,
  /\bBun\.spawn\b/,
];

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
  test("holds no test that runs a process, a CLI entry or a server, or opens a SQLite file or writes to disk", () => {
    const offenders = testFiles(testsRoot)
      .filter((file) => {
        const text = fs.readFileSync(file, "utf8").replace(/^\s*(?:\/\/|\*).*$/gm, "");
        return REAL_RESOURCES.some((marker) => marker.test(text));
      })
      .map((file) => path.relative(testsRoot, file));
    expect(offenders).toEqual([]);
  });
});
