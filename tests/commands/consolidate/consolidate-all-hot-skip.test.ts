/**
 * Regression test for the all-hot chunk early-exit in `akmConsolidate`.
 *
 * Before the fix, the hot-ref protection was prompt-level only: a chunk whose
 * memories are ALL `captureMode: hot` was still sent to the LLM, which could
 * only ever propose (refused) deletes — pure token waste. The early-exit skips
 * the LLM entirely for an all-hot chunk and buckets every memory as
 * `judgedNoAction`, preserving the accounting invariant.
 *
 * These tests need no LLM: with the feature enabled but no LLM configured, an
 * all-hot chunk that early-exits yields `judgedNoAction === N` and
 * `failedChunkMemories === 0`. WITHOUT the early-exit, the same chunk would hit
 * the "No LLM configured" branch and land in `failedChunkMemories` instead —
 * so the two buckets cleanly distinguish the early-exit from the failure path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { akmConsolidate } from "../../../src/commands/improve/consolidate";
import type { AkmConfig } from "../../../src/core/config";
import { type Cleanup, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let cleanup: Cleanup;
let stashDir: string;

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
  cleanup = storage.cleanup;
});

afterEach(() => cleanup());

function writeMemory(name: string, opts: { hot: boolean }): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const capture = opts.hot ? "captureMode: hot\n" : "";
  fs.writeFileSync(
    filePath,
    `---\ndescription: ${name} memory\n${capture}---\n\n${name} body content that is long enough to matter.\n`,
    "utf8",
  );
}

// Consolidation enabled, NO embedding (clustering is a no-op) and NO LLM
// connection (so any chunk that actually reaches the model lands in the
// failed bucket — which lets us prove the all-hot chunk never got there).
const CONFIG = {
  semanticSearchMode: "off",
  profiles: { improve: { default: { processes: { consolidate: { enabled: true } } } } },
} as unknown as AkmConfig;

describe("akmConsolidate — all-hot chunk early-exit", () => {
  test("an all-hot chunk skips the LLM and buckets every memory as judgedNoAction", async () => {
    writeMemory("hot-a", { hot: true });
    writeMemory("hot-b", { hot: true });
    writeMemory("hot-c", { hot: true });

    const result = await akmConsolidate({ stashDir, target: stashDir, config: CONFIG });

    expect(result.ok).toBe(true);
    expect(result.processed).toBe(3);
    // Early-exit bucket: all three judged no-action, none reached the LLM.
    expect(result.judgedNoAction).toBe(3);
    expect(result.failedChunkMemories).toBe(0);
    expect(result.failedChunks).toBe(0);
    expect(result.merged).toBe(0);
    expect(result.deleted).toBe(0);
    // Accounting invariant for the all-hot case: processed == judgedNoAction.
    const actioned = result.merged + result.deleted + (result.promoted?.length ?? 0) + result.contradicted;
    const sigSkips = result.skipReasons?.length ?? 0;
    expect(actioned + (result.judgedNoAction ?? 0) + sigSkips + (result.failedChunkMemories ?? 0)).toBe(
      result.processed,
    );
  });

  test("a chunk that is NOT all-hot still reaches the (here unconfigured) LLM path", async () => {
    // One non-hot memory means the chunk is not all-hot, so the early-exit
    // must NOT fire; with no LLM configured the chunk lands in the failed
    // bucket rather than judgedNoAction.
    writeMemory("hot-a", { hot: true });
    writeMemory("hot-b", { hot: true });
    writeMemory("cold-c", { hot: false });

    const result = await akmConsolidate({ stashDir, target: stashDir, config: CONFIG });

    expect(result.ok).toBe(true);
    expect(result.processed).toBe(3);
    // The whole chunk went to the LLM path (no early-exit) and failed there.
    expect(result.judgedNoAction).toBe(0);
    expect(result.failedChunkMemories).toBe(3);
  });
});
