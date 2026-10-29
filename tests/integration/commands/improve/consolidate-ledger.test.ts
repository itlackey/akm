// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Consolidate judged-memory ledger: a pass records every memory it judged, and
 * a memory judged recently and unchanged is not judged again.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmConsolidate } from "../../../../src/commands/improve/consolidate";
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

let cleanup: Cleanup = () => {};
let stashDir = "";

function writeMemory(name: string, body: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n---\n\n${body}\n`, "utf8");
}

/** Config with the consolidate process enabled. */
function consolidateConfig(): AkmConfig {
  return withImproveAutonomy(
    withTestImproveLlm({
      semanticSearchMode: "off",
      improve: {
        strategies: {
          default: {
            processes: { consolidate: { enabled: true }, extract: { enabled: false } },
          },
        },
      },
    } as unknown as AkmConfig),
  );
}

/** Drive an improve(memory) run with no LLM connection configured. */
async function runImprove(
  config: AkmConfig,
  overrides?: { scope?: string; strategy?: string },
): Promise<Awaited<ReturnType<typeof akmImprove>>> {
  return akmImprove({
    scope: "memory",
    config,
    stashDir,
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

describe("consolidate ledger", () => {
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

    const result = await runImprove(consolidateConfig());

    expect(result.consolidation?.promoted).toHaveLength(1);
    expect(result.consolidation?.warnings.some((w) => w.includes("skipping invalid operation"))).toBe(true);
    // The promoted memory's ledger row came with its proposal; the other
    // judged memory is recorded as judged with no action.
    const rows = new Map(consolidateLedgerRows().map((row) => [row.ref, row.outcome]));
    expect(rows.get("memories/primary")).toBe("proposed");
    expect(rows.get("memories/secondary")).toBe("judged_no_action");
  });

  test("a memory judged recently and unchanged is not judged again; an edit brings it back once retrieval returns it", async () => {
    writeMemory("steady", "A steady memory the model has already looked at and found nothing to do with.");
    writeMemory("edited", "A memory that will be edited after its first judgement.");
    await akmIndex({ stashDir, full: true });
    overrideSeam(_setChatCompletionForTests, async () => JSON.stringify({ operations: [] }));

    const first = await runImprove(consolidateConfig());
    expect(first.consolidation?.processed).toBe(2);
    expect(consolidateLedgerRows().map((row) => row.outcome)).toEqual(["judged_no_action", "judged_no_action"]);

    const second = await runImprove(consolidateConfig());
    expect(second.consolidation?.processed ?? 0).toBe(0);
    const deltaSkips = readEvents({ type: "improve_skipped", ref: "memories/_consolidation" }).events.filter(
      (e) => e.metadata?.reason === "consolidation_no_memory_updates",
    );
    expect(deltaSkips).toHaveLength(1);

    const editedPath = path.join(stashDir, "memories", "edited.md");
    writeMemory("edited", "A memory that was edited after its first judgement, so it is worth another look.");
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(editedPath, later, later);

    // #986: the edit lifts the ledger window, but improve already judged this
    // memory and retrieval never returned it, so it stays out of the pool.
    const third = await runImprove(consolidateConfig());
    expect(third.consolidation?.processed ?? 0).toBe(0);

    const db = openStateDatabase();
    try {
      db.prepare("INSERT INTO usage_events (event_type, entry_ref, source) VALUES ('search', ?, 'user')").run(
        "stash//memories/edited",
      );
    } finally {
      db.close();
    }
    const fourth = await runImprove(consolidateConfig());
    expect(fourth.consolidation?.processed).toBe(1);
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

    const result = await akmConsolidate({
      config: consolidateConfig(),
      stashDir,
      proposalsCtx: { dbPath: unusableDbPath },
    });

    expect(result.failedPromotions).toBe(1);
    expect(consolidateLedgerRows()).toEqual([]);
  });
});
