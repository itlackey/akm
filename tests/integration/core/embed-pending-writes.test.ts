/**
 * Embeddings on write (§0.2 P1, N14): a write through the asset facade records its index row under the lease and queues
 * the ref; `embedPendingWrites` makes the vector after the lease is released. The CLI dispatcher awaits it, so a command
 * that writes (`task add`, `secret set`) leaves rows that carry vectors when semantic search is on.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { embedPendingWrites } from "../../../src/core/assets/type";
import { writeAssets } from "../../../src/core/assets/write";
import { writeTargetAt } from "../../../src/core/bundle-at-dir";
import { getDbPath } from "../../../src/core/paths";
import { withAssetMutationLeaseSync } from "../../../src/indexer/index-writer-lock";
import { akmIndex } from "../../../src/indexer/indexer";
import { _setEmbedderForTests } from "../../../src/llm/embedder";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { interactive } from "../../../src/workspace/lease";
import { runCliCapture } from "../../_helpers/cli";
import {
  type Cleanup,
  sandboxEnvDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  writeSandboxConfig,
} from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";

let stashDir = "";
let cleanup: Cleanup = () => {};
let embedCalls = 0;
let leaseFreeDuringEmbed: boolean[] = [];

beforeEach(async () => {
  const stash = sandboxStashDir();
  stashDir = stash.dir;
  let chain = sandboxXdgConfigHome(stash.cleanup).cleanup;
  chain = sandboxXdgCacheHome(chain).cleanup;
  chain = sandboxEnvDir("akm-embed-data", "AKM_DATA_DIR", chain).cleanup;
  chain = sandboxEnvDir("akm-embed-state", "AKM_STATE_DIR", chain).cleanup;
  cleanup = chain;
  writeSandboxConfig({ semanticSearchMode: "auto" });
  embedCalls = 0;
  leaseFreeDuringEmbed = [];
  const vectorFor = (text: string): number[] => (text.includes("gasoline") ? [0, 1, 0, 0] : [1, 0, 0, 0]);
  overrideSeam(_setEmbedderForTests, {
    embed: async (text) => vectorFor(text),
    embedBatch: async (texts, _config, _signal, _onSkip, onBatch) => {
      embedCalls += 1;
      // The lease is free while the vectors are made: another writer is not waiting on an embedding call.
      try {
        withAssetMutationLeaseSync("probe", () => {}, { maxWaitMs: 0 });
        leaseFreeDuringEmbed.push(true);
      } catch {
        leaseFreeDuringEmbed.push(false);
      }
      const embeddings = texts.map(vectorFor);
      onBatch?.(
        texts.map((_t, i) => i),
        embeddings,
      );
      return embeddings;
    },
  });
  fs.mkdirSync(path.join(stashDir, "memories"), { recursive: true });
  fs.writeFileSync(path.join(stashDir, "memories", "seed.md"), "---\ndescription: seed\n---\n\nSeed.\n", "utf8");
  await akmIndex({ stashDir, full: true });
  embedCalls = 0;
  leaseFreeDuringEmbed = [];
});

afterEach(() => cleanup());

function vectorCount(ref: string): number {
  const db = openExistingDatabase(getDbPath());
  try {
    return (
      db
        .prepare("SELECT COUNT(*) AS c FROM embeddings b JOIN entries e ON e.id = b.id WHERE e.item_ref LIKE ?")
        .get(`%${ref}`) as { c: number }
    ).c;
  } finally {
    closeDatabase(db);
  }
}

test("a facade write embeds nothing under the lease; embedPendingWrites makes the vector after it is released", async () => {
  writeAssets(writeTargetAt(stashDir), { purpose: "test" }, (w) =>
    w.create({ type: "memory", name: "fuel-note", content: "---\ndescription: fuel\n---\n\nAbout gasoline.\n" }),
  );
  expect(embedCalls).toBe(0);
  expect(vectorCount("memories/fuel-note")).toBe(0);

  await embedPendingWrites();

  expect(embedCalls).toBeGreaterThan(0);
  expect(leaseFreeDuringEmbed.every(Boolean)).toBe(true);
  expect(vectorCount("memories/fuel-note")).toBe(1);
  // The queue is drained: a second call has nothing to embed.
  embedCalls = 0;
  await embedPendingWrites();
  expect(embedCalls).toBe(0);
});

test("under a held lease (a Desktop write in `interactive`) the queue is kept; it is embedded once the lease is released", async () => {
  await interactive("test", async () => {
    writeAssets(writeTargetAt(stashDir), { purpose: "test" }, (w) =>
      w.create({ type: "memory", name: "held-note", content: "---\ndescription: held\n---\n\nAbout gasoline.\n" }),
    );
    // What a Desktop write path awaits inside `interactive`: no embedding call while the lease is held.
    await embedPendingWrites();
  });
  expect(embedCalls).toBe(0);
  expect(vectorCount("memories/held-note")).toBe(0);

  // The route wrapper's drain, after the lease is released.
  await embedPendingWrites();
  expect(embedCalls).toBeGreaterThan(0);
  expect(leaseFreeDuringEmbed.every(Boolean)).toBe(true);
  expect(vectorCount("memories/held-note")).toBe(1);
});

test("`env create` (a command, through the dispatcher) and a secret write leave rows that carry vectors", async () => {
  const created = await runCliCapture(["env", "create", "env/newone"]);
  expect(created.code, created.stderr).toBe(0);
  expect(vectorCount("env/newone")).toBe(1);

  // A secret's row is made from its name: its value is never an embedding input.
  writeAssets(writeTargetAt(stashDir), { purpose: "test" }, (w) =>
    w.create({ type: "secret", name: "api-token", content: "value-never-embedded" }),
  );
  await embedPendingWrites();
  expect(vectorCount("secrets/api-token")).toBe(1);
});

test("semantic search off, or no index: nothing is embedded and nothing fails", async () => {
  writeSandboxConfig({ semanticSearchMode: "off" });
  writeAssets(writeTargetAt(stashDir), { purpose: "test" }, (w) =>
    w.create({ type: "memory", name: "quiet", content: "---\ndescription: q\n---\n\nQuiet.\n" }),
  );
  await embedPendingWrites();
  expect(embedCalls).toBe(0);
});
