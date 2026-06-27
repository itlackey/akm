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
  test("includes built-in fetchers when the stash has no custom fetcher directory", async () => {
    const fetchers = await loadWikiSnapshotFetchers(process.env.AKM_STASH_DIR ?? "");
    expect(fetchers.map((fetcher) => fetcher.name)).toContain("youtube-transcript");
  });

  test("loads valid custom fetchers before built-ins and skips invalid modules", async () => {
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
    expect(fetchers.slice(0, 2).map((fetcher) => fetcher.name)).toEqual(["a", "b"]);
    expect(fetchers.map((fetcher) => fetcher.name)).toContain("youtube-transcript");
  });
});
