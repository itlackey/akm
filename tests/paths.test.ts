import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { ConfigError } from "../src/core/errors";
import {
  childProcessEnv,
  getCacheDir,
  getConfigDir,
  getConfigPath,
  getDataDir,
  getDbPath,
  getDefaultStashDir,
  getLockfileLockPath,
  getLockfilePath,
  getRegistryCacheDir,
  getRegistryIndexCacheDir,
  getStashLocksDir,
  getStashStateKey,
  getStateDir,
  getUnresolvedSourcesDir,
} from "../src/core/paths";

// ── Environment helpers ─────────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {};

const envKeys = [
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "AKM_CONFIG_FILE",
  "AKM_CONFIG_DIR",
  "AKM_CACHE_DIR",
  "AKM_DATA_DIR",
  "AKM_STATE_DIR",
  "AKM_BUNDLE_DIR",
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
});

// ── getConfigPath ───────────────────────────────────────────────────────────

describe("getConfigPath", () => {
  test("returns config.json under config dir", () => {
    process.env.XDG_CONFIG_HOME = "/test-cfg";
    expect(getConfigPath()).toBe(path.join("/test-cfg", "akm", "config.json"));
  });

  test("honors an injected env object (DI seam) over process.env", () => {
    process.env.XDG_CONFIG_HOME = "/ambient-cfg";
    expect(getConfigPath({ XDG_CONFIG_HOME: "/injected-cfg" })).toBe(path.join("/injected-cfg", "akm", "config.json"));
  });
});

// ── getCacheDir ─────────────────────────────────────────────────────────────

describe("getCacheDir", () => {
  test("uses XDG_CACHE_HOME on Unix", () => {
    process.env.XDG_CACHE_HOME = "/custom/cache";
    const result = getCacheDir();
    expect(result).toBe(path.join("/custom/cache", "akm"));
  });

  test("falls back to HOME/.cache on Unix when XDG_CACHE_HOME is unset", () => {
    delete process.env.XDG_CACHE_HOME;
    process.env.HOME = "/home/user";
    const result = getCacheDir();
    expect(result).toBe(path.join("/home/user", ".cache", "akm"));
  });

  test("falls back to a UID-SCOPED tmp cache dir when HOME is also unset", () => {
    delete process.env.XDG_CACHE_HOME;
    delete process.env.HOME;
    const result = getCacheDir();
    // The uid suffix is load-bearing: a fixed /tmp/akm-cache is world-shared and
    // entirely predictable, so on a multi-user host the first uid to run akm
    // owns it and every other user then reads and writes the same cache — and
    // any local user can pre-create the path (or a symlink at it) and wait.
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    expect(result).toBe(path.join(os.tmpdir(), uid === undefined ? "akm-cache" : `akm-cache-${uid}`));
    expect(result.startsWith(path.join(os.tmpdir(), "akm-cache"))).toBe(true);
  });

  test("honors an injected env without reading or mutating process.env", () => {
    // Pin the real global to a value that MUST NOT influence the result.
    process.env.XDG_CACHE_HOME = "/host/should-be-ignored";
    const before = JSON.stringify(process.env);
    const result = getCacheDir({ XDG_CACHE_HOME: "/injected/cache" });
    expect(result).toBe(path.join("/injected/cache", "akm"));
    // The resolver read only the injected env and left the global untouched.
    expect(JSON.stringify(process.env)).toBe(before);
  });
});

// ── getDataDir ──────────────────────────────────────────────────────────────

describe("getDataDir", () => {
  test("uses XDG_DATA_HOME on Unix", () => {
    const result = getDataDir({ XDG_DATA_HOME: "/custom/data" }, "linux");
    expect(result).toBe(path.join("/custom/data", "akm"));
  });

  test("falls back to HOME/.local/share on Unix when XDG_DATA_HOME is unset", () => {
    const result = getDataDir({ HOME: "/home/user" }, "linux");
    expect(result).toBe(path.join("/home/user", ".local", "share", "akm"));
  });

  test("falls back to a UID-SCOPED tmp data dir when HOME is also unset", () => {
    const result = getDataDir({}, "linux");
    // See the cache-dir case above: the index and state DBs must not land on a
    // world-shared, predictable path.
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    expect(result).toBe(path.join(os.tmpdir(), uid === undefined ? "akm-data" : `akm-data-${uid}`));
  });

  test("uses LOCALAPPDATA on Windows", () => {
    const result = getDataDir({ LOCALAPPDATA: String.raw`C:\Users\user\AppData\Local` }, "win32");
    expect(result).toBe(path.join(String.raw`C:\Users\user\AppData\Local`, "akm", "data"));
  });

  test("ignores empty XDG_DATA_HOME and falls back to HOME", () => {
    const result = getDataDir({ XDG_DATA_HOME: "  ", HOME: "/home/user" }, "linux");
    expect(result).toBe(path.join("/home/user", ".local", "share", "akm"));
  });

  test("uses default process.env when env argument omitted", () => {
    process.env.XDG_DATA_HOME = "/test-data-xdg";
    const result = getDataDir();
    expect(result).toBe(path.join("/test-data-xdg", "akm"));
  });

  // ── No test sentinel ──────────────────────────────────────────────────────
  //
  // akm does not ask whether it runs under a test. `NODE_ENV=test` or `BUN_TEST=1` in a shell resolves the same
  // directories as without them. What stops a test run reaching the developer's real directories is the harness
  // (tests/_preload.ts, tests/_helpers/isolation-guard.ts; tests/isolation-guard.test.ts).

  test("NODE_ENV=test and BUN_TEST=1 do not change the data directory", () => {
    const plain = getDataDir({ HOME: "/home/user" }, "linux");
    expect(plain).toBe(path.join("/home/user", ".local", "share", "akm"));
    expect(getDataDir({ NODE_ENV: "test", HOME: "/home/user" }, "linux")).toBe(plain);
    expect(getDataDir({ BUN_TEST: "1", HOME: "/home/user" }, "linux")).toBe(plain);
  });

  test("XDG_DATA_HOME still wins, test sentinel or not", () => {
    expect(getDataDir({ NODE_ENV: "test", XDG_DATA_HOME: "/tmp/xdg-data", HOME: "/home/user" }, "linux")).toBe(
      path.join("/tmp/xdg-data", "akm"),
    );
  });
});

// ── getDbPath ───────────────────────────────────────────────────────────────

describe("getDbPath", () => {
  test("returns index.db under data dir", () => {
    process.env.XDG_DATA_HOME = "/data";
    expect(getDbPath()).toBe(path.join("/data", "akm", "index.db"));
  });

  test("honors an injected env object (DI seam) over process.env", () => {
    process.env.XDG_DATA_HOME = "/ambient-data";
    expect(getDbPath({ XDG_DATA_HOME: "/injected-data" })).toBe(path.join("/injected-data", "akm", "index.db"));
  });
});

// getWorkflowDbPath removed in Chunk-8 WI-8.3 (workflow.db folded into state.db;
// the physical path literal survives only in the migrator home,
// scripts/akm-migrate/migrate/legacy/legacy-paths.ts).

// ── getLockfilePath / getLockfileLockPath ───────────────────────────────────

describe("getLockfilePath", () => {
  test("returns akm.lock under data dir", () => {
    process.env.XDG_DATA_HOME = "/data";
    expect(getLockfilePath()).toBe(path.join("/data", "akm", "akm.lock"));
  });
});

describe("getLockfileLockPath", () => {
  test("returns akm.lock.lck under data dir", () => {
    process.env.XDG_DATA_HOME = "/data";
    expect(getLockfileLockPath()).toBe(path.join("/data", "akm", "akm.lock.lck"));
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

// ── getStateDir ──────────────────────────────────────────────────────────────

describe("getStateDir", () => {
  test("uses XDG_STATE_HOME on Unix", () => {
    const result = getStateDir({ XDG_STATE_HOME: "/custom/state" }, "linux");
    expect(result).toBe(path.join("/custom/state", "akm"));
  });

  test("falls back to HOME/.local/state on Unix when XDG_STATE_HOME is unset", () => {
    const result = getStateDir({ HOME: "/home/user" }, "linux");
    expect(result).toBe(path.join("/home/user", ".local", "state", "akm"));
  });

  test("falls back to a UID-scoped tmp state dir when HOME is also unset", () => {
    const result = getStateDir({}, "linux");
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    expect(result).toBe(path.join(os.tmpdir(), uid === undefined ? "akm-state" : `akm-state-${uid}`));
  });

  test("uses LOCALAPPDATA on Windows", () => {
    const result = getStateDir({ LOCALAPPDATA: String.raw`C:\Users\user\AppData\Local` }, "win32");
    expect(result).toBe(path.join(String.raw`C:\Users\user\AppData\Local`, "akm", "state"));
  });

  test("honors an injected env without reading or mutating process.env", () => {
    process.env.XDG_STATE_HOME = "/host/should-be-ignored";
    const before = JSON.stringify(process.env);
    const result = getStateDir({ XDG_STATE_HOME: "/injected/state" }, "linux");
    expect(result).toBe(path.join("/injected/state", "akm"));
    expect(JSON.stringify(process.env)).toBe(before);
  });
});

// ── getStashStateKey / per-stash $STATE and $CACHE writers (itlackey/akm#890) ─

describe("getStashStateKey", () => {
  test("is deterministic for the same resolved absolute path", () => {
    expect(getStashStateKey("/a/b/stash")).toBe(getStashStateKey("/a/b/stash"));
  });

  test("differs between two distinct stash directories", () => {
    expect(getStashStateKey("/a/b/stash-one")).not.toBe(getStashStateKey("/a/b/stash-two"));
  });

  test("resolves a relative path the same as its absolute form", () => {
    const cwdRelative = path.relative(process.cwd(), "/a/b/stash");
    expect(getStashStateKey(cwdRelative)).toBe(getStashStateKey("/a/b/stash"));
  });

  test("is a fixed-length lowercase hex string (bundle-id.ts's shortHash format)", () => {
    expect(getStashStateKey("/a/b/stash")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("per-stash $STATE/$CACHE writer dirs", () => {
  test("namespace two different stashes to two different directories", () => {
    process.env.XDG_STATE_HOME = "/state";
    process.env.XDG_CACHE_HOME = "/cache";
    expect(getUnresolvedSourcesDir("/stash-a")).not.toBe(getUnresolvedSourcesDir("/stash-b"));
    expect(getStashLocksDir("/stash-a")).not.toBe(getStashLocksDir("/stash-b"));
  });

  test("are rooted at $STATE/locks/* or $CACHE/index/* respectively", () => {
    process.env.XDG_STATE_HOME = "/state";
    process.env.XDG_CACHE_HOME = "/cache";
    const key = getStashStateKey("/stash-a");
    expect(getUnresolvedSourcesDir("/stash-a")).toBe(path.join("/cache", "akm", "index", "unresolved-sources", key));
    expect(getStashLocksDir("/stash-a")).toBe(path.join("/state", "akm", "locks", key));
  });
});

// ── getDefaultStashDir ──────────────────────────────────────────────────────

describe("getDefaultStashDir", () => {
  test("returns HOME/akm on Unix", () => {
    process.env.HOME = "/home/user";
    const result = getDefaultStashDir();
    expect(result).toBe(path.join("/home/user", "akm"));
  });

  test("throws when HOME is unset on Unix", () => {
    delete process.env.HOME;
    expect(() => getDefaultStashDir()).toThrow("Unable to determine default bundle directory. Set HOME.");
  });

  test("honors an injected env without reading or mutating process.env", () => {
    // Pin the real global to a value that MUST NOT influence the result.
    process.env.HOME = "/host/should-be-ignored";
    const before = JSON.stringify(process.env);
    const result = getDefaultStashDir({ HOME: "/injected/home" });
    expect(result).toBe(path.join("/injected/home", "akm"));
    expect(JSON.stringify(process.env)).toBe(before);
  });
});

describe("childProcessEnv", () => {
  test("hands a child the config file akm resolved, and nothing about the bundle", () => {
    process.env.XDG_CONFIG_HOME = "/xdg/config";
    process.env.XDG_DATA_HOME = "/xdg/data";
    process.env.XDG_CACHE_HOME = "/xdg/cache";
    process.env.XDG_STATE_HOME = "/xdg/state";
    delete process.env.AKM_CONFIG_FILE;

    // The config file only: it names data, state and cache itself (`paths`) and the bundle (`defaultBundle`).
    expect(childProcessEnv().AKM_CONFIG_FILE).toBe(getConfigPath());
    expect(childProcessEnv()).not.toHaveProperty("AKM_BUNDLE_DIR");
    expect(getDataDir()).toContain(path.join("/xdg/data"));
  });
});

// ── The location variables ──────────────────────────────────────────────────

describe("the location variables", () => {
  const places = {
    AKM_CONFIG_DIR: (env: NodeJS.ProcessEnv) => getConfigDir(env, "linux"),
    AKM_DATA_DIR: (env: NodeJS.ProcessEnv) => getDataDir(env, "linux"),
    AKM_STATE_DIR: (env: NodeJS.ProcessEnv) => getStateDir(env, "linux"),
    AKM_CACHE_DIR: (env: NodeJS.ProcessEnv) => getCacheDir(env),
  } as const;

  for (const [name, resolve] of Object.entries(places)) {
    test(`${name} beats the XDG base`, () => {
      expect(
        resolve({
          [name]: "/chosen/place",
          HOME: "/home/user",
          XDG_CONFIG_HOME: "/xdg",
          XDG_DATA_HOME: "/xdg",
          XDG_STATE_HOME: "/xdg",
          XDG_CACHE_HOME: "/xdg",
        }),
      ).toBe("/chosen/place");
    });
  }

  test("an empty one is not set", () => {
    expect(getDataDir({ AKM_DATA_DIR: "  ", HOME: "/home/user" }, "linux")).toBe(
      path.join("/home/user", ".local", "share", "akm"),
    );
  });

  test("AKM_CONFIG_DIR does not move a selected config file", () => {
    const env = { AKM_CONFIG_DIR: "/dir", AKM_CONFIG_FILE: "/etc/akm/config.json" };
    expect(getConfigPath(env)).toBe("/etc/akm/config.json");
    expect(getConfigDir(env, "linux")).toBe("/dir");
  });
});
