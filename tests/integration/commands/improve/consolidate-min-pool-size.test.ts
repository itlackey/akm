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
import { akmHealth } from "../../../../src/commands/health";
import type { AkmConsolidateOptions } from "../../../../src/commands/improve/consolidate";
import { akmImprove } from "../../../../src/commands/improve/improve";
import type { AkmConfig } from "../../../../src/core/config/config";
import { saveConfig } from "../../../../src/core/config/config";
import { readEvents } from "../../../../src/core/events";
import { openStateDatabase } from "../../../../src/core/state-db";
import { akmIndex } from "../../../../src/indexer/indexer";
import { _setChatCompletionForTests } from "../../../../src/llm/client";
import { listImproveLedgerRows } from "../../../../src/storage/repositories/improve-ledger-repository";
import { withImproveAutonomy, withTestImproveLlm } from "../../../_helpers/improve-config";
import { type Cleanup, withIsolatedAkmStorage } from "../../../_helpers/sandbox";
import { overrideSeam } from "../../../_helpers/seams";

const TIMEOUT_MS = 20_000;

let cleanup: Cleanup = () => {};
let stashDir = "";

function writeMemory(name: string, body: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n---\n\n${body}\n`, "utf8");
}

/** Config with the consolidate process enabled and a specific minPoolSize. */
function configWithMinPoolSize(minPoolSize: number): AkmConfig {
  return withImproveAutonomy(
    withTestImproveLlm({
      semanticSearchMode: "off",
      improve: {
        strategies: {
          default: {
            processes: { consolidate: { enabled: true, minPoolSize }, extract: { enabled: false } },
          },
        },
      },
    } as unknown as AkmConfig),
  );
}

/** Drive an improve(memory) run with no LLM connection configured. */
async function runImprove(
  config: AkmConfig,
  consolidateOptions?: AkmConsolidateOptions,
  overrides?: { scope?: string; strategy?: string },
): Promise<Awaited<ReturnType<typeof akmImprove>>> {
  return akmImprove({
    scope: "memory",
    config,
    stashDir,
    consolidateOptions,
    ensureIndexFn: async () => false,
    reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
    ...overrides,
  });
}

function consolidateLedgerRows() {
  const db = openStateDatabase();
  try {
    return listImproveLedgerRows(db, stashDir, ["consolidate"]);
  } finally {
    db.close();
  }
}

function poolBelowMinSizeEvents() {
  return readEvents({ type: "improve_skipped", ref: "memories/_consolidation" }).events.filter(
    (e) => e.metadata?.reason === "pool_below_min_size",
  );
}

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
  cleanup = storage.cleanup;
  saveConfig(withImproveAutonomy(withTestImproveLlm({ semanticSearchMode: "off" })));
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  stashDir = "";
});

describe("#553 consolidate minPoolSize guard", () => {
  test(
    "eligible pool BELOW minPoolSize → skip + pool_below_min_size event + ZERO consolidate run",
    async () => {
      writeMemory("only-mem", "A single memory — well below the guard.");
      await akmIndex({ stashDir, full: true });

      // The #553 pool guard preempts the pass: pool size 1 < minPoolSize 3.
      await runImprove(configWithMinPoolSize(3));

      const skips = poolBelowMinSizeEvents();
      expect(skips.length).toBe(1);
      expect(skips[0]?.metadata?.poolSize).toBe(1);
      expect(skips[0]?.metadata?.minPoolSize).toBe(3);

      // Zero LLM work: consolidation never entered, and no
      // `consolidation_no_memory_updates` (ledger delta) event fired either —
      // the pool guard short-circuited first.
      expect(consolidateLedgerRows()).toEqual([]);
      const mtimeSkips = readEvents({ type: "improve_skipped", ref: "memories/_consolidation" }).events.filter(
        (e) => e.metadata?.reason === "consolidation_no_memory_updates",
      );
      expect(mtimeSkips.length).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "eligible pool AT/ABOVE minPoolSize → guard does NOT skip (no pool_below_min_size event)",
    async () => {
      for (let i = 0; i < 5; i += 1) {
        writeMemory(`mem-${i}`, `Memory number ${i}.`);
      }
      await akmIndex({ stashDir, full: true });

      // Pool size 5 >= minPoolSize 3 → the pool guard is inert; crucially, NO
      // pool_below_min_size event.
      await runImprove(configWithMinPoolSize(3));

      expect(poolBelowMinSizeEvents().length).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "minPoolSize: 0 disables the guard → never skips on size even for a tiny pool",
    async () => {
      writeMemory("only-mem", "A single memory; guard disabled.");
      await akmIndex({ stashDir, full: true });

      await runImprove(configWithMinPoolSize(0));

      expect(poolBelowMinSizeEvents().length).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "an explicitly named --strategy bypasses the guard even below minPoolSize",
    async () => {
      writeMemory("only-mem", "A single memory — well below the guard.");
      await akmIndex({ stashDir, full: true });

      await runImprove(configWithMinPoolSize(3), undefined, { strategy: "default" });

      expect(poolBelowMinSizeEvents().length).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "an explicit ref --scope bypasses the guard even below minPoolSize",
    async () => {
      writeMemory("only-mem", "A single memory — well below the guard.");
      await akmIndex({ stashDir, full: true });

      await runImprove(configWithMinPoolSize(3), undefined, { scope: "memories/only-mem" });

      expect(poolBelowMinSizeEvents().length).toBe(0);
    },
    TIMEOUT_MS,
  );

  test("completes the pass despite a retired advisory op in the response, and records every judged memory (R4 + R12a)", async () => {
    writeMemory(
      "primary",
      "A substantive primary memory that remains unchanged while its proposed merge awaits review. Its promotion proposal may succeed, but that cannot complete the pending merge.",
    );
    writeMemory(
      "secondary",
      "A substantive secondary memory that remains unchanged while its proposed merge awaits review.",
    );
    await akmIndex({ stashDir, full: true });
    // R12a: the schema/prompt no longer offer merge/delete/contradict — this
    // mocked response simulates a non-schema-honouring model returning one
    // anyway. `isValidOp` rejects it (skipped with a warning), so it never
    // reaches `planned`.
    overrideSeam(_setChatCompletionForTests, async () =>
      JSON.stringify({
        operations: [
          {
            op: "promote",
            ref: "memories/primary",
            knowledgeRef: "knowledge/primary-guidance",
            reason: "Stable guidance",
            description: "Stable primary guidance awaiting review.",
          },
          {
            op: "merge",
            primary: "memories/primary",
            secondaries: ["memories/secondary"],
            mergeStrategy: "combine",
          },
        ],
      }),
    );

    const result = await runImprove(configWithMinPoolSize(0));

    expect(result.consolidation?.promoted).toHaveLength(1);
    expect(result.consolidation?.warnings.some((w) => w.includes("skipping invalid operation"))).toBe(true);
    // The promoted memory's ledger row came with its proposal; the other
    // judged memory is recorded as judged with no action.
    const rows = new Map(consolidateLedgerRows().map((row) => [row.ref, row.outcome]));
    expect(rows.get("memories/primary")).toBe("proposed");
    expect(rows.get("memories/secondary")).toBe("judged_no_action");
  });

  test("a memory judged recently and unchanged is not judged again; editing it brings it back", async () => {
    writeMemory("steady", "A steady memory the model has already looked at and found nothing to do with.");
    writeMemory("edited", "A memory that will be edited after its first judgement.");
    await akmIndex({ stashDir, full: true });
    overrideSeam(_setChatCompletionForTests, async () => JSON.stringify({ operations: [] }));

    const first = await runImprove(configWithMinPoolSize(0));
    expect(first.consolidation?.processed).toBe(2);
    expect(consolidateLedgerRows().map((row) => row.outcome)).toEqual(["judged_no_action", "judged_no_action"]);

    const second = await runImprove(configWithMinPoolSize(0));
    expect(second.consolidation?.processed ?? 0).toBe(0);
    const deltaSkips = readEvents({ type: "improve_skipped", ref: "memories/_consolidation" }).events.filter(
      (e) => e.metadata?.reason === "consolidation_no_memory_updates",
    );
    expect(deltaSkips).toHaveLength(1);

    const editedPath = path.join(stashDir, "memories", "edited.md");
    writeMemory("edited", "A memory that was edited after its first judgement, so it is worth another look.");
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(editedPath, later, later);

    const third = await runImprove(configWithMinPoolSize(0));
    expect(third.consolidation?.processed).toBe(1);
  });

  test("a promotion that fails to persist leaves the memory unrecorded, so the next run retries it", async () => {
    writeMemory(
      "primary",
      "A substantive memory whose promotion must remain retryable when proposal persistence is temporarily unavailable.",
    );
    await akmIndex({ stashDir, full: true });
    overrideSeam(_setChatCompletionForTests, async () =>
      JSON.stringify({
        operations: [
          {
            op: "promote",
            ref: "memories/primary",
            knowledgeRef: "knowledge/primary-guidance",
            reason: "Stable guidance",
            description: "Stable primary guidance awaiting review.",
          },
        ],
      }),
    );
    const unusableDbPath = path.join(stashDir, "proposal-db-directory");
    fs.mkdirSync(unusableDbPath);

    const result = await runImprove(configWithMinPoolSize(0), { proposalsCtx: { dbPath: unusableDbPath } });

    expect(result.consolidation?.failedPromotions).toBe(1);
    expect(consolidateLedgerRows()).toEqual([]);
  });

  test(
    "health surfaces pool_below_min_size in improve skip-reason aggregation",
    async () => {
      writeMemory("only-mem", "A single memory — below the guard.");
      await akmIndex({ stashDir, full: true });

      await runImprove(configWithMinPoolSize(3));
      expect(poolBelowMinSizeEvents().length).toBe(1);

      const health = await akmHealth({ since: "30d" });
      expect(health.improve?.skipReasons?.pool_below_min_size).toBe(1);
    },
    TIMEOUT_MS,
  );
});
