// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { HostTools, hostEnvironment, summarizeUpgrade } from "../src/lib/server/features/host-tools.ts";

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
      AKM_CONFIG_DIR: "/test-config",
    },
    home,
  );
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.AKM_LAUNCHER_NODE, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.AKM_DESKTOP_SESSION_TOKEN, undefined);
  assert.equal(env.AKM_CONFIG_DIR, "/test-config");
  assert.ok(env.PATH.includes(path.join(home, ".local/bin")));
  assert.ok(env.PATH.includes(path.join(home, ".nvm/versions/node/v24.18.0/bin")));
  assert.ok(!env.PATH.split(":").includes("."));
});

async function hostFixture({ absent = false, failure = false } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "akm-host-test-"));
  temporary.push(home);
  const calls = [],
    installed = new Set(),
    configured = new Set();
  let cli = !absent;
  const env = { HOME: home, PATH: "/fixture/bin", XDG_CONFIG_HOME: path.join(home, ".config") };
  const manager = new HostTools({
    home,
    env,
    platform: "linux",
    find: async (name) => (name === "akm" && !cli ? undefined : `/fixture/bin/${name}`),
    fetcher: async (url) => {
      assert.equal(url, "https://github.com/itlackey/akm/releases/latest/download/install.sh");
      return { ok: true, text: async () => "#!/usr/bin/env bash\n# fixture; never executed\n" };
    },
    run: async (file, args, options) => {
      assert.equal(options.home, home);
      assert.equal(options.env.AKM_LAUNCHER_NODE, undefined);
      calls.push({ file, args });
      const name = path.basename(file);
      if (args[0] === "--version")
        return name.startsWith("opencode") ? (name === "opencode2" ? "2.1.4" : "1.18.34") : "0.10.261104";
      if (name === "akm") {
        if (failure && !args.includes("--check"))
          throw Object.assign(new Error("Command failed: akm upgrade"), {
            code: 1,
            stderr: `${"x".repeat(900)}CAUSE-SENTINEL\n`,
          });
        return JSON.stringify({
          currentVersion: "0.10.261104",
          latestVersion: "0.10.261105",
          updateAvailable: true,
          plugins: [],
          migration: { status: "current" },
        });
      }
      if (name === "bash") {
        cli = true;
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
      if (name.startsWith("opencode")) {
        const configDir = path.join(home, ".config/opencode");
        await mkdir(configDir, { recursive: true });
        let config = {};
        try {
          config = JSON.parse(await readFile(path.join(configDir, "opencode.json"), "utf8"));
        } catch {}
        config[name === "opencode2" ? "plugins" : "plugin"] = [args[name === "opencode2" ? 2 : 1]];
        await writeFile(path.join(configDir, "opencode.json"), JSON.stringify(config));
      } else installed.add(name);
      return "{}";
    },
  });
  return { manager, home, calls, installed, configured };
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
});

test("missing CLI uses official user-local installer and verifies the result", async () => {
  const f = await hostFixture({ absent: true });
  f.manager.start("install-cli");
  await f.manager.pending;
  assert.equal(f.manager.snapshot().error, undefined);
  assert.equal(f.manager.snapshot().cli.runnable, true);
  assert.match(f.manager.snapshot().receipt, /installed in ~\/.local\/bin/);
  assert.equal(f.calls.filter((call) => call.file === "/bin/bash").length, 1);
  f.manager.start("install-cli");
  await f.manager.pending;
  assert.match(f.manager.snapshot().error, /existing CLI/);
});

test("all four harness paths use standard native installation commands and verify afterward", async () => {
  const f = await hostFixture();
  for (const id of ["claude", "codex", "opencode", "opencode2"]) {
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
  assert.ok(commands.includes("opencode2 plugin add akm-opencode-v2@next"));
  assert.ok(!commands.some((command) => /trust|approve|--force/.test(command)));
  const count = commands.length;
  f.manager.start("install-plugin", "codex");
  await f.manager.pending;
  assert.match(f.manager.snapshot().error, /already present/);
  assert.ok(f.calls.slice(count).every((call) => call.args.includes("--version") || call.args.includes("list")));
});

test("OpenCode plugin detection reads config files in the order akm does", async () => {
  const f = await hostFixture();
  const dir = path.join(f.home, ".config/opencode");
  await mkdir(dir, { recursive: true });
  const plugin = async (id) => {
    f.manager.start("check");
    await f.manager.pending;
    return f.manager.snapshot().harnesses.find((item) => item.id === id).plugin;
  };
  // opencode.jsonc is read before opencode.json; OpenCode 1 stops at the first file that sets the list.
  await writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({ plugin: ["akm-opencode@latest"], plugins: ["akm-opencode-v2@next"] }),
  );
  await writeFile(
    path.join(dir, "opencode.jsonc"),
    '// comment\n{ "plugin": ["another-plugin"], "plugins": ["another-plugin"], }',
  );
  assert.equal((await plugin("opencode")).state, "missing");
  // OpenCode 2 keeps looking, and does not read OPENCODE_CONFIG.
  assert.equal((await plugin("opencode2")).spec, "akm-opencode-v2@next");
  await rm(path.join(dir, "opencode.json"));
  const explicit = path.join(f.home, "explicit.json");
  await writeFile(explicit, JSON.stringify({ plugin: ["akm-opencode"], plugins: ["akm-opencode-v2"] }));
  f.manager.sourceEnv.OPENCODE_CONFIG = explicit;
  assert.equal((await plugin("opencode")).spec, "akm-opencode");
  assert.equal((await plugin("opencode2")).state, "missing");
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
