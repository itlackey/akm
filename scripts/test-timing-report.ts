// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Runs `bun test --verbose ./tests` and emits a sorted timing report
 * showing the N slowest test files and top N slowest individual tests.
 *
 * Usage: bun run test:time [--top=N]
 *
 * The output helps identify which 10-15 tests account for >50% of
 * total suite time so targeted speedup PRs can be filed against them.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

const TOP_N = Number(process.argv.find((a) => a.startsWith("--top="))?.split("=")[1] ?? 20);
const repoRoot = path.resolve(import.meta.dir, "..");

const result = spawnSync(
  process.execPath,
  ["test", "--verbose", "./tests"],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);

const output = (result.stdout ?? "") + (result.stderr ?? "");

// Bun verbose output: lines like "  ✓ test name (12ms)" or "  ✗ test name (34ms)"
const testLineRe = /^\s+[✓✗x✔]\s+(.+?)\s+\((\d+)ms\)/;
// Bun file summary: lines like "tests/foo.test.ts: 12 pass (456ms)"
const fileSummaryRe = /^(tests\/.+\.test\.ts):\s+\d+ (?:pass|tests?)\s+\((\d+)ms\)/;

type TimedEntry = { name: string; ms: number };

const slowTests: TimedEntry[] = [];
const slowFiles: TimedEntry[] = [];

for (const line of output.split("\n")) {
  const tm = testLineRe.exec(line);
  if (tm) {
    slowTests.push({ name: tm[1], ms: Number(tm[2]) });
    continue;
  }
  const fm = fileSummaryRe.exec(line.trim());
  if (fm) {
    slowFiles.push({ name: fm[1], ms: Number(fm[2]) });
  }
}

slowTests.sort((a, b) => b.ms - a.ms);
slowFiles.sort((a, b) => b.ms - a.ms);

const totalMs = slowFiles.reduce((s, f) => s + f.ms, 0);
const top20FileMs = slowFiles.slice(0, TOP_N).reduce((s, f) => s + f.ms, 0);

console.log(`\n=== Slowest ${TOP_N} test files (${Math.round(top20FileMs / 1000)}s of ${Math.round(totalMs / 1000)}s total) ===`);
for (const f of slowFiles.slice(0, TOP_N)) {
  const pct = totalMs > 0 ? ((f.ms / totalMs) * 100).toFixed(1) : "?";
  console.log(`  ${String(f.ms).padStart(6)}ms  ${pct.padStart(5)}%  ${f.name}`);
}

if (slowTests.length > 0) {
  console.log(`\n=== Slowest ${TOP_N} individual tests ===`);
  for (const t of slowTests.slice(0, TOP_N)) {
    console.log(`  ${String(t.ms).padStart(6)}ms  ${t.name}`);
  }
}

console.log(`\nTotal suite: ${Math.round(totalMs / 1000)}s across ${slowFiles.length} files\n`);
