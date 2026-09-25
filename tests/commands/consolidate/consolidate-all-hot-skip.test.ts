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
import type { AkmConfig } from "../../../src/core/config/config";
import { ConfigError } from "../../../src/core/errors";
import { getStateDbPath } from "../../../src/core/state-db";
import type { LoweringNotice } from "../../../src/execution/resolved-request";
import {
  type Cleanup,
  mutateScopedEnv,
  withEnv,
  withIsolatedAkmStorage,
  withMockedFetch,
} from "../../_helpers/sandbox";

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
  test("missing required credential does not eagerly create consolidation state", async () => {
    writeMemory("cold-a", { hot: false });
    const config = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { stash: { path: stashDir, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "stash",
      engines: {
        planner: {
          kind: "llm",
          endpoint: "http://127.0.0.1:1/v1/chat/completions",
          model: "never-dispatched",
          apiKey: "$AKM_CONSOLIDATE_REQUIRED_KEY",
        },
      },
      defaults: { llmEngine: "planner", improveStrategy: "default" },
      improve: { strategies: { default: { processes: { consolidate: { enabled: true } } } } },
    } as AkmConfig;
    const stateDbPath = getStateDbPath();

    await withEnv({ AKM_CONSOLIDATE_REQUIRED_KEY: undefined }, async () => {
      await expect(akmConsolidate({ stashDir, config })).rejects.toBeInstanceOf(ConfigError);
    });

    expect(fs.existsSync(stateDbPath)).toBe(false);
  });

  test.each([
    { dryRun: false },
    { dryRun: true },
  ])("each $dryRun-run chunk dispatch reads the credential current at that call", async ({ dryRun }) => {
    writeMemory("cold-a", { hot: false });
    writeMemory("cold-b", { hot: false });
    const config = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { stash: { path: stashDir, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "stash",
      engines: {
        planner: {
          kind: "llm",
          endpoint: "https://consolidate.example.test/v1/chat/completions",
          model: "planner",
          apiKey: "$AKM_CONSOLIDATE_ROTATING_KEY",
        },
      },
      defaults: { llmEngine: "planner", improveStrategy: "default" },
      improve: { strategies: { default: { processes: { consolidate: { enabled: true } } } } },
    } as AkmConfig;
    const original = "consolidate-original-secret";
    const rotated = "consolidate-rotated-secret";
    const observed: Array<string | null> = [];

    const result = await withEnv({ AKM_CONSOLIDATE_ROTATING_KEY: original }, () =>
      withMockedFetch(
        () => akmConsolidate({ stashDir, config, dryRun, maxChunkSize: 1 }),
        async (_input, init) => {
          observed.push(new Headers(init?.headers).get("authorization"));
          if (observed.length === 1) mutateScopedEnv("AKM_CONSOLIDATE_ROTATING_KEY", rotated);
          return new Response(
            JSON.stringify({ choices: [{ message: { content: JSON.stringify({ operations: [] }) } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      ),
    );

    expect(result.ok).toBe(true);
    expect(observed).toEqual([`Bearer ${original}`, `Bearer ${rotated}`]);
  });

  test("an all-hot chunk skips the LLM and buckets every memory as judgedNoAction", async () => {
    writeMemory("hot-a", { hot: true });
    writeMemory("hot-b", { hot: true });
    writeMemory("hot-c", { hot: true });

    const result = await akmConsolidate({ stashDir, config: CONFIG });

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

    const result = await akmConsolidate({ stashDir, config: CONFIG });

    expect(result.ok).toBe(true);
    expect(result.processed).toBe(3);
    // The whole chunk went to the LLM path (no early-exit) and failed there.
    expect(result.judgedNoAction).toBe(0);
    expect(result.failedChunkMemories).toBe(3);
  });

  test("standalone selection is frozen once and reports its lowering notice once", async () => {
    writeMemory("hot-a", { hot: true });
    const config = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaults: { improveStrategy: "freeze-once", llmEngine: "planner" },
      improve: {
        strategies: {
          "freeze-once": {
            processes: {
              consolidate: {
                enabled: true,
                llm: { unsupportedPlannerField: true },
              },
            },
          },
        },
      },
      engines: {
        planner: {
          kind: "llm",
          endpoint: "https://example.test/v1/chat/completions",
          model: "planner-model",
        },
      },
    } as unknown as AkmConfig;
    const reported: Readonly<LoweringNotice>[] = [];

    const result = await akmConsolidate({
      stashDir,
      config,
      onNotices: (notices) => reported.push(...notices),
    });

    expect(reported).toEqual([
      expect.objectContaining({
        code: "untranslated-field",
        adapter: "llm",
        field: "inference.unsupportedPlannerField",
      }),
    ]);
    expect(result.notices).toEqual(reported);
    expect(result.judgedNoAction).toBe(1);
  });
});
