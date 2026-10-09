// Integration (spawns real processes): `akm upgrade`'s plugin step runs
// against stand-in `claude`, `codex`, `opencode`, `npm`, `pgrep` and
// `trash-put` scripts on a PATH that holds nothing else. No network, no real
// harness is touched.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runUpgrade, type UpgradeRunDependencies, usesHostCache } from "../../src/commands/sources/plugin-upgrade";
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
      XDG_CONFIG_HOME: path.join(root, "xdg-config"),
      OPENCODE_CONFIG: "",
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

function cacheDir(tag = "latest"): string {
  return path.join(world.cache, "opencode", "packages", `akm-opencode@${tag}`);
}

function writeCachedOpenCode(version: string, tag = "latest"): void {
  const dir = path.join(cacheDir(tag), "node_modules", "akm-opencode");
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
  stub("pgrep", opts.running ? `echo ${process.pid}` : "exit 1");
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
): UpgradeRunDependencies & {
  upgradeCalls: UpgradeCheckResponse[];
  channels: string[];
  targets: Array<string | undefined>;
} {
  const upgradeCalls: UpgradeCheckResponse[] = [];
  const channels: string[] = [];
  const targets: Array<string | undefined> = [];
  return {
    upgradeCalls,
    channels,
    targets,
    checkForUpdate: async (_version, channel) => {
      channels.push(channel);
      return {
        currentVersion: current,
        latestVersion: latest,
        updateAvailable: current !== latest,
        installMethod: "npm",
      };
    },
    performUpgrade: async (check, opts): Promise<UpgradeResponse> => {
      upgradeCalls.push(check);
      targets.push(opts.targetVersion);
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

    test("deferred when the matched process cannot be inspected: no way to rule it out", async () => {
      writeCachedOpenCode("0.9.26");
      stubOpenCode({ latest: "0.9.27", pin: "0.9.27", running: false });
      stub("pgrep", "echo 999999999");
      const run = await upgrade();
      expect(entry(run, "opencode").outcome).toBe("deferred");
      expect(mutations()).toEqual([]);
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

  describe("--next", () => {
    const NEXT = { check: false, force: false, skipPostUpgrade: true, next: true };
    const NEXT_CHECK = { check: true, force: false, skipPostUpgrade: true, next: true };

    function writeConfig(plugin: unknown[], file = "opencode.json"): void {
      const dir = path.join(world.root, "xdg-config", "opencode");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), `// comments are fine\n${JSON.stringify({ plugin })}`);
    }

    /** `npm view akm-opencode@<tag>` answers per tag; a tag set to null fails like an unpublished one. */
    function stubNpm(tags: { latest: [string, string?]; next: [string, string?] | null }): void {
      const answer = (t: [string, string?] | null) =>
        t === null
          ? 'echo "E404 no such tag" >&2; exit 1'
          : `printf '${JSON.stringify(t[1] ? { version: t[0], "dependencies.akm-cli": t[1] } : { version: t[0] })}\\n'`;
      stub(
        "npm",
        `case "$2" in
akm-opencode@next) ${answer(tags.next)};;
akm-opencode@latest) ${answer(tags.latest)};;
*) exit 2;;
esac`,
      );
    }

    /** `opencode debug config` re-creates the @next cache at `version`. */
    function stubOpenCodeNext(version: string, running = false): void {
      const pkgDir = path.join(cacheDir("next"), "node_modules", "akm-opencode");
      stub(
        "opencode",
        `case "$*" in
"--version") echo 1.0.0;;
"debug config") /bin/mkdir -p "${pkgDir}"; printf '{"version":"${version}"}' > "${pkgDir}/package.json";;
*) exit 2;;
esac`,
      );
      stub("pgrep", running ? `echo ${process.pid}` : "exit 1");
      stub("trash-put", `/bin/mkdir -p "$STUB_STATE/trash" && /bin/mv "$1" "$STUB_STATE/trash/"`);
    }

    test("asks for the next channel, names the exact version to the install step, and reports the channel", async () => {
      const deps = fakeDeps("0.9.27-rc.1", "0.9.26");
      const run = await withEnv(world.env, () => runUpgrade(NEXT, "0.9.26", deps));
      expect(deps.channels).toEqual(["next"]);
      expect(deps.targets).toEqual(["0.9.27-rc.1"]);
      expect(run.result.channel).toBe("next");
    });

    test("the default run asks for latest and names no version when nothing is held back", async () => {
      const deps = fakeDeps("0.9.28", "0.9.26");
      const run = await withEnv(world.env, () => runUpgrade(UPGRADE, "0.9.26", deps));
      expect(deps.channels).toEqual(["latest"]);
      expect(deps.targets).toEqual([undefined]);
      expect(run.result.channel).toBe("latest");
    });

    test("with the config naming akm-opencode@next: lockstep and the cache refresh follow @next", async () => {
      writeConfig(["akm-opencode@next"]);
      writeCachedOpenCode("0.9.27-rc.1", "next");
      stubNpm({ latest: ["0.9.26", "0.9.26"], next: ["0.9.27-rc.2", "0.9.27-rc.2"] });
      stubOpenCodeNext("0.9.27-rc.2");
      const deps = fakeDeps("0.9.27-rc.3", "0.9.27-rc.1");
      const run = await withEnv(world.env, () => runUpgrade(NEXT, "0.9.27-rc.1", deps));
      expect(run.result.lockstep).toEqual({
        plugin: "akm-opencode",
        pinnedVersion: "0.9.27-rc.2",
        newestVersion: "0.9.27-rc.3",
        heldBack: true,
      });
      expect(deps.targets).toEqual(["0.9.27-rc.2"]);
      expect(entry(run, "opencode")).toMatchObject({ outcome: "updated", from: "0.9.27-rc.1", to: "0.9.27-rc.2" });
      expect(commands()).toContain(`trash-put ${cacheDir("next")}`);
      expect(fs.existsSync(cacheDir("latest"))).toBe(false);
    });

    test("a [spec, options] plugin entry in a .jsonc config counts", async () => {
      writeConfig([["akm-opencode@next", { x: 1 }]], "opencode.jsonc");
      writeCachedOpenCode("0.9.27-rc.2", "next");
      stubNpm({ latest: ["0.9.26", "0.9.26"], next: ["0.9.27-rc.2", "0.9.27-rc.2"] });
      stubOpenCodeNext("0.9.27-rc.2");
      const run = await withEnv(world.env, () =>
        runUpgrade(NEXT, "0.9.27-rc.2", fakeDeps("0.9.27-rc.2", "0.9.27-rc.2")),
      );
      expect(entry(run, "opencode")).toMatchObject({ outcome: "current", to: "0.9.27-rc.2" });
    });

    test("a bare akm-opencode in the config: the entry is skipped with the line to add, lockstep stays on @latest", async () => {
      writeConfig(["akm-opencode"]);
      writeCachedOpenCode("0.9.26");
      stubNpm({ latest: ["0.9.26", "0.9.26"], next: ["0.9.27-rc.2", "0.9.27-rc.2"] });
      stubOpenCodeNext("0.9.27-rc.2");
      const deps = fakeDeps("0.9.27-rc.2", "0.9.25");
      const run = await withEnv(world.env, () => runUpgrade(NEXT, "0.9.25", deps));
      expect(entry(run, "opencode").outcome).toBe("skipped");
      expect(entry(run, "opencode").message).toContain('"plugin": ["akm-opencode@next"]');
      expect(run.result.lockstep).toMatchObject({ pinnedVersion: "0.9.26", heldBack: true });
      expect(deps.targets).toEqual(["0.9.26"]);
      expect(mutations()).toEqual([]);
      expect(commands().some((c) => c.startsWith("npm view akm-opencode@next"))).toBe(false);
    });

    test("a plain run with the config naming akm-opencode@next leaves both caches alone (#1115)", async () => {
      writeConfig(["akm-opencode@next"]);
      writeCachedOpenCode("0.9.26");
      writeCachedOpenCode("0.9.27-rc.2", "next");
      stubNpm({ latest: ["0.9.27", "0.9.27"], next: ["0.9.28-rc.1", "0.9.28-rc.1"] });
      stubOpenCodeNext("0.9.28-rc.1");
      const run = await withEnv(world.env, () => runUpgrade(UPGRADE, "0.9.27", fakeDeps("0.9.27", "0.9.27")));
      expect(entry(run, "opencode").outcome).toBe("skipped");
      expect(entry(run, "opencode").message).toContain("akm upgrade --next");
      expect(mutations()).toEqual([]);
      expect(fs.existsSync(cacheDir("latest"))).toBe(true);
      expect(fs.existsSync(cacheDir("next"))).toBe(true);
    });

    test("a config pinning an exact akm-opencode version is left alone on any run, with no lockstep (#1117)", async () => {
      writeConfig(["akm-opencode@0.8.0"]);
      writeCachedOpenCode("0.9.26");
      writeCachedOpenCode("0.9.27-rc.2", "next");
      stubNpm({ latest: ["0.9.27", "0.9.27"], next: ["0.9.28-rc.1", "0.9.28-rc.1"] });
      stubOpenCodeNext("0.9.28-rc.1");
      for (const args of [UPGRADE, NEXT]) {
        const run = await withEnv(world.env, () => runUpgrade(args, "0.9.27", fakeDeps("0.9.28", "0.9.27")));
        expect(entry(run, "opencode").outcome).toBe("skipped");
        expect(entry(run, "opencode").message).toContain('OpenCode loads "akm-opencode@0.8.0"');
        expect(run.result.lockstep).toBeUndefined();
      }
      expect(mutations()).toEqual([]);
      expect(commands().some((c) => c.startsWith("npm view akm-opencode"))).toBe(false);
      expect(fs.existsSync(cacheDir("latest"))).toBe(true);
      expect(fs.existsSync(cacheDir("next"))).toBe(true);
    });

    test("no OpenCode config at all behaves like a bare one", async () => {
      writeCachedOpenCode("0.9.26");
      stubNpm({ latest: ["0.9.26", "0.9.26"], next: ["0.9.27-rc.2", "0.9.27-rc.2"] });
      const run = await withEnv(world.env, () => runUpgrade(NEXT, "0.9.25", fakeDeps("0.9.27-rc.2", "0.9.25")));
      expect(entry(run, "opencode").outcome).toBe("skipped");
    });

    test("akm-opencode@next older than @latest fails closed: CLI held, entry failed", async () => {
      writeConfig(["akm-opencode@next"]);
      writeCachedOpenCode("0.9.26-rc.1", "next");
      stubNpm({ latest: ["0.9.26", "0.9.26"], next: ["0.9.26-rc.2", "0.9.26-rc.2"] });
      stubOpenCodeNext("0.9.26-rc.2");
      const deps = fakeDeps("0.9.27-rc.1", "0.9.25");
      const run = await withEnv(world.env, () => runUpgrade(NEXT, "0.9.25", deps));
      expect(deps.upgradeCalls[0]).toMatchObject({ latestVersion: "0.9.25", updateAvailable: false });
      expect(run.result.lockstep).toMatchObject({ pinnedVersion: null, heldBack: true });
      expect(run.result.lockstep?.reason).toContain("older than the 0.9.26 that akm-opencode@latest");
      expect(entry(run, "opencode").outcome).toBe("failed");
      expect(run.mode === "upgrade" && run.failed).toBe(true);
      expect(mutations()).toEqual([]);
    });

    test("real version shapes: a prerelease plugin build is not behind the stable one, the pins decide (#1089)", async () => {
      writeConfig(["akm-opencode@next"]);
      writeCachedOpenCode("0.9.28-alpha.8.202610071200", "next");
      // By semver the dotted prerelease sorts below the concatenated-patch stable build.
      stubNpm({
        latest: ["0.9.27202610072331", "0.9.27"],
        next: ["0.9.28-alpha.8.202610081938", "0.9.28-alpha.8"],
      });
      stubOpenCodeNext("0.9.28-alpha.8.202610081938");
      const deps = fakeDeps("0.9.28-alpha.8", "0.9.27");
      const run = await withEnv(world.env, () => runUpgrade(NEXT, "0.9.27", deps));
      expect(run.result.lockstep).toMatchObject({ pinnedVersion: "0.9.28-alpha.8" });
      expect(deps.upgradeCalls[0]).toMatchObject({ latestVersion: "0.9.28-alpha.8", updateAvailable: true });
      expect(entry(run, "opencode")).toMatchObject({
        outcome: "updated",
        from: "0.9.28-alpha.8.202610071200",
        to: "0.9.28-alpha.8.202610081938",
      });
    });

    test("real version shapes: @next whose pin is older than @latest's pin still fails closed", async () => {
      writeConfig(["akm-opencode@next"]);
      writeCachedOpenCode("0.9.26-alpha.1.202610010000", "next");
      stubNpm({
        latest: ["0.9.27202610072331", "0.9.27"],
        next: ["0.9.27-alpha.1.202610081938", "0.9.26"],
      });
      stubOpenCodeNext("0.9.27-alpha.1.202610081938");
      const deps = fakeDeps("0.9.28-alpha.8", "0.9.26");
      const run = await withEnv(world.env, () => runUpgrade(NEXT, "0.9.26", deps));
      expect(run.result.lockstep).toMatchObject({ pinnedVersion: null, heldBack: true });
      expect(run.result.lockstep?.reason).toContain("pins akm-cli 0.9.26, older than the 0.9.27");
      expect(entry(run, "opencode").outcome).toBe("failed");
      expect(mutations()).toEqual([]);
    });

    test("an @next cache that already holds npm's @next build is current: plugin versions are compared for equality only", async () => {
      writeConfig(["akm-opencode@next"]);
      writeCachedOpenCode("0.9.28-alpha.8.202610081938", "next");
      stubNpm({
        latest: ["0.9.27202610072331", "0.9.27"],
        next: ["0.9.28-alpha.8.202610081938", "0.9.28-alpha.8"],
      });
      stubOpenCodeNext("0.9.28-alpha.8.202610081938");
      const run = await withEnv(world.env, () =>
        runUpgrade(NEXT, "0.9.28-alpha.8", fakeDeps("0.9.28-alpha.8", "0.9.27")),
      );
      expect(entry(run, "opencode").outcome).toBe("current");
    });

    test("the stable cache is compared by equality with npm @latest: a concatenated-patch build is stale or current", async () => {
      writeCachedOpenCode("0.9.27202610062331");
      stubOpenCode({ latest: "0.9.27202610072331", pin: "0.9.27", running: false });
      const run = await upgrade();
      expect(entry(run, "opencode")).toMatchObject({
        outcome: "updated",
        from: "0.9.27202610062331",
        to: "0.9.27202610072331",
      });
    });

    test("a missing akm-opencode@next fails closed", async () => {
      writeConfig(["akm-opencode@next"]);
      writeCachedOpenCode("0.9.26", "next");
      stubNpm({ latest: ["0.9.26", "0.9.26"], next: null });
      const deps = fakeDeps("0.9.27-rc.1", "0.9.25");
      const run = await withEnv(world.env, () => runUpgrade(NEXT, "0.9.25", deps));
      expect(deps.upgradeCalls[0]).toMatchObject({ latestVersion: "0.9.25", updateAvailable: false });
      expect(run.result.lockstep?.reason).toContain("akm-opencode@next");
      expect(entry(run, "opencode").outcome).toBe("failed");
    });

    test("an akm-opencode@next with no readable akm-cli pin fails closed", async () => {
      writeConfig(["akm-opencode@next"]);
      writeCachedOpenCode("0.9.26", "next");
      stubNpm({ latest: ["0.9.26", "0.9.26"], next: ["0.9.27-rc.2"] });
      const deps = fakeDeps("0.9.27-rc.1", "0.9.25");
      const run = await withEnv(world.env, () => runUpgrade(NEXT, "0.9.25", deps));
      expect(deps.upgradeCalls[0]).toMatchObject({ latestVersion: "0.9.25", updateAvailable: false });
      expect(run.result.lockstep?.reason).toContain("akm-opencode@next declares no akm-cli");
    });

    test("without the OpenCode plugin the CLI goes to the --next target unheld", async () => {
      const deps = fakeDeps("0.9.27-rc.1", "0.9.25");
      const run = await withEnv(world.env, () => runUpgrade(NEXT, "0.9.25", deps));
      expect(deps.upgradeCalls[0]?.latestVersion).toBe("0.9.27-rc.1");
      expect(run.result).not.toHaveProperty("lockstep");
    });

    test("Claude Code and Codex are refreshed as usual and carry a note", async () => {
      stubClaude({ from: "0.9.26", to: "0.9.27" });
      stubCodex({ from: "0.9.27", to: "0.9.27" });
      const run = await withEnv(world.env, () => runUpgrade(NEXT, "0.9.25", fakeDeps("0.9.27-rc.1", "0.9.25")));
      expect(entry(run, "claude-code")).toMatchObject({ outcome: "updated" });
      expect(entry(run, "claude-code").message).toContain("no prerelease channel");
      expect(entry(run, "codex")).toMatchObject({ outcome: "current" });
      expect(entry(run, "codex").message).toContain("no prerelease channel");
      expect(mutations()).toEqual([
        "claude plugin marketplace update akm-plugins",
        "claude plugin update akm@akm-plugins",
        "codex plugin marketplace upgrade akm-plugins",
      ]);
    });

    test("without --next those entries carry no note", async () => {
      stubClaude({ from: "0.9.26", to: "0.9.27" });
      const run = await upgrade();
      expect(entry(run, "claude-code").message).toBeUndefined();
    });

    test("--check --next reports and changes nothing", async () => {
      writeConfig(["akm-opencode@next"]);
      writeCachedOpenCode("0.9.27-rc.1", "next");
      stubClaude({ from: "0.9.26", to: "0.9.27" });
      stubNpm({ latest: ["0.9.26", "0.9.26"], next: ["0.9.27-rc.2", "0.9.27-rc.2"] });
      stubOpenCodeNext("0.9.27-rc.2");
      const deps = fakeDeps("0.9.27-rc.3", "0.9.27-rc.1");
      const run = await withEnv(world.env, () => runUpgrade(NEXT_CHECK, "0.9.27-rc.1", deps));
      expect(run.mode).toBe("check");
      expect(run.result.channel).toBe("next");
      expect(run.result.lockstep).toMatchObject({ pinnedVersion: "0.9.27-rc.2", heldBack: true });
      expect(entry(run, "opencode")).toMatchObject({ outcome: "pending", to: "0.9.27-rc.2" });
      expect(deps.upgradeCalls).toHaveLength(0);
      expect(mutations()).toEqual([]);
      expect(fs.existsSync(cacheDir("next"))).toBe(true);
      expect(fs.readFileSync(path.join(world.state, "claude-version"), "utf8")).toBe("0.9.26");
    });

    test("--check --next says to run `akm upgrade --next`", () => {
      const text = formatUpgradePlain({
        currentVersion: "0.9.25",
        latestVersion: "0.9.27-rc.1",
        updateAvailable: true,
        channel: "next",
      });
      expect(text).toContain("run 'akm upgrade --next' to install");
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

describe("usesHostCache", () => {
  let proc: string;
  beforeEach(() => {
    proc = path.join(makeSandboxDir("akm-fake-proc").dir, "proc");
    fs.mkdirSync(path.join(proc, "self", "ns"), { recursive: true });
    fs.symlinkSync("mnt:[111]", path.join(proc, "self", "ns", "mnt"));
  });
  function fakeProcess(pid: string, mnt?: string, cgroup?: string): void {
    fs.mkdirSync(path.join(proc, pid, "ns"), { recursive: true });
    if (mnt) fs.symlinkSync(mnt, path.join(proc, pid, "ns", "mnt"));
    if (cgroup) fs.writeFileSync(path.join(proc, pid, "cgroup"), cgroup);
  }

  test("a process in akm's own mount namespace counts, even in a container-looking cgroup", () => {
    fakeProcess("10", "mnt:[111]", "0::/system.slice/docker-abc.scope\n");
    expect(usesHostCache("10", proc)).toBe(true);
  });

  test("a process in another mount namespace is ignored", () => {
    fakeProcess("11", "mnt:[222]", "0::/user.slice/session-1.scope\n");
    expect(usesHostCache("11", proc)).toBe(false);
  });

  test("with the namespace unreadable, a container cgroup is ignored and a host cgroup counts", () => {
    fakeProcess("12", undefined, "0::/system.slice/docker-abc.scope\n");
    fakeProcess("13", undefined, "0::/user.slice/user-1000.slice/session-3.scope\n");
    fakeProcess("14", undefined, "0::/machine.slice/libpod-abc.scope\n");
    expect(usesHostCache("12", proc)).toBe(false);
    expect(usesHostCache("13", proc)).toBe(true);
    expect(usesHostCache("14", proc)).toBe(false);
  });

  test("with nothing readable, the process counts", () => {
    fakeProcess("15");
    expect(usesHostCache("15", proc)).toBe(true);
    expect(usesHostCache("16", proc)).toBe(true);
  });
});
