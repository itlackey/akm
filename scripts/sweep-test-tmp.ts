// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Sweep stale test-sandbox directories out of the OS temp dir.
 *
 * The test harness creates per-process sandbox roots under `os.tmpdir()`:
 *   - `akm-test-suite-*` — the suite-wide sandbox (tests/_preload.ts)
 *   - `akm-sb-*`         — the sandbox helpers (tests/_helpers/sandbox.ts)
 *   - `akm-*`            — many individual tests' ad-hoc `mkdtempSync` fixtures
 *
 * These tear down on normal exit and (now) on catchable signals, but a
 * SIGKILL'd or crashed worker leaks its whole root. Over a long session that
 * accumulated tens of thousands of husks in tmpfs. This sweep is the backstop:
 * it removes ONLY entries under `os.tmpdir()` whose name starts with `akm-`,
 * and ONLY when older than a threshold (default 60 min) so a concurrently-
 * running test suite — whose dirs are fresh — is never touched. Production akm
 * never writes to `/tmp/akm-*` (it uses ~/.local/share/akm and the stash), and
 * the owner's stash lives at ~/akm — so this cannot affect prod data, and a
 * non-akm sibling like `/tmp/openpalm-*` never matches the `akm-` prefix.
 *
 * Best-effort: never throws, always exits 0, so it can prefix test scripts
 * without ever failing a run.
 *
 * Usage:  bun scripts/sweep-test-tmp.ts
 *   AKM_TMP_SWEEP_MIN_AGE_MS — override the age threshold (default 3600000).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every `/tmp/akm-*` entry is a test-sandbox husk (prod uses ~/.local/share/akm
// and the ~/akm stash, never tmp). The `akm-` prefix is deliberately broad so
// the per-test ad-hoc fixtures are swept too; the age guard is what keeps a live
// run safe. NOTE: keep this an `akm-` prefix — never widen to all of tmpdir.
const SWEEP_PREFIXES = ["akm-"] as const;
const DEFAULT_MIN_AGE_MS = 60 * 60 * 1000; // 1 hour

function main(): void {
  const tmp = os.tmpdir();
  const minAgeMs = Number(process.env.AKM_TMP_SWEEP_MIN_AGE_MS) || DEFAULT_MIN_AGE_MS;
  const cutoff = Date.now() - minAgeMs;

  let entries: string[];
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return; // tmp unreadable — nothing to do.
  }

  let removed = 0;
  for (const name of entries) {
    if (!SWEEP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const full = path.join(tmp, name);
    try {
      const stat = fs.lstatSync(full);
      if (!stat.isDirectory()) continue;
      // Age guard: skip anything a live run may still be using.
      if (stat.mtimeMs > cutoff) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Best-effort per entry; ignore (e.g. removed concurrently).
    }
  }

  if (removed > 0) {
    console.error(`[sweep-test-tmp] removed ${removed} stale test-sandbox dir(s) from ${tmp}`);
  }
}

main();
