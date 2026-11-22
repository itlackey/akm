// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The retired `bundles.<name>.components` form: a bundle's one component only repeated it. It is read as the flat
// bundle (`adapter`, `root`, `writable`), in memory with one warning, and `akm migrate apply` rewrites the file.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { convertBundleComponents } from "../../src/core/config/convert-bundle-components";
import { getConfigPath } from "../../src/core/paths";
import { withIsolatedAkmStorage } from "../_helpers/sandbox";

const CLI = path.resolve(import.meta.dir, "../../src/cli.ts");
let cleanup = () => {};
afterEach(() => cleanup());

function cli(args: string[]) {
  return spawnSync("bun", [CLI, ...args], { encoding: "utf8", env: { ...process.env }, timeout: 60000 });
}

function writeConfig(value: unknown): void {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(value));
}

function readConfig(): { bundles: Record<string, Record<string, unknown> | undefined> } {
  return JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
}

function retiredWarnings(stderr: string): string[] {
  return stderr.split("\n").filter((line) => line.includes("retired bundles.<name>.components"));
}

function oldConfig(stashDir: string, component: Record<string, unknown>, bundle: Record<string, unknown> = {}) {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    defaultBundle: "main",
    bundles: { main: { path: stashDir, ...bundle, components: { main: component } } },
  };
}

describe("convertBundleComponents", () => {
  test("lifts the component's adapter, root and writable onto the bundle and drops `components`", () => {
    const raw = {
      bundles: { docs: { path: "/p", components: { main: { root: "content", adapter: "okf", writable: false } } } },
    };
    const result = convertBundleComponents(raw);
    expect(result.changed).toBe(true);
    expect(result.bundles).toEqual(["docs"]);
    expect(result.config).toEqual({
      bundles: { docs: { path: "/p", root: "content", adapter: "okf", writable: false } },
    });
  });

  test("a key the bundle already has wins for adapter and root, but the component's writable wins", () => {
    const result = convertBundleComponents({
      bundles: {
        docs: {
          path: "/p",
          adapter: "akm",
          root: "top",
          writable: true,
          components: { main: { root: "old", adapter: "okf", writable: false } },
        },
      },
    });
    expect(result.config.bundles).toEqual({ docs: { path: "/p", adapter: "akm", root: "top", writable: false } });
  });

  test("a root of `.` is the default and is not carried", () => {
    const result = convertBundleComponents({
      bundles: { npm: { npm: "pkg", components: { main: { root: ".", adapter: "akm" } } } },
    });
    expect(result.config.bundles).toEqual({ npm: { npm: "pkg", adapter: "akm" } });
  });

  test("more than one component stays an error", () => {
    const raw = { bundles: { docs: { path: "/p", components: { a: { root: "a" }, b: { root: "b" } } } } };
    expect(() => convertBundleComponents(raw)).toThrow("bundle components map must contain exactly one component");
    expect(() => convertBundleComponents({ bundles: { docs: { path: "/p", components: {} } } })).toThrow(
      "bundle components map must contain exactly one component",
    );
  });

  test("a config with no `components` comes back as it is", () => {
    const raw = { bundles: { docs: { path: "/p", adapter: "okf" } } };
    const result = convertBundleComponents(raw);
    expect(result.changed).toBe(false);
    expect(result.config).toBe(raw);
  });
});

describe("a config in the retired components form", () => {
  test("loads with one warning, and the bundle reports the component's adapter and writable", () => {
    const storage = withIsolatedAkmStorage();
    cleanup = storage.cleanup;
    writeConfig(oldConfig(storage.stashDir, { root: ".", adapter: "okf", writable: false }, { writable: true }));

    const listed = cli(["bundle", "list", "--format", "json"]);
    expect(listed.status, listed.stderr).toBe(0);
    expect(retiredWarnings(listed.stderr)).toHaveLength(1);
    const main = JSON.parse(listed.stdout).sources[0];
    expect(main).toMatchObject({
      name: "main",
      adapter: "okf",
      detected: false,
      writable: false,
      components: [{ name: "main", root: ".", adapter: "okf", detected: false, writable: false }],
    });
    // The file is not rewritten by a read.
    expect(readConfig().bundles.main).toHaveProperty("components");
  });

  test("`akm bundle list` shows top-level adapter and detected, and the deprecated components list", () => {
    const storage = withIsolatedAkmStorage();
    cleanup = storage.cleanup;
    const other = path.join(path.dirname(storage.stashDir), "other");
    fs.mkdirSync(other, { recursive: true });
    writeConfig({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaultBundle: "main",
      bundles: { main: { path: storage.stashDir, adapter: "akm" }, auto: { path: other } },
    });
    const listed = cli(["bundle", "list", "--format", "json"]);
    expect(listed.status, listed.stderr).toBe(0);
    expect(retiredWarnings(listed.stderr)).toHaveLength(0);
    const byName = new Map((JSON.parse(listed.stdout).sources as Array<{ name: string }>).map((s) => [s.name, s]));
    expect(byName.get("main")).toMatchObject({
      adapter: "akm",
      detected: false,
      components: [{ name: "main", adapter: "akm" }],
    });
    expect(byName.get("auto")).toMatchObject({ adapter: "akm", detected: true });
  });

  test("`akm migrate apply` rewrites it to the flat shape, and the next read has nothing to warn about", () => {
    const storage = withIsolatedAkmStorage();
    cleanup = storage.cleanup;
    writeConfig(oldConfig(storage.stashDir, { root: ".", adapter: "okf", writable: false }, { writable: true }));

    const applied = cli(["migrate", "apply"]);
    expect(applied.status, applied.stderr).toBe(0);
    expect(readConfig().bundles.main).toEqual({ path: storage.stashDir, adapter: "okf", writable: false });

    const again = cli(["bundle", "list", "--format", "json"]);
    expect(again.status, again.stderr).toBe(0);
    expect(retiredWarnings(again.stderr)).toHaveLength(0);
  });

  test("an ordinary write keeps the component's writable from winning over the edit", () => {
    const storage = withIsolatedAkmStorage();
    cleanup = storage.cleanup;
    writeConfig(oldConfig(storage.stashDir, { root: ".", adapter: "akm", writable: true }));

    const set = cli(["config", "set", "bundles.main.writable", "false"]);
    expect(set.status, set.stderr).toBe(0);
    const listed = cli(["bundle", "list", "--format", "json"]);
    expect(JSON.parse(listed.stdout).sources[0].writable).toBe(false);
  });

  test("`akm config set bundles.<name>.components.*` is refused, naming the keys that replace it", () => {
    const storage = withIsolatedAkmStorage();
    cleanup = storage.cleanup;
    writeConfig({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaultBundle: "main",
      bundles: { main: { path: storage.stashDir } },
    });
    const before = fs.readFileSync(getConfigPath(), "utf8");
    const refused = cli(["config", "set", "bundles.main.components.main.adapter", "okf"]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("bundles.main.adapter, bundles.main.root or bundles.main.writable");
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);

    const accepted = cli(["config", "set", "bundles.main.adapter", "okf"]);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(readConfig().bundles.main?.adapter).toBe("okf");
  });
});
