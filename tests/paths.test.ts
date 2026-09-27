import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import {
  getCacheDir,
  getConfigDir,
  getConfigPath,
  getDataDir,
  getDbPath,
  getDefaultStashDir,
  getLockfileLockPath,
  getLockfilePath,
  getMeasurementVerdictsDir,
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

  test("AKM_CONFIG_DIR overrides all other paths", () => {
    const result = getConfigDir({ AKM_CONFIG_DIR: "/override/config", HOME: "/home/user" }, "linux");
    expect(result).toBe("/override/config");
  });

  // Regression: the 2026-05-23 setup-clobbers-user-config incident. When the user (or a
  // test harness) sets AKM_BUNDLE_DIR to a transient path, config writes
  // must NOT target the user's host ~/.config/akm — they must route into
  // the stash so saveConfig() can never silently clobber the host.
  test("AKM_BUNDLE_DIR=/tmp/X routes config to /tmp/X/.akm (isolation safety)", () => {
    const result = getConfigDir({ AKM_BUNDLE_DIR: "/tmp/test-stash", HOME: "/home/user" }, "linux");
    expect(result).toBe(path.join("/tmp/test-stash", ".akm"));
  });

  test("AKM_BUNDLE_DIR=/private/var/folders/... (macOS mktemp) also triggers isolation", () => {
    const result = getConfigDir(
      { AKM_BUNDLE_DIR: "/private/var/folders/zz/abc/T/akm-test", HOME: "/Users/user" },
      "darwin",
    );
    expect(result).toBe(path.join("/private/var/folders/zz/abc/T/akm-test", ".akm"));
  });

  test("AKM_BUNDLE_DIR=~/my-stash (persistent path) does NOT redirect — daily users unaffected", () => {
    const result = getConfigDir({ AKM_BUNDLE_DIR: "/home/user/my-stash", HOME: "/home/user" }, "linux");
    expect(result).toBe(path.join("/home/user", ".config", "akm"));
  });

  test("AKM_CONFIG_DIR override beats AKM_BUNDLE_DIR isolation rule (explicit wins)", () => {
    const result = getConfigDir(
      { AKM_CONFIG_DIR: "/keep/host/config", AKM_BUNDLE_DIR: "/tmp/transient", HOME: "/home/user" },
      "linux",
    );
    expect(result).toBe("/keep/host/config");
  });

  test("XDG_CONFIG_HOME also beats AKM_BUNDLE_DIR isolation rule (existing tests rely on this)", () => {
    const result = getConfigDir(
      { XDG_CONFIG_HOME: "/iso/cfg", AKM_BUNDLE_DIR: "/tmp/transient", HOME: "/home/user" },
      "linux",
    );
    expect(result).toBe(path.join("/iso/cfg", "akm"));
  });

  test("APPDATA on Windows also beats AKM_BUNDLE_DIR isolation rule", () => {
    const result = getConfigDir({ APPDATA: String.raw`C:\iso\cfg`, AKM_BUNDLE_DIR: "/tmp/transient" }, "win32");
    expect(result).toBe(path.join(String.raw`C:\iso\cfg`, "akm"));
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
    delete process.env.AKM_CACHE_DIR;
    process.env.XDG_CACHE_HOME = "/custom/cache";
    const result = getCacheDir();
    expect(result).toBe(path.join("/custom/cache", "akm"));
  });

  test("falls back to HOME/.cache on Unix when XDG_CACHE_HOME is unset", () => {
    delete process.env.AKM_CACHE_DIR;
    delete process.env.XDG_CACHE_HOME;
    // Clear AKM_BUNDLE_DIR too — under CI, it can be inherited from outer
    // test isolation pointing at a transient dir, which would trigger the
    // new isolation rule and override this test's HOME-based expectation.
    delete process.env.AKM_BUNDLE_DIR;
    process.env.HOME = "/home/user";
    const result = getCacheDir();
    expect(result).toBe(path.join("/home/user", ".cache", "akm"));
  });

  test("falls back to a UID-SCOPED tmp cache dir when HOME is also unset", () => {
    delete process.env.AKM_CACHE_DIR;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.AKM_BUNDLE_DIR;
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

  test("AKM_CACHE_DIR overrides all other paths", () => {
    process.env.AKM_CACHE_DIR = "/override/cache";
    const result = getCacheDir();
    expect(result).toBe("/override/cache");
  });

  // Regression: the 2026-05-23 setup-clobbers-user-config incident companion fix. When
  // AKM_BUNDLE_DIR is transient, cache (which holds config-backups/) must
  // also isolate into the stash so saveConfig backup writes do not
  // pollute the user's host ~/.cache/akm/config-backups/.
  test("AKM_BUNDLE_DIR=/tmp/X routes cache to /tmp/X/.akm/cache (isolation safety)", () => {
    delete process.env.AKM_CACHE_DIR;
    delete process.env.XDG_CACHE_HOME;
    process.env.HOME = "/home/user";
    process.env.AKM_BUNDLE_DIR = "/tmp/test-cache-stash";
    const result = getCacheDir();
    expect(result).toBe(path.join("/tmp/test-cache-stash", ".akm", "cache"));
  });

  test("AKM_BUNDLE_DIR=~/persistent does NOT redirect cache (daily users unaffected)", () => {
    delete process.env.AKM_CACHE_DIR;
    delete process.env.XDG_CACHE_HOME;
    process.env.HOME = "/home/user";
    process.env.AKM_BUNDLE_DIR = "/home/user/my-stash";
    const result = getCacheDir();
    expect(result).toBe(path.join("/home/user", ".cache", "akm"));
  });

  test("AKM_CACHE_DIR beats AKM_BUNDLE_DIR isolation rule", () => {
    process.env.AKM_CACHE_DIR = "/override/cache";
    process.env.AKM_BUNDLE_DIR = "/tmp/transient";
    const result = getCacheDir();
    expect(result).toBe("/override/cache");
  });

  test("XDG_CACHE_HOME also beats AKM_BUNDLE_DIR isolation rule (existing tests rely on this)", () => {
    delete process.env.AKM_CACHE_DIR;
    process.env.XDG_CACHE_HOME = "/iso/cache";
    process.env.AKM_BUNDLE_DIR = "/tmp/transient";
    const result = getCacheDir();
    expect(result).toBe(path.join("/iso/cache", "akm"));
  });

  test("honors an injected env without reading or mutating process.env", () => {
    // Pin the real global to a value that MUST NOT influence the result.
    process.env.AKM_CACHE_DIR = "/host/should-be-ignored";
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

  test("AKM_DATA_DIR overrides all other paths", () => {
    const result = getDataDir({ AKM_DATA_DIR: "/override/data", HOME: "/home/user" }, "linux");
    expect(result).toBe("/override/data");
  });

  test("ignores empty XDG_DATA_HOME and falls back to HOME", () => {
    const result = getDataDir({ XDG_DATA_HOME: "  ", HOME: "/home/user" }, "linux");
    expect(result).toBe(path.join("/home/user", ".local", "share", "akm"));
  });

  test("uses default process.env when env argument omitted", () => {
    process.env.XDG_DATA_HOME = "/test-data-xdg";
    delete process.env.AKM_DATA_DIR;
    const result = getDataDir();
    expect(result).toBe(path.join("/test-data-xdg", "akm"));
  });

  // ── Test-isolation write-guard ────────────────────────────────────────────
  //
  // Defense-in-depth: under `bun test` / NODE_ENV=test, every call to
  // getDataDir() must resolve through an explicit XDG_DATA_HOME or
  // AKM_DATA_DIR override. Falling through to the developer's real
  // ~/.local/share/akm silently writes SQLite databases, lockfiles, and
  // snapshots into their personal data dir (observed: 4,183-row
  // registry-cache pollution). The guard catches that by throwing
  // TEST_ISOLATION_MISSING regardless of whether AKM_BUNDLE_DIR is set.

  test("test-isolation guard fires when BUN_TEST=1 and XDG_DATA_HOME missing", () => {
    expect(() => getDataDir({ BUN_TEST: "1", HOME: "/home/user" }, "linux")).toThrow(
      /Refusing to resolve data directory under bun test/,
    );
  });

  test("test-isolation guard fires when NODE_ENV=test and XDG_DATA_HOME missing", () => {
    expect(() => getDataDir({ NODE_ENV: "test", HOME: "/home/user" }, "linux")).toThrow(
      /Refusing to resolve data directory under bun test/,
    );
  });

  test("test-isolation guard does NOT fire when both AKM_BUNDLE_DIR and XDG_DATA_HOME are set", () => {
    const result = getDataDir(
      { NODE_ENV: "test", AKM_BUNDLE_DIR: "/tmp/stash", XDG_DATA_HOME: "/tmp/xdg-data", HOME: "/home/user" },
      "linux",
    );
    expect(result).toBe(path.join("/tmp/xdg-data", "akm"));
  });

  test("test-isolation guard does NOT fire when XDG_DATA_HOME alone is set", () => {
    const result = getDataDir({ NODE_ENV: "test", XDG_DATA_HOME: "/tmp/xdg-data", HOME: "/home/user" }, "linux");
    expect(result).toBe(path.join("/tmp/xdg-data", "akm"));
  });

  test("test-isolation guard does NOT fire when AKM_DATA_DIR override is set", () => {
    const result = getDataDir(
      { NODE_ENV: "test", AKM_BUNDLE_DIR: "/tmp/stash", AKM_DATA_DIR: "/tmp/akm-data", HOME: "/home/user" },
      "linux",
    );
    expect(result).toBe("/tmp/akm-data");
  });

  test("test-isolation guard does NOT fire outside tests (no BUN_TEST / NODE_ENV=test)", () => {
    // Real CLI invocation with custom stash but no XDG override is legal.
    const result = getDataDir({ AKM_BUNDLE_DIR: "/home/user/my-stash", HOME: "/home/user" }, "linux");
    expect(result).toBe(path.join("/home/user", ".local", "share", "akm"));
  });

  test("test-isolation guard surfaces the TEST_ISOLATION_MISSING code", () => {
    try {
      getDataDir({ NODE_ENV: "test", HOME: "/home/user" }, "linux");
      throw new Error("expected guard to throw");
    } catch (err) {
      // ConfigError carries a stable machine-readable code.
      expect((err as { code?: string }).code).toBe("TEST_ISOLATION_MISSING");
    }
  });
});

// ── getDbPath ───────────────────────────────────────────────────────────────

describe("getDbPath", () => {
  test("returns index.db under data dir", () => {
    process.env.XDG_DATA_HOME = "/data";
    delete process.env.AKM_DATA_DIR;
    expect(getDbPath()).toBe(path.join("/data", "akm", "index.db"));
  });

  test("honors an injected env object (DI seam) over process.env", () => {
    process.env.XDG_DATA_HOME = "/ambient-data";
    delete process.env.AKM_DATA_DIR;
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
    delete process.env.AKM_DATA_DIR;
    expect(getLockfilePath()).toBe(path.join("/data", "akm", "akm.lock"));
  });
});

describe("getLockfileLockPath", () => {
  test("returns akm.lock.lck under data dir", () => {
    process.env.XDG_DATA_HOME = "/data";
    delete process.env.AKM_DATA_DIR;
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
    delete process.env.AKM_STATE_DIR;
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

  test("AKM_STATE_DIR overrides all other paths", () => {
    const result = getStateDir({ AKM_STATE_DIR: "/override/state", XDG_STATE_HOME: "/ignored" }, "linux");
    expect(result).toBe("/override/state");
  });

  test("uses LOCALAPPDATA on Windows", () => {
    const result = getStateDir({ LOCALAPPDATA: String.raw`C:\Users\user\AppData\Local` }, "win32");
    expect(result).toBe(path.join(String.raw`C:\Users\user\AppData\Local`, "akm", "state"));
  });

  test("honors an injected env without reading or mutating process.env", () => {
    process.env.AKM_STATE_DIR = "/host/should-be-ignored";
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
    expect(getMeasurementVerdictsDir("/stash-a")).not.toBe(getMeasurementVerdictsDir("/stash-b"));
    expect(getUnresolvedSourcesDir("/stash-a")).not.toBe(getUnresolvedSourcesDir("/stash-b"));
    expect(getStashLocksDir("/stash-a")).not.toBe(getStashLocksDir("/stash-b"));
  });

  test("are rooted at $STATE/improve/*, $STATE/locks/*, or $CACHE/index/* respectively", () => {
    process.env.XDG_STATE_HOME = "/state";
    process.env.XDG_CACHE_HOME = "/cache";
    const key = getStashStateKey("/stash-a");
    expect(getMeasurementVerdictsDir("/stash-a")).toBe(
      path.join("/state", "akm", "improve", "measurement", "verdicts", key),
    );
    expect(getUnresolvedSourcesDir("/stash-a")).toBe(path.join("/cache", "akm", "index", "unresolved-sources", key));
    expect(getStashLocksDir("/stash-a")).toBe(path.join("/state", "akm", "locks", key));
  });
});

// ── getDefaultStashDir ──────────────────────────────────────────────────────

describe("getDefaultStashDir", () => {
  test("returns HOME/akm on Unix", () => {
    delete process.env.AKM_BUNDLE_DIR;
    process.env.HOME = "/home/user";
    const result = getDefaultStashDir();
    expect(result).toBe(path.join("/home/user", "akm"));
  });

  test("throws when HOME is unset on Unix", () => {
    delete process.env.AKM_BUNDLE_DIR;
    delete process.env.HOME;
    expect(() => getDefaultStashDir()).toThrow("Unable to determine default bundle directory. Set HOME.");
  });

  test("AKM_BUNDLE_DIR overrides all other paths", () => {
    process.env.AKM_BUNDLE_DIR = "/override/stash";
    const result = getDefaultStashDir();
    expect(result).toBe("/override/stash");
  });

  test("honors an injected env without reading or mutating process.env", () => {
    // Pin the real global to a value that MUST NOT influence the result.
    process.env.AKM_BUNDLE_DIR = "/host/should-be-ignored";
    const before = JSON.stringify(process.env);
    const result = getDefaultStashDir({ HOME: "/injected/home" });
    expect(result).toBe(path.join("/injected/home", "akm"));
    expect(JSON.stringify(process.env)).toBe(before);
  });
});
