// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: reads stored embeddings from a real index in isolated storage.
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { handleApiRequest } from "../../../src/commands/ui/api";
import { resetConfigCache, saveConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { akmIndex } from "../../../src/indexer/indexer";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { getEntryIdByFilePath } from "../../../src/storage/repositories/index-entries-repository";
import { setMeta } from "../../../src/storage/repositories/index-meta-repository";
import { upsertEmbedding } from "../../../src/storage/repositories/index-vec-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let other: string;
const page = (name: string) => `---\ndescription: ${name} page\n---\n# ${name}\nSynthetic ${name} text.\n`;
const related = (ref: string, scope?: string) =>
  handleApiRequest("/api/asset/related", new URLSearchParams({ ref, ...(scope ? { scope } : {}) })) as Promise<{
    available: boolean;
    note: string;
    matches: Array<{ ref: string; title: string; type: string; cosine: number }>;
  }>;
const refs = (result: { matches: Array<{ ref: string }> }) => result.matches.map((match) => match.ref);

/** Stores `vectors` (file path to vector) under `model`; the index's current model is `current`. */
function embed(vectors: Record<string, number[]>, model = "model-a", current = model) {
  const db = openIndexDatabase(getDbPath());
  try {
    for (const [file, vector] of Object.entries(vectors)) {
      const id = getEntryIdByFilePath(db, file);
      if (id === undefined) throw new Error(`not indexed: ${file}`);
      upsertEmbedding(db, id, vector, model);
    }
    setMeta(db, "embeddingFingerprint", current);
  } finally {
    closeDatabase(db);
  }
}

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  other = path.join(storage.root, "other");
  fs.mkdirSync(path.join(other, "knowledge"), { recursive: true });
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir, writable: true }, other: { path: other, writable: true } },
    defaultBundle: "stash",
    registries: [],
  });
  resetConfigCache();
  for (const name of ["a", "b", "d"])
    fs.writeFileSync(path.join(storage.stashDir, "knowledge", `${name}.md`), page(name));
  fs.writeFileSync(path.join(other, "knowledge", "c.md"), page("c"));
  fs.mkdirSync(path.join(storage.stashDir, "env"), { recursive: true });
  fs.writeFileSync(path.join(storage.stashDir, "env", "prod.env"), "TOKEN=planted\n");
  await akmIndex({ stashDir: storage.stashDir, full: true });
});
afterEach(() => storage.cleanup());

const stashFile = (name: string) => path.join(storage.stashDir, "knowledge", `${name}.md`);

test("lists the nearest stored embeddings across bundles, or only the asset's own bundle", async () => {
  embed({
    [stashFile("a")]: [1, 0],
    [stashFile("b")]: [0.9, Math.sqrt(1 - 0.81)],
    [path.join(other, "knowledge", "c.md")]: [0.8, 0.6],
    [stashFile("d")]: [0, 1],
    [path.join(storage.stashDir, "env", "prod.env")]: [1, 0],
  });
  const all = await related("stash//knowledge/a");
  expect(all.available).toBe(true);
  // Best first; the asset itself and the protected env file are never listed.
  expect(refs(all)).toEqual(["stash//knowledge/b", "other//knowledge/c", "stash//knowledge/d"]);
  expect(all.matches[0]).toMatchObject({ title: "b", type: "knowledge" });
  expect(all.matches[0]!.cosine).toBeCloseTo(0.9, 5);
  expect(refs(await related("stash//knowledge/a", "bundle"))).toEqual(["stash//knowledge/b", "stash//knowledge/d"]);
  // A disabled bundle drops out without reindexing.
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir, writable: true }, other: { path: other, enabled: false } },
    defaultBundle: "stash",
    registries: [],
  });
  expect(refs(await related("stash//knowledge/a"))).toEqual(["stash//knowledge/b", "stash//knowledge/d"]);
});

test("reads at most twenty matches, however many entries are indexed", async () => {
  const vectors: Record<string, number[]> = { [stashFile("a")]: [1, 0] };
  for (let i = 0; i < 30; i++) {
    const file = path.join(storage.stashDir, "knowledge", `n${i}.md`);
    fs.writeFileSync(file, page(`n${i}`));
    vectors[file] = [1, i / 100];
  }
  await akmIndex({ stashDir: storage.stashDir, full: true });
  embed(vectors);
  const result = await related("stash//knowledge/a");
  expect(result.matches).toHaveLength(20);
  expect(refs(result)[0]).toBe("stash//knowledge/n0");
});

test("says why nothing is listed: no embedding, an older model's embedding, an env file, a bad scope", async () => {
  expect(await related("stash//knowledge/a")).toMatchObject({ available: false, matches: [] });
  embed({ [stashFile("a")]: [1, 0], [stashFile("b")]: [1, 0] }, "model-old", "model-new");
  const stale = await related("stash//knowledge/a");
  expect(stale).toMatchObject({ available: false, matches: [] });
  expect(stale.note).toContain("older model");
  expect(await related("stash//env/prod")).toMatchObject({ available: false, matches: [] });
  await expect(related("stash//knowledge/a", "everything")).rejects.toThrow("scope");
});
