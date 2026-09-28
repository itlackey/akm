// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Lazy graph extraction is retired (GR-D6/D7). With an older config that
 * still sets `index.graph.lazyGraphExtraction: true`, `akm show` and
 * `akm curate` make no model call and the index has no extraction queue.
 * Graph extraction runs only in `akm improve`. Runs the indexer against real
 * databases, so it lives under tests/integration/.
 */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmCurate } from "../../../src/commands/read/curate";
import { akmShowUnified } from "../../../src/commands/read/show";
import { resetConfigCache } from "../../../src/core/config/config";
import { getConfigPath, getDbPath } from "../../../src/core/paths";
import { akmIndex } from "../../../src/indexer/indexer";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let requests = 0;
const llmServer = Bun.serve({
  port: 0,
  fetch() {
    requests++;
    const content = JSON.stringify({ entities: ["Alpha", "Beta"], relations: [["Alpha", "depends on", "Beta"]] });
    return Response.json({ choices: [{ message: { content } }] });
  },
});

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  requests = 0;
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

afterAll(() => {
  llmServer.stop(true);
});

test("show and curate make no model call and queue nothing when the old flag is set", async () => {
  fs.writeFileSync(
    getConfigPath(),
    JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        graph: { kind: "llm", endpoint: `http://127.0.0.1:${llmServer.port}/v1/chat/completions`, model: "m" },
      },
      defaults: { llmEngine: "graph" },
      index: { graph: { lazyGraphExtraction: true } },
    }),
  );
  fs.writeFileSync(
    path.join(storage.stashDir, "memories", "lazy-note.md"),
    "---\ndescription: A lazy note about Alpha\n---\n\nAlpha depends on Beta.\n",
  );
  await akmIndex({ stashDir: storage.stashDir });

  await akmShowUnified({ ref: "memories/lazy-note" });
  const curated = await akmCurate({ query: "lazy note Alpha" });

  expect(curated.items.some((item) => "ref" in item && item.ref === "memories/lazy-note")).toBe(true);
  expect(requests).toBe(0);
  const db = openIndexDatabase(getDbPath());
  try {
    const queue = db.prepare("SELECT name FROM sqlite_master WHERE name = 'graph_extraction_queue'").all();
    expect(queue).toEqual([]);
  } finally {
    closeDatabase(db);
  }
});
