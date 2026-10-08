// Integration (spawns real processes): `akm upgrade`'s plugin step runs
// against stand-in `claude`, `codex`, `opencode`, `npm`, `pgrep` and
// `trash-put` scripts on a PATH that holds nothing else. No network, no real
// harness is touched.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runUpgrade, type UpgradeRunDependencies } from "../../src/commands/sources/plugin-upgrade";
import { moveToTrash } from "../../src/core/trash";
import { shapeForCommand } from "../../src/output/shapes";
import { formatUpgradePlain } from "../../src/output/text/command-format";
import type { UpgradeCheckResponse, UpgradeResponse } from "../../src/sources/types";
import { makeSandboxDir, withEnv } from "../_helpers/sandbox";

const posixOnly = process.platform === "win32" ? describe.skip : describe;

interface World {
  root: string;
  bin: string;
  state: string;
  cache: string;
  log: string;
  env: Record<string, string>;
  cleanup: () => void;
}

let world: World;

beforeEach(() => {
  const sandbox = makeSandboxDir("akm-upgrade-plugins");
  const root = sandbox.dir;
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  const cache = path.join(root, "xdg-cache");
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  fs.mkdirSync(cache);
  const log = path.join(root, "commands.log");
  fs.writeFileSync(log, "");
  world = {
    root,
    bin,
    state,
    cache,
    log,
    cleanup: sandbox.cleanup,
    env: {
      PATH: bin,
      XDG_CACHE_HOME: cache,
      XDG_DATA_HOME: path.join(root, "xdg-data"),
      STUB_LOG: log,
      STUB_STATE: state,
    },
  };
});

afterEach(() => {
  world.cleanup();
});

function stub(name: string, body: string): void {
  const file = path.join(world.bin, name);
  fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "$STUB_LOG"\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

function setState(key: string, value: string): void {
  fs.writeFileSync(path.join(world.state, key), value);
}

/** A `claude` whose installed akm plugin sits at `from` and moves to `to` on `plugin update`. */
function stubClaude(opts: {
  from: string;
  to: string;
  marketplace?: boolean;
  installed?: boolean;
  failOn?: string;
}): void {
  setState("claude-version", opts.from);
  setState("claude-next", opts.to);
  const marketplaces = opts.marketplace === false ? "[]" : '[{"name":"akm-plugins"}]';
  const plugins = opts.installed === false ? "[]" : '[{"id":"akm@akm-plugins","version":"%s"}]';
  stub(
    "claude",
    `case "$*" in
"plugin marketplace list --json") printf '%s\\n' '${marketplaces}';;
"plugin list --json") read v < "$STUB_STATE/claude-version"; printf '${plugins}\\n' "$v";;
"plugin marketplace update akm-plugins") ${opts.failOn === "marketplace" ? 'echo "git fetch failed" >&2; exit 1' : ":"};;
"plugin update akm@akm-plugins") read n < "$STUB_STATE/claude-next"; printf '%s' "$n" > "$STUB_STATE/claude-version";;
*) exit 2;;
esac`,
  );
}

function stubCodex(opts: { from: string; to: string; installed?: boolean }): void {
  setState("codex-version", opts.from);
  setState("codex-next", opts.to);
  const installed =
    opts.installed === false
      ? '{"installed":[],"available":[]}'
      : '{"installed":[{"pluginId":"akm@akm-plugins","version":"%s"}],"available":[]}';
  stub(
    "codex",
    `case "$*" in
"plugin list --marketplace akm-plugins --json") read v < "$STUB_STATE/codex-version"; printf '${installed}\\n' "$v";;
"plugin marketplace upgrade akm-plugins") read n < "$STUB_STATE/codex-next"; printf '%s' "$n" > "$STUB_STATE/codex-version";;
*) exit 2;;
esac`,
  );
}

function cacheDir(): string {
  return path.join(world.cache, "opencode", "packages", "akm-opencode@latest");
}

function writeCachedOpenCode(version: string): void {
  const dir = path.join(cacheDir(), "node_modules", "akm-opencode");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "akm-opencode", version }));
}

/**
 * `npm view akm-opencode@latest ...` answers `latest`/`pin`; `opencode debug config`
 * re-creates the cache at `latest`; `pgrep` reports OpenCode running or not;
 * `trash-put` moves its argument into the stub trash.
 */
function stubOpenCode(opts: { latest: string; pin: string; running: boolean; npmFails?: boolean }): void {
  stub(
    "npm",
    opts.npmFails
      ? 'echo "registry unreachable" >&2; exit 1'
      : `printf '{"version":"${opts.latest}","dependencies.akm-cli":"${opts.pin}"}\\n'`,
  );
  const pkgDir = path.join(cacheDir(), "node_modules", "akm-opencode");
  stub(
    "opencode",
    `case "$*" in
"--version") echo 1.0.0;;
"debug config") pwd >> "$STUB_LOG"; /bin/mkdir -p "${pkgDir}"; printf '{"version":"${opts.latest}"}' > "${pkgDir}/package.json";;
*) exit 2;;
esac`,
  );
  stub("pgrep", opts.running ? "echo 4242" : "exit 1");
  stub("trash-put", `/bin/mkdir -p "$STUB_STATE/trash" && /bin/mv "$1" "$STUB_STATE/trash/"`);
}

function commands(): string[] {
  return fs.readFileSync(world.log, "utf8").split("\n").filter(Boolean);
}

const MUTATING = [
  "claude plugin marketplace update",
  "claude plugin update",
  "codex plugin marketplace upgrade",
  "trash-put",
  "opencode debug config",
];

function mutations(): string[] {
  return commands().filter((line) => MUTATING.some((m) => line.startsWith(m)));
}

function fakeDeps(
  latest: string,
  current = "0.9.20",
): UpgradeRunDependencies & { upgradeCalls: UpgradeCheckResponse[] } {
  const upgradeCalls: UpgradeCheckResponse[] = [];
  return {
    upgradeCalls,
    checkForUpdate: async () => ({
      currentVersion: current,
      latestVersion: latest,
      updateAvailable: current !== latest,
      installMethod: "npm",
    }),
    performUpgrade: async (check): Promise<UpgradeResponse> => {
      upgradeCalls.push(check);
      return {
        currentVersion: check.currentVersion,
        newVersion: check.latestVersion,
        upgraded: check.updateAvailable,
        installMethod: check.installMethod,
        migration: { status: "current" },
      };
    },
  };
}

const UPGRADE = { check: false, force: false, skipPostUpgrade: true };
const CHECK = { check: true, force: false, skipPostUpgrade: true };

async function upgrade(args = UPGRADE, deps = fakeDeps("0.9.28", "0.9.28")) {
  return withEnv(world.env, () => runUpgrade(args, "0.9.28", deps));
}

function entry(run: Awaited<ReturnType<typeof upgrade>>, harness: string) {
  const found = run.result.plugins.find((p) => p.harness === harness);
  if (!found) throw new Error(`no ${harness} entry`);
  return found;
}

posixOnly("akm upgrade: plugin step", () => {
  test("every harness absent: all skipped, nothing run, exit clean", async () => {
    const run = await upgrade();
    expect(run.result.plugins.map((p) => p.outcome)).toEqual(["skipped", "skipped", "skipped"]);
    expect(entry(run, "claude-code").message).toContain("not on PATH");
    expect(mutations()).toEqual([]);
    expect(run.mode === "upgrade" && run.failed).toBe(false);
  });

  describe("Claude Code", () => {
    test("refreshes the marketplace, then the plugin, and reports the version move", async () => {
      stubClaude({ from: "0.9.26", to: "0.9.27" });
      const run = await upgrade();
      expect(entry(run, "claude-code")).toMatchObject({ outcome: "updated", from: "0.9.26", to: "0.9.27" });
      expect(mutations()).toEqual([
        "claude plugin marketplace update akm-plugins",
        "claude plugin update akm@akm-plugins",
      ]);
    });

    test("current when the refresh changes nothing", async () => {
      stubClaude({ from: "0.9.27", to: "0.9.27" });
      const run = await upgrade();
      expect(entry(run, "claude-code")).toMatchObject({ outcome: "current", from: "0.9.27", to: "0.9.27" });
    });

    test("skipped, and nothing run, when the akm-plugins marketplace is not configured", async () => {
      stubClaude({ from: "0.9.26", to: "0.9.27", marketplace: false });
      const run = await upgrade();
      expect(entry(run, "claude-code")).toMatchObject({ outcome: "skipped" });
      expect(mutations()).toEqual([]);
    });

    test("skipped, and never installed, when the akm plugin is not installed", async () => {
      stubClaude({ from: "0.9.26", to: "0.9.27", installed: false });
      const run = await upgrade();
      expect(entry(run, "claude-code")).toMatchObject({ outcome: "skipped" });
      expect(mutations()).toEqual([]);
    });

    test("a failing refresh is captured on the entry and fails the run without losing the CLI step", async () => {
      stubClaude({ from: "0.9.26", to: "0.9.27", failOn: "marketplace" });
      const deps = fakeDeps("0.9.28");
      const run = await withEnv(world.env, () => runUpgrade(UPGRADE, "0.9.20", deps));
      expect(entry(run, "claude-code")).toMatchObject({ outcome: "failed" });
      expect(entry(run, "claude-code").message).toContain("git fetch failed");
      expect(deps.upgradeCalls).toHaveLength(1);
      expect(run.mode === "upgrade" && run.failed).toBe(true);
    });
  });

  describe("Codex", () => {
    test("upgrades the marketplace, which refreshes the installed plugin", async () => {
      stubCodex({ from: "0.9.26", to: "0.9.27" });
      const run = await upgrade();
      expect(entry(run, "codex")).toMatchObject({ outcome: "updated", from: "0.9.26", to: "0.9.27" });
      expect(mutations()).toEqual(["codex plugin marketplace upgrade akm-plugins"]);
    });

    test("current when nothing moved", async () => {
      stubCodex({ from: "0.9.27", to: "0.9.27" });
      expect(entry(await upgrade(), "codex").outcome).toBe("current");
    });

    test("skipped, and nothing run, when the plugin is not installed from akm-plugins", async () => {
      stubCodex({ from: "0.9.26", to: "0.9.27", installed: false });
      const run = await upgrade();
      expect(entry(run, "codex").outcome).toBe("skipped");
      expect(mutations()).toEqual([]);
    });
  });

  describe("OpenCode", () => {
    test("moves the stale cache to the trash and prefetches the latest from a temp dir", async () => {
      writeCachedOpenCode("0.9.26");
      stubOpenCode({ latest: "0.9.27", pin: "0.9.27", running: false });
      const run = await upgrade();
      expect(entry(run, "opencode")).toMatchObject({ outcome: "updated", from: "0.9.26", to: "0.9.27" });
      const log = commands();
      expect(log).toContain(`trash-put ${cacheDir()}`);
      expect(fs.existsSync(path.join(world.state, "trash", "akm-opencode@latest"))).toBe(true);
      const prefetchAt = log.indexOf("opencode debug config");
      expect(prefetchAt).toBeGreaterThan(log.indexOf(`trash-put ${cacheDir()}`));
      // `pwd` ran in a temp dir, not the test's cwd.
      expect(log[prefetchAt + 1]).toContain("akm-opencode-prefetch-");
      expect(fs.existsSync(log[prefetchAt + 1] as string)).toBe(false);
    });

    test("deferred while OpenCode is running: the cache is untouched", async () => {
      writeCachedOpenCode("0.9.26");
      stubOpenCode({ latest: "0.9.27", pin: "0.9.27", running: true });
      const run = await upgrade();
      expect(entry(run, "opencode")).toMatchObject({ outcome: "deferred", from: "0.9.26", to: "0.9.27" });
      expect(entry(run, "opencode").message).toContain("running");
      expect(mutations()).toEqual([]);
      expect(fs.existsSync(cacheDir())).toBe(true);
      expect(run.mode === "upgrade" && run.failed).toBe(false);
    });

    test("current when the cache already holds npm's latest: no process probe, no trash", async () => {
      writeCachedOpenCode("0.9.27");
      stubOpenCode({ latest: "0.9.27", pin: "0.9.27", running: true });
      const run = await upgrade();
      expect(entry(run, "opencode").outcome).toBe("current");
      expect(commands().some((c) => c.startsWith("pgrep"))).toBe(false);
      expect(mutations()).toEqual([]);
    });

    test("skipped, and npm never asked, when OpenCode has no cached akm-opencode", async () => {
      stubOpenCode({ latest: "0.9.27", pin: "0.9.27", running: false });
      const run = await upgrade();
      expect(entry(run, "opencode").outcome).toBe("skipped");
      expect(commands().some((c) => c.startsWith("npm"))).toBe(false);
    });

    test("an unreachable npm fails the OpenCode entry only", async () => {
      writeCachedOpenCode("0.9.26");
      stubOpenCode({ latest: "0.9.27", pin: "0.9.27", running: false, npmFails: true });
      stubClaude({ from: "0.9.27", to: "0.9.27" });
      const run = await upgrade();
      expect(entry(run, "opencode")).toMatchObject({ outcome: "failed" });
      expect(entry(run, "claude-code").outcome).toBe("current");
    });
  });

  describe("version lockstep", () => {
    test("with the OpenCode plugin present the CLI target is the akm-cli it pins, and the output says so", async () => {
      writeCachedOpenCode("0.9.26");
      stubOpenCode({ latest: "0.9.27", pin: "0.9.27", running: true });
      const deps = fakeDeps("0.9.28", "0.9.25");
      const run = await withEnv(world.env, () => runUpgrade(UPGRADE, "0.9.25", deps));
      expect(deps.upgradeCalls[0]).toMatchObject({ latestVersion: "0.9.27", updateAvailable: true });
      expect(run.result.lockstep).toEqual({
        plugin: "akm-opencode",
        pinnedVersion: "0.9.27",
        newestVersion: "0.9.28",
        heldBack: true,
      });
      expect(formatUpgradePlain(run.result as unknown as Record<string, unknown>)).toContain("held at v0.9.27");
    });

    test("npm failing to answer holds the CLI where it is, and says why", async () => {
      writeCachedOpenCode("0.9.26");
      stubOpenCode({ latest: "0.9.27", pin: "0.9.27", running: true, npmFails: true });
      const deps = fakeDeps("0.9.28", "0.9.25");
      const run = await withEnv(world.env, () => runUpgrade(UPGRADE, "0.9.25", deps));
      expect(deps.upgradeCalls[0]).toMatchObject({ latestVersion: "0.9.25", updateAvailable: false });
      expect(run.result.lockstep).toMatchObject({
        plugin: "akm-opencode",
        pinnedVersion: null,
        newestVersion: "0.9.28",
        heldBack: true,
      });
      expect(run.result.lockstep?.reason).toContain("registry unreachable");
      expect(entry(run, "opencode").outcome).toBe("failed");
      expect(run.mode === "upgrade" && run.failed).toBe(true);
      const text = formatUpgradePlain(run.result as unknown as Record<string, unknown>);
      expect(text).toContain("akm is not upgraded to v0.9.28");
      expect(text).toContain("registry unreachable");
    });

    test("an akm-opencode that declares no akm-cli holds the CLI too", async () => {
      writeCachedOpenCode("0.9.26");
      stubOpenCode({ latest: "0.9.27", pin: "0.9.27", running: true });
      stub("npm", `printf '{"version":"0.9.27"}\\n'`);
      const deps = fakeDeps("0.9.28", "0.9.25");
      const run = await withEnv(world.env, () => runUpgrade(UPGRADE, "0.9.25", deps));
      expect(deps.upgradeCalls[0]).toMatchObject({ latestVersion: "0.9.25", updateAvailable: false });
      expect(run.result.lockstep?.reason).toContain("no akm-cli");
    });

    test("a held-back upgrade tells the install step the exact version, so @latest cannot pass the pin", async () => {
      writeCachedOpenCode("0.9.26");
      stubOpenCode({ latest: "0.9.27", pin: "0.9.27", running: true });
      const seen: Array<string | undefined> = [];
      const deps = fakeDeps("0.9.28", "0.9.25");
      const performUpgrade = deps.performUpgrade;
      deps.performUpgrade = (check, opts) => {
        seen.push(opts.targetVersion);
        return performUpgrade(check, opts);
      };
      await withEnv(world.env, () => runUpgrade(UPGRADE, "0.9.25", deps));
      expect(seen).toEqual(["0.9.27"]);
    });

    test("without the OpenCode plugin the CLI goes to the newest release", async () => {
      stubOpenCode({ latest: "0.9.27", pin: "0.9.27", running: false });
      const deps = fakeDeps("0.9.28", "0.9.25");
      const run = await withEnv(world.env, () => runUpgrade(UPGRADE, "0.9.25", deps));
      expect(deps.upgradeCalls[0]?.latestVersion).toBe("0.9.28");
      expect(run.result).not.toHaveProperty("lockstep");
    });

    test("a pin at the newest release holds nothing back", async () => {
      writeCachedOpenCode("0.9.28");
      stubOpenCode({ latest: "0.9.28", pin: "0.9.28", running: false });
      const deps = fakeDeps("0.9.28", "0.9.25");
      const run = await withEnv(world.env, () => runUpgrade(UPGRADE, "0.9.25", deps));
      expect(deps.upgradeCalls[0]?.latestVersion).toBe("0.9.28");
      expect(run.result.lockstep?.heldBack).toBe(false);
    });

    test("the CLI is never moved backwards to meet the pin: no install is requested", async () => {
      writeCachedOpenCode("0.9.26");
      stubOpenCode({ latest: "0.9.26", pin: "0.9.26", running: true });
      const deps = fakeDeps("0.9.28", "0.9.27");
      await withEnv(world.env, () => runUpgrade(UPGRADE, "0.9.27", deps));
      expect(deps.upgradeCalls[0]).toMatchObject({ currentVersion: "0.9.27", updateAvailable: false });
    });
  });

  describe("--check", () => {
    test("reports each harness (unknown where it needs a fetch) and changes nothing", async () => {
      stubClaude({ from: "0.9.26", to: "0.9.27" });
      stubCodex({ from: "0.9.26", to: "0.9.27" });
      writeCachedOpenCode("0.9.26");
      stubOpenCode({ latest: "0.9.27", pin: "0.9.27", running: false });
      const deps = fakeDeps("0.9.28", "0.9.25");
      const run = await withEnv(world.env, () => runUpgrade(CHECK, "0.9.25", deps));
      expect(run.mode).toBe("check");
      expect(run.result.plugins.map((p) => [p.harness, p.outcome])).toEqual([
        ["claude-code", "unknown"],
        ["codex", "unknown"],
        ["opencode", "pending"],
      ]);
      expect(entry(run, "claude-code").message).toContain("--check does not do");
      expect(deps.upgradeCalls).toHaveLength(0);
      expect(mutations()).toEqual([]);
      expect(fs.existsSync(cacheDir())).toBe(true);
      expect(fs.readFileSync(path.join(world.state, "claude-version"), "utf8")).toBe("0.9.26");
    });

    test("an OpenCode that is running shows as deferred, a current cache as current", async () => {
      writeCachedOpenCode("0.9.26");
      stubOpenCode({ latest: "0.9.27", pin: "0.9.27", running: true });
      expect(entry(await upgrade(CHECK), "opencode").outcome).toBe("deferred");
      writeCachedOpenCode("0.9.27");
      expect(entry(await upgrade(CHECK), "opencode").outcome).toBe("current");
    });
  });

  describe("idempotence", () => {
    test("a second run is current everywhere, moves nothing, and prints no plugin line", async () => {
      stubClaude({ from: "0.9.26", to: "0.9.27" });
      stubCodex({ from: "0.9.26", to: "0.9.27" });
      writeCachedOpenCode("0.9.26");
      stubOpenCode({ latest: "0.9.27", pin: "0.9.28", running: false });
      const deps = fakeDeps("0.9.28", "0.9.28");
      const first = await withEnv(world.env, () => runUpgrade(UPGRADE, "0.9.28", deps));
      expect(first.result.plugins.map((p) => p.outcome)).toEqual(["updated", "updated", "updated"]);

      fs.writeFileSync(world.log, "");
      const second = await withEnv(world.env, () => runUpgrade(UPGRADE, "0.9.28", deps));
      expect(second.result.plugins.map((p) => p.outcome)).toEqual(["current", "current", "current"]);
      expect(mutations().some((m) => m.startsWith("trash-put") || m.startsWith("opencode"))).toBe(false);
      expect(second.mode === "upgrade" && second.failed).toBe(false);
      expect(formatUpgradePlain({ ...second.result, upgraded: false } as never)).toBeNull();
    });
  });
});

describe("upgrade output shape", () => {
  test("the plugin and lockstep fields pass through beside the existing ones", () => {
    const result = {
      currentVersion: "0.9.25",
      latestVersion: "0.9.27",
      updateAvailable: true,
      installMethod: "npm",
      lockstep: { plugin: "akm-opencode", pinnedVersion: "0.9.27", newestVersion: "0.9.28", heldBack: true },
      plugins: [{ harness: "codex", outcome: "unknown" }],
    };
    expect(shapeForCommand("upgrade", result, "normal")).toMatchObject(result);
  });
});

describe("formatUpgradePlain", () => {
  test("a current install with current or skipped plugins prints no plugin lines", () => {
    const text = formatUpgradePlain({
      currentVersion: "0.9.28",
      latestVersion: "0.9.28",
      updateAvailable: false,
      plugins: [
        { harness: "claude-code", outcome: "current" },
        { harness: "codex", outcome: "skipped", message: "codex is not on PATH" },
      ],
    });
    expect(text).toBe("akm v0.9.28 is already the latest version");
  });

  test("updated, deferred and failed plugins each get a line", () => {
    const text = formatUpgradePlain({
      upgraded: false,
      message: "akm v0.9.28 is already the latest version",
      plugins: [
        { harness: "claude-code", outcome: "updated", from: "0.9.26", to: "0.9.27" },
        { harness: "opencode", outcome: "deferred", message: "OpenCode is running" },
        { harness: "codex", outcome: "failed", message: "boom" },
      ],
    });
    expect(text).toContain("Claude Code plugin updated v0.9.26 → v0.9.27");
    expect(text).toContain("OpenCode plugin deferred (OpenCode is running)");
    expect(text).toContain("Codex plugin failed (boom)");
  });
});

posixOnly("moveToTrash", () => {
  test("with no trash tool the directory moves into the FreeDesktop trash with a restore record", async () => {
    const target = path.join(world.root, "victim");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "file"), "x");
    await withEnv(world.env, () => moveToTrash(target, []));
    expect(fs.existsSync(target)).toBe(false);
    const trash = path.join(world.root, "xdg-data", "Trash");
    expect(fs.readFileSync(path.join(trash, "files", "victim", "file"), "utf8")).toBe("x");
    expect(fs.readFileSync(path.join(trash, "info", "victim.trashinfo"), "utf8")).toContain(`Path=${target}`);
  });

  test("a tool that exits 0 without moving the directory is not believed", async () => {
    const target = path.join(world.root, "victim2");
    fs.mkdirSync(target);
    stub("trash-put", "exit 0");
    await withEnv(world.env, () => moveToTrash(target, [["trash-put"]]));
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(world.root, "xdg-data", "Trash", "files", "victim2"))).toBe(true);
  });
});
