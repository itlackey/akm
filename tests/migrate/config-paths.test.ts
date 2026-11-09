// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm migrate apply` and the `paths` key: a host that located its data, state or cache with
 * `AKM_DATA_DIR`, `AKM_STATE_DIR` or `AKM_CACHE_DIR` keeps them by the file naming them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { normalizeConfigFile } from "../../scripts/akm-migrate/config/normalize";
import { resetConfigCache } from "../../src/core/config/config";
import { getConfigPath } from "../../src/core/paths";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage } from "../_helpers/sandbox";

type Dict = Record<string, unknown>;

let storage: IsolatedAkmStorage;
let dirs: { data: string; state: string; cache: string };

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
  dirs = {
    data: path.join(storage.root, "env-data"),
    state: path.join(storage.root, "env-state"),
    cache: path.join(storage.root, "env-cache"),
  };
});
afterEach(() => {
  resetConfigCache();
  fs.chmodSync(path.dirname(getConfigPath()), 0o755);
  storage.cleanup();
});

const environment = () => ({
  AKM_DATA_DIR: dirs.data,
  AKM_STATE_DIR: dirs.state,
  AKM_CACHE_DIR: dirs.cache,
});

function writeConfig(value: Dict): void {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(value, null, 2)}\n`);
}
const readConfig = (): Dict => JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Dict;
const migrate = (apply: boolean) => normalizeConfigFile(getConfigPath(), { apply });

describe("a host that set the location variables", () => {
  test("`status` reports the paths as pending and writes nothing", async () => {
    writeConfig({ semanticSearchMode: "off" });
    const before = fs.readFileSync(getConfigPath(), "utf8");

    const result = await withEnv(environment(), () => migrate(false));

    expect(result).toMatchObject({ changed: true, applied: false, paths: dirs });
    expect(result.keys).toContain("paths");
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  test("`apply` writes them as absolute paths, and the config then locates them", async () => {
    writeConfig({ semanticSearchMode: "off" });

    const result = await withEnv(environment(), () => migrate(true));

    expect(result).toMatchObject({ changed: true, applied: true, paths: dirs });
    expect(readConfig().paths).toEqual(dirs);
  });

  test("a second apply changes nothing: idempotent", async () => {
    writeConfig({ semanticSearchMode: "off" });
    await withEnv(environment(), () => migrate(true));
    const after = fs.readFileSync(getConfigPath(), "utf8");

    const again = await withEnv(environment(), () => migrate(true));

    expect(again.changed).toBe(false);
    expect(again.paths).toBeUndefined();
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(after);
  });

  test("a location the file already names stays as the file has it; only the others are added", async () => {
    writeConfig({ semanticSearchMode: "off", paths: { data: "kept-relative" } });

    const result = await withEnv(environment(), () => migrate(true));

    expect(result.paths).toEqual({ state: dirs.state, cache: dirs.cache });
    expect(readConfig().paths).toEqual({ data: "kept-relative", state: dirs.state, cache: dirs.cache });
  });

  test("a host that set none gets no `paths`", async () => {
    writeConfig({ semanticSearchMode: "off" });

    const result = await migrate(true);

    expect(result.changed).toBe(false);
    expect(readConfig()).not.toHaveProperty("paths");
  });

  test("with no config file yet, apply makes one that names them", async () => {
    const result = await withEnv(environment(), () => migrate(true));

    expect(result.applied).toBe(true);
    expect(readConfig().paths).toEqual(dirs);
  });
});

// Risk 6: an image bakes the file (or mounts it read-only), so the migrator cannot add `paths`.
describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a config file that cannot be written",
  () => {
    test("is reported with the entries for the image template, not a crash, and is left as it was", async () => {
      writeConfig({ semanticSearchMode: "off" });
      const before = fs.readFileSync(getConfigPath(), "utf8");
      fs.chmodSync(getConfigPath(), 0o444);
      fs.chmodSync(path.dirname(getConfigPath()), 0o555);

      const result = await withEnv(environment(), () => migrate(true));

      expect(result).toMatchObject({ changed: false, applied: false, paths: dirs });
      expect(result.notes?.join("\n")).toContain("cannot be written");
      expect(result.notes?.join("\n")).toContain(JSON.stringify({ paths: dirs }));
      expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    });
  },
);
