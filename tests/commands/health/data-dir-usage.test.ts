// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #896: the `data-dir-usage` health advisory must name the data dir's total
 * size and its largest top-level subdirectory (with size + percentage) when
 * the data dir dwarfs the live databases or one subdirectory dominates, and
 * stay silent on a small, balanced data dir. Also covers a data dir holding
 * tens of thousands of small files, the case the walk cap exists for.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectDataDirUsageAdvisory } from "../../../src/commands/health/data-dir-usage";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Write a file of exactly `bytes` size at `filePath`, creating parent dirs. */
/**
 * Create a SPARSE file of `bytes` apparent size. The advisory sums
 * `stat().size`, not allocated blocks, so multi-gigabyte fixtures cost no
 * real disk — which is what makes the incident's 70 GB shape testable.
 */
function writeFileOfSize(filePath: string, bytes: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "");
  fs.truncateSync(filePath, bytes);
}

describe("collectDataDirUsageAdvisory (#896)", () => {
  test("returns undefined when the data dir does not exist", () => {
    expect(collectDataDirUsageAdvisory(path.join(os.tmpdir(), "akm-data-dir-usage-does-not-exist"))).toBeUndefined();
  });

  test("returns undefined for a small, balanced data dir", () => {
    const dataDir = makeTempDir("akm-ddu-balanced-");
    writeFileOfSize(path.join(dataDir, "state.db"), 1_000_000_000);
    writeFileOfSize(path.join(dataDir, "index.db"), 500_000_000);
    writeFileOfSize(path.join(dataDir, "logs.db"), 200_000_000);
    // A modest backups/ dir, comparable in size to the live databases —
    // neither the bloat ratio nor the dominant-subdirectory threshold trips.
    writeFileOfSize(path.join(dataDir, "backups", "task-v3", "snap-1", "files", "a"), 300_000_000);

    expect(collectDataDirUsageAdvisory(dataDir)).toBeUndefined();
  });

  test("warns and names the dominating subdirectory with size and percentage", () => {
    const dataDir = makeTempDir("akm-ddu-dominated-");
    writeFileOfSize(path.join(dataDir, "state.db"), 1_000_000_000);
    writeFileOfSize(path.join(dataDir, "index.db"), 500_000_000);
    writeFileOfSize(path.join(dataDir, "logs.db"), 300_000_000);
    // backups/ dwarfs the live databases and dominates the total.
    for (let i = 0; i < 5; i++) {
      writeFileOfSize(path.join(dataDir, "backups", "migrations", `snap-${i}`, "state.db"), 4_000_000_000);
    }

    const advisory = collectDataDirUsageAdvisory(dataDir);
    expect(advisory).toBeDefined();
    expect(advisory?.name).toBe("data-dir-usage");
    expect(advisory?.status).toBe("warn");
    expect(advisory?.message).toContain("backups/ is");
    expect(advisory?.message).toMatch(/backups\/ is [\d.]+G \(9\d% of data dir\)/);
    const largest = advisory?.evidence?.largestSubdir as { name: string; bytes: number; percent: number };
    expect(largest.name).toBe("backups");
    expect(largest.bytes).toBe(20_000_000_000);
    expect(Math.round(largest.percent)).toBeGreaterThan(90);
  });

  // A fresh install's `state.db-wal` is most of its data dir. Counting it in
  // the total but not as "live" made an untouched install report a ~126x
  // ratio and warn on its very first `akm health`.
  test("counts each database's -wal and -shm sidecars as part of the live set", () => {
    const dataDir = makeTempDir("akm-ddu-wal-");
    writeFileOfSize(path.join(dataDir, "state.db"), 1_000_000_000);
    writeFileOfSize(path.join(dataDir, "state.db-wal"), 20_000_000_000);
    writeFileOfSize(path.join(dataDir, "state.db-shm"), 100_000_000);
    writeFileOfSize(path.join(dataDir, "backups", "snap", "a"), 1_000_000_000);

    // Live is ~21.1 GB of a ~22.1 GB dir. Ignoring the sidecars would score
    // this 22x and warn.
    expect(collectDataDirUsageAdvisory(dataDir)).toBeUndefined();
  });

  test("counts metrics.db as part of the live set", () => {
    const dataDir = makeTempDir("akm-ddu-metrics-");
    writeFileOfSize(path.join(dataDir, "state.db"), 1_000_000_000);
    writeFileOfSize(path.join(dataDir, "metrics.db"), 20_000_000_000);
    writeFileOfSize(path.join(dataDir, "backups", "snap", "a"), 1_000_000_000);

    // Live is 21 GB of a 22 GB dir. Leaving metrics.db out would score this 11x and warn.
    expect(collectDataDirUsageAdvisory(dataDir)).toBeUndefined();
  });

  test("stays silent on a small data dir, whatever the ratio", () => {
    const dataDir = makeTempDir("akm-ddu-small-");
    writeFileOfSize(path.join(dataDir, "state.db"), 8_000);
    writeFileOfSize(path.join(dataDir, "backups", "snap", "a"), 50_000_000);

    expect(collectDataDirUsageAdvisory(dataDir)).toBeUndefined();
  });

  // Guards the walk over a data dir polluted with tens of thousands of small
  // files (task logs, npm logs). Asserts the observable RESULT of the full
  // walk, not a wall-clock delta: `expect(elapsed).toBeLessThan(...)` is flaky
  // under this repo's sharded runners (up to min(nproc, 8) concurrent `bun
  // test` processes) — see tests/integration/ranking-salience-boost.test.ts:155
  // for the same reasoning. The duration is logged for observability, and the
  // test-level timeout is the loose promptness guard.
  test("walks a data dir of ~50k small files without truncating", () => {
    const dataDir = makeTempDir("akm-ddu-manyfiles-");
    writeFileOfSize(path.join(dataDir, "state.db"), 1_000_000);
    const logsDir = path.join(dataDir, "task-logs");
    fs.mkdirSync(logsDir, { recursive: true });
    for (let i = 0; i < 50_000; i++) {
      const f = path.join(logsDir, `run-${i}.log`);
      fs.writeFileSync(f, "");
      fs.truncateSync(f, 100_000); // sparse: 5 GB apparent, ~0 real
    }

    const start = performance.now();
    const advisory = collectDataDirUsageAdvisory(dataDir);
    console.log(`[data-dir-usage] 50k-file walk took ${(performance.now() - start).toFixed(0)}ms`);

    // 50k entries is under MAX_WALK_ENTRIES (100k), so every file is counted:
    // task-logs dominates, and the reported total is exact, not a lower bound.
    const evidence = advisory?.evidence as
      | { totalBytes: number; walkBounded: boolean; largestSubdir?: { name: string; bytes: number } }
      | undefined;
    expect(advisory?.name).toBe("data-dir-usage");
    expect(evidence?.walkBounded).toBe(false);
    expect(evidence?.largestSubdir?.name).toBe("task-logs");
    expect(evidence?.largestSubdir?.bytes).toBe(50_000 * 100_000);
    expect(evidence?.totalBytes).toBe(50_000 * 100_000 + 1_000_000);
  }, 60_000);
});
