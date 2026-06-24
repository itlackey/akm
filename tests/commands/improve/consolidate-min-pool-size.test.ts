// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #553 — consolidate `minPoolSize` guard.
 *
 * The consolidation pass skips entirely (zero LLM calls) when the eligible
 * memory pool is below `processes.consolidate.minPoolSize`. The skip is emitted
 * as an `improve_skipped` event with `reason: "pool_below_min_size"` (reusing
 * the #551 emission path), which the health command's dynamic skip-reason
 * aggregation surfaces. `minPoolSize: 0` disables the guard; the default is 500.
 *
 * These tests pin: skip-below-threshold (+event, +zero LLM), runs-at-threshold
 * (guard does not preempt the run), disable-with-0, and health visibility. They
 * use small sandboxed pools and a tiny `minPoolSize` so the guard boundary is
 * exercised deterministically without seeding 500 memories.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmHealth } from "../../../src/commands/health";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmConfig } from "../../../src/core/config/config";
import { saveConfig } from "../../../src/core/config/config";
import { readEvents } from "../../../src/core/events";
import { type Cleanup, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { type SeededEntries, seedEntries } from "../../_helpers/seed-entries";

const TIMEOUT_MS = 20_000;

let cleanup: Cleanup = () => {};
let stashDir = "";
const seededDbs: SeededEntries[] = [];

function memoryPath(name: string): string {
  return path.join(stashDir, "memories", `${name}.md`);
}

function writeMemory(name: string, body: string): void {
  const filePath = memoryPath(name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n---\n\n${body}\n`, "utf8");
}

// #664 Seam 2: the consolidate pool-size guard counts the eligible memory pool
// from the planner's `getAllEntries`, so seed those rows into an in-memory index
// DB instead of running a full on-disk FTS rebuild (`akmIndex({full:true})`).
// The backing files are still written by writeMemory (the mtime pool-delta gate
// and existsSync guard read them); `filePath` points at the same path.
function seedMemories(names: string[]): SeededEntries["getAllEntries"] {
  const s = seedEntries(names.map((name) => ({ name, type: "memory", stashDir, filePath: memoryPath(name) })));
  seededDbs.push(s);
  return s.getAllEntries;
}

/** Config with the consolidate process enabled and a specific minPoolSize. */
function configWithMinPoolSize(minPoolSize: number): AkmConfig {
  return {
    semanticSearchMode: "off",
    profiles: {
      improve: {
        default: {
          processes: { consolidate: { enabled: true, minPoolSize }, extract: { enabled: false } },
        },
      },
    },
  } as unknown as AkmConfig;
}

/** Drive an improve(memory) run with no LLM connection configured. */
async function runImprove(config: AkmConfig, getAllEntries: SeededEntries["getAllEntries"]): Promise<void> {
  await akmImprove({
    scope: "memory",
    config,
    stashDir,
    getAllEntries,
    minRetrievalCount: 0,
    ensureIndexFn: async () => false,
    reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
  });
}

function poolBelowMinSizeEvents() {
  return readEvents({ type: "improve_skipped", ref: "memory:_consolidation" }).events.filter(
    (e) => e.metadata?.reason === "pool_below_min_size",
  );
}

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
  cleanup = storage.cleanup;
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  for (const s of seededDbs.splice(0)) s.close();
  cleanup();
  cleanup = () => {};
  stashDir = "";
});

describe("#553 consolidate minPoolSize guard", () => {
  test(
    "eligible pool BELOW minPoolSize → skip + pool_below_min_size event + ZERO consolidate run",
    async () => {
      writeMemory("only-mem", "A single memory — well below the guard.");
      const getAllEntries = seedMemories(["only-mem"]);

      // No prior consolidate_completed event exists, so the #551 mtime-delta
      // gate would normally treat this as the bootstrap "run once" path. The
      // #553 pool guard must preempt it: pool size 1 < minPoolSize 3.
      await runImprove(configWithMinPoolSize(3), getAllEntries);

      const skips = poolBelowMinSizeEvents();
      expect(skips.length).toBe(1);
      expect(skips[0]?.metadata?.poolSize).toBe(1);
      expect(skips[0]?.metadata?.minPoolSize).toBe(3);

      // Zero LLM work: consolidation never entered, so no consolidate_completed
      // event was recorded and no `consolidation_no_memory_updates` (mtime-gate)
      // event fired either — the pool guard short-circuited before both.
      const completed = readEvents({ type: "consolidate_completed" }).events;
      expect(completed.length).toBe(0);
      const mtimeSkips = readEvents({ type: "improve_skipped", ref: "memory:_consolidation" }).events.filter(
        (e) => e.metadata?.reason === "consolidation_no_memory_updates",
      );
      expect(mtimeSkips.length).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "eligible pool AT/ABOVE minPoolSize → guard does NOT skip (no pool_below_min_size event)",
    async () => {
      const names = Array.from({ length: 5 }, (_, i) => `mem-${i}`);
      for (const name of names) writeMemory(name, `Memory ${name}.`);
      const getAllEntries = seedMemories(names);

      // Pool size 5 >= minPoolSize 3 → the pool guard is inert. With no LLM
      // configured the pass proceeds past the guard into the mtime/cooldown gate
      // (the #551 behaviour); crucially, NO pool_below_min_size event.
      await runImprove(configWithMinPoolSize(3), getAllEntries);

      expect(poolBelowMinSizeEvents().length).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "minPoolSize: 0 disables the guard → never skips on size even for a tiny pool",
    async () => {
      writeMemory("only-mem", "A single memory; guard disabled.");
      const getAllEntries = seedMemories(["only-mem"]);

      await runImprove(configWithMinPoolSize(0), getAllEntries);

      expect(poolBelowMinSizeEvents().length).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "health surfaces pool_below_min_size in improve skip-reason aggregation",
    async () => {
      writeMemory("only-mem", "A single memory — below the guard.");
      const getAllEntries = seedMemories(["only-mem"]);

      await runImprove(configWithMinPoolSize(3), getAllEntries);
      expect(poolBelowMinSizeEvents().length).toBe(1);

      const health = akmHealth({ since: "30d" });
      expect(health.improve?.skipReasons?.pool_below_min_size).toBe(1);
    },
    TIMEOUT_MS,
  );
});
