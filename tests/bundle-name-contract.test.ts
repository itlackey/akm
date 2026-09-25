// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * D6 — bundle naming is a contract: an illegal or already-taken `--name`
 * fails before any write on every add path (local, website, registry —
 * registry coverage lives in
 * tests/integration/registry/registry-add-bundle-name.test.ts, which needs a
 * real sync), re-adding an installed ref under a different `--name` names
 * `akm bundle rename` instead of silently keeping the old key, and every add
 * result carries `bundleId`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmAdd } from "../src/commands/sources/source-add";
import { loadConfig, saveConfig } from "../src/core/config/config";
import { UsageError } from "../src/core/errors";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-name-contract-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function makeStashDir(base: string): void {
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(base, sub), { recursive: true });
  }
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  storage.cleanup();
  for (const dir of createdTmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function configPath(): string {
  return path.join(storage.configDir, "akm", "config.json");
}

describe("akm bundle add <local path> --name (D6)", () => {
  test("every successful add result carries bundleId", async () => {
    const dir = createTmpDir();
    makeStashDir(dir);

    const result = await akmAdd({ ref: dir, name: "my-local" });

    expect(result.bundleId).toBe("my-local");
  });

  test("an illegal bundle name fails before any write", async () => {
    const dir = createTmpDir();
    makeStashDir(dir);
    const before = fs.readFileSync(configPath(), "utf8");

    await expect(akmAdd({ ref: dir, name: "my.local" })).rejects.toThrow(UsageError);
    await expect(akmAdd({ ref: dir, name: "my.local" })).rejects.toThrow(/not a legal bundle name/);

    expect(fs.readFileSync(configPath(), "utf8")).toBe(before);
    expect(loadConfig().bundles ?? {}).toEqual({});
  });

  test("a name already used by a different bundle fails before any write", async () => {
    const first = createTmpDir();
    makeStashDir(first);
    await akmAdd({ ref: first, name: "taken" });
    const before = fs.readFileSync(configPath(), "utf8");

    const second = createTmpDir();
    makeStashDir(second);
    await expect(akmAdd({ ref: second, name: "taken" })).rejects.toThrow(/already exists/);

    expect(fs.readFileSync(configPath(), "utf8")).toBe(before);
    expect(Object.keys(loadConfig().bundles ?? {})).toEqual(["taken"]);
  });

  test("re-adding the same path under a different --name fails and names rename", async () => {
    const dir = createTmpDir();
    makeStashDir(dir);
    await akmAdd({ ref: dir, name: "original" });
    const before = fs.readFileSync(configPath(), "utf8");

    await expect(akmAdd({ ref: dir, name: "renamed" })).rejects.toThrow(/akm bundle rename original renamed/);

    expect(fs.readFileSync(configPath(), "utf8")).toBe(before);
    expect(Object.keys(loadConfig().bundles ?? {})).toEqual(["original"]);
  });

  test("re-adding the same path under the same --name is a no-op, not an error", async () => {
    const dir = createTmpDir();
    makeStashDir(dir);
    await akmAdd({ ref: dir, name: "stable" });

    await expect(akmAdd({ ref: dir, name: "stable" })).resolves.toBeDefined();
    expect(Object.keys(loadConfig().bundles ?? {})).toEqual(["stable"]);
  });
});

describe("akm bundle add <website URL> --name (D6)", () => {
  // The name contract is enforced inside the config mutation, before the
  // website mirror is fetched — so these never need a mocked network.
  test("an illegal bundle name fails before any write", async () => {
    const before = fs.readFileSync(configPath(), "utf8");

    await expect(akmAdd({ ref: "https://example.com/docs", name: "my.site" })).rejects.toThrow(
      /not a legal bundle name/,
    );

    expect(fs.readFileSync(configPath(), "utf8")).toBe(before);
    expect(loadConfig().bundles ?? {}).toEqual({});
  });

  test("a name already used by a different bundle fails before any write", async () => {
    saveConfig({
      semanticSearchMode: "off",
      bundles: { taken: { website: { url: "https://other.example.com/" } } },
    });
    const before = fs.readFileSync(configPath(), "utf8");

    await expect(akmAdd({ ref: "https://example.com/docs", name: "taken" })).rejects.toThrow(/already exists/);

    expect(fs.readFileSync(configPath(), "utf8")).toBe(before);
    expect(Object.keys(loadConfig().bundles ?? {})).toEqual(["taken"]);
  });

  test("re-adding the same URL under a different --name fails and names rename", async () => {
    saveConfig({
      semanticSearchMode: "off",
      bundles: { original: { website: { url: "https://example.com/docs" } } },
    });
    const before = fs.readFileSync(configPath(), "utf8");

    await expect(akmAdd({ ref: "https://example.com/docs", name: "renamed" })).rejects.toThrow(
      /akm bundle rename original renamed/,
    );

    expect(fs.readFileSync(configPath(), "utf8")).toBe(before);
    expect(Object.keys(loadConfig().bundles ?? {})).toEqual(["original"]);
  });
});
