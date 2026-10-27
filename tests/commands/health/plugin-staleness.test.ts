// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `plugin-version` advisory for `akm health` (itlackey/akm#832). Real
 * filesystem fixtures (plugin cache manifests + `akm-version.ts`), an
 * injected `listRemoteTags` seam so no subprocess/network call is ever made.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectPluginStalenessAdvisories, type ListRemoteTagsFn } from "../../../src/commands/health/plugin-staleness";
import { withEnvSync } from "../../_helpers/sandbox";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write a fake cached plugin under `<pluginsRoot>/cache/<marketplace>/akm/<version>/`. */
function installPlugin(
  pluginsRoot: string,
  opts: {
    marketplace?: string;
    version?: string;
    manifestVersion?: string;
    versionRange?: string | null;
  } = {},
): void {
  const marketplace = opts.marketplace ?? "akm-plugins";
  const version = opts.version ?? "0.9.1";
  const pluginDir = path.join(pluginsRoot, "cache", marketplace, "akm", version);
  fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "akm", version: opts.manifestVersion ?? version }),
  );
  if (opts.versionRange !== null) {
    fs.mkdirSync(path.join(pluginDir, "shared"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "shared", "akm-version.ts"),
      `export const AKM_VERSION_RANGE = "${opts.versionRange ?? "^0.9.0"}"\n`,
    );
  }
}

function makeMarketplaceDir(pluginsRoot: string, marketplace = "akm-plugins"): void {
  fs.mkdirSync(path.join(pluginsRoot, "marketplaces", marketplace), { recursive: true });
}

function fakeTags(tags: string[] | undefined): ListRemoteTagsFn {
  return () => tags;
}

/**
 * A guaranteed-empty OpenCode cache root, so these Claude-plugin-only tests
 * never pick up a real `~/.cache/opencode` on the host running them — `os.
 * homedir()` under bun does not honor a sandboxed `HOME`, same reason
 * `claudePluginsDir()` needs `AKM_CLAUDE_PLUGINS_DIR`.
 */
function noOpencode(pluginsRoot: string): string {
  return path.join(pluginsRoot, "no-opencode-cache");
}

describe("collectPluginStalenessAdvisories (itlackey/akm#832)", () => {
  test("stale plugin detected: installed 0.9.1, newest tag 0.9.1202608250804", () => {
    const pluginsRoot = makeTempDir("akm-plugin-stale-");
    installPlugin(pluginsRoot, { version: "0.9.1" });
    makeMarketplaceDir(pluginsRoot);

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2",
      listRemoteTags: fakeTags(["0.9.1", "0.9.1202608250804"]),
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(adv?.name).toBe("plugin-version");
    expect(adv?.status).toBe("warn");
    expect(adv?.evidence?.stale).toBe(true);
    expect(adv?.evidence?.availableVersion).toBe("0.9.1202608250804");
    expect(adv?.message).toContain("STALE");
    expect(adv?.message).toContain("claude plugin update akm@akm-plugins");
  });

  test("on the next channel the build on the channel head is up to date, though stable tags exist", () => {
    const pluginsRoot = makeTempDir("akm-plugin-next-current-");
    installPlugin(pluginsRoot, { versionRange: null, version: "0.10.261013-beta" });
    makeMarketplaceDir(pluginsRoot);

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.10.261015-beta",
      // What the real lister returns on `next`: the release tag on that branch's head.
      listRemoteTags: fakeTags(["0.10.261013-beta"]),
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(adv?.status).toBe("pass");
    expect(adv?.evidence?.stale).toBe(false);
    expect(adv?.evidence?.availableVersion).toBe("0.10.261013-beta");
    expect(adv?.message).not.toContain("STALE");
  });

  test("on the next channel an install behind the channel head is stale", () => {
    const pluginsRoot = makeTempDir("akm-plugin-next-stale-");
    installPlugin(pluginsRoot, { versionRange: null, version: "0.10.261012-beta" });
    makeMarketplaceDir(pluginsRoot);

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.10.261015-beta",
      listRemoteTags: fakeTags(["0.10.261013-beta"]),
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(adv?.status).toBe("warn");
    expect(adv?.evidence?.availableVersion).toBe("0.10.261013-beta");
    expect(adv?.message).toContain("STALE");
  });

  test("on the default branch the newest stable tag counts", () => {
    const pluginsRoot = makeTempDir("akm-plugin-stable-channel-");
    installPlugin(pluginsRoot, { version: "0.9.30202610090106" });
    makeMarketplaceDir(pluginsRoot);

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.31",
      // What the real lister returns on the default branch: stable tags only.
      listRemoteTags: fakeTags(["0.9.1", "0.9.30202610090106"]),
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(adv?.status).toBe("pass");
    expect(adv?.evidence?.availableVersion).toBe("0.9.30202610090106");
  });

  test("with several cached builds, the highest one counts as installed, prereleases included", () => {
    const pluginsRoot = makeTempDir("akm-plugin-cached-builds-");
    installPlugin(pluginsRoot, { versionRange: null, version: "0.9.30202610090106" });
    installPlugin(pluginsRoot, { versionRange: null, version: "0.10.261013-beta" });
    makeMarketplaceDir(pluginsRoot);

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.10.261015-beta",
      listRemoteTags: fakeTags(["0.9.30202610090106", "0.10.261013-beta"]),
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(adv?.message).toContain("installed 0.10.261013-beta");
    expect(adv?.status).toBe("pass");
  });

  test("up-to-date plugin is not flagged", () => {
    const pluginsRoot = makeTempDir("akm-plugin-uptodate-");
    installPlugin(pluginsRoot, { version: "0.9.1202608250804" });
    makeMarketplaceDir(pluginsRoot);

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2",
      listRemoteTags: fakeTags(["0.9.1", "0.9.1202608250804"]),
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(adv?.status).toBe("pass");
    expect(adv?.evidence?.stale).toBe(false);
    expect(adv?.message).not.toContain("STALE");
  });

  test("range-rejects-CLI detected: ^0.9.0 does not admit 0.9.2-alpha.3", () => {
    const pluginsRoot = makeTempDir("akm-plugin-range-");
    installPlugin(pluginsRoot, { version: "0.9.1", versionRange: "^0.9.0" });
    makeMarketplaceDir(pluginsRoot);

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2-alpha.3",
      listRemoteTags: fakeTags(["0.9.1"]),
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(adv?.status).toBe("warn");
    expect(adv?.evidence?.admitted).toBe(false);
    expect(adv?.message).toContain("NOT ADMITTED");
    expect(adv?.message).toContain("^0.9.0");
  });

  test("running CLI admitted by the range is not flagged on that basis", () => {
    const pluginsRoot = makeTempDir("akm-plugin-admitted-");
    installPlugin(pluginsRoot, { version: "0.9.1", versionRange: "^0.9.0" });
    makeMarketplaceDir(pluginsRoot);

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2",
      listRemoteTags: fakeTags(["0.9.1"]),
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(adv?.status).toBe("pass");
    expect(adv?.evidence?.admitted).toBe(true);
  });

  test("nothing installed degrades benignly (empty plugins root)", () => {
    const pluginsRoot = makeTempDir("akm-plugin-empty-");
    const result = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2",
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });
    expect(result).toEqual([]);
  });

  test("no Claude plugins directory at all degrades benignly", () => {
    const pluginsRoot = path.join(os.tmpdir(), `akm-plugin-missing-${Date.now()}-${Math.random()}`);
    const result = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2",
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });
    expect(result).toEqual([]);
  });

  test("no marketplace clone: reports installed version, no stale claim, no crash", () => {
    const pluginsRoot = makeTempDir("akm-plugin-no-marketplace-");
    installPlugin(pluginsRoot, { version: "0.9.1" });
    // Deliberately no marketplaces/ dir at all.

    let calls = 0;
    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2",
      listRemoteTags: () => {
        calls += 1;
        return ["9.9.9"]; // if this were ever consulted, it would (wrongly) look newer
      },
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(calls).toBe(0);
    expect(adv?.status).toBe("pass");
    expect(adv?.evidence?.availableVersion).toBeNull();
    expect(adv?.evidence?.stale).toBe(false);
  });

  test("remote lookup failure (offline/timeout) degrades benignly, no false STALE", () => {
    const pluginsRoot = makeTempDir("akm-plugin-offline-");
    installPlugin(pluginsRoot, { version: "0.9.1" });
    makeMarketplaceDir(pluginsRoot);

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2",
      listRemoteTags: fakeTags(undefined),
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(adv?.status).toBe("pass");
    expect(adv?.evidence?.availableVersion).toBeNull();
    expect(adv?.evidence?.stale).toBe(false);
  });

  test("probe: false never asks the remote and reports unknown, not up to date", () => {
    const pluginsRoot = makeTempDir("akm-plugin-no-probe-");
    installPlugin(pluginsRoot, { version: "0.9.1" });
    makeMarketplaceDir(pluginsRoot);

    let calls = 0;
    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2",
      probe: false,
      listRemoteTags: () => {
        calls += 1;
        return ["9.9.9"];
      },
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(calls).toBe(0);
    expect(adv?.status).toBe("unknown");
    expect(adv?.message).toContain("not probed");
    expect(adv?.evidence?.probed).toBe(false);
    expect(adv?.evidence?.availableVersion).toBeNull();
    expect(adv?.evidence?.stale).toBe(false);
  });

  test("probe: false still runs the local range check and warns on a mismatch", () => {
    const pluginsRoot = makeTempDir("akm-plugin-no-probe-range-");
    installPlugin(pluginsRoot, { version: "0.9.1", versionRange: "0.9.1" });
    makeMarketplaceDir(pluginsRoot);

    let calls = 0;
    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2",
      probe: false,
      listRemoteTags: () => {
        calls += 1;
        return undefined;
      },
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(calls).toBe(0);
    expect(adv?.status).toBe("warn");
    expect(adv?.evidence?.admitted).toBe(false);
  });

  test("unreadable/malformed plugin.json is skipped, not a crash", () => {
    const pluginsRoot = makeTempDir("akm-plugin-badmanifest-");
    const pluginDir = path.join(pluginsRoot, "cache", "akm-plugins", "akm", "0.9.1", ".claude-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.json"), "{not valid json");

    const result = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2",
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });
    expect(result).toEqual([]);
  });

  test("malformed AKM_VERSION_RANGE degrades to 'unknown compatibility', never a false NOT ADMITTED", () => {
    const pluginsRoot = makeTempDir("akm-plugin-badrange-");
    installPlugin(pluginsRoot, { version: "0.9.1", versionRange: "not-a-real-range!!" });
    makeMarketplaceDir(pluginsRoot);

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2-alpha.3",
      listRemoteTags: fakeTags(["0.9.1"]),
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(adv?.status).toBe("pass");
    expect(adv?.evidence?.admitted).toBeNull();
    expect(adv?.message).not.toContain("NOT ADMITTED");
  });

  test("missing shared/akm-version.ts degrades to 'unknown compatibility'", () => {
    const pluginsRoot = makeTempDir("akm-plugin-norange-");
    installPlugin(pluginsRoot, { version: "0.9.1", versionRange: null });
    makeMarketplaceDir(pluginsRoot);

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2-alpha.3",
      listRemoteTags: fakeTags(["0.9.1"]),
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(adv?.status).toBe("pass");
    expect(adv?.evidence?.admitted).toBeNull();
    expect(adv?.evidence?.versionRange).toBeNull();
  });

  // OpenCode's bundled akm-cli, checked independently of any
  // Claude harness plugin.
  describe("opencode-plugin-version", () => {
    function installOpencodeBundledAkm(cacheRoot: string, version: string): void {
      const pkgDir = path.join(cacheRoot, "packages", "akm-opencode", "node_modules", "akm-cli");
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "akm-cli", version }));
    }

    test("no OpenCode plugin installed: no advisory, no crash", () => {
      const pluginsRoot = makeTempDir("akm-plugin-noopencode-");
      const result = collectPluginStalenessAdvisories({
        pluginsRoot,
        cliVersion: "0.9.2",
        opencodeCacheRoot: noOpencode(pluginsRoot),
      });
      expect(result).toEqual([]);
    });

    test("stale bundled akm-cli: warn naming both versions, never executed", () => {
      const pluginsRoot = makeTempDir("akm-plugin-opencode-stale-");
      const opencodeCacheRoot = path.join(pluginsRoot, "opencode-cache");
      installOpencodeBundledAkm(opencodeCacheRoot, "0.9.15");

      const [adv] = collectPluginStalenessAdvisories({ pluginsRoot, cliVersion: "0.9.17", opencodeCacheRoot });

      expect(adv?.name).toBe("opencode-plugin-version");
      expect(adv?.status).toBe("warn");
      expect(adv?.message).toContain("0.9.15");
      expect(adv?.message).toContain("0.9.17");
      expect(adv?.evidence).toMatchObject({ bundledVersion: "0.9.15", cliVersion: "0.9.17" });
    });

    test("matching bundled akm-cli: pass", () => {
      const pluginsRoot = makeTempDir("akm-plugin-opencode-match-");
      const opencodeCacheRoot = path.join(pluginsRoot, "opencode-cache");
      installOpencodeBundledAkm(opencodeCacheRoot, "0.9.17");

      const [adv] = collectPluginStalenessAdvisories({ pluginsRoot, cliVersion: "0.9.17", opencodeCacheRoot });

      expect(adv?.status).toBe("pass");
    });

    test("unreadable/malformed package.json is skipped, not a crash", () => {
      const pluginsRoot = makeTempDir("akm-plugin-opencode-badmanifest-");
      const opencodeCacheRoot = path.join(pluginsRoot, "opencode-cache");
      const pkgDir = path.join(opencodeCacheRoot, "packages", "akm-opencode", "node_modules", "akm-cli");
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, "package.json"), "{not valid json");

      const result = collectPluginStalenessAdvisories({ pluginsRoot, cliVersion: "0.9.17", opencodeCacheRoot });
      expect(result).toEqual([]);
    });

    test("coexists with a stale Claude plugin as a second, independent result", () => {
      const pluginsRoot = makeTempDir("akm-plugin-opencode-both-");
      installPlugin(pluginsRoot, { version: "0.9.1" });
      makeMarketplaceDir(pluginsRoot);
      const opencodeCacheRoot = path.join(pluginsRoot, "opencode-cache");
      installOpencodeBundledAkm(opencodeCacheRoot, "0.9.15");

      const results = collectPluginStalenessAdvisories({
        pluginsRoot,
        cliVersion: "0.9.17",
        listRemoteTags: fakeTags(["0.9.1"]),
        opencodeCacheRoot,
      });

      expect(results.map((r) => r.name)).toEqual(["plugin-version", "opencode-plugin-version"]);
    });
  });

  // OpenCode 1 caches each spec in its own folder, so the advisory reads the one spec the global OpenCode config
  // names under `plugin` and no other cached spec (#1265).
  describe("opencode-plugin-version reads the spec the OpenCode config names", () => {
    function cacheSpec(cacheRoot: string, folder: string, version: string): void {
      const pkgDir = path.join(cacheRoot, "packages", folder, "node_modules", "akm-cli");
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "akm-cli", version }));
    }

    /** Collect with `config` (or no config file) as the global OpenCode config. */
    function collect(
      config: { file: "opencode.json" | "opencode.jsonc"; text: string } | undefined,
      cliVersion: string,
      cacheRoot: string,
    ) {
      const pluginsRoot = makeTempDir("akm-plugin-opencode-spec-");
      const configDir = path.join(pluginsRoot, "opencode-config");
      fs.mkdirSync(configDir, { recursive: true });
      if (config) fs.writeFileSync(path.join(configDir, config.file), config.text);
      return withEnvSync({ OPENCODE_CONFIG_DIR: configDir, OPENCODE_CONFIG: undefined }, () =>
        collectPluginStalenessAdvisories({ pluginsRoot, cliVersion, opencodeCacheRoot: cacheRoot }),
      );
    }

    const cacheRootOf = () => path.join(makeTempDir("akm-plugin-opencode-spec-cache-"), "opencode");
    const named = (spec: string) => ({ file: "opencode.json" as const, text: JSON.stringify({ plugin: [spec] }) });

    test("@next: the next folder is read, against the running CLI, and no other cached spec is", () => {
      const cacheRoot = cacheRootOf();
      cacheSpec(cacheRoot, "akm-opencode@next", "0.10.261012-beta");
      cacheSpec(cacheRoot, "akm-opencode@latest", "0.9.1");
      cacheSpec(cacheRoot, "akm-opencode", "0.9.2");

      const results = collect(named("akm-opencode@next"), "0.10.261013-beta", cacheRoot);

      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("opencode-plugin-version");
      expect(results[0]?.status).toBe("warn");
      expect(results[0]?.message).toContain("(akm-opencode@next)");
      expect(results[0]?.message).toContain("v0.10.261012-beta");
      expect(results[0]?.evidence).toEqual({
        bundledVersion: "0.10.261012-beta",
        cliVersion: "0.10.261013-beta",
        spec: "akm-opencode@next",
      });
    });

    test("@next at the running version passes", () => {
      const cacheRoot = cacheRootOf();
      cacheSpec(cacheRoot, "akm-opencode@next", "0.10.261013-beta");

      expect(collect(named("akm-opencode@next"), "0.10.261013-beta", cacheRoot).map((r) => r.status)).toEqual(["pass"]);
    });

    test("a bare name reads its @latest folder", () => {
      const cacheRoot = cacheRootOf();
      cacheSpec(cacheRoot, "akm-opencode@latest", "0.9.15");
      cacheSpec(cacheRoot, "akm-opencode@next", "0.10.261013-beta");

      const results = collect(named("akm-opencode"), "0.9.17", cacheRoot);

      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("warn");
      expect(results[0]?.evidence).toMatchObject({ bundledVersion: "0.9.15", spec: "akm-opencode@latest" });
    });

    test("a bare name, or none, with only the bare folder cached reads that folder, as before", () => {
      const cacheRoot = cacheRootOf();
      cacheSpec(cacheRoot, "akm-opencode", "0.9.15");

      for (const config of [named("akm-opencode"), undefined]) {
        const results = collect(config, "0.9.17", cacheRoot);
        expect(results.map((r) => [r.name, r.status])).toEqual([["opencode-plugin-version", "warn"]]);
        expect(results[0]?.evidence).toEqual({ bundledVersion: "0.9.15", cliVersion: "0.9.17" });
      }
    });

    test("a config naming a spec with no cache folder falls back to the bare folder", () => {
      const cacheRoot = cacheRootOf();
      cacheSpec(cacheRoot, "akm-opencode", "0.9.17");

      expect(collect(named("akm-opencode@next"), "0.9.17", cacheRoot).map((r) => r.status)).toEqual(["pass"]);
    });

    test("no config entry does not scan the other cached specs", () => {
      const cacheRoot = cacheRootOf();
      cacheSpec(cacheRoot, "akm-opencode@next", "0.10.261012-beta");

      expect(collect(undefined, "0.10.261013-beta", cacheRoot)).toEqual([]);
      expect(
        collect({ file: "opencode.json", text: '{"plugin":["other-plugin"]}' }, "0.10.261013-beta", cacheRoot),
      ).toEqual([]);
    });

    test("a version pin is reported as pinned with that version, with no staleness verdict", () => {
      const cacheRoot = cacheRootOf();
      cacheSpec(cacheRoot, "akm-opencode@0.10.261012-beta", "0.10.261012-beta");

      const [adv, ...rest] = collect(named("akm-opencode@0.10.261012-beta"), "0.10.261015-beta", cacheRoot);

      expect(rest).toEqual([]);
      expect(adv?.name).toBe("opencode-plugin-version");
      expect(adv?.status).toBe("pass");
      expect(adv?.message).toContain("pinned to v0.10.261012-beta");
      expect(adv?.message).toContain("(akm-opencode@0.10.261012-beta)");
      expect(adv?.message).not.toContain("update the OpenCode plugin");
      expect(adv?.evidence).toEqual({
        bundledVersion: "0.10.261012-beta",
        cliVersion: "0.10.261015-beta",
        spec: "akm-opencode@0.10.261012-beta",
        pinnedVersion: "0.10.261012-beta",
      });
    });

    test("opencode.jsonc with comments and a trailing comma, the entry as a [spec, options] pair", () => {
      const cacheRoot = cacheRootOf();
      cacheSpec(cacheRoot, "akm-opencode@next", "0.10.261012-beta");
      const text = `{
        // plugins this host loads
        "plugin": [
          "some-other-plugin@1.2.3", /* not ours */
          ["akm-opencode@next", { "debug": true }], // ours
        ],
      }`;

      const results = collect({ file: "opencode.jsonc", text }, "0.10.261013-beta", cacheRoot);

      expect(results.map((r) => [r.status, r.evidence?.spec])).toEqual([["warn", "akm-opencode@next"]]);
    });
  });

  // OpenCode 2 keeps its plugins in `npm/<spec>/<epoch-ms>/node_modules` (observed on 2.0.26),
  // and akm-opencode-v2 has its own advisory so it never reads as the OpenCode 1 plugin.
  describe("opencode-v2-plugin-version", () => {
    function installV2BundledAkm(
      cacheRoot: string,
      version: string,
      spec = "akm-opencode-v2@latest",
      build = "1800000000000",
    ) {
      const pkgDir = path.join(cacheRoot, "npm", spec, build, "node_modules", "akm-cli");
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "akm-cli", version }));
    }

    function installV1BundledAkm(cacheRoot: string, version: string): void {
      const pkgDir = path.join(cacheRoot, "packages", "akm-opencode", "node_modules", "akm-cli");
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "akm-cli", version }));
    }

    function roots(prefix: string) {
      const pluginsRoot = makeTempDir(prefix);
      return { pluginsRoot, opencodeCacheRoot: path.join(pluginsRoot, "opencode-cache") };
    }

    test("a stale bundled akm-cli warns, names the spec and the remedy", () => {
      const { pluginsRoot, opencodeCacheRoot } = roots("akm-plugin-v2-stale-");
      installV2BundledAkm(opencodeCacheRoot, "0.9.15");

      const [adv, ...rest] = collectPluginStalenessAdvisories({ pluginsRoot, cliVersion: "0.9.17", opencodeCacheRoot });

      expect(rest).toEqual([]);
      expect(adv?.name).toBe("opencode-v2-plugin-version");
      expect(adv?.status).toBe("warn");
      expect(adv?.message).toContain("OpenCode 2's akm-opencode-v2");
      expect(adv?.message).toContain("akm-opencode-v2@latest");
      expect(adv?.message).toContain("v0.9.15");
      expect(adv?.message).toContain("update the akm-opencode-v2 plugin");
      expect(adv?.evidence).toEqual({ bundledVersion: "0.9.15", cliVersion: "0.9.17", spec: "akm-opencode-v2@latest" });
    });

    test("a matching bundled akm-cli passes", () => {
      const { pluginsRoot, opencodeCacheRoot } = roots("akm-plugin-v2-match-");
      installV2BundledAkm(opencodeCacheRoot, "0.9.17");

      const [adv] = collectPluginStalenessAdvisories({ pluginsRoot, cliVersion: "0.9.17", opencodeCacheRoot });

      expect(adv?.status).toBe("pass");
    });

    test("only the newest build folder of a spec counts", () => {
      const { pluginsRoot, opencodeCacheRoot } = roots("akm-plugin-v2-builds-");
      installV2BundledAkm(opencodeCacheRoot, "0.9.1", "akm-opencode-v2@latest", "1700000000000");
      installV2BundledAkm(opencodeCacheRoot, "0.9.17", "akm-opencode-v2@latest", "1800000000000");

      const results = collectPluginStalenessAdvisories({ pluginsRoot, cliVersion: "0.9.17", opencodeCacheRoot });

      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("pass");
    });

    test("each cached spec (@latest, @next, a pin) gets its own advisory", () => {
      const { pluginsRoot, opencodeCacheRoot } = roots("akm-plugin-v2-specs-");
      installV2BundledAkm(opencodeCacheRoot, "0.9.17", "akm-opencode-v2@latest");
      installV2BundledAkm(opencodeCacheRoot, "0.9.15", "akm-opencode-v2@0.8.0");

      const results = collectPluginStalenessAdvisories({ pluginsRoot, cliVersion: "0.9.17", opencodeCacheRoot });

      expect(results.map((r) => [r.evidence?.spec, r.status])).toEqual([
        ["akm-opencode-v2@0.8.0", "warn"],
        ["akm-opencode-v2@latest", "pass"],
      ]);
    });

    test("an unreadable package.json, or a different package under npm/, is skipped", () => {
      const { pluginsRoot, opencodeCacheRoot } = roots("akm-plugin-v2-bad-");
      const bad = path.join(
        opencodeCacheRoot,
        "npm",
        "akm-opencode-v2@latest",
        "1800000000000",
        "node_modules",
        "akm-cli",
      );
      fs.mkdirSync(bad, { recursive: true });
      fs.writeFileSync(path.join(bad, "package.json"), "{not valid json");
      installV2BundledAkm(opencodeCacheRoot, "0.9.15", "akm-opencode@latest");

      expect(collectPluginStalenessAdvisories({ pluginsRoot, cliVersion: "0.9.17", opencodeCacheRoot })).toEqual([]);
    });

    test("an OpenCode 1 cache never produces a V2 advisory, and a V2 cache never a V1 one", () => {
      const v1 = roots("akm-plugin-v2-only-v1-");
      installV1BundledAkm(v1.opencodeCacheRoot, "0.9.15");
      expect(
        collectPluginStalenessAdvisories({
          pluginsRoot: v1.pluginsRoot,
          cliVersion: "0.9.17",
          opencodeCacheRoot: v1.opencodeCacheRoot,
        }).map((r) => r.name),
      ).toEqual(["opencode-plugin-version"]);

      const v2 = roots("akm-plugin-v2-only-v2-");
      installV2BundledAkm(v2.opencodeCacheRoot, "0.9.15");
      expect(
        collectPluginStalenessAdvisories({
          pluginsRoot: v2.pluginsRoot,
          cliVersion: "0.9.17",
          opencodeCacheRoot: v2.opencodeCacheRoot,
        }).map((r) => r.name),
      ).toEqual(["opencode-v2-plugin-version"]);
    });

    test("both installed: independent advisories, each against the running CLI", () => {
      const { pluginsRoot, opencodeCacheRoot } = roots("akm-plugin-v2-both-");
      installV1BundledAkm(opencodeCacheRoot, "0.9.17");
      installV2BundledAkm(opencodeCacheRoot, "0.9.15");

      const results = collectPluginStalenessAdvisories({ pluginsRoot, cliVersion: "0.9.17", opencodeCacheRoot });

      expect(results.map((r) => [r.name, r.status])).toEqual([
        ["opencode-plugin-version", "pass"],
        ["opencode-v2-plugin-version", "warn"],
      ]);
    });
  });
});

/** Run git in `cwd`; throws on failure so a broken fixture fails loudly. */
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A marketplace remote shaped like itlackey/akm-plugins: `main` at an untagged commit after the stable tag, `next`
 * reset to the newest build, and a retired 8-digit daily-build tag that semver sorts above every monthly build.
 * The plugins root's marketplace clone is made the way Claude Code makes it (`git clone --branch <ref>`), so a tag
 * `ref` leaves it detached at that tag. Returns the clone's path.
 */
function makeMarketplaceRemote(pluginsRoot: string, ref: string): string {
  const work = path.join(pluginsRoot, "remote-work");
  fs.mkdirSync(work, { recursive: true });
  git(work, "init", "-q");
  const commit = (message: string) => git(work, "commit", "-q", "--allow-empty", "-m", message);
  commit("0.9 stable");
  git(work, "tag", "v0.9.30202610090106");
  commit("retired daily build");
  git(work, "tag", "v0.10.26101201-alpha");
  git(work, "checkout", "-q", "-b", "next");
  commit("next build 0.10.261012-beta");
  git(work, "tag", "v0.10.261012-beta");
  commit("next build 0.10.261013-beta");
  git(work, "tag", "v0.10.261013-beta");
  git(work, "checkout", "-q", "main");
  commit("untagged work on main");
  const bare = path.join(pluginsRoot, "remote.git");
  git(pluginsRoot, "clone", "-q", "--bare", work, bare);
  const clone = path.join(pluginsRoot, "marketplaces", "akm-plugins");
  git(pluginsRoot, "clone", "-q", "--branch", ref, bare, clone);
  return clone;
}

describe("the real remote probe reads the channel the marketplace clone follows", () => {
  test("a clone on next is compared with the tag on next's head, not the retired build that sorts higher", () => {
    const pluginsRoot = makeTempDir("akm-plugin-real-next-");
    installPlugin(pluginsRoot, { versionRange: null, version: "0.10.261013-beta" });
    makeMarketplaceRemote(pluginsRoot, "next");

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.10.261015-beta",
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(adv?.evidence?.availableVersion).toBe("0.10.261013-beta");
    expect(adv?.status).toBe("pass");
  });

  test("a clone on next behind the channel head is stale", () => {
    const pluginsRoot = makeTempDir("akm-plugin-real-next-behind-");
    installPlugin(pluginsRoot, { versionRange: null, version: "0.10.261012-beta" });
    makeMarketplaceRemote(pluginsRoot, "next");

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.10.261015-beta",
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(adv?.evidence?.availableVersion).toBe("0.10.261013-beta");
    expect(adv?.status).toBe("warn");
    expect(adv?.message).toContain("STALE");
  });

  test("a clone on the default branch is compared with the newest stable tag only", () => {
    const pluginsRoot = makeTempDir("akm-plugin-real-main-");
    installPlugin(pluginsRoot, { versionRange: null, version: "0.9.30202610090106" });
    makeMarketplaceRemote(pluginsRoot, "main");

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.31",
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(adv?.evidence?.availableVersion).toBe("0.9.30202610090106");
    expect(adv?.status).toBe("pass");
  });

  test("a clone pinned to a tag is compared with that tag, not the newest stable tag or the next head", () => {
    const pluginsRoot = makeTempDir("akm-plugin-real-pin-");
    installPlugin(pluginsRoot, { versionRange: null, version: "0.10.261012-beta" });
    makeMarketplaceRemote(pluginsRoot, "v0.10.261012-beta");

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.10.261015-beta",
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(adv?.evidence?.availableVersion).toBe("0.10.261012-beta");
    expect(adv?.status).toBe("pass");
  });

  test("a detached clone at an untagged commit is compared with the newest stable tag, as before", () => {
    const pluginsRoot = makeTempDir("akm-plugin-real-detached-");
    installPlugin(pluginsRoot, { versionRange: null, version: "0.9.30202610090106" });
    const clone = makeMarketplaceRemote(pluginsRoot, "main");
    git(clone, "checkout", "-q", "--detach");

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.31",
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(adv?.evidence?.availableVersion).toBe("0.9.30202610090106");
    expect(adv?.status).toBe("pass");
  });

  test("a clone with no origin remote makes no staleness claim", () => {
    const pluginsRoot = makeTempDir("akm-plugin-real-noremote-");
    installPlugin(pluginsRoot, { versionRange: null, version: "0.10.261012-beta" });
    const clone = makeMarketplaceRemote(pluginsRoot, "next");
    git(clone, "remote", "remove", "origin");

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.10.261015-beta",
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(adv?.evidence?.availableVersion).toBeNull();
    expect(adv?.status).toBe("pass");
    expect(adv?.message).toBe("akm@akm-plugins: installed 0.10.261012-beta");
  });

  test("an unreachable remote (offline) makes no staleness claim", () => {
    const pluginsRoot = makeTempDir("akm-plugin-real-offline-");
    installPlugin(pluginsRoot, { versionRange: null, version: "0.10.261012-beta" });
    const clone = makeMarketplaceRemote(pluginsRoot, "next");
    git(clone, "remote", "set-url", "origin", path.join(pluginsRoot, "gone.git"));

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.10.261015-beta",
      opencodeCacheRoot: noOpencode(pluginsRoot),
    });

    expect(adv?.evidence?.availableVersion).toBeNull();
    expect(adv?.status).toBe("pass");
  });
});
