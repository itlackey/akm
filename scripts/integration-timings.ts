// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shards the integration suite by recorded duration, and keeps the record.
 *
 * `tests/integration/.timings.json` maps each test file (repo-relative path) to
 * the seconds it took in a past run. `plan` deals the files out longest first,
 * each to the shard with the least recorded time so far; a file with no record
 * weighs the median of the recorded ones. Ties go by path and then by shard
 * number, so every machine plans the same shards from the same inputs. The
 * seconds only rank files against each other: they need not be CI's seconds.
 *
 * `update` folds the junit reports of a run (`scripts/test-integration.sh`
 * writes one per shard, next to its log) into the timings file: a file the
 * reports name takes the reported time, any other recorded file keeps its own,
 * and a file no longer on disk is dropped.
 *
 * Usage:  bun scripts/integration-timings.ts plan <shards> <file>...   # prints "<shard> <file>" lines, shards from 1
 *         bun scripts/integration-timings.ts update <junit.xml>...
 */

import fs from "node:fs";

export const TIMINGS_PATH = "tests/integration/.timings.json";

/** The shard (0-based) of each file: longest first, each to the least-loaded shard. */
export function planShards(files: readonly string[], timings: Record<string, number>, shards: number): string[][] {
  const recorded = Object.values(timings).sort((a, b) => a - b);
  const n = recorded.length;
  // With nothing recorded every file weighs the same, and the plan is a deal by path.
  const median = n === 0 ? 1 : ((recorded[Math.floor((n - 1) / 2)] ?? 0) + (recorded[Math.floor(n / 2)] ?? 0)) / 2;
  const weight = (file: string): number => timings[file] ?? median;
  const order = [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const plan = Array.from({ length: shards }, () => ({ files: [] as string[], load: 0 }));
  for (const file of order) {
    // The lighter shard; on equal load, the one with fewer files, so files with no weight still spread.
    const target = plan.reduce((best, shard) =>
      shard.load < best.load || (shard.load === best.load && shard.files.length < best.files.length) ? shard : best,
    );
    target.files.push(file);
    target.load += weight(file);
  }
  return plan.map((shard) => shard.files);
}

/**
 * Seconds per test file from one bun junit report: the sum of its tests' times. Bun's `<testsuite>` time counts only
 * the tests directly in it, and no element carries a file's `beforeAll`/`afterAll` time, so the tests are the measure.
 */
export function readJunitTimings(xml: string): Record<string, number> {
  const timings: Record<string, number> = {};
  for (const [, attributes = ""] of xml.matchAll(/<testcase\b([^>]*)>/g)) {
    const file = /\bfile="([^"]*)"/.exec(attributes)?.[1];
    const time = Number(/\btime="([^"]*)"/.exec(attributes)?.[1]);
    if (file && Number.isFinite(time)) timings[file] = (timings[file] ?? 0) + time;
  }
  return timings;
}

function readTimings(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(TIMINGS_PATH, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan") {
    const shards = Number(args[0]);
    if (!Number.isInteger(shards) || shards < 1) throw new Error(`plan: shard count must be a positive integer`);
    const plan = planShards(args.slice(1), readTimings(), shards);
    console.log(plan.flatMap((files, k) => files.map((file) => `${k + 1} ${file}`)).join("\n"));
  } else if (command === "update" && args.length > 0) {
    const timings = readTimings();
    for (const report of args) Object.assign(timings, readJunitTimings(fs.readFileSync(report, "utf8")));
    const kept = Object.entries(timings)
      .filter(([file]) => fs.existsSync(file))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([file, seconds]) => [file, Math.round(seconds * 100) / 100]);
    fs.writeFileSync(TIMINGS_PATH, `${JSON.stringify(Object.fromEntries(kept), null, 2)}\n`);
    console.error(`[integration-timings] ${kept.length} files in ${TIMINGS_PATH}`);
  } else {
    console.error("Usage: bun scripts/integration-timings.ts plan <shards> <file>... | update <junit.xml>...");
    process.exit(2);
  }
}
