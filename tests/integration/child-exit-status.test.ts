// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A child's status becomes akm's exit code, and a failure akm already recorded is never turned into success or into
 * another status by it. Run as akm's own process ends: a real process, its exit status read by the caller.
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const SHARED = path.resolve(import.meta.dir, "../../src/cli/shared.ts");

/** The exit status of a process that had `recorded` as its exit code and then reported the child's `code`. */
function exitStatus(recorded: number | undefined, code: number): number | null {
  const program = `
    const { reportChildExit } = await import(${JSON.stringify(SHARED)});
    ${recorded === undefined ? "" : `process.exitCode = ${recorded};`}
    reportChildExit(${code});`;
  return spawnSync(process.execPath, ["-e", program], { encoding: "utf8" }).status;
}

test.each([
  { recorded: undefined, child: 0, status: 0, says: "a child that succeeded, with nothing recorded, is success" },
  { recorded: undefined, child: 5, status: 5, says: "a child's failure, with nothing recorded, is akm's status" },
  { recorded: 0, child: 5, status: 5, says: "a child's failure when the host had set 0 is akm's status" },
  { recorded: 3, child: 0, status: 3, says: "a recorded failure is kept when the child exits 0" },
  { recorded: 3, child: 5, status: 3, says: "a recorded failure is kept when the child fails differently" },
])("$says", ({ recorded, child, status }) => {
  expect(exitStatus(recorded, child)).toBe(status);
});
