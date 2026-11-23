// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Overlapping bundles (§0.2 N22, N10). One function, `bundleOverlaps`, decides what overlaps: path bundles by real
 * path (equal, or one inside the other), location bundles by adapter and location. Config load refuses equal roots; a
 * config write refuses any overlap the current config does not already have, naming both bundles and leaving the
 * config as it was; a config that already nests bundles keeps loading and working, and `akm doctor` warns.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { bundleOverlaps } from "../../src/core/config/config-sources";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let outer: string;
let inner: string;
let apart: string;

const configPath = () => path.join(process.env.XDG_CONFIG_HOME as string, "akm", "config.json");

function mkdir(...parts: string[]): string {
  const dir = path.join(storage.root, ...parts);
  fs.mkdirSync(path.join(dir, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(dir, "knowledge", "note.md"), "---\ndescription: a note\n---\n\n# Note\n");
  return dir;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  outer = mkdir("outer");
  inner = mkdir("outer", "inner");
  apart = mkdir("apart");
  resetConfigCache();
});

afterEach(() => {
  storage.cleanup();
});

describe("bundleOverlaps", () => {
  const config = (bundles: Record<string, Record<string, unknown>>) =>
    ({ configVersion: "0.9.0", semanticSearchMode: "off", bundles }) as never;

  test("names equal and nested path bundles, comparing real paths", () => {
    const alias = path.join(storage.root, "alias");
    fs.symlinkSync(apart, alias);
    const found = bundleOverlaps(
      config({
        outer: { path: outer },
        inner: { path: inner },
        apart: { path: apart },
        alias: { path: alias },
        other: { path: mkdir("other") },
      }),
    );
    expect(found.map(({ bundles, kind, inner: nested }) => [...bundles, kind, nested])).toEqual([
      ["outer", "inner", "nested", "inner"],
      ["apart", "alias", "same", undefined],
    ]);
  });

  test("a bundle's `root` narrows its content root", () => {
    expect(bundleOverlaps(config({ outer: { path: outer, root: "knowledge" }, inner: { path: inner } }))).toEqual([]);
  });

  test("location bundles overlap only by the same adapter and location", () => {
    const found = bundleOverlaps(
      config({
        a: { location: "akm", adapter: "secret-tool" },
        b: { location: "akm", adapter: "secret-tool" },
        c: { location: "akm", adapter: "azure-key-vault" },
        d: { location: "akm/x", adapter: "secret-tool" },
      }),
    );
    expect(found.map(({ bundles, kind }) => [...bundles, kind])).toEqual([["a", "b", "same"]]);
  });
});

describe("a config write that adds an overlap", () => {
  function configBytes(): string {
    return fs.readFileSync(configPath(), "utf8");
  }

  beforeEach(() => {
    writeSandboxConfig({ semanticSearchMode: "off", bundles: { outer: { path: outer } }, defaultBundle: "outer" });
    resetConfigCache();
  });

  async function refused(args: string[], named: string[]): Promise<void> {
    const before = configBytes();
    const result = await runCliCapture(args);
    expect(result.code, result.stderr).toBe(78);
    const error = JSON.parse(result.stderr) as { code: string; error: string };
    expect(error.code).toBe("INVALID_CONFIG_FILE");
    for (const name of named) expect(error.error).toContain(`"${name}"`);
    expect(configBytes()).toBe(before);
    expect((await runCliCapture(["bundle", "list", "--format=json"])).code).toBe(0);
  }

  test("`bundle add` of a directory inside a bundle is refused, naming both, and the config is unchanged", async () => {
    await refused(["bundle", "add", inner, "--name", "inner"], ["inner", "outer"]);
  }, 60_000);

  test("`bundle add` of a directory that contains a bundle is refused", async () => {
    const parent = path.join(storage.root, "holder");
    const held = mkdir("holder", "held");
    writeSandboxConfig({ semanticSearchMode: "off", bundles: { held: { path: held } }, defaultBundle: "held" });
    await refused(["bundle", "add", parent, "--name", "parent"], ["parent", "held"]);
  }, 60_000);

  test("`bundle add` of a symbolic-link alias of a bundle is refused instead of writing a config that cannot load", async () => {
    const alias = path.join(storage.root, "alias");
    fs.symlinkSync(outer, alias);
    await refused(["bundle", "add", alias, "--name", "alias"], ["outer", "alias"]);
  }, 60_000);

  test("`config set bundles.<n>.path` onto a bundle's directory is refused", async () => {
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: { outer: { path: outer }, apart: { path: apart } },
      defaultBundle: "outer",
    });
    await refused(["config", "set", "bundles.apart.path", inner], ["apart", "outer"]);
  }, 60_000);

  test("re-adding a bundle's own path stays a no-op", async () => {
    const result = await runCliCapture(["bundle", "add", outer]);
    expect(result.code, result.stderr).toBe(0);
    expect(Object.keys(loadConfig().bundles ?? {})).toEqual(["outer"]);
    expect(loadConfig().bundles?.outer?.path).toBe(outer);
  }, 60_000);

  test("a directory apart from every bundle is added", async () => {
    const result = await runCliCapture(["bundle", "add", apart, "--name", "apart"]);
    expect(result.code, result.stderr).toBe(0);
    expect(Object.keys(loadConfig().bundles ?? {})).toEqual(["outer", "apart"]);
  }, 60_000);
});

describe("a config that already nests bundles", () => {
  beforeEach(() => {
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: { outer: { path: outer }, inner: { path: inner } },
      defaultBundle: "outer",
    });
    resetConfigCache();
  });

  test("keeps loading, and an unrelated config write is accepted", async () => {
    expect(Object.keys(loadConfig().bundles ?? {})).toEqual(["outer", "inner"]);
    const result = await runCliCapture(["config", "set", "semanticSearchMode", "off"]);
    expect(result.code, result.stderr).toBe(0);
    expect(Object.keys(loadConfig().bundles ?? {})).toEqual(["outer", "inner"]);
    expect((await runCliCapture(["bundle", "list", "--format=json"])).code).toBe(0);
  }, 60_000);

  test("`akm doctor` warns `bundle-shared-path` for the pair and exits 4", async () => {
    const result = await runCliCapture(["doctor", "--no-probe", "--format", "json"]);
    const report = JSON.parse(result.stdout) as {
      advisories: Array<{ name: string; status: string; message: string; evidence?: { pairs: unknown[] } }>;
    };
    const check = report.advisories.find((entry) => entry.name === "bundle-shared-path");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain('bundle "inner" is inside bundle "outer"');
    expect(check?.evidence?.pairs).toEqual([{ inner: "inner", outer: "outer" }]);
    expect(result.code).toBe(4);
  }, 60_000);

  test("`akm doctor` has no `bundle-shared-path` entry when no bundle is nested", async () => {
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: { outer: { path: outer }, apart: { path: apart } },
      defaultBundle: "outer",
    });
    resetConfigCache();
    const report = JSON.parse((await runCliCapture(["doctor", "--no-probe", "--format", "json"])).stdout) as {
      advisories: Array<{ name: string }>;
    };
    expect(report.advisories.some((entry) => entry.name === "bundle-shared-path")).toBe(false);
  }, 60_000);
});
