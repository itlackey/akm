import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import {
  getBinDir,
  getCacheDir,
  getConfigDir,
  getConfigPath,
  getDbPath,
  getDefaultStashDir,
  getRegistryCacheDir,
  getRegistryIndexCacheDir,
  getWorkflowDbPath,
} from "../src/core/paths";

// ── Environment helpers ─────────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {};

const envKeys = [
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "AKM_CONFIG_DIR",
  "AKM_CACHE_DIR",
  "AKM_STASH_DIR",
];

function saveEnv(): void {
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
}

saveEnv();

afterEach(() => {
  restoreEnv();
});

// ── getConfigDir ────────────────────────────────────────────────────────────

describe("getConfigDir", () => {
  test("uses XDG_CONFIG_HOME on Unix", () => {
    const result = getConfigDir({ XDG_CONFIG_HOME: "/custom/config" }, "linux");
    expect(result).toBe(path.join("/custom/config", "akm"));
  });

  test("falls back to HOME/.config on Unix when XDG_CONFIG_HOME is unset", () => {
    const result = getConfigDir({ HOME: "/home/user" }, "linux");
    expect(result).toBe(path.join("/home/user", ".config", "akm"));
  });

  test("throws on Unix when HOME and XDG_CONFIG_HOME are both unset", () => {
    expect(() => getConfigDir({}, "linux")).toThrow(
      "Unable to determine config directory. Set XDG_CONFIG_HOME or HOME.",
    );
  });

  test("uses APPDATA on Windows", () => {
    const result = getConfigDir({ APPDATA: String.raw`C:\Users\user\AppData\Roaming` }, "win32");
    expect(result).toBe(path.join(String.raw`C:\Users\user\AppData\Roaming`, "akm"));
  });

  test("falls back to USERPROFILE on Windows when APPDATA is unset", () => {
    const result = getConfigDir({ USERPROFILE: String.raw`C:\Users\user` }, "win32");
    expect(result).toBe(path.join(String.raw`C:\Users\user`, "AppData", "Roaming", "akm"));
  });

  test("throws on Windows when APPDATA and USERPROFILE are both unset", () => {
    expect(() => getConfigDir({}, "win32")).toThrow(
      "Unable to determine config directory. Set APPDATA or USERPROFILE.",
    );
  });

  test("trims whitespace from XDG_CONFIG_HOME", () => {
    const result = getConfigDir({ XDG_CONFIG_HOME: "  /trimmed  " }, "linux");
    expect(result).toBe(path.join("/trimmed", "akm"));
  });

  test("trims whitespace from HOME", () => {
    const result = getConfigDir({ HOME: "  /home/user  " }, "linux");
    expect(result).toBe(path.join("/home/user", ".config", "akm"));
  });

  test("ignores empty XDG_CONFIG_HOME and falls back to HOME", () => {
    const result = getConfigDir({ XDG_CONFIG_HOME: "  ", HOME: "/home/user" }, "linux");
    expect(result).toBe(path.join("/home/user", ".config", "akm"));
  });

  test("ignores empty APPDATA on Windows and falls back to USERPROFILE", () => {
    const result = getConfigDir({ APPDATA: "  ", USERPROFILE: String.raw`C:\Users\user` }, "win32");
    expect(result).toBe(path.join(String.raw`C:\Users\user`, "AppData", "Roaming", "akm"));
  });

  test("uses default process.env when env argument omitted", () => {
    process.env.XDG_CONFIG_HOME = "/test-xdg";
    const result = getConfigDir();
    expect(result).toBe(path.join("/test-xdg", "akm"));
  });

  test("uses darwin platform same as linux (XDG path)", () => {
    const result = getConfigDir({ XDG_CONFIG_HOME: "/darwin/cfg" }, "darwin");
    expect(result).toBe(path.join("/darwin/cfg", "akm"));
  });

  test("AKM_CONFIG_DIR overrides all other paths", () => {
    const result = getConfigDir({ AKM_CONFIG_DIR: "/override/config", HOME: "/home/user" }, "linux");
    expect(result).toBe("/override/config");
  });
});

// ── getConfigPath ───────────────────────────────────────────────────────────

describe("getConfigPath", () => {
  test("returns config.json under config dir", () => {
    process.env.XDG_CONFIG_HOME = "/test-cfg";
    expect(getConfigPath()).toBe(path.join("/test-cfg", "akm", "config.json"));
  });
});

// ── getCacheDir ─────────────────────────────────────────────────────────────

describe("getCacheDir", () => {
  test("uses XDG_CACHE_HOME on Unix", () => {
    delete process.env.AKM_CACHE_DIR;
    process.env.XDG_CACHE_HOME = "/custom/cache";
    const result = getCacheDir();
    expect(result).toBe(path.join("/custom/cache", "akm"));
  });

  test("falls back to HOME/.cache on Unix when XDG_CACHE_HOME is unset", () => {
    delete process.env.AKM_CACHE_DIR;
    delete process.env.XDG_CACHE_HOME;
    process.env.HOME = "/home/user";
    const result = getCacheDir();
    expect(result).toBe(path.join("/home/user", ".cache", "akm"));
  });

  test("falls back to /tmp/akm-cache when HOME is also unset", () => {
    delete process.env.AKM_CACHE_DIR;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.HOME;
    const result = getCacheDir();
    expect(result).toBe(path.join("/tmp", "akm-cache"));
  });

  test("AKM_CACHE_DIR overrides all other paths", () => {
    process.env.AKM_CACHE_DIR = "/override/cache";
    const result = getCacheDir();
    expect(result).toBe("/override/cache");
  });
});

// ── getDbPath ───────────────────────────────────────────────────────────────

describe("getDbPath", () => {
  test("returns index.db under cache dir", () => {
    process.env.XDG_CACHE_HOME = "/cache";
    expect(getDbPath()).toBe(path.join("/cache", "akm", "index.db"));
  });
});

describe("getWorkflowDbPath", () => {
  test("returns workflow.db under cache dir", () => {
    process.env.XDG_CACHE_HOME = "/cache";
    expect(getWorkflowDbPath()).toBe(path.join("/cache", "akm", "workflow.db"));
  });
});

// ── getRegistryCacheDir ─────────────────────────────────────────────────────

describe("getRegistryCacheDir", () => {
  test("returns registry subdir under cache dir", () => {
    process.env.XDG_CACHE_HOME = "/cache";
    expect(getRegistryCacheDir()).toBe(path.join("/cache", "akm", "registry"));
  });
});

// ── getRegistryIndexCacheDir ────────────────────────────────────────────────

describe("getRegistryIndexCacheDir", () => {
  test("returns registry-index subdir under cache dir", () => {
    process.env.XDG_CACHE_HOME = "/cache";
    expect(getRegistryIndexCacheDir()).toBe(path.join("/cache", "akm", "registry-index"));
  });
});

// ── getBinDir ───────────────────────────────────────────────────────────────

describe("getBinDir", () => {
  test("returns bin subdir under cache dir", () => {
    process.env.XDG_CACHE_HOME = "/cache";
    expect(getBinDir()).toBe(path.join("/cache", "akm", "bin"));
  });
});

// ── getDefaultStashDir ──────────────────────────────────────────────────────

describe("getDefaultStashDir", () => {
  test("returns HOME/akm on Unix", () => {
    delete process.env.AKM_STASH_DIR;
    process.env.HOME = "/home/user";
    const result = getDefaultStashDir();
    expect(result).toBe(path.join("/home/user", "akm"));
  });

  test("throws when HOME is unset on Unix", () => {
    delete process.env.AKM_STASH_DIR;
    delete process.env.HOME;
    expect(() => getDefaultStashDir()).toThrow("Unable to determine default stash directory. Set HOME.");
  });

  test("AKM_STASH_DIR overrides all other paths", () => {
    process.env.AKM_STASH_DIR = "/override/stash";
    const result = getDefaultStashDir();
    expect(result).toBe("/override/stash");
  });
});
