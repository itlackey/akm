import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getConfigLockPath } from "../src/core/config/config-io";
import { readCredential, writeCredential } from "../src/core/config/credentials";
import { childProcessEnv, getCacheDir, getConfigDir, getConfigPath, getDataDir, getStateDir } from "../src/core/paths";
import { makeSandboxDir, withEnv } from "./_helpers/sandbox";

describe("selected config file paths", () => {
  test("file overrides directory selection and relative paths become absolute", () => {
    const env = { AKM_CONFIG_FILE: "custom/settings.json", AKM_CONFIG_DIR: "/ignored" };
    expect(getConfigPath(env)).toBe(path.resolve("custom/settings.json"));
    // The selected file never moves the config directory.
    expect(getConfigDir(env)).toBe("/ignored");
  });

  test("an empty AKM_CONFIG_FILE is ignored, as if unset", () => {
    const env = { AKM_CONFIG_FILE: "", AKM_CONFIG_DIR: "/dir" };
    expect(getConfigPath(env)).toBe(path.join("/dir", "config.json"));
  });

  test("credentials stay in the default config dir and write locks follow the selected filename", async () => {
    const sandbox = makeSandboxDir("akm-selected-config-");
    const dir = sandbox.dir;
    const configDir = path.join(dir, "default-config");
    const selected = path.join(dir, "elsewhere", "chosen.json");
    try {
      await withEnv({ AKM_CONFIG_FILE: selected, AKM_CONFIG_DIR: configDir }, async () => {
        writeCredential({ connection: "test" }, "example-value", "https://example.invalid/v1");
        expect(fs.existsSync(path.join(configDir, "credentials.json"))).toBe(true);
        expect(fs.existsSync(path.join(path.dirname(selected), "credentials.json"))).toBe(false);
        expect(readCredential({ connection: "test" }, "https://example.invalid/v1")).toBe("example-value");
        expect(getConfigLockPath()).toBe(`${selected}.lck`);
        expect(childProcessEnv().AKM_CONFIG_FILE).toBe(selected);
      });
    } finally {
      sandbox.cleanup();
    }
  });

  test("the child environment names the resolved config file, selected or default", async () => {
    const sandbox = makeSandboxDir("akm-child-config-");
    try {
      const configDir = path.join(sandbox.dir, "default-config");
      await withEnv({ AKM_CONFIG_FILE: undefined, AKM_CONFIG_DIR: configDir }, async () => {
        expect(childProcessEnv().AKM_CONFIG_FILE).toBe(path.join(configDir, "config.json"));
      });
    } finally {
      sandbox.cleanup();
    }
  });

  test("AKM_DATA_DIR, AKM_STATE_DIR and AKM_CACHE_DIR beat the config file's paths", async () => {
    const sandbox = makeSandboxDir("akm-location-env-");
    try {
      const file = path.join(sandbox.dir, "config.json");
      fs.writeFileSync(
        file,
        JSON.stringify({ paths: { data: "from-file/data", state: "from-file/state", cache: "from-file/cache" } }),
      );
      await withEnv(
        { AKM_CONFIG_FILE: file, AKM_DATA_DIR: undefined, AKM_STATE_DIR: undefined, AKM_CACHE_DIR: undefined },
        async () => {
          expect(getDataDir()).toBe(path.join(sandbox.dir, "from-file/data"));
          expect(getStateDir()).toBe(path.join(sandbox.dir, "from-file/state"));
          expect(getCacheDir()).toBe(path.join(sandbox.dir, "from-file/cache"));
        },
      );
      await withEnv(
        {
          AKM_CONFIG_FILE: file,
          AKM_DATA_DIR: path.join(sandbox.dir, "env-data"),
          AKM_STATE_DIR: path.join(sandbox.dir, "env-state"),
          AKM_CACHE_DIR: path.join(sandbox.dir, "env-cache"),
        },
        async () => {
          expect(getDataDir()).toBe(path.join(sandbox.dir, "env-data"));
          expect(getStateDir()).toBe(path.join(sandbox.dir, "env-state"));
          expect(getCacheDir()).toBe(path.join(sandbox.dir, "env-cache"));
        },
      );
    } finally {
      sandbox.cleanup();
    }
  });
});
