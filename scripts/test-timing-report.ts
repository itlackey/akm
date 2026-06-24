// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Emits a sorted timing report showing the N slowest test files.
 *
 * Usage:
 *   bun run test:time [--top=N] [path ...]
 *   bun scripts/test-timing-report.ts [--top=N] [path ...]
 *
 * With no path arguments every `*.test.ts` under ./tests is timed; pass one
 * or more paths (files or directories) to scope the report to a subset.
 *
 * Why per-file (and not per-test): when `bun test` runs non-interactively
 * (spawned, no TTY) it prints only the run summary — `Ran N tests across M
 * files. [T ms]` — and no per-test or per-file timing lines. So the most
 * reliable way to rank files is to run each file on its own and read the
 * single-file summary's wall time. The output helps identify which handful of
 * files account for most of the suite time so targeted speedup PRs can be
 * filed against them.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const TOP_N = Number(args.find((a) => a.startsWith("--top="))?.split("=")[1] ?? 20);
const targets = args.filter((a) => !a.startsWith("--"));

const repoRoot = path.resolve(import.meta.dir, "..");

// The default `bun run test:unit` scope is `./tests
// --path-ignore-patterns=tests/integration`, so the bare report (no path args)
// must mirror that and skip `tests/integration/` — otherwise ~111s of files
// that never run in test:unit pollute the totals and the per-file ranking (the
// #664 measurement caveat). Passing an explicit path still times whatever the
// caller names, integration included.
const UNIT_IGNORE_DIR = path.join(repoRoot, "tests", "integration");

/** Recursively collect *.test.ts files under a directory. */
function collectTests(dir: string, options: { excludeIntegration?: boolean } = {}): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      if (options.excludeIntegration && path.resolve(full) === UNIT_IGNORE_DIR) continue;
      results.push(...collectTests(full, options));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      results.push(full);
    }
  }
  return results;
}

/** Resolve CLI targets (files or dirs) to a flat list of test files. */
function resolveTargets(rawTargets: string[]): string[] {
  if (rawTargets.length === 0) {
    // Mirror test:unit: every *.test.ts under ./tests EXCEPT tests/integration.
    return collectTests(path.join(repoRoot, "tests"), { excludeIntegration: true });
  }
  const files: string[] = [];
  for (const t of rawTargets) {
    const abs = path.isAbsolute(t) ? t : path.resolve(repoRoot, t);
    if (!fs.existsSync(abs)) {
      console.error(`warning: skipping missing path ${t}`);
      continue;
    }
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      files.push(...collectTests(abs));
    } else if (abs.endsWith(".test.ts")) {
      files.push(abs);
    }
  }
  return files;
}

// Parses bun's run summary, e.g. "Ran 19 tests across 1 file. [138.00ms]".
// Duration may be reported in ms or s depending on magnitude.
const summaryRe = /Ran\s+\d+\s+tests?\s+across\s+\d+\s+files?\.\s+\[([\d.]+)(ms|s)\]/;

type TimedEntry = { name: string; ms: number };

const slowFiles: TimedEntry[] = [];
const files = resolveTargets(targets);

if (files.length === 0) {
  console.error("No test files matched.");
  process.exit(1);
}

console.log(`Timing ${files.length} test file(s)...\n`);

for (const file of files) {
  const rel = path.relative(repoRoot, file);
  const started = Date.now();
  const result = spawnSync(process.execPath, ["test", file], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const wall = Date.now() - started;
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  const m = summaryRe.exec(output);
  // Prefer bun's reported in-suite time; fall back to measured wall time so a
  // file always contributes an entry even if the summary line shifts format.
  let ms = wall;
  if (m) {
    const value = Number(m[1]);
    ms = m[2] === "s" ? value * 1000 : value;
  }
  slowFiles.push({ name: rel, ms: Math.round(ms) });
}

slowFiles.sort((a, b) => b.ms - a.ms);

const totalMs = slowFiles.reduce((s, f) => s + f.ms, 0);
const topFileMs = slowFiles.slice(0, TOP_N).reduce((s, f) => s + f.ms, 0);

console.log(
  `=== Slowest ${TOP_N} test files (${Math.round(topFileMs / 1000)}s of ${Math.round(totalMs / 1000)}s total) ===`,
);
for (const f of slowFiles.slice(0, TOP_N)) {
  const pct = totalMs > 0 ? ((f.ms / totalMs) * 100).toFixed(1) : "?";
  console.log(`  ${String(f.ms).padStart(6)}ms  ${pct.padStart(5)}%  ${f.name}`);
}

console.log(`\nTotal: ${Math.round(totalMs / 1000)}s across ${slowFiles.length} files\n`);
