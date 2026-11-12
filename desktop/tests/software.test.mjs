// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { HostTools, hostEnvironment, runHost, summarizeUpgrade } from "../src/lib/server/features/host-tools.ts";

const temporary = [];
after(() => Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true }))));

test("host environment finds conventional user tools without running profiles or leaking desktop/launcher state", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "akm-host-env-"));
  temporary.push(home);
  await mkdir(path.join(home, ".nvm/versions/node/v24.18.0"), { recursive: true });
  const env = await hostEnvironment(
    {
      PATH: "/usr/bin:.:relative",
      NODE_OPTIONS: "secret",
      AKM_LAUNCHER_NODE: "/bundled/electron",
      ELECTRON_RUN_AS_NODE: "1",
      AKM_DESKTOP_SESSION_TOKEN: "secret",
      AKM_CONFIG_FILE: "/test-config/config.json",
    },
    home,
  );
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.AKM_LAUNCHER_NODE, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.AKM_DESKTOP_SESSION_TOKEN, undefined);
  assert.equal(env.AKM_CONFIG_FILE, "/test-config/config.json");
  assert.ok(env.PATH.includes(path.join(home, ".local/bin")));
  assert.ok(env.PATH.includes(path.join(home, ".nvm/versions/node/v24.18.0/bin")));
  assert.ok(!env.PATH.split(":").includes("."));
});

async function hostFixture({
  absent = false,
  failure = false,
  desktopVersion,
  bun = true,
  platform = "linux",
  opencodeVersion = "1.18.34",
  installerVersion,
  latestVersion = "0.10.261105",
  checkFails = false,
  upgradeResult,
  marketplace = false,
  extra,
} = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "akm-host-test-"));
  temporary.push(home);
  const calls = [],
    installerUrls = [],
    installed = new Set(),
    configured = new Set(marketplace ? ["claude", "codex"] : []);
  let cli = !absent;
  let cliVersion = "0.10.261104";
  let hasBun = bun;
  const env = {
    HOME: home,
    PATH: "/fixture/bin",
    XDG_CONFIG_HOME: path.join(home, ".config"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
  };
  const manager = new HostTools({
    home,
    env,
    platform,
    desktopVersion,
    find: async (name) =>
      (name === "akm" && !cli) || (name === "bun" && !hasBun) ? undefined : `/fixture/bin/${name}`,
    fetcher: async (url) => {
      installerUrls.push(url);
      const first = url.endsWith(".ps1") ? "#Requires -Version 5.1" : "#!/usr/bin/env bash";
      return { ok: true, text: async () => `${first}\n# fixture; never executed\n` };
    },
    run: async (file, args, options) => {
      assert.equal(options.home, home);
      assert.equal(options.env.AKM_LAUNCHER_NODE, undefined);
      calls.push({ file, args, installDir: options.env.AKM_INSTALL_DIR });
      const name = path.basename(file);
      if (args[0] === "--version") return name === "opencode" ? opencodeVersion : cliVersion;
      if (name === "akm") {
        if (checkFails && args.includes("--check")) throw new Error("offline");
        if (extra) {
          const reply = extra(args);
          if (reply !== undefined) return reply;
        }
        if (upgradeResult && !args.includes("--check")) {
          cliVersion = upgradeResult.after ?? cliVersion;
          if (upgradeResult.exit)
            throw Object.assign(new Error("Command failed: akm upgrade"), {
              code: 1,
              stdout: JSON.stringify(upgradeResult.body),
              stderr: "",
            });
          return JSON.stringify(upgradeResult.body);
        }
        if (failure && !args.includes("--check"))
          throw Object.assign(new Error("Command failed: akm upgrade"), {
            code: 1,
            stderr: `${"x".repeat(900)}CAUSE-SENTINEL\n`,
          });
        return JSON.stringify({
          currentVersion: "0.10.261104",
          latestVersion,
          updateAvailable: true,
          plugins: [],
          migration: { status: "current" },
        });
      }
      if (name === "bash" || name === "powershell.exe") {
        cli = true;
        // The installers take the release tag as their only argument; with none they install the latest.
        cliVersion = installerVersion ?? args.find((arg) => /^v\d/.test(arg))?.slice(1) ?? "0.10.261105";
        return "installed";
      }
      if (args.slice(0, 2).join(" ") === "plugin list")
        return JSON.stringify(
          name === "codex"
            ? { installed: installed.has(name) ? [{ pluginId: "akm@akm-plugins", version: "0.10.261105" }] : [] }
            : installed.has(name)
              ? [{ id: "akm@akm-plugins", version: "0.10.261105", scope: "user" }]
              : [],
        );
      if (args.slice(0, 3).join(" ") === "plugin marketplace list")
        return JSON.stringify(
          name === "codex"
            ? { marketplaces: configured.has(name) ? [{ name: "akm-plugins" }] : [] }
            : configured.has(name)
              ? [{ name: "akm-plugins" }]
              : [],
        );
      if (args.slice(0, 3).join(" ") === "plugin marketplace add") {
        configured.add(name);
        return "{}";
      }
      if (name === "opencode") {
        const configDir = path.join(home, ".config/opencode");
        await mkdir(configDir, { recursive: true });
        let config = {};
        try {
          config = JSON.parse(await readFile(path.join(configDir, "opencode.json"), "utf8"));
        } catch {}
        const v2 = opencodeVersion.startsWith("2.");
        config[v2 ? "plugins" : "plugin"] = [args[v2 ? 2 : 1]];
        await writeFile(path.join(configDir, "opencode.json"), JSON.stringify(config));
      } else installed.add(name);
      return "{}";
    },
  });
  return { manager, home, calls, installed, configured, installerUrls, installBun: () => (hasBun = true) };
}

test("host checks are read-only and upgrades invoke the existing CLI, not the bundled engine", async () => {
  const f = await hostFixture();
  f.manager.start("check");
  await f.manager.pending;
  assert.equal(f.manager.snapshot().upgrade.updateAvailable, true);
  assert.ok(
    f.calls.every(
      (call) => call.args.includes("--version") || call.args.includes("--check") || call.args.includes("list"),
    ),
  );
  f.calls.length = 0;
  f.manager.start("upgrade-cli");
  assert.throws(() => f.manager.start("install-cli"), /already running/);
  await f.manager.pending;
  assert.ok(
    f.calls.some((call) => call.file === "/fixture/bin/akm" && call.args.join(" ") === "upgrade --format json"),
  );
  assert.ok(!f.calls.some((call) => call.args.includes("--allow-downgrade") || call.args.includes("--channel")));
  assert.match(f.manager.snapshot().receipt, /bundled desktop engine is unchanged/);
  assert.deepEqual(
    summarizeUpgrade({ latestVersion: "1.0.0", credentials: "secret", migration: { files: ["private"] } }),
    { latestVersion: "1.0.0" },
  );
  // Which plugin follows which channel, and what the run did with it, is kept; the entries' messages (other than the
  // reason a plugin was deferred or failed) and backups are not.
  assert.deepEqual(
    summarizeUpgrade({
      plugins: [
        { harness: "claude-code", channel: "next", message: "private", backups: ["x"] },
        { harness: "codex", outcome: "skipped" },
      ],
    }),
    {
      plugins: [
        { harness: "claude-code", channel: "next" },
        { harness: "codex", outcome: "skipped" },
      ],
    },
  );
});

test("missing CLI uses official user-local installer and verifies the result", async () => {
  // A development run (unstamped 0.0.0) has no release of its own and takes the latest installer.
  const f = await hostFixture({ absent: true, desktopVersion: "0.0.0" });
  f.manager.start("install-cli");
  await f.manager.pending;
  assert.equal(f.manager.snapshot().error, undefined);
  assert.equal(f.manager.snapshot().cli.runnable, true);
  assert.match(f.manager.snapshot().receipt, /installed in ~\/.local\/bin/);
  assert.equal(f.calls.filter((call) => call.file === "/bin/bash").length, 1);
  f.manager.start("install-cli");
  await f.manager.pending;
  assert.match(f.manager.snapshot().error, /installer that owns it/);
  assert.deepEqual(f.installerUrls, ["https://github.com/itlackey/akm/releases/latest/download/install.sh"]);
});

test("the installer comes from Desktop's own release, so the host CLI starts equal to the engine", async () => {
  const f = await hostFixture({ absent: true, desktopVersion: "0.10.261105-beta" });
  f.manager.start("install-cli");
  await f.manager.pending;
  assert.equal(f.manager.snapshot().error, undefined);
  assert.deepEqual(f.installerUrls, ["https://github.com/itlackey/akm/releases/download/v0.10.261105-beta/install.sh"]);
});

test("on Windows the CLI installs through install.ps1 of Desktop's release, into %LOCALAPPDATA%\\akm", async () => {
  const f = await hostFixture({ absent: true, desktopVersion: "0.10.261105", platform: "win32" });
  assert.equal(f.manager.snapshot().cliDirectory, "%LOCALAPPDATA%\\akm");
  f.manager.start("install-cli");
  await f.manager.pending;
  assert.equal(f.manager.snapshot().error, undefined);
  assert.deepEqual(f.installerUrls, ["https://github.com/itlackey/akm/releases/download/v0.10.261105/install.ps1"]);
  const [install] = f.calls.filter((call) => call.file === "powershell.exe");
  assert.deepEqual(install.args.slice(0, 5), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
  assert.equal(path.basename(install.args[5]), "install.ps1");
  assert.equal(install.args[6], "v0.10.261105", "the script takes the release tag as its argument");
  assert.equal(install.installDir, path.join(f.home, "AppData", "Local", "akm"));
  assert.ok(!f.calls.some((call) => call.file === "/bin/bash"));
  assert.match(f.manager.snapshot().receipt, /installed in %LOCALAPPDATA%\\akm/);
  const env = await hostEnvironment({ PATH: "", LOCALAPPDATA: "/la" }, f.home, "win32");
  assert.ok(env.PATH.split(path.delimiter).includes(path.join("/la", "akm")), "Desktop finds what it installed");
});

test("all three harnesses use standard native installation commands and verify afterward", async () => {
  const f = await hostFixture();
  for (const id of ["claude", "codex", "opencode"]) {
    f.manager.start("install-plugin", id, "next");
    await f.manager.pending;
    assert.equal(f.manager.snapshot().error, undefined, id);
    assert.ok(
      ["installed", "configured"].includes(f.manager.snapshot().harnesses.find((item) => item.id === id).plugin.state),
    );
  }
  const commands = f.calls.map((call) => [path.basename(call.file), ...call.args].join(" "));
  assert.ok(commands.includes("claude plugin marketplace add itlackey/akm-plugins@next"));
  assert.ok(commands.includes("claude plugin install akm@akm-plugins --scope user"));
  assert.ok(commands.includes("codex plugin marketplace add itlackey/akm-plugins --ref next"));
  assert.ok(commands.includes("codex plugin add akm@akm-plugins"));
  assert.ok(commands.includes("opencode plugin akm-opencode@next --global"));
  assert.ok(!commands.some((command) => /trust|approve|--force/.test(command)));
  const count = commands.length;
  f.manager.start("install-plugin", "codex");
  await f.manager.pending;
  assert.match(f.manager.snapshot().error, /already present/);
  assert.ok(f.calls.slice(count).every((call) => call.args.includes("--version") || call.args.includes("list")));
});

// OpenCode 2 is the same `opencode` program; its major picks the v2 plugin and there is no separate row for it (F2).
test("OpenCode 2 is detected by its version on the one OpenCode row and takes the v2 plugin", async () => {
  const f = await hostFixture({ opencodeVersion: "2.1.4" });
  f.manager.start("check");
  await f.manager.pending;
  assert.deepEqual(
    f.manager.snapshot().harnesses.map((item) => item.id),
    ["claude", "codex", "opencode"],
  );
  const opencode = f.manager.snapshot().harnesses.find((item) => item.id === "opencode");
  assert.equal(opencode.major, 2);
  assert.equal(opencode.plugin.state, "missing");
  f.manager.start("install-plugin", "opencode", "next");
  await f.manager.pending;
  assert.equal(f.manager.snapshot().error, undefined);
  const commands = f.calls.map((call) => [path.basename(call.file), ...call.args].join(" "));
  assert.ok(commands.includes("opencode plugin add akm-opencode-v2@next"));
  const after = f.manager.snapshot().harnesses.find((item) => item.id === "opencode").plugin;
  assert.deepEqual([after.state, after.spec, after.note], ["configured", "akm-opencode-v2@next", undefined]);
});

test("Claude and Codex plugins need Bun, which Desktop shows the official command for and re-detects but never runs", async () => {
  const f = await hostFixture({ bun: false });
  f.manager.start("check");
  await f.manager.pending;
  assert.deepEqual(f.manager.snapshot().bun, {
    id: "bun",
    installed: false,
    installCommand: "curl -fsSL https://bun.sh/install | bash",
  });
  for (const id of ["claude", "codex"]) {
    f.manager.start("install-plugin", id);
    await f.manager.pending;
    assert.match(f.manager.snapshot().error, /Install Bun first/, id);
  }
  // OpenCode installs its own copy of akm and has no Bun hooks, so it is not held back.
  f.manager.start("install-plugin", "opencode");
  await f.manager.pending;
  assert.equal(f.manager.snapshot().error, undefined);
  assert.ok(!f.calls.some((call) => call.args.includes("marketplace")));
  // The person installs Bun and rechecks; the same action then goes through.
  f.installBun();
  f.manager.start("check");
  await f.manager.pending;
  assert.equal(f.manager.snapshot().bun.installed, true);
  f.manager.start("install-plugin", "claude");
  await f.manager.pending;
  assert.equal(f.manager.snapshot().error, undefined);
  assert.ok(!f.calls.some((call) => path.basename(call.file) === "bash" || /bun\.sh/.test(call.args.join(" "))));
});

test("Bun's install command follows the platform", async () => {
  const { bunInstallCommand } = await import("../src/lib/server/features/host-tools.ts");
  assert.match(bunInstallCommand("win32"), /^powershell .*bun\.sh\/install\.ps1/);
  assert.equal(bunInstallCommand("darwin"), bunInstallCommand("linux"));
});

test("OpenCode plugin detection reads config files in the order akm does", async () => {
  const v1 = await hostFixture();
  const v2 = await hostFixture({ opencodeVersion: "2.1.4" });
  const plugin = async (f) => {
    f.manager.start("check");
    await f.manager.pending;
    return f.manager.snapshot().harnesses.find((item) => item.id === "opencode").plugin;
  };
  for (const f of [v1, v2]) {
    const dir = path.join(f.home, ".config/opencode");
    await mkdir(dir, { recursive: true });
    // opencode.jsonc is read before opencode.json; OpenCode 1 stops at the first file that sets the list.
    await writeFile(
      path.join(dir, "opencode.json"),
      JSON.stringify({ plugin: ["akm-opencode@latest"], plugins: ["akm-opencode-v2@next"] }),
    );
    await writeFile(
      path.join(dir, "opencode.jsonc"),
      '// comment\n{ "plugin": ["another-plugin"], "plugins": ["another-plugin"], }',
    );
  }
  assert.equal((await plugin(v1)).state, "missing");
  // OpenCode 2 keeps looking, and does not read OPENCODE_CONFIG.
  assert.equal((await plugin(v2)).spec, "akm-opencode-v2@next");
  const explicit = path.join(v1.home, "explicit.json");
  await writeFile(explicit, JSON.stringify({ plugin: ["akm-opencode"], plugins: ["akm-opencode-v2"] }));
  for (const f of [v1, v2]) {
    await rm(path.join(f.home, ".config/opencode/opencode.json"));
    f.manager.sourceEnv.OPENCODE_CONFIG = explicit;
  }
  assert.equal((await plugin(v1)).spec, "akm-opencode");
  assert.equal((await plugin(v2)).state, "missing");
});

test("a failed native command is not reported as success; its cause is bounded detail, not the user-facing message", async () => {
  const f = await hostFixture({ failure: true });
  f.manager.start("upgrade-cli");
  await f.manager.pending;
  assert.equal(f.manager.snapshot().receipt, undefined);
  const snapshot = f.manager.snapshot();
  assert.match(snapshot.error, /did not complete/);
  assert.ok(!snapshot.error.includes("CAUSE-SENTINEL"), "the message for the person stays generic");
  assert.match(snapshot.errorDetail, /Command failed: akm upgrade/);
  assert.match(snapshot.errorDetail, /CAUSE-SENTINEL/, "the end of stderr is the cause");
  assert.ok(snapshot.errorDetail.length <= 1000, "detail is bounded");
  assert.throws(() => f.manager.start("shell", "rm"), /Invalid/);
  assert.throws(() => f.manager.start("install-plugin", "other"), /Invalid/);
});

test("both installers are told Desktop's exact release tag and the installed version is verified (#1609-1)", async () => {
  for (const platform of ["linux", "win32"]) {
    const f = await hostFixture({ absent: true, desktopVersion: "0.11.261201-beta.1", platform });
    f.manager.start("install-cli");
    await f.manager.pending;
    const installer = f.calls.find((call) => call.file === (platform === "win32" ? "powershell.exe" : "/bin/bash"));
    assert.equal(installer.args.at(-1), "v0.11.261201-beta.1", platform);
    assert.equal(f.manager.snapshot().error, undefined, platform);
    assert.equal(f.manager.snapshot().cli.version, "0.11.261201-beta.1");
  }
  // An installer that put another version in place is not a success.
  const wrong = await hostFixture({
    absent: true,
    desktopVersion: "0.11.261201-beta.1",
    installerVersion: "0.10.261117",
  });
  wrong.manager.start("install-cli");
  await wrong.manager.pending;
  assert.match(wrong.manager.snapshot().error, /0\.10\.261117 in place, not the 0\.11\.261201-beta\.1/);
  assert.equal(wrong.manager.snapshot().receipt, undefined);
});

test("the CLI upgrade asks akm for its target right before it runs and refuses one Desktop cannot read (#1609-3)", async () => {
  const within = (version) => (version === undefined ? undefined : version <= "0.10.261110");
  // No earlier check and no cache: the guard's own check runs first, then the upgrade.
  const ok = await hostFixture({ latestVersion: "0.10.261105" });
  ok.manager.start("upgrade-cli", undefined, undefined, { within });
  await ok.manager.pending;
  const order = ok.calls.filter((call) => call.args[0] === "upgrade").map((call) => call.args.join(" "));
  assert.deepEqual(order.slice(0, 2), ["upgrade --check --format json", "upgrade --format json"]);
  assert.equal(ok.manager.snapshot().error, undefined);
  // The target appeared since the last check: refused, and the mutating command never ran.
  const newer = await hostFixture({ latestVersion: "0.10.261201" });
  newer.manager.start("upgrade-cli", undefined, undefined, { within });
  await newer.manager.pending;
  assert.match(newer.manager.snapshot().error, /Update AKM Desktop first/);
  assert.ok(!newer.calls.some((call) => call.args.join(" ") === "upgrade --format json"));
  // The check itself failed: unverifiable, so refused with guidance and nothing changed.
  const offline = await hostFixture({ checkFails: true });
  offline.manager.start("upgrade-cli", undefined, undefined, { within });
  await offline.manager.pending;
  assert.match(offline.manager.snapshot().error, /nothing was changed/);
  assert.ok(!offline.calls.some((call) => call.args.join(" ") === "upgrade --format json"));
  // A target that is not a version cannot be verified either.
  const odd = await hostFixture({ latestVersion: "soon" });
  odd.manager.start("upgrade-cli", undefined, undefined, { within: () => undefined });
  await odd.manager.pending;
  assert.match(odd.manager.snapshot().error, /could not be verified/);
});

test("a nonzero upgrade keeps akm's redacted result and shows the version actually installed (#1609-6)", async () => {
  const f = await hostFixture({
    upgradeResult: {
      exit: true,
      after: "0.10.261105",
      body: {
        currentVersion: "0.10.261104",
        upgraded: true,
        migration: { status: "blocked", files: ["/home/secret/index.db"], credentials: "TOKEN-SENTINEL" },
        plugins: [
          { harness: "opencode", outcome: "failed", message: "line one\nnpm ERR", backups: ["/home/secret/x.bak"] },
        ],
      },
    },
  });
  f.manager.start("upgrade-cli");
  await f.manager.pending;
  const snapshot = f.manager.snapshot();
  assert.match(snapshot.error, /the migration blocked, the opencode plugin failed/);
  assert.equal(snapshot.cli.version, "0.10.261105", "inventory is refreshed after the partial change");
  assert.equal(snapshot.action.upgrade.migration, "blocked");
  assert.equal(snapshot.receipt, undefined);
  const shown = JSON.stringify(snapshot);
  assert.ok(!shown.includes("TOKEN-SENTINEL") && !shown.includes("/home/secret"), "no raw payloads");
});

test("deferred plugins and a compatibility hold keep their reasons, apart from the check that follows (#1609-7)", async () => {
  const f = await hostFixture({
    upgradeResult: {
      body: {
        currentVersion: "0.10.261104",
        latestVersion: "0.10.261104",
        updateAvailable: false,
        plugins: [{ harness: "opencode", outcome: "deferred", message: "OpenCode is running", backups: ["/secret"] }],
        lockstep: {
          plugin: "akm-opencode",
          pinnedVersion: "0.10.261104",
          newestVersion: "0.10.261105",
          heldBack: true,
        },
      },
    },
  });
  f.manager.start("upgrade-cli");
  await f.manager.pending;
  let snapshot = f.manager.snapshot();
  assert.deepEqual(snapshot.action.upgrade.plugins, [
    { harness: "opencode", outcome: "deferred", reason: "OpenCode is running" },
  ]);
  assert.equal(snapshot.action.upgrade.lockstep.heldBack, true);
  assert.equal(snapshot.command, "akm upgrade --format json", "the check does not replace the action's command");
  assert.match(snapshot.receipt, /upgrade completed/);
  // The follow-up check fails after the action went through: a partial outcome, the receipt stays.
  const g = await hostFixture({
    extra: (args) => {
      if (args.includes("--check") && g.after) throw new Error("offline");
      if (args[0] === "upgrade" && !args.includes("--check")) g.after = true;
      return undefined;
    },
  });
  g.manager.start("upgrade-cli");
  await g.manager.pending;
  snapshot = g.manager.snapshot();
  assert.match(snapshot.receipt, /upgrade completed/);
  assert.match(snapshot.error, /change completed, but checking the result afterwards failed/);
  assert.equal(snapshot.command, "akm upgrade --format json");
});

test("a timed-out parent and its descendants are ended, and no overlapping retry starts until a check (#1609-9)", async (t) => {
  if (process.platform === "win32") return t.skip("process groups are POSIX");
  const dir = await mkdtemp(path.join(os.tmpdir(), "akm-descendant-"));
  temporary.push(dir);
  const marker = path.join(dir, "child-ran");
  // A parent that starts a child which would write the marker after the parent's timeout.
  await assert.rejects(
    runHost("/bin/sh", ["-c", `(sleep 1; echo ran > "${marker}") & sleep 5`], {
      env: process.env,
      home: dir,
      timeout: 200,
    }),
    (error) => error.killed === true && error.code === "ETIMEDOUT",
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await assert.rejects(readFile(marker), { code: "ENOENT" }, "the descendant was ended with its parent");

  let hang = true;
  const f = await hostFixture({
    extra: (args) => {
      if (hang && args[0] === "upgrade" && !args.includes("--check"))
        throw Object.assign(new Error("timed out"), { killed: true, code: "ETIMEDOUT" });
      return undefined;
    },
  });
  f.manager.start("upgrade-cli");
  await f.manager.pending;
  assert.match(f.manager.snapshot().error, /timed out/);
  assert.equal(f.manager.snapshot().unsettled, "upgrade-cli");
  hang = false;
  assert.throws(() => f.manager.start("upgrade-cli"), /may still be running/);
  assert.throws(() => f.manager.start("install-cli"), /may still be running/);
  f.manager.start("check");
  await f.manager.pending;
  assert.equal(f.manager.snapshot().unsettled, undefined);
  f.manager.start("upgrade-cli");
  await f.manager.pending;
  assert.equal(f.manager.snapshot().error, undefined);
});

test("a prerelease choice is not silently dropped when akm-plugins already exists; consent installs from it as it is (#1609-5)", async () => {
  const f = await hostFixture({ marketplace: true });
  f.manager.start("install-plugin", "claude", "next");
  await f.manager.pending;
  const stopped = f.manager.snapshot();
  assert.match(stopped.error, /already set up and keeps the channel/);
  assert.equal(stopped.consent, "claude");
  assert.ok(!f.calls.some((call) => call.args.includes("install") || call.args.includes("add")), "nothing was changed");
  f.manager.start("install-plugin", "claude", "next", { consent: true });
  await f.manager.pending;
  const done = f.manager.snapshot();
  assert.equal(done.error, undefined);
  assert.equal(done.consent, undefined);
  assert.match(done.receipt, /existing akm-plugins marketplace was kept; its channel was not changed/);
  assert.ok(!f.calls.some((call) => call.args.slice(0, 3).join(" ") === "plugin marketplace add"));
  // Stable on an existing marketplace needs no question, and a missing marketplace is added on the chosen channel.
  const stable = await hostFixture({ marketplace: true });
  stable.manager.start("install-plugin", "codex", "latest");
  await stable.manager.pending;
  assert.equal(stable.manager.snapshot().error, undefined);
  const fresh = await hostFixture();
  fresh.manager.start("install-plugin", "claude", "next");
  await fresh.manager.pending;
  assert.ok(fresh.calls.some((call) => call.args.includes("itlackey/akm-plugins@next")));
});

test("the prerelease choice reaches the check and the upgrade, and an explicit channel switch uses akm's own flag (#1609-5)", async () => {
  const f = await hostFixture();
  f.manager.start("check", undefined, "next");
  await f.manager.pending;
  f.manager.start("upgrade-cli", undefined, "next");
  await f.manager.pending;
  f.manager.start("switch-channel", undefined, "next");
  await f.manager.pending;
  const upgrades = f.calls.filter((call) => call.args[0] === "upgrade").map((call) => call.args.join(" "));
  assert.ok(upgrades.includes("upgrade --check --next --quiet --format json"));
  assert.ok(upgrades.includes("upgrade --next --quiet --format json"));
  assert.ok(upgrades.includes("upgrade --channel next --format json"));
  assert.match(f.manager.snapshot().receipt, /switched the CLI and installed plugins to the prerelease channel/);
});

test("a CLI that does not run is repaired only with consent and only where Desktop installed it (#1609-12)", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "akm-repair-"));
  temporary.push(home);
  const target = path.join(home, ".local/bin/akm");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "broken");
  let repaired = false;
  const calls = [];
  const manager = new HostTools({
    home,
    env: { HOME: home, PATH: "/fixture/bin" },
    platform: "linux",
    desktopVersion: "0.10.261117",
    find: async (name) => (name === "akm" ? target : undefined),
    fetcher: async () => ({ ok: true, text: async () => "#!/usr/bin/env bash\n" }),
    run: async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === "--version") {
        if (repaired) return "0.10.261117";
        throw new Error("exec format error");
      }
      if (path.basename(file) === "bash") repaired = true;
      return "{}";
    },
  });
  // An earlier check reported a standalone binary; before that Desktop does not claim the file.
  manager.start("install-cli");
  await manager.pending;
  assert.equal(manager.snapshot().cliManaged, false);
  assert.ok(!calls.some((call) => path.basename(call[0]) === "bash"));
  manager.state.upgrade = { installMethod: "binary" };
  manager.start("install-cli");
  await manager.pending;
  assert.equal(manager.snapshot().cliManaged, true);
  assert.equal(manager.snapshot().consent, "cli");
  assert.match(manager.snapshot().error, /does not run is already in ~\/\.local\/bin/);
  assert.ok(!calls.some((call) => path.basename(call[0]) === "bash"), "nothing was replaced without consent");
  manager.start("install-cli", undefined, undefined, { consent: true });
  await manager.pending;
  assert.equal(manager.snapshot().error, undefined);
  assert.deepEqual(calls.find((call) => path.basename(call[0]) === "bash").slice(2), ["v0.10.261117"]);
  // An akm somewhere else is never replaced, even with consent.
  const other = await hostFixture();
  other.manager.start("install-cli", undefined, undefined, { consent: true });
  await other.manager.pending;
  assert.match(
    other.manager.snapshot().error,
    /\/fixture\/bin\/akm, not as a standalone binary Desktop put in ~\/\.local\/bin/,
  );
  assert.ok(!other.calls.some((call) => path.basename(call.file) === "bash"));
});

test("a link in the install directory is another installer's: never Desktop's to replace, and a non-standalone akm is not managed (#1609-12)", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "akm-link-"));
  temporary.push(home);
  const target = path.join(home, ".local/bin/akm");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(path.join(home, "real-akm"), "elsewhere");
  await symlink(path.join(home, "real-akm"), target);
  const calls = [];
  const manager = new HostTools({
    home,
    env: { HOME: home, PATH: "/fixture/bin" },
    platform: "linux",
    desktopVersion: "0.10.261117",
    find: async (name) => (name === "akm" ? target : undefined),
    fetcher: async () => ({ ok: true, text: async () => "#!/usr/bin/env bash\n" }),
    run: async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === "--version") throw new Error("broken");
      return "{}";
    },
  });
  manager.start("install-cli", undefined, undefined, { consent: true });
  await manager.pending;
  assert.equal(manager.snapshot().cliManaged, false);
  assert.match(manager.snapshot().error, /installer that owns it/);
  assert.ok(!calls.some((call) => path.basename(call[0]) === "bash"));
  // A regular file that akm itself reports as a package-manager install is not Desktop's either.
  const regular = await hostFixture();
  await mkdir(path.join(regular.home, ".local/bin"), { recursive: true });
  await writeFile(path.join(regular.home, ".local/bin/akm"), "x");
  regular.manager.find = async () => path.join(regular.home, ".local/bin/akm");
  regular.manager.state.upgrade = { installMethod: "npm" };
  await regular.manager.inventory(await regular.manager.environment());
  assert.equal(regular.manager.state.cliManaged, false);
  regular.manager.state.upgrade = undefined;
  await regular.manager.inventory(await regular.manager.environment());
  assert.equal(regular.manager.state.cliManaged, false, "not Desktop's until akm reports a standalone binary");
  regular.manager.state.upgrade = { installMethod: "binary" };
  await regular.manager.inventory(await regular.manager.environment());
  assert.equal(regular.manager.state.cliManaged, true);
});

test("a switch checks the target channel afterwards, a timed-out check is not unsettled, output over the cap is, and a new check clears the old action (#1609)", async () => {
  const f = await hostFixture();
  f.manager.start("switch-channel", undefined, "latest");
  await f.manager.pending;
  assert.equal(f.manager.snapshot().error, undefined);
  const last = f.calls
    .filter((call) => call.args[0] === "upgrade")
    .at(-1)
    .args.join(" ");
  assert.equal(last, "upgrade --check --format json");
  f.manager.start("switch-channel", undefined, "next");
  await f.manager.pending;
  assert.equal(
    f.calls
      .filter((call) => call.args[0] === "upgrade")
      .at(-1)
      .args.join(" "),
    "upgrade --check --next --quiet --format json",
  );
  assert.ok(f.manager.snapshot().action);
  f.manager.start("check");
  assert.equal(f.manager.snapshot().action, undefined, "the earlier action's outcome lines go when a new check starts");
  await f.manager.pending;
  let hang = true;
  const g = await hostFixture({
    extra: (args) => {
      if (hang && args.includes("--check"))
        throw Object.assign(new Error("timed out"), { killed: true, code: "ETIMEDOUT" });
      return undefined;
    },
  });
  g.manager.start("check");
  await g.manager.pending;
  assert.equal(g.manager.snapshot().unsettled, undefined, "a read-only check changes nothing, so nothing is unsettled");
  hang = false;
  g.manager.start("upgrade-cli");
  await g.manager.pending;
  assert.equal(g.manager.snapshot().error, undefined);
});

test("output over the cap stops the command and leaves its action unsettled like a timeout (#1609-9)", async (t) => {
  const f = await hostFixture({
    extra: (args) => {
      if (args[0] === "upgrade" && !args.includes("--check"))
        throw Object.assign(new Error("flood"), { killed: true, code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
      return undefined;
    },
  });
  f.manager.start("upgrade-cli");
  await f.manager.pending;
  assert.match(f.manager.snapshot().error, /too much output/);
  assert.equal(f.manager.snapshot().unsettled, "upgrade-cli");
  if (process.platform === "win32") return t.skip("POSIX shell");
  await assert.rejects(
    runHost("/bin/sh", ["-c", "head -c 6000000 /dev/zero | tr '\\0' x"], {
      env: process.env,
      home: os.tmpdir(),
      timeout: 20_000,
    }),
    (error) => error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && error.killed === true,
  );
});

test("the host CLI for scheduled tasks is the one Software detects, and none when it is absent", async () => {
  const present = await hostFixture();
  const cli = await present.manager.cli();
  assert.equal(cli.path, "/fixture/bin/akm");
  assert.equal(cli.env.AKM_LAUNCHER_NODE, undefined);
  assert.equal(await (await hostFixture({ absent: true })).manager.cli(), undefined);
});
