// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `migrateLegacySourceShape` (`src/core/config/legacy-source-shape-shim.ts`)
 * already folds a legacy `stashDir`/`sources[]`/`installed` config into
 * `bundles`/`defaultBundle` in memory on every load, warning that
 * `akm migrate apply` will rewrite the file. `findConfigLegacySourceShape`
 * (status, read-only) and `applyConfigLegacySourceShape` (apply, persists
 * once) are the on-disk counterpart, in the same one-time-migration shape as
 * `./config-extra-params.ts` — replacing what `stripRetiredConfigKeys`
 * (`./config-retired-keys.ts`) used to do here, which deleted this shape
 * instead of converting it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyConfigLegacySourceShape,
  findConfigLegacySourceShape,
} from "../../scripts/akm-migrate/migrate/config-legacy-source-shape";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";

let root: string;
let configPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-config-legacy-source-shape-"));
  configPath = path.join(root, "config.json");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
  fs.writeFileSync(configPath, JSON.stringify(value));
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

describe("findConfigLegacySourceShape (status, read-only)", () => {
  test("reports nothing when the config file does not exist", () => {
    expect(findConfigLegacySourceShape(configPath)).toEqual({ converted: [] });
  });

  test("reports nothing for a config already on the bundles/defaultBundle shape", () => {
    writeConfig({ configVersion: "0.9.0", defaultBundle: "stash", bundles: { stash: { path: "/srv/stash" } } });
    expect(findConfigLegacySourceShape(configPath)).toEqual({ converted: [] });
  });

  test("lists the legacy keys present, without touching the file", () => {
    writeConfig({
      configVersion: "0.9.0",
      stashDir: "/srv/stash",
      sources: [{ type: "git", url: "https://example.com/team.git", name: "team" }],
      installed: [],
    });
    const plan = findConfigLegacySourceShape(configPath);
    expect(new Set(plan.converted)).toEqual(new Set(["stashDir", "sources", "installed"]));
    const before = readConfig();
    expect(before.stashDir).toBe("/srv/stash");
    expect(before.bundles).toBeUndefined();
  });

  test("converts an empty sources[] and an empty stashDir instead of leaving them untouched", () => {
    writeConfig({ configVersion: "0.9.0", sources: [], stashDir: "", semanticSearchMode: "off" });
    const plan = findConfigLegacySourceShape(configPath);
    expect(new Set(plan.converted)).toEqual(new Set(["stashDir", "sources"]));
  });

  test("emits no warning while planning a legacy config", () => {
    writeConfig({ configVersion: "0.9.0", stashDir: "/srv/stash" });
    const warnings: string[] = [];
    _resetWarnOnceForTests();
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      findConfigLegacySourceShape(configPath);
    } finally {
      _setWarnSinkForTests(undefined);
    }
    expect(warnings).toEqual([]);
  });
});

describe("applyConfigLegacySourceShape (apply, persists once)", () => {
  test("does nothing when the config file does not exist", () => {
    expect(applyConfigLegacySourceShape(configPath)).toEqual({ applied: false, converted: [] });
    expect(fs.existsSync(configPath)).toBe(false);
  });

  test("does nothing when the config carries none of the legacy shape", () => {
    writeConfig({ configVersion: "0.9.0", defaultBundle: "stash", bundles: { stash: { path: "/srv/stash" } } });
    const before = readConfig();
    expect(applyConfigLegacySourceShape(configPath)).toEqual({ applied: false, converted: [] });
    expect(readConfig()).toEqual(before);
  });

  test("converts stashDir + sources[] + installed into bundles/defaultBundle, backs up once, and a second apply is a no-op", () => {
    writeConfig({
      configVersion: "0.9.0",
      stashDir: "/srv/stash",
      sources: [{ type: "git", url: "https://example.com/team.git", name: "team" }],
      installed: [],
      semanticSearchMode: "off",
    });

    const backupDir = path.join(process.env.XDG_CACHE_HOME ?? "", "akm", "config-backups");
    const before = new Set(fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : []);

    const result = applyConfigLegacySourceShape(configPath);
    expect(new Set(result.converted)).toEqual(new Set(["stashDir", "sources", "installed"]));
    expect(result.applied).toBe(true);

    const after = readConfig();
    expect(after.stashDir).toBeUndefined();
    expect(after.sources).toBeUndefined();
    expect(after.installed).toBeUndefined();
    expect(after.defaultBundle).toBe("stash");
    expect(after.bundles).toEqual({
      stash: { path: "/srv/stash", writable: true },
      team: { git: "https://example.com/team.git", writable: false },
    });
    // Every other key survives byte-for-byte in value.
    expect(after.semanticSearchMode).toBe("off");

    const added = fs.readdirSync(backupDir).filter((name) => !before.has(name) && name !== "config.latest.json");
    expect(added).toHaveLength(1);
    expect(fs.readFileSync(path.join(backupDir, added[0] as string), "utf8")).toContain("stashDir");

    const second = applyConfigLegacySourceShape(configPath);
    expect(second).toEqual({ applied: false, converted: [] });
    const afterSecond = fs.readdirSync(backupDir).filter((name) => !before.has(name) && name !== "config.latest.json");
    expect(afterSecond).toEqual(added);
  });

  test("emits no warning while applying a legacy config", () => {
    writeConfig({ configVersion: "0.9.0", stashDir: "/srv/stash" });
    const warnings: string[] = [];
    _resetWarnOnceForTests();
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      const result = applyConfigLegacySourceShape(configPath);
      expect(result.applied).toBe(true);
    } finally {
      _setWarnSinkForTests(undefined);
    }
    expect(warnings).toEqual([]);
  });

  test("converts an empty sources[], backs up once, and a second apply is a no-op", () => {
    writeConfig({ configVersion: "0.9.0", sources: [], semanticSearchMode: "off" });

    const backupDir = path.join(process.env.XDG_CACHE_HOME ?? "", "akm", "config-backups");
    const before = new Set(fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : []);

    const result = applyConfigLegacySourceShape(configPath);
    expect(result).toEqual({ applied: true, converted: ["sources"] });

    const after = readConfig();
    expect(after.sources).toBeUndefined();
    expect(after.semanticSearchMode).toBe("off");

    const added = fs.readdirSync(backupDir).filter((name) => !before.has(name) && name !== "config.latest.json");
    expect(added).toHaveLength(1);

    const second = applyConfigLegacySourceShape(configPath);
    expect(second).toEqual({ applied: false, converted: [] });
    const afterSecond = fs.readdirSync(backupDir).filter((name) => !before.has(name) && name !== "config.latest.json");
    expect(afterSecond).toEqual(added);
  });

  test("converts an empty stashDir, backs up once, and a second apply is a no-op", () => {
    writeConfig({ configVersion: "0.9.0", stashDir: "", semanticSearchMode: "off" });

    const backupDir = path.join(process.env.XDG_CACHE_HOME ?? "", "akm", "config-backups");
    const before = new Set(fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : []);

    const result = applyConfigLegacySourceShape(configPath);
    expect(result).toEqual({ applied: true, converted: ["stashDir"] });

    const after = readConfig();
    expect(after.stashDir).toBeUndefined();
    expect(after.bundles).toBeUndefined();
    expect(after.semanticSearchMode).toBe("off");

    const added = fs.readdirSync(backupDir).filter((name) => !before.has(name) && name !== "config.latest.json");
    expect(added).toHaveLength(1);

    const second = applyConfigLegacySourceShape(configPath);
    expect(second).toEqual({ applied: false, converted: [] });
    const afterSecond = fs.readdirSync(backupDir).filter((name) => !before.has(name) && name !== "config.latest.json");
    expect(afterSecond).toEqual(added);
  });

  test("a converted config no longer warns about the legacy shape on the next in-memory read", () => {
    writeConfig({ configVersion: "0.9.0", stashDir: "/srv/stash" });
    applyConfigLegacySourceShape(configPath);

    const warnings: string[] = [];
    _resetWarnOnceForTests();
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      // The same detection findConfigLegacySourceShape uses is what the
      // in-memory read shim runs on every load; re-running it here proves
      // the file no longer trips it.
      expect(findConfigLegacySourceShape(configPath)).toEqual({ converted: [] });
    } finally {
      _setWarnSinkForTests(undefined);
    }
    expect(warnings.some((w) => w.includes("legacy-source-shape") || w.includes("stashDir"))).toBe(false);
  });
});
