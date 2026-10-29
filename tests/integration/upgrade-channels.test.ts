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
    expect(read("calls.jsonl")).not.toContain('"clone"');
  });

  test("CLI downgrades are refused before edits, and --allow-downgrade permits them", async () => {
    await expect(
      withEnv(env, () => runUpgrade({ ...opts, channel: "latest" }, "0.10.4-beta", deps("0.10.4-beta", "0.10.2"))),
    ).rejects.toThrow("--allow-downgrade");
    expect(read("claude/settings.json")).toBe(originalClaude);
    const run = await withEnv(env, () =>
      runUpgrade({ ...opts, channel: "latest", allowDowngrade: true }, "0.10.4-beta", deps("0.10.4-beta", "0.10.2")),
    );
    expect(run.mode === "upgrade" && run.failed).toBe(false);
    expect(run.result.currentVersion).toBe("0.10.4-beta");
  });

  test.each([
    "claudeVersion",
    "codexVersion",
  ])("a newer %s blocks a downgrade before CLI or files change", async (versionKey) => {
    state({ [versionKey]: "0.10.9" });
    const dependency = deps();
    await expect(withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.1", dependency))).rejects.toThrow(
      "--allow-downgrade",
    );
    expect(dependency.calls).toHaveLength(0);
    expect(read("claude/settings.json")).toBe(originalClaude);
    expect(read("codex/config.toml")).toBe(originalCodex);
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

  test("Codex downgrade checks its own manifest, which can differ from Claude's", async () => {
    state({ codexTargetVersion: "0.9.0" });
    const dependency = deps();
    await expect(withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.1", dependency))).rejects.toThrow(
      "downgrade codex",
    );
    expect(dependency.calls).toHaveLength(0);
  });

  test("checks every Claude scope for downgrade, then refreshes those exact scopes", async () => {
    const rows = ["user", "project", "local"].map((scope) => ({
      id: "akm@akm-plugins",
      version: scope === "local" ? "0.10.9" : "0.10.1",
      scope,
      ...(scope === "user" ? {} : { projectPath: root }),
    }));
    state({ claudeInstallations: rows });
    const dependency = deps();
    await expect(withEnv(env, () => runUpgrade({ ...opts, channel: "next" }, "0.10.1", dependency))).rejects.toThrow(
      "downgrade claude",
    );
    expect(dependency.calls).toHaveLength(0);
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
