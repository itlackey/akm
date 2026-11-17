// Integration: spawns isolated native CLI stand-ins; no user's harness or network is used.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { runUpgrade, type UpgradeRunDependencies } from "../../src/commands/sources/plugin-upgrade";
import { parseJsonc } from "../../src/core/common";
import { makeSandboxDir, withEnv } from "../_helpers/sandbox";

let root: string;
let cleanup: () => void;
let env: Record<string, string>;
const opts = { check: false, force: false, skipPostUpgrade: true };
const originalCodex =
  '# retained\n[marketplaces."akm-plugins"]\nsource_type = "git"\nsource = "https://example.test/plugins.git"\n\n[plugins."other@other"]\nenabled = true\n';
const originalClaude = JSON.stringify(
  {
    extraKnownMarketplaces: { "akm-plugins": { source: { source: "git", url: "https://example.test/plugins.git" } } },
    enabledPlugins: { "akm@akm-plugins": false },
    pluginConfigs: { "akm@akm-plugins": { userConfig: { retained: "value" } } },
    unrelated: true,
  },
  null,
  2,
);
function file(name: string) {
  return path.join(root, name);
}
function write(name: string, content: string) {
  fs.mkdirSync(path.dirname(file(name)), { recursive: true });
  fs.writeFileSync(file(name), content);
}
function read(name: string) {
  return fs.readFileSync(file(name), "utf8");
}
function state(patch: Record<string, unknown> = {}) {
  const value = JSON.parse(read("state.json"));
  write("state.json", JSON.stringify({ ...value, ...patch }));
}
function deps(current = "0.10.1", latest = "0.10.3-beta", migration: "current" | "failed" = "current") {
  const calls: unknown[] = [];
  return {
    calls,
    checkForUpdate: async () => ({
      currentVersion: current,
      latestVersion: latest,
      updateAvailable: latest !== current,
      installMethod: "npm" as const,
    }),
    performUpgrade: async (check, options) => {
      calls.push(options);
      return {
        currentVersion: current,
        newVersion: check.latestVersion,
        upgraded: current !== check.latestVersion,
        installMethod: "npm",
        migration: { status: migration },
      };
    },
  } satisfies UpgradeRunDependencies & { calls: unknown[] };
}
beforeEach(() => {
  const sandbox = makeSandboxDir("akm-channel-tests");
  root = sandbox.dir;
  cleanup = sandbox.cleanup;
  write(
    "state.json",
    JSON.stringify({
      versions: { latest: "0.10.2", next: "0.10.3-beta" },
      claudeVersion: "0.10.1",
      codexVersion: "0.10.1",
    }),
  );
  write("calls.jsonl", "");
  write("claude/settings.json", originalClaude);
  write(
    "claude/plugins/known_marketplaces.json",
    JSON.stringify({
      "akm-plugins": {
        source: { source: "git", url: "https://example.test/plugins.git" },
        installLocation: "preserved",
        autoUpdate: true,
      },
      other: { keep: true },
    }),
  );
  write("codex/config.toml", originalCodex);
  write(
    "config/opencode/opencode.jsonc",
    '{\n // keep comments\n "plugin": ["other", ["akm-opencode", {"keep": true}]],\n "provider": {"keep": true},\n}\n',
  );
  write("cache/opencode/packages/akm-opencode@latest/node_modules/akm-opencode/package.json", '{"version":"0.10.1"}');
  const stub = path.join(import.meta.dir, "_fixtures/channel-harness.ts");
  for (const command of ["claude", "codex", "npm", "git", "pgrep", "opencode", "trash-put"]) {
    write(`bin/${command}`, `#!${process.execPath}\nimport ${JSON.stringify(stub)};\n`);
    fs.chmodSync(file(`bin/${command}`), 0o755);
  }
  env = {
    PATH: file("bin"),
    AKM_CHANNEL_FIXTURE: root,
    CLAUDE_CONFIG_DIR: file("claude"),
    AKM_CLAUDE_PLUGINS_DIR: file("claude/plugins"),
    CODEX_HOME: file("codex"),
    XDG_CONFIG_HOME: file("config"),
    XDG_CACHE_HOME: file("cache"),
    XDG_DATA_HOME: file("data"),
    OPENCODE_CONFIG: "",
  };
});
afterEach(() => cleanup());

(process.platform === "win32" ? describe.skip : describe)("explicit coordinated channel switching", () => {
  test("latest → next preserves native settings, tuple options and backups, and refreshes each harness", async () => {
    const dependency = deps();
    const run = await withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.1", dependency));
    expect(run.mode === "upgrade" && run.failed).toBe(false);
    expect(dependency.calls).toEqual([{ force: false, skipPostUpgrade: true, targetVersion: "0.10.3-beta" }]);
    expect(
      run.result.plugins.every(
        (p) => p.channel === "next" && p.previousChannel === "latest" && p.outcome === "updated",
      ),
    ).toBe(true);
    const claude = JSON.parse(read("claude/settings.json"));
    expect(claude.pluginConfigs).toEqual(JSON.parse(originalClaude).pluginConfigs);
    expect(claude.enabledPlugins["akm@akm-plugins"]).toBe(false);
    expect(claude.extraKnownMarketplaces["akm-plugins"].source.ref).toBe("next");
    expect(read("codex/config.toml")).toContain('[marketplaces."akm-plugins"]');
    expect(read("codex/config.toml")).toContain('[plugins."other@other"]\nenabled = true');
    expect(
      (parseToml(read("codex/config.toml")) as { marketplaces: Record<string, { ref?: string }> }).marketplaces[
        "akm-plugins"
      ]?.ref,
    ).toBe("next");
    expect((parseJsonc(read("config/opencode/opencode.jsonc")) as { plugin: unknown[] }).plugin).toEqual([
      "other",
      ["akm-opencode@next", { keep: true }],
    ]);
    expect(read("config/opencode/opencode.jsonc")).toContain("// keep comments");
    for (const plugin of run.result.plugins)
      for (const backup of plugin.backups ?? []) expect(fs.existsSync(backup)).toBe(true);
    expect(read("calls.jsonl")).not.toContain('"remove"');
  });

  test("--check shows mismatches and a planned switch without native writes or installs", async () => {
    const run = await withEnv(env, () =>
      runUpgrade({ ...opts, check: true, channel: "next" }, "0.10.3-beta", deps("0.10.3-beta")),
    );
    expect(
      run.result.plugins.every(
        (p) => p.channel === "latest" && p.channelMismatch === true && p.targetChannel === "next",
      ),
    ).toBe(true);
    expect(read("claude/settings.json")).toBe(originalClaude);
    expect(read("codex/config.toml")).toBe(originalCodex);
    expect(read("calls.jsonl")).not.toContain('"update"');
    expect(read("calls.jsonl")).not.toContain('"upgrade"');
  });

  test("--check --channel next reports the same shape as --check --next, plus the target channel", async () => {
    const viaNext = await withEnv(env, () =>
      runUpgrade({ ...opts, check: true, next: true }, "0.10.1", deps("0.10.1")),
    );
    const viaChannel = await withEnv(env, () =>
      runUpgrade({ ...opts, check: true, channel: "next" }, "0.10.1", deps("0.10.1")),
    );
    expect(viaNext.mode).toBe("check");
    expect(viaChannel.mode).toBe("check");
    const { targetChannel, ...rest } = viaChannel.result as typeof viaChannel.result & { targetChannel?: string };
    expect(targetChannel).toBe("next");
    expect(Object.keys(rest).sort()).toEqual(Object.keys(viaNext.result).sort());
    expect(rest.channel).toBe(viaNext.result.channel);
    expect(rest.plugins.map((p) => p.harness)).toEqual(viaNext.result.plugins.map((p) => p.harness));
  });

  describe("--check reports the plugin updates the channel in force would make", () => {
    const check = (channel: "latest" | "next", current = "0.10.3-beta") =>
      withEnv(env, () => runUpgrade({ ...opts, check: true, channel }, current, deps(current, current)));
    const plan = (run: Awaited<ReturnType<typeof check>>, harness: string) =>
      run.result.plugins.find((p) => p.harness === harness);

    test("a prerelease CLI with Claude and Codex on stable: both would move to the prerelease build", async () => {
      const run = await check("next");
      for (const harness of ["claude-code", "codex"])
        expect(plan(run, harness)).toMatchObject({
          outcome: "pending",
          from: "0.10.1",
          to: "0.10.3-beta",
          channel: "latest",
          targetChannel: "next",
          channelMismatch: true,
        });
      expect(read("claude/settings.json")).toBe(originalClaude);
      expect(read("codex/config.toml")).toBe(originalCodex);
      expect(read("calls.jsonl")).not.toContain('"update"');
      expect(read("calls.jsonl")).not.toContain('"upgrade"');
    });

    test("the stable channel's newest build is the target on stable", async () => {
      const run = await check("latest", "0.10.1");
      expect(plan(run, "claude-code")).toMatchObject({ outcome: "pending", from: "0.10.1", to: "0.10.2" });
    });

    test("a plugin already at the channel's newest build is current, and a newer one stays", async () => {
      state({ claudeVersion: "0.10.3-beta", codexVersion: "0.10.9" });
      const run = await check("next");
      expect(plan(run, "claude-code")).toMatchObject({ outcome: "current", from: "0.10.3-beta", to: "0.10.3-beta" });
      expect(plan(run, "codex")).toMatchObject({
        outcome: "current",
        from: "0.10.9",
        message: "codex stays at 0.10.9; next has nothing newer",
      });
    });

    test("a marketplace that cannot be read: a switch leaves the plugin where it is, as the real switch does; a plain check says unknown", async () => {
      state({ remote: "down" });
      const run = await check("next");
      for (const harness of ["claude-code", "codex"])
        expect(plan(run, harness)).toMatchObject({ outcome: "current", from: "0.10.1", to: "0.10.1" });
      expect(plan(run, "codex")?.message).toContain("stays at 0.10.1; could not read the next build's version");
      const plain = await withEnv(env, () => runUpgrade({ ...opts, check: true }, "0.10.1", deps("0.10.1", "0.10.1")));
      for (const harness of ["claude-code", "codex"])
        expect(plan(plain, harness)).toMatchObject({ outcome: "unknown", from: "0.10.1" });
      expect(plan(plain, "codex")?.message).toContain("the latest build could not be read");
    });

    test("the plan reads the marketplace each harness registered, and the real switch installs what the plan said", async () => {
      const planned = await check("next", "0.10.1");
      const clones = () =>
        read("calls.jsonl")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((call) => call.command === "git" && call.args[0] === "clone")
          .map((call) => call.args.at(-2));
      expect(clones()).toEqual(["https://example.test/plugins.git", "https://example.test/plugins.git"]);
      expect(read("calls.jsonl")).not.toContain("itlackey");
      const real = await withEnv(env, () =>
        runUpgrade({ ...opts, channel: "next" }, "0.10.1", deps("0.10.1", "0.10.3-beta")),
      );
      for (const harness of ["claude-code", "codex"])
        expect(real.result.plugins.find((p) => p.harness === harness)).toMatchObject({
          outcome: "updated",
          from: plan(planned, harness)?.from,
          to: plan(planned, harness)?.to,
        });
    });
  });

  test("--channel on an installation that already follows it changes nothing on disk and reports what a plain upgrade does", async () => {
    const followNext = () => {
      const known = JSON.parse(read("claude/plugins/known_marketplaces.json"));
      known["akm-plugins"].source.ref = "next";
      write("claude/plugins/known_marketplaces.json", JSON.stringify(known));
      const settings = JSON.parse(originalClaude);
      settings.extraKnownMarketplaces["akm-plugins"].source.ref = "next";
      write("claude/settings.json", JSON.stringify(settings, null, 2));
      write("codex/config.toml", originalCodex.replace('source_type = "git"', 'source_type = "git"\nref = "next"'));
      write("config/opencode/opencode.jsonc", '{"plugin": [["akm-opencode@next", {"keep": true}]]}');
      write(
        "cache/opencode/packages/akm-opencode@next/node_modules/akm-opencode/package.json",
        '{"version":"0.10.3-beta"}',
      );
      state({ claudeVersion: "0.10.3-beta", codexVersion: "0.10.3-beta" });
    };
    followNext();
    const files = [
      "claude/settings.json",
      "claude/plugins/known_marketplaces.json",
      "codex/config.toml",
      "config/opencode/opencode.jsonc",
    ];
    const before = files.map(read);
    const entries = (run: Awaited<ReturnType<typeof runUpgrade>>) =>
      run.result.plugins.map(({ harness, outcome, from, to }) => ({ harness, outcome, from, to }));
    const plain = await withEnv(env, () =>
      runUpgrade({ ...opts, next: true }, "0.10.3-beta", deps("0.10.3-beta", "0.10.3-beta")),
    );
    const switched = await withEnv(env, () =>
      runUpgrade({ ...opts, channel: "next" }, "0.10.3-beta", deps("0.10.3-beta", "0.10.3-beta")),
    );
    expect(switched.mode === "upgrade" && switched.failed).toBe(false);
    expect(files.map(read)).toEqual(before);
    expect(fs.readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith(".bak"))).toEqual([]);
    expect(entries(switched)).toEqual(entries(plain));
    for (const entry of switched.result.plugins) expect(entry.backups).toBeUndefined();
  });

  test("a channel whose newest akm is older keeps the installed akm and still switches; --allow-downgrade moves back", async () => {
    state({
      versions: { latest: "0.10.261120", next: "0.10.261120-beta" },
      claudeVersion: "0.10.261100",
      codexVersion: "0.10.261100",
    });
    const older = () => deps("0.10.261119", "0.10.261119-beta.1");
    const dependency = older();
    const run = await withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.261119", dependency));
    expect(run.mode === "upgrade" && run.failed).toBe(false);
    expect(dependency.calls).toEqual([{ force: false, skipPostUpgrade: true, targetVersion: "0.10.261119" }]);
    expect((run.result as { upgraded?: boolean }).upgraded).toBe(false);
    expect((run.result as { message?: string }).message).toBe("akm stays at 0.10.261119; next has nothing newer");
    expect(run.result.plugins.every((p) => p.channel === "next")).toBe(true);
    expect(JSON.parse(read("claude/settings.json")).extraKnownMarketplaces["akm-plugins"].source.ref).toBe("next");
    const back = older();
    const moved = await withEnv(env, () =>
      runUpgrade({ ...opts, channel: "next", allowDowngrade: true }, "0.10.261119", back),
    );
    expect(moved.mode === "upgrade" && moved.failed).toBe(false);
    expect(back.calls).toEqual([{ force: false, skipPostUpgrade: true, targetVersion: "0.10.261119-beta.1" }]);
    expect((moved.result as { newVersion?: string }).newVersion).toBe("0.10.261119-beta.1");
  });

  test("the OpenCode plugin's next build pinning an older akm does not hold the CLI back", async () => {
    state({
      versions: { latest: "0.10.261119", next: "0.10.261115-beta" },
      claudeVersion: "0.10.261100",
      codexVersion: "0.10.261100",
    });
    const dependency = deps("0.10.261119", "0.10.261120-beta.1");
    const run = await withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.261119", dependency));
    expect(run.mode === "upgrade" && run.failed).toBe(false);
    expect(dependency.calls).toEqual([{ force: false, skipPostUpgrade: true, targetVersion: "0.10.261120-beta.1" }]);
    expect((run.result as { newVersion?: string }).newVersion).toBe("0.10.261120-beta.1");
    expect(run.result).not.toHaveProperty("lockstep");
  });

  test("a channel whose newest plugin build is older leaves the installed plugin completely untouched", async () => {
    write("cache/opencode/packages/akm-opencode@latest/node_modules/akm-opencode/package.json", '{"version":"0.10.9"}');
    const config = read("config/opencode/opencode.jsonc");
    const run = await withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.1", deps()));
    expect(run.mode === "upgrade" && run.failed).toBe(false);
    expect(run.result.plugins.find((p) => p.harness === "opencode")).toMatchObject({
      outcome: "current",
      channel: "latest",
      from: "0.10.9",
      to: "0.10.9",
      message: "akm-opencode stays at 0.10.9; next has nothing newer",
    });
    expect(read("config/opencode/opencode.jsonc")).toBe(config);
    expect(read("calls.jsonl")).not.toContain("debug config");
    expect(fs.existsSync(file("cache/opencode/packages/akm-opencode@latest/node_modules"))).toBe(true);
  });

  test("Claude installed newer than the marketplace next ref stays, while akm and the other plugins switch", async () => {
    state({
      versions: { latest: "0.10.261121", next: "0.10.261116-beta" },
      claudeVersion: "0.10.261121",
      codexVersion: "0.10.261100",
    });
    write(
      "cache/opencode/packages/akm-opencode@latest/node_modules/akm-opencode/package.json",
      '{"version":"0.10.261100"}',
    );
    const known = read("claude/plugins/known_marketplaces.json");
    const dependency = deps("0.10.261121", "0.10.261122-beta.1");
    const run = await withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.261121", dependency));
    expect(run.mode === "upgrade" && run.failed).toBe(false);
    expect(dependency.calls).toEqual([{ force: false, skipPostUpgrade: true, targetVersion: "0.10.261122-beta.1" }]);
    expect(run.result.plugins.find((p) => p.harness === "claude-code")).toMatchObject({
      outcome: "current",
      channel: "latest",
      message: "claude-code stays at 0.10.261121; next has nothing newer",
    });
    expect(read("claude/settings.json")).toBe(originalClaude);
    expect(read("claude/plugins/known_marketplaces.json")).toBe(known);
    expect(read("calls.jsonl")).not.toContain('"update"');
    expect(run.result.plugins.find((p) => p.harness === "codex")).toMatchObject({ channel: "next" });
  });

  test("a Codex marketplace newer than its next ref stays untouched", async () => {
    state({ codexVersion: "0.10.9" });
    const run = await withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.1", deps()));
    expect(run.mode === "upgrade" && run.failed).toBe(false);
    expect(run.result.plugins.find((p) => p.harness === "codex")).toMatchObject({
      outcome: "current",
      channel: "latest",
      message: "codex stays at 0.10.9; next has nothing newer",
    });
    expect(read("codex/config.toml")).toBe(originalCodex);
    expect(read("calls.jsonl")).not.toContain("marketplace upgrade");
  });

  test("a Codex catalog in the local-path form still reads its build version", async () => {
    state({ codexVersion: "0.10.9", codexCatalog: "local" });
    const run = await withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.1", deps()));
    expect(run.result.plugins.find((p) => p.harness === "codex")).toMatchObject({
      outcome: "current",
      message: "codex stays at 0.10.9; next has nothing newer",
    });
  });

  test("a Codex build version that cannot be read leaves Codex alone and the CLI still upgrades", async () => {
    state({ codexCatalog: "unreadable" });
    const dependency = deps();
    const run = await withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.1", dependency));
    expect(run.mode === "upgrade" && run.failed).toBe(false);
    expect(dependency.calls).toHaveLength(1);
    const codex = run.result.plugins.find((p) => p.harness === "codex");
    expect(codex).toMatchObject({ outcome: "current", channel: "latest" });
    expect(codex?.message).toContain("codex stays at 0.10.1; could not read the next build's version");
    expect(read("codex/config.toml")).toBe(originalCodex);
    expect(run.result.plugins.find((p) => p.harness === "claude-code")).toMatchObject({ channel: "next" });
  });

  test.each([
    "claude plugin marketplace update akm-plugins",
    "codex plugin marketplace upgrade akm-plugins",
    "opencode debug config",
  ])("%s failure reports the configured channel and saved backups", async (fail) => {
    state({ fail });
    const run = await withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.1", deps()));
    expect(run.mode === "upgrade" && run.failed).toBe(true);
    const failed = run.result.plugins.find((p) => p.outcome === "failed");
    expect(failed?.channel).toBe("next");
    expect(failed?.backups?.length).toBeGreaterThan(0);
  });

  test("failed CLI migration leaves plugin configuration unchanged", async () => {
    const run = await withEnv(env, () =>
      runUpgrade({ ...opts, channel: "next" }, "0.10.1", deps("0.10.1", "0.10.3-beta", "failed")),
    );
    expect(run.mode === "upgrade" && run.failed).toBe(true);
    expect(run.result.plugins).toEqual([]);
    expect(read("claude/settings.json")).toBe(originalClaude);
    expect(read("codex/config.toml")).toBe(originalCodex);
  });
  test("next → latest removes only refs and retains unrelated settings", async () => {
    await withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.1", deps()));
    const run = await withEnv(env, () =>
      runUpgrade({ ...opts, channel: "latest", allowDowngrade: true }, "0.10.3-beta", deps("0.10.3-beta", "0.10.2")),
    );
    expect(run.mode === "upgrade" && run.failed).toBe(false);
    expect(run.result.plugins.every((p) => p.channel === "latest")).toBe(true);
    expect(JSON.parse(read("claude/settings.json"))).toEqual(JSON.parse(originalClaude));
    expect(parseToml(read("codex/config.toml"))).toEqual(parseToml(originalCodex));
    expect((parseJsonc(read("config/opencode/opencode.jsonc")) as { plugin: unknown[] }).plugin).toEqual([
      "other",
      ["akm-opencode", { keep: true }],
    ]);
  });

  describe("opencode.json and opencode.jsonc both name the plugin", () => {
    const jsonText = JSON.stringify({ plugin: ["akm-opencode"], model: "keep" });
    const cached = (tag: string) => fs.existsSync(file(`cache/opencode/packages/akm-opencode@${tag}/node_modules`));
    const jsoncPlugin = () => (parseJsonc(read("config/opencode/opencode.jsonc")) as { plugin: unknown[] }).plugin;
    beforeEach(() => write("config/opencode/opencode.json", jsonText));

    test("--check, --channel next and --channel latest read and edit opencode.jsonc only", async () => {
      const checked = await withEnv(env, () =>
        runUpgrade({ ...opts, check: true, channel: "next" }, "0.10.3-beta", deps("0.10.3-beta")),
      );
      expect(checked.result.plugins.find((p) => p.harness === "opencode")).toMatchObject({ channel: "latest" });
      expect(read("config/opencode/opencode.json")).toBe(jsonText);
      expect(jsoncPlugin()[1]).toEqual(["akm-opencode", { keep: true }]);

      await withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.1", deps()));
      expect(jsoncPlugin()[1]).toEqual(["akm-opencode@next", { keep: true }]);
      expect(read("config/opencode/opencode.json")).toBe(jsonText);
      expect(cached("next")).toBe(true);

      const back = await withEnv(env, () =>
        runUpgrade({ ...opts, channel: "latest", allowDowngrade: true }, "0.10.3-beta", deps("0.10.3-beta", "0.10.2")),
      );
      expect(back.mode === "upgrade" && back.failed).toBe(false);
      expect(jsoncPlugin()[1]).toEqual(["akm-opencode", { keep: true }]);
      expect(read("config/opencode/opencode.json")).toBe(jsonText);
    });

    test("a .jsonc plugin list that omits the package means it is not loaded: opencode.json is not edited", async () => {
      write("config/opencode/opencode.jsonc", '{"plugin": ["other"]}');
      const run = await withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.1", deps()));
      expect(run.result.plugins.find((p) => p.harness === "opencode")?.outcome).toBe("skipped");
      expect(read("config/opencode/opencode.json")).toBe(jsonText);
    });
  });

  test("--allow-downgrade moves every Claude scope to the channel's version", async () => {
    const rows = ["user", "project", "local"].map((scope) => ({
      id: "akm@akm-plugins",
      version: scope === "local" ? "0.10.9" : "0.10.1",
      scope,
      ...(scope === "user" ? {} : { projectPath: root }),
    }));
    state({ claudeInstallations: rows });
    const dependency = deps();
    const run = await withEnv(env, () =>
      runUpgrade({ ...opts, channel: "next", allowDowngrade: true }, "0.10.1", dependency),
    );
    expect(run.mode === "upgrade" && run.failed).toBe(false);
    const calls = read("calls.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      calls.filter((call) => call.command === "claude" && call.args[1] === "update").map((call) => call.args.at(-1)),
    ).toEqual(["user", "project", "local"]);
  });

  test("a running OpenCode already on the channel defers its plugin and the upgrade succeeds", async () => {
    await withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.1", deps()));
    state({ versions: { latest: "0.10.2", next: "0.10.4-beta" }, openCodeRunning: true });
    const run = await withEnv(env, () =>
      runUpgrade({ ...opts, channel: "next" }, "0.10.3-beta", deps("0.10.3-beta", "0.10.4-beta")),
    );
    expect(run.result.plugins.find((p) => p.harness === "opencode")).toMatchObject({
      outcome: "deferred",
      channel: "next",
    });
    expect(run.mode === "upgrade" && run.failed).toBe(false);
  });

  test("a running OpenCode still on the other channel leaves the coordinated switch incomplete", async () => {
    state({ openCodeRunning: true });
    const run = await withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.1", deps()));
    expect(run.result.plugins.find((p) => p.harness === "opencode")).toMatchObject({
      outcome: "deferred",
      channel: "latest",
    });
    expect(run.mode === "upgrade" && run.failed).toBe(true);
  });

  test("an unavailable installed OpenCode makes the coordinated switch incomplete", async () => {
    fs.unlinkSync(file("bin/opencode"));
    const run = await withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.1", deps()));
    expect(run.mode === "upgrade" && run.failed).toBe(true);
    expect(run.result.plugins.find((p) => p.harness === "opencode")).toMatchObject({
      outcome: "skipped",
      channel: "latest",
      channelMismatch: true,
    });
  });
  test.each([
    ["config/opencode/opencode.jsonc", "opencode", "latest"],
    ["claude/settings.json", "claude-code", "unknown"],
  ])("failed atomic write to %s preserves backup paths and the actual channel", async (target, harness, channel) => {
    const original = fs.renameSync;
    spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === file(target)) throw new Error("fixture atomic write failed");
      return original(from, to);
    });
    const run = await withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.1", deps()));
    expect(run.mode === "upgrade" && run.failed).toBe(true);
    const plugin = run.result.plugins.find((p) => p.harness === harness);
    expect(plugin).toMatchObject({ outcome: "failed", channel });
    expect(plugin?.backups?.length).toBeGreaterThan(0);
    for (const backup of plugin?.backups ?? []) expect(fs.existsSync(backup)).toBe(true);
  });

  test("explicit switch reconciles settings even when the registry already follows the target", async () => {
    const known = JSON.parse(read("claude/plugins/known_marketplaces.json"));
    known["akm-plugins"].source.ref = "next";
    write("claude/plugins/known_marketplaces.json", JSON.stringify(known));
    const run = await withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.1", deps()));
    expect(run.mode === "upgrade" && run.failed).toBe(false);
    expect(JSON.parse(read("claude/settings.json")).extraKnownMarketplaces["akm-plugins"].source.ref).toBe("next");
  });
  test.each([
    "claude plugin list --json",
    "codex plugin list --marketplace akm-plugins --json",
  ])("inventory failure (%s) prevents a false complete switch", async (fail) => {
    state({ fail });
    const dependency = deps();
    await expect(withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.1", dependency))).rejects.toThrow(
      "Could not inventory",
    );
    expect(dependency.calls).toHaveLength(0);
    expect(read("claude/settings.json")).toBe(originalClaude);
    expect(read("codex/config.toml")).toBe(originalCodex);
    const checked = await withEnv(env, () =>
      runUpgrade({ ...opts, check: true, channel: "next" }, "0.10.1", dependency),
    );
    expect(checked.result.plugins.some((plugin) => plugin.outcome === "failed" && plugin.channel === "unknown")).toBe(
      true,
    );
  });
});
