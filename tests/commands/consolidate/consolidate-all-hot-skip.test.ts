/**
 * An all-`captureMode: hot` chunk is sent to the model like any other chunk (hot memories are
 * consolidated like any memory; 0.10 Policy decision 5).
 *
 * With the feature enabled but no LLM configured, a chunk that reaches the model lands in
 * `failedChunkMemories` ("No LLM configured"); a chunk skipped without a call would land in
 * `judgedNoAction`. The two buckets tell the paths apart without a model.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { akmConsolidate } from "../../../src/commands/improve/consolidate";
import type { AkmConfig } from "../../../src/core/config/config";
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
// failed bucket — which lets us prove an all-hot chunk does get there).
const CONFIG = {
  semanticSearchMode: "off",
  profiles: { improve: { default: { processes: { consolidate: { enabled: true } } } } },
} as unknown as AkmConfig;

describe("akmConsolidate — all-hot chunk", () => {
  test("nothing configured does not eagerly create consolidation state", async () => {
    writeMemory("cold-a", { hot: false });
    const config = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { stash: { path: stashDir, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "stash",
      improve: { strategy: "default", strategies: { default: { processes: { consolidate: { enabled: true } } } } },
    } as AkmConfig;
    const stateDbPath = getStateDbPath();

    const result = await akmConsolidate({ stashDir, config });

    expect(result.warnings).toContain("No LLM configured for consolidation");
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
      connections: {
        planner: {
          endpoint: "https://consolidate.example.test/v1/chat/completions",
          models: { fast: "planner" },
          apiKey: "$AKM_CONSOLIDATE_ROTATING_KEY",
        },
      },
      improve: { strategy: "default", strategies: { default: { processes: { consolidate: { enabled: true } } } } },
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

  test("an all-hot chunk reaches the model like any chunk (not skipped as judged no-action)", async () => {
    writeMemory("hot-a", { hot: true });
    writeMemory("hot-b", { hot: true });
    writeMemory("hot-c", { hot: true });

    const result = await akmConsolidate({ stashDir, config: CONFIG });

    expect(result.ok).toBe(true);
    expect(result.processed).toBe(3);
    // The chunk went to the LLM path (no LLM configured here), so it is failed, not judged no-action.
    expect(result.judgedNoAction).toBe(0);
    expect(result.failedChunkMemories).toBe(3);
    expect(result.failedChunks).toBe(1);
  });

  test("an all-hot chunk calls the model and a promote it returns is planned", async () => {
    writeMemory("hot-a", { hot: true });
    writeMemory("hot-b", { hot: true });
    const config = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { stash: { path: stashDir, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "stash",
      connections: {
        planner: { endpoint: "https://consolidate.example.test/v1/chat/completions", models: { fast: "planner" } },
      },
      improve: { strategy: "default", strategies: { default: { processes: { consolidate: { enabled: true } } } } },
    } as AkmConfig;
    let calls = 0;

    const result = await withMockedFetch(
      () => akmConsolidate({ stashDir, config, dryRun: true }),
      async () => {
        calls++;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    operations: [
                      {
                        op: "promote",
                        ref: "memories/hot-a",
                        knowledgeRef: "knowledge/hot-a",
                        reason: "stable fact",
                        description: "hot-a knowledge",
                        confidence: 0.95,
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );

    expect(calls).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.failedChunkMemories).toBe(0);
    expect(result.planned).toEqual([expect.objectContaining({ op: "promote", ref: "memories/hot-a" })]);
  });

  test("a mixed hot and cold chunk still reaches the (here unconfigured) LLM path", async () => {
    writeMemory("hot-a", { hot: true });
    writeMemory("hot-b", { hot: true });
    writeMemory("cold-c", { hot: false });

    const result = await akmConsolidate({ stashDir, config: CONFIG });

    expect(result.ok).toBe(true);
    expect(result.processed).toBe(3);
    expect(result.judgedNoAction).toBe(0);
    expect(result.failedChunkMemories).toBe(3);
  });

  test("standalone selection is frozen once and reports its lowering notice once", async () => {
    writeMemory("hot-a", { hot: true });
    const config = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      improve: {
        strategy: "freeze-once",
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
      connections: {
        planner: {
          endpoint: "https://example.test/v1/chat/completions",
          models: { fast: "planner-model" },
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
        adapter: "connection",
        field: "inference.unsupportedPlannerField",
      }),
    ]);
    expect(result.notices).toEqual(reported);
  });
});
