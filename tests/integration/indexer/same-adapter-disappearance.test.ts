import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../src/core/config/config";
import { akmIndex, lookupBundleRef } from "../../../src/indexer/indexer";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig({
    semanticSearchMode: "off",
    bundles: {
      primary: {
        path: storage.stashDir,
        writable: true,
        components: { main: { root: ".", adapter: "akm", writable: true } },
      },
    },
    defaultBundle: "primary",
  });
});

afterEach(() => storage.cleanup());

test("incremental indexing removes a vanished directory owned by the same adapter", async () => {
  const file = path.join(storage.stashDir, "knowledge", "retired", "guide.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "# Retired guide\n");

  await akmIndex({ stashDir: storage.stashDir, full: true });
  expect(await lookupBundleRef({ bundle: "primary", conceptId: "knowledge/retired/guide" })).not.toBeNull();

  fs.rmSync(path.dirname(file), { recursive: true });
  await akmIndex({ stashDir: storage.stashDir });

  expect(await lookupBundleRef({ bundle: "primary", conceptId: "knowledge/retired/guide" })).toBeNull();
});
