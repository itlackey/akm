/**
 * A repeated `--from` searches several named bundles as one set (#1460): ranked once, OR across the
 * bundles, `--filter` and the rest still AND on top. A single `--from` is unchanged.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmSearch, parseSearchSource } from "../src/commands/read/search";
import { saveConfig } from "../src/core/config/config";
import { akmIndex } from "../src/indexer/indexer";
import {
  type Cleanup,
  makeSandboxDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "./_helpers/sandbox";

let stashDir = "";
let cleanup: Cleanup = () => {};
const extras: Array<{ dir: string; cleanup: Cleanup }> = [];

function writeNote(root: string, name: string, team: string): void {
  const file = path.join(root, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nteam: ${team}\n---\n\nwidget ${name} note\n`, "utf8");
}

beforeEach(async () => {
  const dataResult = sandboxXdgDataHome();
  const cacheResult = sandboxXdgCacheHome(dataResult.cleanup);
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  stashDir = stashResult.dir;
  cleanup = stashResult.cleanup;
  writeNote(stashDir, "home-note", "a");
  const bundles: Record<string, { path: string }> = {};
  for (const [name, team] of [
    ["one", "a"],
    ["two", "b"],
    ["three", "a"],
  ] as const) {
    const extra = makeSandboxDir(`akm-from-${name}`);
    extras.push(extra);
    writeNote(extra.dir, `${name}-note`, team);
    bundles[name] = { path: extra.dir };
  }
  saveConfig({ semanticSearchMode: "off", bundles });
  await akmIndex({ stashDir, full: true });
});

afterEach(() => {
  for (const extra of extras.splice(0)) extra.cleanup();
  cleanup();
});

const names = async (input: Partial<Parameters<typeof akmSearch>[0]>) =>
  (
    (await akmSearch({ query: "widget", skipLogging: true, ...input })).results.map((h) =>
      "name" in h ? h.name : "",
    ) as string[]
  ).sort();

describe("repeated --from", () => {
  test("searches the union of the named bundles and reports them", async () => {
    const result = await akmSearch({ query: "widget", source: ["one", "two"], skipLogging: true });
    expect(result.results.map((h) => ("name" in h ? h.name : "")).sort()).toEqual(["one-note", "two-note"]);
    expect(result.bundles).toEqual(["one", "two"]);
  });

  test("a single --from is unchanged and reports no bundles", async () => {
    expect(await names({ source: "three" })).toEqual(["three-note"]);
    expect(await names({ source: ["three"] })).toEqual(["three-note"]);
    expect((await akmSearch({ query: "widget", source: "three", skipLogging: true })).bundles).toBeUndefined();
  });

  test("--filter still ANDs on top", async () => {
    expect(await names({ source: ["one", "two", "three"], filters: { team: ["a"] } })).toEqual([
      "one-note",
      "three-note",
    ]);
  });

  test("an unknown bundle name is rejected", async () => {
    await expect(akmSearch({ query: "widget", source: ["one", "nope"], skipLogging: true })).rejects.toThrow(
      /Unknown source name/,
    );
  });
});

describe("parseSearchSource with several values", () => {
  test("keeps bundle names, dedupes, and collapses one value", () => {
    expect(parseSearchSource(["a", "b", "a"])).toEqual(["a", "b"]);
    expect(parseSearchSource(["a", "a"])).toBe("a");
    expect(parseSearchSource([])).toBe("local");
  });

  test("a keyword cannot be mixed with bundle names", () => {
    expect(() => parseSearchSource(["local", "team"])).toThrow(/cannot be combined/);
    expect(() => parseSearchSource(["team", "all"])).toThrow(/cannot be combined/);
  });
});
