// Integration: real Git against local file:// repositories and a stand-in `claude`; no network, no user harness.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { collectPluginStalenessAdvisories } from "../../src/commands/health/plugin-staleness";
import {
  marketplaceTargetVersion,
  runUpgrade,
  type UpgradeRunDependencies,
} from "../../src/commands/sources/plugin-upgrade";
import { makeSandboxDir, withEnv, withEnvSync } from "../_helpers/sandbox";

let root: string;
let cleanup: () => void;
const file = (name: string) => path.join(root, name);

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/**
 * A marketplace repository: `main` offers the stable build, `next` a newer prerelease, and `bundle.bin` stands in for
 * the akm-cli files the real `next` branch carries. Served like GitHub serves it: partial clones are allowed.
 */
function makeMarketplace(): string {
  const repo = file("marketplace");
  fs.mkdirSync(path.join(repo, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(repo, "claude", ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ plugins: [{ name: "akm", source: "./claude" }] }),
  );
  const offer = (version: string) => {
    fs.writeFileSync(path.join(repo, "claude", ".claude-plugin", "plugin.json"), JSON.stringify({ version }));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", version);
  };
  git(repo, "init", "-q");
  git(repo, "config", "uploadpack.allowFilter", "true");
  offer("0.10.1");
  git(repo, "checkout", "-q", "-b", "next");
  fs.writeFileSync(path.join(repo, "bundle.bin"), Buffer.alloc(8 * 1024 * 1024, "akm-cli bundle\n"));
  offer("0.10.3-beta");
  git(repo, "checkout", "-q", "main");
  return `file://${repo}`;
}

beforeEach(() => {
  const sandbox = makeSandboxDir("akm-channel-reader");
  root = sandbox.dir;
  cleanup = sandbox.cleanup;
});
afterEach(() => cleanup());

(process.platform === "win32" ? describe.skip : describe)("the one reader of a marketplace channel", () => {
  test("reading the channel's version downloads the catalog and manifest, not the rest of the branch", () => {
    const source = makeMarketplace();
    const log = file("clone-sizes");
    const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    fs.mkdirSync(file("bin"));
    // Records the size of each clone as made, before the reader removes it.
    fs.writeFileSync(
      file("bin/git"),
      `#!/bin/sh\n${real} "$@"; rc=$?\nif [ "$1" = clone ]; then for a; do last=$a; done; du -sk "$last" >> ${log}; fi\nexit $rc\n`,
      { mode: 0o755 },
    );
    const env = { PATH: `${file("bin")}${path.delimiter}${process.env.PATH}` };

    expect(withEnvSync(env, () => marketplaceTargetVersion(source, "next", "claude"))).toBe("0.10.3-beta");
    expect(withEnvSync(env, () => marketplaceTargetVersion(source, "latest", "claude"))).toBe("0.10.1");

    const sizesKb = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => Number(line.split("\t")[0]));
    expect(sizesKb).toHaveLength(2);
    for (const kb of sizesKb) expect(kb).toBeLessThan(1024);
  });

  test("health and `akm upgrade --check` report the same newest version for a registered non-default source", async () => {
    const source = makeMarketplace();
    const plugins = file("claude/plugins");
    const installPath = path.join(plugins, "cache/akm-plugins/akm/0.10.0");
    fs.mkdirSync(installPath, { recursive: true });
    fs.writeFileSync(path.join(plugins, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {} }));
    fs.writeFileSync(
      path.join(plugins, "known_marketplaces.json"),
      JSON.stringify({ "akm-plugins": { source: { source: "git", url: source, ref: "next" } } }),
    );
    fs.writeFileSync(
      file("rows.json"),
      JSON.stringify([{ id: "akm@akm-plugins", version: "0.10.0", scope: "user", enabled: true, installPath }]),
    );
    fs.writeFileSync(file("marketplaces.json"), JSON.stringify([{ name: "akm-plugins", ref: "next" }]));
    fs.mkdirSync(file("bin"));
    fs.writeFileSync(
      file("bin/claude"),
      `#!/bin/sh\ncase "$*" in\n"plugin marketplace list --json") cat ${file("marketplaces.json")};;\n"plugin list --json") cat ${file("rows.json")};;\nesac\n`,
      { mode: 0o755 },
    );
    const env = {
      PATH: `${file("bin")}${path.delimiter}${process.env.PATH}`,
      CLAUDE_CONFIG_DIR: file("claude"),
      AKM_CLAUDE_PLUGINS_DIR: plugins,
      CODEX_HOME: file("codex"),
      XDG_CONFIG_HOME: file("config"),
      XDG_CACHE_HOME: file("cache"),
      XDG_DATA_HOME: file("data"),
      OPENCODE_CONFIG: "",
    };
    const dependency = {
      checkForUpdate: async () => ({
        currentVersion: "0.10.3-beta",
        latestVersion: "0.10.3-beta",
        updateAvailable: false,
        installMethod: "npm" as const,
      }),
    } as unknown as UpgradeRunDependencies;

    const { checked, health } = await withEnv(env, async () => ({
      checked: await runUpgrade({ check: true, force: false, skipPostUpgrade: true }, "0.10.3-beta", dependency),
      health: collectPluginStalenessAdvisories({ cliVersion: "0.10.3-beta", opencodeCacheRoot: file("no-opencode") }),
    }));

    const planned =
      checked.mode === "check" ? checked.result.plugins.find((p) => p.harness === "claude-code") : undefined;
    const advisory = health.find((a) => a.name === "plugin-version");
    expect(planned).toMatchObject({ outcome: "pending", from: "0.10.0", to: "0.10.3-beta" });
    expect(advisory?.evidence?.availableVersion).toBe(planned?.to);
    expect(advisory?.evidence?.stale).toBe(true);
  });
});
