// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One answer to "which bundle is the working one": `AKM_BUNDLE_DIR`, else `defaultBundle`, else an error that reads
 * and writes share. No implicit `~/akm`; a dangling `defaultBundle` warns and loads as unset; the migrator registers an
 * existing `~/akm` for the hosts that relied on the old fallback.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { normalizeConfigFile } from "../scripts/akm-migrate/config/normalize";
import { akmSearch } from "../src/commands/read/search";
import { akmShowUnified as akmShow } from "../src/commands/read/show";
import { NO_DEFAULT_BUNDLE_MESSAGE, resolveStashDir } from "../src/core/common";
import { loadConfig, resetConfigCache, saveConfig } from "../src/core/config/config";
import { getConfigPath } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { resolveWorkingStashTarget } from "../src/core/write-source";
import { akmIndex } from "../src/indexer/indexer";
import { resolveSourceEntries } from "../src/indexer/search/search-source";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;
let home: string;
let warnings: string[];

beforeEach(() => {
  storage = withIsolatedAkmStorage({ AKM_BUNDLE_DIR: undefined });
  home = path.join(storage.root, "home");
  fs.mkdirSync(home, { recursive: true });
  resetConfigCache();
  warnings = [];
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  _setWarnSinkForTests(undefined);
  resetConfigCache();
  storage.cleanup();
});

const bundle = (dir: string) => ({ path: dir, components: { main: { root: ".", adapter: "akm" } } });

function seedDir(name: string, files: Record<string, string> = {}): string {
  const dir = path.join(storage.root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function listTree(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

describe("no env, no default bundle", () => {
  test("reads and writes error with the same message, even with ~/akm present", async () => {
    await withEnv({ HOME: home }, () => {
      fs.mkdirSync(path.join(home, "akm"), { recursive: true });
      const config = loadConfig();
      expect(() => resolveStashDir()).toThrow(NO_DEFAULT_BUNDLE_MESSAGE);
      expect(() => resolveSourceEntries(undefined, config)).toThrow(NO_DEFAULT_BUNDLE_MESSAGE);
      expect(() => resolveWorkingStashTarget(config)).toThrow(NO_DEFAULT_BUNDLE_MESSAGE);
    });
  });

  test("configured bundles and no default: the sources are the bundles", () => {
    const dir = seedDir("lib", { "knowledge/a.md": "# a\n" });
    writeSandboxConfig({ bundles: { lib: bundle(dir) } });
    const sources = resolveSourceEntries(undefined, loadConfig());
    expect(sources.map((source) => source.path)).toEqual([dir]);
  });
});

describe("a defaultBundle that names no bundle", () => {
  test("warns once, loads as unset, reads work and a write errors", async () => {
    const dir = seedDir("lib", { "knowledge/ghost-note.md": "---\ndescription: ghost note\n---\n# ghost note\n" });
    writeSandboxConfig({ semanticSearchMode: "off", bundles: { lib: bundle(dir) }, defaultBundle: "ghost" });

    const config = loadConfig();
    loadConfig();
    resetConfigCache();
    loadConfig();
    expect(config.defaultBundle).toBeUndefined();
    const dangling = warnings.filter((line) => line.includes("names no configured bundle"));
    expect(dangling).toHaveLength(1);
    expect(dangling[0]).toContain('"ghost"');

    await akmIndex({ stashDir: dir, full: true });
    const result = await akmSearch({ query: "ghost note" });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(() => resolveWorkingStashTarget(config)).toThrow(NO_DEFAULT_BUNDLE_MESSAGE);
  });

  test("saving a config that names a missing bundle is still an error", () => {
    expect(() => saveConfig({ ...loadConfig(), bundles: {}, defaultBundle: "ghost" })).toThrow(
      /does not name a configured bundle|requires a bundles map/,
    );
  });
});

describe("a command or agent that says `engine:` does not break index, show or search", () => {
  test("they read it; only rendering it for a run refuses", async () => {
    const dir = seedDir("lib", {
      "commands/review.md": "---\ndescription: review things\nengine: lab\n---\nReview it.\n",
      "agents/reviewer.md": "---\ndescription: reviews things\nakm:\n  engine: lab\n---\nReview.\n",
    });
    writeSandboxConfig({ semanticSearchMode: "off", bundles: { lib: bundle(dir) }, defaultBundle: "lib" });
    await akmIndex({ stashDir: dir, full: true });
    const found = await akmSearch({ query: "review" });
    expect(found.hits.length).toBeGreaterThan(0);
    await akmShow({ ref: "commands/review.md" });
    await akmShow({ ref: "agents/reviewer.md" });
  });
});

describe("the migrator registers an existing ~/akm", () => {
  const run = (apply: boolean) => withEnv({ HOME: home }, () => normalizeConfigFile(getConfigPath(), { apply }));

  test("no default bundle: ~/akm becomes the default and nothing is added to it", async () => {
    const homeStash = seedDir("home/akm", { "knowledge/keep.md": "# keep\n" });
    const before = listTree(homeStash);
    writeSandboxConfig({ connections: { lab: { endpoint: "http://lab:8080/v1", models: { fast: "m" } } } });

    const dry = await run(false);
    expect(dry.changed).toBe(true);
    expect(dry.applied).toBe(false);
    expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).defaultBundle).toBeUndefined();

    const done = await run(true);
    expect(done.applied).toBe(true);
    expect(done.notes?.join("\n")).toContain(homeStash);
    const written = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(written.defaultBundle).toBeString();
    expect(written.bundles[written.defaultBundle].path).toBe(homeStash);
    expect(listTree(homeStash)).toEqual(before);

    resetConfigCache();
    expect(loadConfig().defaultBundle).toBe(written.defaultBundle);
    expect((await run(true)).changed).toBe(false);
  });

  test("no config file at all: ~/akm still gets registered", async () => {
    const homeStash = seedDir("home/akm");
    fs.rmSync(getConfigPath(), { force: true });
    const done = await run(true);
    expect(done.applied).toBe(true);
    const written = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(written.bundles[written.defaultBundle].path).toBe(homeStash);
  });

  test("no ~/akm, or a default already set, or the bundle disabled: nothing is registered", async () => {
    writeSandboxConfig({ connections: { lab: { endpoint: "http://lab:8080/v1", models: { fast: "m" } } } });
    expect((await run(true)).changed).toBe(false);

    const homeStash = seedDir("home/akm");
    const other = seedDir("other");
    writeSandboxConfig({ bundles: { other: bundle(other) }, defaultBundle: "other" });
    expect((await run(true)).changed).toBe(false);

    writeSandboxConfig({
      bundles: { dormant: { ...bundle(homeStash), enabled: false }, other: bundle(other) },
      defaultBundle: undefined,
    });
    const written = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    delete written.defaultBundle;
    fs.writeFileSync(getConfigPath(), JSON.stringify(written));
    await run(true);
    expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).defaultBundle).toBeUndefined();
  });
});
