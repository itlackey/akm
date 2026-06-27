import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadWikiSnapshotFetchers } from "../../src/sources/wiki-fetchers/registry";
import { type Cleanup, sandboxStashDir, sandboxXdgConfigHome } from "../_helpers/sandbox";

let cleanup: Cleanup = () => {};

beforeEach(() => {
  const cfgResult = sandboxXdgConfigHome();
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  cleanup = stashResult.cleanup;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

describe("wiki fetcher registry", () => {
  test("returns an empty list when the fetcher directory does not exist", async () => {
    const fetchers = await loadWikiSnapshotFetchers(process.env.AKM_STASH_DIR ?? "");
    expect(fetchers).toEqual([]);
  });

  test("loads valid fetchers in alphabetical filename order and skips invalid modules", async () => {
    const fetcherDir = path.join(process.env.AKM_STASH_DIR ?? "", "scripts", "wiki-fetchers");
    fs.mkdirSync(fetcherDir, { recursive: true });
    fs.writeFileSync(
      path.join(fetcherDir, "b.ts"),
      'export default { name: "b", matches() { return false; }, async fetch() { return null; } };\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(fetcherDir, "a.ts"),
      'export default { name: "a", matches() { return false; }, async fetch() { return null; } };\n',
      "utf8",
    );
    fs.writeFileSync(path.join(fetcherDir, "broken.ts"), 'export default { name: "broken" };\n', "utf8");

    const fetchers = await loadWikiSnapshotFetchers(process.env.AKM_STASH_DIR ?? "");
    expect(fetchers.map((fetcher) => fetcher.name)).toEqual(["a", "b"]);
  });
});
