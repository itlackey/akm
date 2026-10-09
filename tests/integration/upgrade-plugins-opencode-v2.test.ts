// Integration (spawns real processes): `akm upgrade`'s OpenCode 2 plugin step (`akm-opencode-v2`)
// runs against stand-in `opencode`, `npm`, `pgrep` and `trash-put` scripts on a PATH that holds
// nothing else, mirroring tests/integration/upgrade-plugins.test.ts for OpenCode 1. The layout
// (`npm/<spec>/<build>/node_modules/<pkg>`, the `plugins` key, `opencode plugin add`) is what
// OpenCode 2.0.26 was observed to do. No network, no real harness is touched.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runUpgrade, type UpgradeRunDependencies } from "../../src/commands/sources/plugin-upgrade";
import type { UpgradeCheckResponse, UpgradeResponse } from "../../src/sources/types";
import { makeSandboxDir, withEnv } from "../_helpers/sandbox";

const posixOnly = process.platform === "win32" ? describe.skip : describe;

interface World {
  root: string;
  bin: string;
  state: string;
  log: string;
  env: Record<string, string>;
  cleanup: () => void;
}

let world: World;

beforeEach(() => {
  const sandbox = makeSandboxDir("akm-upgrade-opencode-v2");
  const root = sandbox.dir;
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  const log = path.join(root, "commands.log");
  fs.writeFileSync(log, "");
  world = {
    root,
    bin,
    state,
    log,
    cleanup: sandbox.cleanup,
    env: {
      PATH: bin,
      XDG_CACHE_HOME: path.join(root, "xdg-cache"),
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

const V1 = "akm-opencode";
const V2 = "akm-opencode-v2";

/** OpenCode 1: <cache>/opencode/packages/<pkg>@<tag>. OpenCode 2: <cache>/opencode/npm/<pkg>@<tag>/<build>. */
function v1CacheDir(tag = "latest"): string {
  return path.join(world.root, "xdg-cache", "opencode", "packages", `${V1}@${tag}`);
}

function v2CacheDir(tag = "latest"): string {
  return path.join(world.root, "xdg-cache", "opencode", "npm", `${V2}@${tag}`);
}

function writeV1Cache(version: string, tag = "latest"): void {
  const dir = path.join(v1CacheDir(tag), "node_modules", V1);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: V1, version }));
}

/** Two build folders: the newest one is the one OpenCode loads. */
function writeV2Cache(version: string, tag = "latest"): void {
  const old = path.join(v2CacheDir(tag), "1700000000000", "node_modules", V2);
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, "package.json"), JSON.stringify({ name: V2, version: "0.0.1" }));
  const dir = path.join(v2CacheDir(tag), "1800000000000", "node_modules", V2);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: V2, version }));
}

function configFile(file = "opencode.json"): string {
  return path.join(world.root, "xdg-config", "opencode", file);
}

function writeConfig(config: Record<string, unknown>, file = "opencode.json"): void {
  fs.mkdirSync(path.dirname(configFile(file)), { recursive: true });
  fs.writeFileSync(configFile(file), `// comments are fine\n${JSON.stringify(config)}`);
}

/**
 * `npm view <pkg>@<tag>` answers from `pins` (version, akm-cli pin); `opencode` reports `--version` as
 * `major`, `plugin add <spec>` re-creates the V2 cache of `<pkg>@latest|next` at `fresh`, and
 * `debug config` re-creates the V1 `@latest` cache at `fresh`.
 */
function stubWorld(opts: {
  major: 1 | 2;
  running?: boolean;
  fresh: string;
  pins: Record<string, [string, string?] | null>;
}): void {
  const npmCases = Object.entries(opts.pins)
    .map(([spec, answer]) =>
      answer === null
        ? `${spec}) echo "E404" >&2; exit 1;;`
        : `${spec}) printf '${JSON.stringify(answer[1] ? { version: answer[0], "dependencies.akm-cli": answer[1] } : { version: answer[0] })}\\n';;`,
    )
    .join("\n");
  stub("npm", `case "$2" in\n${npmCases}\n*) exit 2;;\nesac`);
  const v2Latest = path.join(v2CacheDir("latest"), "1900000000000", "node_modules", V2);
  const v2Next = path.join(v2CacheDir("next"), "1900000000000", "node_modules", V2);
  const v1Latest = path.join(v1CacheDir("latest"), "node_modules", V1);
  stub(
    "opencode",
    `case "$*" in
"--version") echo "${opts.major === 2 ? "opencode v2.0.26" : "1.18.34"}";;
"plugin add ${V2}"|"plugin add ${V2}@latest") /bin/mkdir -p "${v2Latest}"; printf '{"version":"${opts.fresh}"}' > "${v2Latest}/package.json";;
"plugin add ${V2}@next") /bin/mkdir -p "${v2Next}"; printf '{"version":"${opts.fresh}"}' > "${v2Next}/package.json";;
"debug config") /bin/mkdir -p "${v1Latest}"; printf '{"version":"${opts.fresh}"}' > "${v1Latest}/package.json";;
*) exit 2;;
esac`,
  );
  stub("pgrep", opts.running ? `echo ${process.pid}` : "exit 1");
  stub("trash-put", `/bin/mkdir -p "$STUB_STATE/trash" && /bin/mv "$1" "$STUB_STATE/trash/"`);
}

function commands(): string[] {
  return fs.readFileSync(world.log, "utf8").split("\n").filter(Boolean);
}

const MUTATING = ["trash-put", "opencode debug config", "opencode plugin add"];

function mutations(): string[] {
  return commands().filter((line) => MUTATING.some((m) => line.startsWith(m)));
}

function fakeDeps(
  latest: string,
  current = "0.9.20",
): UpgradeRunDependencies & { upgradeCalls: UpgradeCheckResponse[]; targets: Array<string | undefined> } {
  const upgradeCalls: UpgradeCheckResponse[] = [];
  const targets: Array<string | undefined> = [];
  return {
    upgradeCalls,
    targets,
    checkForUpdate: async () => ({
      currentVersion: current,
      latestVersion: latest,
      updateAvailable: current !== latest,
      installMethod: "npm",
    }),
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
const NEXT = { check: false, force: false, skipPostUpgrade: true, next: true };

async function upgrade(args: typeof UPGRADE & { next?: boolean } = UPGRADE, deps = fakeDeps("0.9.28", "0.9.28")) {
  return withEnv(world.env, () => runUpgrade(args, "0.9.28", deps));
}

function entry(run: Awaited<ReturnType<typeof upgrade>>, harness: string) {
  const found = run.result.plugins.find((p) => p.harness === harness);
  if (!found) throw new Error(`no ${harness} entry`);
  return found;
}

const PINS = { "akm-opencode-v2@latest": ["0.9.27", "0.9.27"] as [string, string] };

posixOnly("akm upgrade: OpenCode 2 plugin (akm-opencode-v2)", () => {
  test("a host with only OpenCode 1 reports no OpenCode 2 entry: three entries, as before", async () => {
    writeConfig({ plugin: [V1] });
    writeV1Cache("0.9.26");
    stubWorld({ major: 1, fresh: "0.9.27", pins: { "akm-opencode@latest": ["0.9.27", "0.9.27"] } });
    const run = await upgrade();
    expect(run.result.plugins.map((p) => p.harness)).toEqual(["claude-code", "codex", "opencode"]);
    expect(entry(run, "opencode")).toMatchObject({ outcome: "updated", from: "0.9.26", to: "0.9.27" });
    expect(mutations()).toEqual([`trash-put ${v1CacheDir()}`, "opencode debug config"]);
    expect(run.result.lockstep?.plugin).toBe(V1);
  });

  test("moves the stale cache to the trash and re-creates it with `opencode plugin add`, from a temp dir", async () => {
    writeConfig({ plugins: [V2] });
    writeV2Cache("0.9.26");
    stubWorld({ major: 2, fresh: "0.9.27", pins: PINS });
    const before = fs.readFileSync(configFile(), "utf8");
    const run = await upgrade();
    expect(entry(run, "opencode-v2")).toMatchObject({ outcome: "updated", from: "0.9.26", to: "0.9.27" });
    expect(mutations()).toEqual([`trash-put ${v2CacheDir()}`, `opencode plugin add ${V2}`]);
    expect(fs.existsSync(path.join(world.state, "trash", `${V2}@latest`))).toBe(true);
    // The OpenCode config is never written by akm, and OpenCode 1's package is never named.
    expect(fs.readFileSync(configFile(), "utf8")).toBe(before);
    expect(commands().join("\n")).not.toContain("debug config");
    expect(run.result.lockstep).toMatchObject({ plugin: V2, pinnedVersion: "0.9.27" });
  });

  test("the version comes from the newest build folder", async () => {
    writeConfig({ plugins: [V2] });
    writeV2Cache("0.9.27");
    stubWorld({ major: 2, fresh: "0.9.27", pins: PINS, running: true });
    const run = await upgrade();
    expect(entry(run, "opencode-v2")).toMatchObject({ outcome: "current", from: "0.9.27", to: "0.9.27" });
    expect(mutations()).toEqual([]);
  });

  test("deferred while OpenCode is running: the cache is untouched", async () => {
    writeConfig({ plugins: [V2] });
    writeV2Cache("0.9.26");
    stubWorld({ major: 2, fresh: "0.9.27", pins: PINS, running: true });
    const run = await upgrade();
    expect(entry(run, "opencode-v2")).toMatchObject({ outcome: "deferred", from: "0.9.26", to: "0.9.27" });
    expect(mutations()).toEqual([]);
    expect(fs.existsSync(v2CacheDir())).toBe(true);
  });

  test("a bare `akm-opencode-v2@latest` spec refreshes @latest and re-fetches that exact spec", async () => {
    writeConfig({ plugins: [`${V2}@latest`] });
    writeV2Cache("0.9.26");
    stubWorld({ major: 2, fresh: "0.9.27", pins: PINS });
    const run = await upgrade();
    expect(entry(run, "opencode-v2").outcome).toBe("updated");
    expect(mutations()).toContain(`opencode plugin add ${V2}@latest`);
  });

  test("an exact-version pin is left alone on any run, with no lockstep (#1117 for V2)", async () => {
    writeConfig({ plugins: [`${V2}@0.8.0`] });
    writeV2Cache("0.8.0", "0.8.0");
    writeV2Cache("0.9.26");
    stubWorld({ major: 2, fresh: "0.9.27", pins: PINS });
    for (const args of [UPGRADE, NEXT]) {
      const run = await upgrade(args, fakeDeps("0.9.30", "0.9.28"));
      expect(entry(run, "opencode-v2")).toMatchObject({ outcome: "skipped" });
      expect(entry(run, "opencode-v2").message).toContain(`"${V2}@0.8.0"`);
      expect(run.result.lockstep).toBeUndefined();
    }
    expect(mutations()).toEqual([]);
  });

  test("@next is only refreshed under --next; a plain run leaves it alone (#1115 for V2)", async () => {
    writeConfig({ plugins: [`${V2}@next`] });
    writeV2Cache("0.9.28-alpha.1.202610081938", "next");
    stubWorld({
      major: 2,
      fresh: "0.9.28-alpha.2.202610091000",
      pins: {
        "akm-opencode-v2@latest": ["0.9.27", "0.9.27"],
        "akm-opencode-v2@next": ["0.9.28-alpha.2.202610091000", "0.9.28"],
      },
    });
    const plain = await upgrade();
    expect(entry(plain, "opencode-v2")).toMatchObject({ outcome: "skipped" });
    expect(entry(plain, "opencode-v2").message).toContain("--next");
    expect(mutations()).toEqual([]);

    const run = await upgrade(NEXT, fakeDeps("0.9.28", "0.9.27"));
    expect(entry(run, "opencode-v2")).toMatchObject({ outcome: "updated", to: "0.9.28-alpha.2.202610091000" });
    expect(mutations()).toEqual([`trash-put ${v2CacheDir("next")}`, `opencode plugin add ${V2}@next`]);
    expect(run.result.lockstep).toMatchObject({ plugin: V2, pinnedVersion: "0.9.28" });
  });

  test("--next with a bare spec in the config: skipped with the line to add, lockstep stays on @latest", async () => {
    writeConfig({ plugins: [V2] });
    writeV2Cache("0.9.26");
    stubWorld({ major: 2, fresh: "0.9.27", pins: PINS });
    const run = await upgrade(NEXT, fakeDeps("0.9.28", "0.9.25"));
    expect(entry(run, "opencode-v2")).toMatchObject({ outcome: "skipped" });
    expect(entry(run, "opencode-v2").message).toContain(`"plugins": ["${V2}@next"]`);
    expect(run.result.lockstep).toMatchObject({ plugin: V2, pinnedVersion: "0.9.27", heldBack: true });
    expect(mutations()).toEqual([]);
  });

  test("a cache that OpenCode 2 holds but the config does not name is never refreshed: plugin add would write the config", async () => {
    writeConfig({ plugins: ["something-else"] });
    writeV2Cache("0.9.26");
    stubWorld({ major: 2, fresh: "0.9.27", pins: PINS });
    const run = await upgrade();
    expect(entry(run, "opencode-v2")).toMatchObject({ outcome: "skipped" });
    expect(entry(run, "opencode-v2").message).toContain("does not name");
    expect(mutations()).toEqual([]);
  });

  test("named only under the legacy `plugin` key: skipped, because `plugin add` would write a `plugins` entry", async () => {
    writeConfig({ plugin: [V2] });
    writeV2Cache("0.9.26");
    stubWorld({ major: 2, fresh: "0.9.27", pins: PINS });
    const run = await upgrade();
    expect(entry(run, "opencode-v2")).toMatchObject({ outcome: "skipped" });
    expect(entry(run, "opencode-v2").message).toContain('"plugin"');
    expect(mutations()).toEqual([]);
  });

  test("a .jsonc config with a [spec, options] entry counts", async () => {
    writeConfig({ plugins: [[V2, { a: 1 }]] }, "opencode.jsonc");
    writeV2Cache("0.9.26");
    stubWorld({ major: 2, fresh: "0.9.27", pins: PINS });
    expect(entry(await upgrade(), "opencode-v2").outcome).toBe("updated");
  });

  test("OPENCODE_CONFIG is not read for OpenCode 2: `plugin add` would write the global config instead", async () => {
    const elsewhere = path.join(world.root, "elsewhere.json");
    fs.writeFileSync(elsewhere, JSON.stringify({ plugins: [V2] }));
    writeV2Cache("0.9.26");
    stubWorld({ major: 2, fresh: "0.9.27", pins: PINS });
    const run = await withEnv({ ...world.env, OPENCODE_CONFIG: elsewhere }, () =>
      runUpgrade(UPGRADE, "0.9.28", fakeDeps("0.9.28", "0.9.28")),
    );
    // Not named by a global config file, and the cache alone makes the plugin present.
    expect(entry(run, "opencode-v2")).toMatchObject({ outcome: "skipped" });
    expect(mutations()).toEqual([]);
  });

  test("`opencode` on PATH being OpenCode 1: skipped, and nothing is trashed that it cannot re-create", async () => {
    writeConfig({ plugins: [V2] });
    writeV2Cache("0.9.26");
    stubWorld({ major: 1, fresh: "0.9.27", pins: PINS });
    const run = await upgrade();
    expect(entry(run, "opencode-v2")).toMatchObject({ outcome: "skipped" });
    expect(entry(run, "opencode-v2").message).toContain("not OpenCode 2");
    expect(mutations()).toEqual([]);
    expect(fs.existsSync(v2CacheDir())).toBe(true);
  });

  test("an unreadable pin holds the CLI where it is and fails the entry, like OpenCode 1", async () => {
    writeConfig({ plugins: [V2] });
    writeV2Cache("0.9.26");
    stubWorld({ major: 2, fresh: "0.9.27", pins: { "akm-opencode-v2@latest": null } });
    const deps = fakeDeps("0.9.28", "0.9.25");
    const run = await withEnv(world.env, () => runUpgrade(UPGRADE, "0.9.25", deps));
    expect(run.result.lockstep).toMatchObject({ plugin: V2, pinnedVersion: null, heldBack: true });
    expect(entry(run, "opencode-v2").outcome).toBe("failed");
    expect(run.mode === "upgrade" && run.failed).toBe(true);
  });

  test("--check reports pending and changes nothing", async () => {
    writeConfig({ plugins: [V2] });
    writeV2Cache("0.9.26");
    stubWorld({ major: 2, fresh: "0.9.27", pins: PINS });
    const run = await upgrade(CHECK);
    expect(entry(run, "opencode-v2")).toMatchObject({ outcome: "pending", from: "0.9.26", to: "0.9.27" });
    expect(mutations()).toEqual([]);
  });

  describe("a V2-only host (an OpenCode 1 package is never touched)", () => {
    test("the akm-opencode entry is skipped and akm-opencode is never installed, refreshed or written", async () => {
      writeConfig({ plugins: [V2] });
      writeV2Cache("0.9.26");
      stubWorld({ major: 2, fresh: "0.9.27", pins: PINS });
      const run = await upgrade();
      expect(entry(run, "opencode")).toMatchObject({ outcome: "skipped" });
      const log = commands().join("\n");
      expect(log).not.toContain("debug config");
      expect(log).not.toMatch(/plugin add akm-opencode( |$)/m);
      expect(fs.existsSync(path.join(world.root, "xdg-cache", "opencode", "packages"))).toBe(false);
      expect(JSON.parse(fs.readFileSync(configFile(), "utf8").replace(/^\/\/.*\n/, ""))).toEqual({ plugins: [V2] });
    });
  });

  describe("both plugins installed", () => {
    const BOTH_PINS = {
      "akm-opencode@latest": ["0.9.27", "0.9.27"] as [string, string],
      "akm-opencode-v2@latest": ["0.9.28", "0.9.28"] as [string, string],
    };

    function bothInstalled(): void {
      writeConfig({ plugin: [V1], plugins: [V2] });
      writeV1Cache("0.9.26");
      writeV2Cache("0.9.26");
    }

    test("with an OpenCode 2 binary only V2 is refreshed; V1's cache, the other major's, is left in place", async () => {
      bothInstalled();
      stubWorld({ major: 2, fresh: "0.9.28", pins: BOTH_PINS });
      const run = await upgrade();
      expect(run.result.plugins.map((p) => p.harness)).toEqual(["claude-code", "codex", "opencode", "opencode-v2"]);
      expect(entry(run, "opencode-v2")).toMatchObject({ outcome: "updated", to: "0.9.28" });
      expect(entry(run, "opencode")).toMatchObject({ outcome: "skipped" });
      expect(mutations()).toEqual([`trash-put ${v2CacheDir()}`, `opencode plugin add ${V2}`]);
      expect(fs.existsSync(v1CacheDir())).toBe(true);
    });

    test("with an OpenCode 1 binary only V1 is refreshed", async () => {
      bothInstalled();
      stubWorld({ major: 1, fresh: "0.9.27", pins: BOTH_PINS });
      const run = await upgrade();
      expect(entry(run, "opencode")).toMatchObject({ outcome: "updated", to: "0.9.27" });
      expect(entry(run, "opencode-v2")).toMatchObject({ outcome: "skipped" });
      expect(mutations()).toEqual([`trash-put ${v1CacheDir()}`, "opencode debug config"]);
      expect(fs.existsSync(v2CacheDir())).toBe(true);
    });

    test("the CLI is held to the older of the two pins, and the lockstep names that plugin", async () => {
      bothInstalled();
      stubWorld({ major: 2, fresh: "0.9.28", pins: BOTH_PINS, running: true });
      const deps = fakeDeps("0.9.30", "0.9.25");
      const run = await withEnv(world.env, () => runUpgrade(UPGRADE, "0.9.25", deps));
      expect(run.result.lockstep).toMatchObject({ plugin: V1, pinnedVersion: "0.9.27", heldBack: true });
      expect(deps.targets).toEqual(["0.9.27"]);
    });

    test("an unreadable pin on either plugin holds the CLI", async () => {
      bothInstalled();
      stubWorld({
        major: 2,
        fresh: "0.9.28",
        pins: { "akm-opencode@latest": ["0.9.27", "0.9.27"], "akm-opencode-v2@latest": null },
        running: true,
      });
      const run = await upgrade(UPGRADE, fakeDeps("0.9.30", "0.9.25"));
      expect(run.result.lockstep).toMatchObject({ plugin: V2, pinnedVersion: null });
    });
  });
});
