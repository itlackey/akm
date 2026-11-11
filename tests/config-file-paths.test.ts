import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getConfigLockPath } from "../src/core/config/config-io";
import { readCredential, writeCredential } from "../src/core/config/credentials";
import { akmLocations, childProcessEnv, getConfigDir, getConfigPath } from "../src/core/paths";
import {
  scheduledRowEnvironment,
  scheduledRowEnvironmentEntries,
  scheduledRowEnvironmentFrom,
  scheduledTaskContextEnv,
} from "../src/tasks/scheduler-invocation";
import { makeSandboxDir, withEnv } from "./_helpers/sandbox";

describe("selected config file paths", () => {
  test("file overrides directory selection and relative paths become absolute", () => {
    const env = { AKM_CONFIG_FILE: "custom/settings.json", AKM_CONFIG_DIR: "/ignored" };
    expect(getConfigPath(env)).toBe(path.resolve("custom/settings.json"));
    expect(getConfigDir(env)).toBe(path.resolve("custom"));
    expect(() => getConfigPath({ AKM_CONFIG_FILE: "" })).toThrow("non-empty file path");
  });

  test("credentials stay adjacent and write locks follow the selected filename", async () => {
    const sandbox = makeSandboxDir("akm-selected-config-");
    const dir = sandbox.dir;
    const selected = path.join(dir, "chosen.json");
    try {
      await withEnv({ AKM_CONFIG_FILE: selected }, async () => {
        writeCredential({ connection: "test" }, "example-value", "https://example.invalid/v1");
        expect(fs.existsSync(path.join(dir, "credentials.json"))).toBe(true);
        expect(readCredential({ connection: "test" }, "https://example.invalid/v1", true)).toBe("example-value");
        expect(getConfigLockPath()).toBe(`${selected}.lck`);
        expect(akmLocations().AKM_CONFIG_FILE).toBe(selected);
        expect(childProcessEnv().AKM_CONFIG_FILE).toBe(selected);
      });
    } finally {
      sandbox.cleanup();
    }
  });

  test("child environment does not introduce a file selector when absent", async () => {
    await withEnv({ AKM_CONFIG_FILE: undefined }, async () => {
      expect(akmLocations().AKM_CONFIG_FILE).toBeUndefined();
      expect(childProcessEnv().AKM_CONFIG_FILE).toBeUndefined();
    });
  });

  test("scheduler contexts retain the explicit absolute file without freezing directory defaults", () => {
    const sandbox = makeSandboxDir("akm-file-scheduler-");
    try {
      const env = { AKM_CONFIG_FILE: "custom/settings.json", AKM_BUNDLE_DIR: sandbox.dir };
      const row = scheduledRowEnvironment(env);
      expect(row).toEqual({ AKM_BUNDLE_DIR: sandbox.dir, AKM_CONFIG_FILE: path.resolve("custom/settings.json") });
      const entries = scheduledRowEnvironmentEntries(row);
      expect(scheduledRowEnvironmentFrom(Object.fromEntries(entries))).toEqual(row);
      expect(scheduledTaskContextEnv(Object.fromEntries(entries))).toEqual(row);
      expect(scheduledRowEnvironment({ AKM_BUNDLE_DIR: sandbox.dir })).toEqual({ AKM_BUNDLE_DIR: sandbox.dir });
    } finally {
      sandbox.cleanup();
    }
  });
});
