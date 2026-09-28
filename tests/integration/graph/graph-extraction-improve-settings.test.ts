// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * GR-D15: `index.graph` settings reach improve-triggered graph extraction.
 * A strategy's `processes.graphExtraction` value wins; a setting it leaves
 * unset comes from `index.graph`, and only then from the built-in default.
 * Drives `resolveImprovePlan` → the graph maintenance stage → the real pass
 * against a local fake endpoint that records each request. Opens a real index
 * database, so it lives under tests/integration/.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveImprovePlan } from "../../../src/commands/improve/improve-strategies";
import { runGraphExtractionMaintenancePass } from "../../../src/commands/improve/loop-stages";
import type { AkmConfig, ImproveProcessConfig } from "../../../src/core/config/config";
import { type GraphExtractionResult, runGraphExtractionPass } from "../../../src/indexer/graph/graph-extraction";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

interface WireRequest {
  model: string;
  assets: number;
  enableThinking: unknown;
}
const requests: WireRequest[] = [];

const llmServer = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as {
      model: string;
      enable_thinking?: unknown;
      messages: Array<{ role: string; content: string }>;
    };
    const user = body.messages.find((m) => m.role === "user")?.content ?? "";
    const batch = /\bN=\d+/.test(user);
    const assets = batch ? (user.match(/=== ASSET \d+ ===/g) ?? []).length : 1;
    requests.push({ model: body.model, assets, enableThinking: body.enable_thinking });
    const one = { entities: ["Alpha", "Beta"], relations: [["Alpha", "uses", "Beta"]] };
    const content = JSON.stringify(batch ? Array.from({ length: assets }, () => one) : one);
    return Response.json({ choices: [{ message: { content } }] });
  },
});

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  requests.length = 0;
});

afterEach(() => {
  storage.cleanup();
});

afterAll(() => {
  llmServer.stop(true);
});

function writeAsset(dir: "memories" | "knowledge", name: string): void {
  fs.writeFileSync(
    path.join(storage.stashDir, dir, `${name}.md`),
    `---\ntitle: ${name}\n---\n\nAlpha uses Beta (${name}).\n`,
  );
}

/** Every process off except graph extraction, which runs a full scan. */
function config(graphExtraction: ImproveProcessConfig, index: AkmConfig["index"]): AkmConfig {
  const off = { enabled: false };
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    engines: {
      graph: { kind: "llm", endpoint: `http://127.0.0.1:${llmServer.port}/v1/chat/completions`, model: "engine-model" },
    },
    defaults: { llmEngine: "graph" },
    index,
    improve: {
      strategies: {
        refresh: {
          processes: {
            reflect: off,
            distill: off,
            consolidate: off,
            memoryInference: off,
            extract: off,
            validation: off,
            triage: off,
            proactiveMaintenance: off,
            graphExtraction: { enabled: true, fullScan: true, ...graphExtraction },
          },
        },
      },
    },
  };
}

async function runRefresh(cfg: AkmConfig): Promise<GraphExtractionResult | undefined> {
  const plan = resolveImprovePlan("refresh", cfg, { repairValidationFailures: false });
  const db = openIndexDatabase(path.join(storage.dataDir, "graph-settings.db"));
  try {
    const out = await runGraphExtractionMaintenancePass(
      {
        config: cfg,
        sources: [{ path: storage.stashDir }] as never,
        primaryStashDir: storage.stashDir,
        improveProfile: plan.strategy.config,
        resolvedPlan: plan,
        memoryInferenceFn: () => {
          throw new Error("memory inference is not part of this test");
        },
        graphExtractionFn: runGraphExtractionPass,
      },
      { current: db },
      { actionableRefs: [], memoryRefsForInference: new Set() },
    );
    return out.graphExtraction;
  } finally {
    closeDatabase(db);
  }
}

describe("improve-triggered graph extraction reads index.graph (GR-D15)", () => {
  test("batch size and include types the strategy leaves unset come from index.graph", async () => {
    for (const name of ["k1", "k2", "k3", "k4"]) writeAsset("knowledge", name);
    writeAsset("memories", "m1");

    const result = await runRefresh(
      config({}, { graph: { graphExtractionBatchSize: 2, graphExtractionIncludeTypes: ["knowledge"] } }),
    );

    // Four knowledge files in batches of two; the memory is not an included type.
    expect(requests.map((r) => r.assets)).toEqual([2, 2]);
    expect(result?.considered).toBe(4);
    expect(result?.telemetry?.batchSize).toBe(2);
  });

  test("the strategy's own batch size and include types still win over index.graph", async () => {
    for (const name of ["k1", "k2", "k3", "k4"]) writeAsset("knowledge", name);
    writeAsset("memories", "m1");

    const result = await runRefresh(
      config(
        { batchSize: 4, includeTypes: ["memory", "knowledge"] },
        { graph: { graphExtractionBatchSize: 2, graphExtractionIncludeTypes: ["knowledge"] } },
      ),
    );

    expect(result?.considered).toBe(5);
    expect(requests.map((r) => r.assets)).toEqual([4, 1]);
  });

  test("index.graph model and llm settings apply unless the strategy's process sets its own", async () => {
    writeAsset("memories", "m1");
    const index = { graph: { model: "graph-model", llm: { enableThinking: false } } };

    await runRefresh(config({}, index));
    expect(requests).toEqual([{ model: "graph-model", assets: 1, enableThinking: false }]);

    requests.length = 0;
    fs.writeFileSync(path.join(storage.stashDir, "memories", "m1.md"), "---\n---\n\nAlpha uses Beta, changed.\n");
    await runRefresh(config({ model: "process-model", llm: { enableThinking: true } }, index));
    expect(requests).toEqual([{ model: "process-model", assets: 1, enableThinking: true }]);
  });
});
