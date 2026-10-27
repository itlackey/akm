// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Sweep the sandbox roots of test runs that died out of the OS temp dir.
 *
 * A test process that creates a sandbox root (the suite root in
 * `tests/_preload.ts`, the roots of `tests/_helpers/sandbox.ts`) registers it with
 * `registerTestRoot`: one line in a lease file named for the process, kept apart
 * from the root so the root holds nothing the test did not put there. A SIGKILL'd
 * or crashed process leaks its roots, and this sweep removes exactly the roots a
 * lease lists once the process that holds the lease is gone. A directory no lease
 * lists is not the sweep's, whatever its name or age: akm's own
 * `akm-model-work-*` scratch (the run that made it removes it), another tool's
 * `akm-*` directory, a person's checkout. A root whose process is alive is in
 * use, however old it is.
 *
 * Best-effort: never throws, always exits 0, so it can prefix test scripts
 * without ever failing a run.
 *
 * Usage:  bun scripts/sweep-test-tmp.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where the leases are kept, inside the temp dir. */
function leaseDir(tmp: string): string {
  return path.join(tmp, ".akm-test-leases");
}

/** Record `dir`, a directory directly under the temp dir, as a root this process created and will remove. */
export function registerTestRoot(dir: string): void {
  const leases = leaseDir(os.tmpdir());
  fs.mkdirSync(leases, { recursive: true });
  fs.appendFileSync(path.join(leases, String(process.pid)), `${dir}\n`);
}

/** Whether `pid` names a running process (one this user may not signal is running). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove the roots listed by the leases under `tmp` whose process is gone; the number removed. */
export function sweepTestTmp(tmp: string): number {
  const leases = leaseDir(tmp);
  let held: string[];
  try {
    held = fs.readdirSync(leases);
  } catch {
    return 0; // No lease was ever taken here.
  }
  let removed = 0;
  for (const name of held) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0 || isAlive(pid)) continue;
    const lease = path.join(leases, name);
    try {
      for (const dir of fs.readFileSync(lease, "utf8").split("\n")) {
        // A lease lists direct children of the temp dir; a line that is anything else is not this sweep's to remove.
        if (dir === "" || path.dirname(dir) !== tmp || !fs.existsSync(dir)) continue;
        if (!fs.lstatSync(dir).isDirectory()) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      }
      fs.rmSync(lease, { force: true });
    } catch {
      // Best-effort per lease; the next sweep retries.
    }
  }
  return removed;
}

if (import.meta.main) {
  const tmp = os.tmpdir();
  const removed = sweepTestTmp(tmp);
  if (removed > 0) console.error(`[sweep-test-tmp] removed ${removed} dead test-sandbox dir(s) from ${tmp}`);
}
