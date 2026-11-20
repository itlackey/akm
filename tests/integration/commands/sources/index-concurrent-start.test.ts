// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Concurrent plain `akm index` runs take the rebuild lock one at a time; a run that finds it held skips and
 * every run exits 0, never 75 or 78 (field follow-up to #956, G1). Spawns TWO REAL CLI child processes (`bun src/cli.ts index
 * --full --format=json`) launched back to back with no work between the two
 * `Bun.spawn` calls, so the index.db write contention `INDEX_DB_CONTENDED`
 * (F1) reclassifies is exercised exactly as a real scheduler/hook double-launch would hit it,
 * unlike index-skip-if-locked.test.ts (plants the rebuild-lock file) or
 * index-db-contention.test.ts (holds a second DB connection open). Neither
 * mechanism collides on every pair on a fast, unloaded machine, so this repeats many small concurrent
 * pairs rather than one pair — empirically the reliable way to actually
 * reproduce the reported bug (verified against the unfixed code: repeated
 * small pairs reproduce a real `exit 78` in a handful of trials, where a
 * single pair usually does not collide at all). Across every trial this pins
 * the property the field bug broke: no process ever exits 78 (config error —
 * the reported regression) or 70 (internal/unclassified), and none exits 75 either.
 *
 * Integration-scoped (ORG-03/06): spawns real child processes, each opening a
 * real index.db.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../../src/core/config/config";
import { readEvents } from "../../../../src/core/events";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

const repoRoot = path.resolve(import.meta.dir, "../../../..");

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  storage.cleanup();
});

function seedMemoryFiles(count: number): void {
  const dir = path.join(storage.stashDir, "memories");
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(
      path.join(dir, `note-${i}.md`),
      `---\ndescription: note ${i}\n---\n\nContent for note ${i}.\n`,
      "utf8",
    );
  }
}

interface ChildResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function spawnIndexChild(extraArgs: string[]): Promise<ChildResult> {
  const child = Bun.spawn(["bun", "src/cli.ts", "index", "--full", "--format=json", ...extraArgs], {
    cwd: repoRoot,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

// A handful of tiny files keeps each trial's own run fast; the collision
// this test needs comes from repeating many concurrent pairs (below), not
// from making any one pair's run slow.
const FILES_PER_TRIAL = 5;
// Empirically the smallest trial count that reliably produced at least one
// real collision (either mechanism) against the unfixed code in repeated
// local runs — see the module doc.
const CONCURRENT_TRIALS = 15;

describe("akm index — two real concurrent runs never fail (field follow-up to #956, G1)", () => {
  test("every run across many concurrent pairs exits 0 with a completed index or a lock-held skip, and builds do not overlap", async () => {
    seedMemoryFiles(FILES_PER_TRIAL);
    let completed = 0;

    for (let trial = 0; trial < CONCURRENT_TRIALS; trial += 1) {
      // Launched back to back with no work in between: whichever process takes the rebuild lock builds, the other
      // skips.
      const results = await Promise.all([spawnIndexChild([]), spawnIndexChild([])]);

      for (const result of results) {
        expect(result.code).toBe(0);
        const parsed = JSON.parse(result.stdout);
        if (parsed.skipped) {
          expect(parsed.skipped.reason).toBe("lock-held");
        } else {
          expect(parsed.totalEntries).toBeGreaterThanOrEqual(FILES_PER_TRIAL);
          completed += 1;
        }
      }
    }
    // Each build records `index_completed` with its duration. Sorted by completion, a build must have started
    // (completion time minus its own duration) after the previous one finished: no two builds overlap.
    const completions = readEvents({ type: "index_completed" })
      .events.map((event) => ({ end: Date.parse(event.ts), totalMs: Number(event.metadata?.totalMs ?? 0) }))
      .sort((a, b) => a.end - b.end);
    expect(completions).toHaveLength(completed);
    for (let i = 1; i < completions.length; i += 1) {
      expect(completions[i]!.end - completions[i]!.totalMs).toBeGreaterThanOrEqual(completions[i - 1]!.end - 5);
    }
  }, 120_000);
});
