import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../src/core/config/config";
import { loadConfig, resetConfigCache, saveConfig } from "../src/core/config/config";
import { ConfigError } from "../src/core/errors";
import { getConfigPath } from "../src/core/paths";
import { type Cleanup, type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

// #598 regression guard. The bug: an `akm config` rewrite silently dropped
// process-level tuning fields (consolidate.incrementalSince, minPoolSize,
// extract.minContentChars, per-process `enabled` flags) because they were not
// in the typed schema, so the load→save round trip wiped them. They are now
// first-class `ImproveProcessConfigSchema` fields (config-schema.ts). These
// tests lock the round trip AND the chosen resolution for unknown process keys:
// a hard ConfigError at load time, NOT a silent drop.

let storage: IsolatedAkmStorage;
let cleanup: Cleanup = () => {};

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  resetConfigCache();
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  resetConfigCache();
});

describe("#598 process-level config fields survive a load→save→load round trip", () => {
  test("consolidate/extract tuning fields and enabled flags are preserved", () => {
    const config = {
      semanticSearchMode: "off",
      profiles: {
        improve: {
          default: {
            processes: {
              consolidate: {
                enabled: true,
                incrementalSince: "4h",
                minPoolSize: 50,
                neighborsPerChanged: 3,
              },
              extract: {
                enabled: false,
                minContentChars: 200,
              },
            },
          },
        },
      },
    } as unknown as AkmConfig;

    // Persist, then drop the in-memory cache so the reload comes from disk.
    saveConfig(config);
    resetConfigCache();
    const reloaded = loadConfig();

    const consolidate = reloaded.profiles?.improve?.default?.processes?.consolidate;
    expect(consolidate?.enabled).toBe(true);
    expect(consolidate?.incrementalSince).toBe("4h");
    expect(consolidate?.minPoolSize).toBe(50);
    expect(consolidate?.neighborsPerChanged).toBe(3);

    const extract = reloaded.profiles?.improve?.default?.processes?.extract;
    expect(extract?.enabled).toBe(false);
    expect(extract?.minContentChars).toBe(200);
  });

  test("a second save (rewrite) does not drop the fields the first save persisted", () => {
    saveConfig({
      semanticSearchMode: "off",
      profiles: {
        improve: { default: { processes: { consolidate: { incrementalSince: "6h", minPoolSize: 25 } } } },
      },
    } as unknown as AkmConfig);
    resetConfigCache();

    // Mutate an unrelated field and rewrite — the original failure mode was the
    // rewrite silently clobbering the process-level tuning fields.
    const loaded = loadConfig();
    saveConfig({ ...loaded, semanticSearchMode: "auto" });
    resetConfigCache();

    const consolidate = loadConfig().profiles?.improve?.default?.processes?.consolidate;
    expect(consolidate?.incrementalSince).toBe("6h");
    expect(consolidate?.minPoolSize).toBe(25);
  });

  test("an unknown process sub-key hard-errors at load (chosen resolution: strict, not silent drop)", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        semanticSearchMode: "off",
        profiles: { improve: { default: { processes: { consolidate: { incrementalSince: "4h", bogusKey: 1 } } } } },
      }),
    );
    resetConfigCache();
    expect(() => loadConfig()).toThrow(ConfigError);
  });
});
