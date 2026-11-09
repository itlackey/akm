// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { shouldBypassConfigStartup } from "../../src/cli";
import { getConfigPath } from "../../src/core/paths";
import { assertSetupConfigPreflight, runSetupWithDefaults } from "../../src/setup/setup";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  sandboxHome,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";

let cleanup: Cleanup | undefined;

beforeEach(() => {
  const home = sandboxHome();
  const config = sandboxXdgConfigHome(home.cleanup);
  const cache = sandboxXdgCacheHome(config.cleanup);
  cleanup = sandboxXdgDataHome(cache.cleanup).cleanup;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe("raw recovery startup", () => {
  test("path and migrate/setup forwarders bypass normal config startup", () => {
    for (const args of [
      ["bun", "cli.ts", "migrate", "status"],
      ["bun", "cli.ts", "config", "path"],
      ["bun", "cli.ts", "setup"],
      ["bun", "cli.ts", "workflow", "--help"],
    ]) {
      expect(shouldBypassConfigStartup(args)).toBe(true);
    }
  });

  test("help and version config bypass ignores child flags after `--`", () => {
    expect(shouldBypassConfigStartup(["bun", "cli.ts", "env", "run", "env/prod", "--", "tool", "--help"])).toBe(false);
    expect(
      shouldBypassConfigStartup(["bun", "cli.ts", "secret", "run", "secrets/token", "TOKEN", "--", "tool", "-v"]),
    ).toBe(false);
  });

  test("top-level migrate status is wired through the real CLI process", async () => {
    // A key akm no longer reads is dropped by `apply`, so `status` reports the config step as ready and writes nothing.
    const stash = path.join(process.env.HOME as string, "migrate-source");
    fs.mkdirSync(stash, { recursive: true });
    const config = `${JSON.stringify({
      bundles: { primary: { path: stash, writable: true } },
      defaultBundle: "primary",
      retiredKeyForTest: true,
    })}\n`;
    fs.writeFileSync(getConfigPath(), config);

    const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "status"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ status: "ready", configFile: { changed: true } });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(config);
  });

  test("setup rejects a config that fails to load before creating the stash or backup", async () => {
    // A schema-invalid field is what makes the config fail to load.
    fs.writeFileSync(getConfigPath(), '{"bundles":{"primary":{"path":42,"writable":true}}}\n');
    const stash = path.join(process.env.HOME as string, "akm");
    expect(() => assertSetupConfigPreflight()).toThrow(/`akm setup` cannot run/);
    await expect(runSetupWithDefaults({ noInit: false })).rejects.toThrow(/`akm setup` cannot run/);
    expect(fs.existsSync(stash)).toBe(false);
    expect(fs.existsSync(path.join(process.env.XDG_CACHE_HOME as string, "akm", "migration-backups"))).toBe(false);
  });
});

describe("locked config mutation", () => {
  test("concurrent config set processes preserve every independent connection", async () => {
    const first = await runCliCapture([
      "config",
      "set",
      "--silent",
      "connections.seed",
      '{"endpoint":"http://localhost:1/v1","models":{"fast":"seed"}}',
    ]);
    expect(first.code).toBe(0);
    const env = { ...process.env };
    const children = Array.from({ length: 8 }, (_, index) =>
      Bun.spawn(
        [
          "bun",
          "src/cli.ts",
          "config",
          "set",
          "--silent",
          `connections.worker-${index}`,
          JSON.stringify({
            endpoint: `http://localhost:${8100 + index}/v1`,
            models: { fast: `model-${index}` },
          }),
        ],
        { cwd: path.resolve(import.meta.dir, "../.."), env, stdout: "pipe", stderr: "pipe" },
      ),
    );
    const exits = await Promise.all(children.map((child) => child.exited));
    expect(exits).toEqual(new Array(8).fill(0));
    const written = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as { connections: Record<string, unknown> };
    expect(Object.keys(written.connections).sort()).toEqual([
      "seed",
      "worker-0",
      "worker-1",
      "worker-2",
      "worker-3",
      "worker-4",
      "worker-5",
      "worker-6",
      "worker-7",
    ]);
  }, 20_000);

  test("unset against absent config is a true no-op", async () => {
    const result = await runCliCapture(["config", "unset", "--silent", "embedding"]);
    expect(result.code).toBe(0);
    expect(fs.existsSync(getConfigPath())).toBe(false);
  });

  test("different config-mutating commands preserve each other's concurrent updates", async () => {
    const env = { ...process.env };
    // #37: setup runs FIRST, sequentially. Setup and `akm add` both write the
    // `bundles` field now, so running them concurrently is a GENUINE
    // same-field conflict the precommit layer rejects by design (fail-closed,
    // "rerun setup") rather than silently losing an update. The concurrency
    // pin below covers writers of three DIFFERENT fields.
    const setup = Bun.spawn(["bun", "src/cli.ts", "setup", "--yes", "--no-init", "--format", "json"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await setup.exited).toBe(0);

    const commands = [
      ["config", "set", "--silent", "output.detail", "full"],
      ["registry", "add", "https://registry-one.example/index.json", "--name", "registry-one"],
      ["bundle", "add", "https://source-one.example", "--provider", "website", "--name", "source-one"],
    ];
    const children = commands.map((args) =>
      Bun.spawn(["bun", "src/cli.ts", ...args], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const exits = await Promise.all(children.map((child) => child.exited));
    const errors = await Promise.all(children.map((child) => new Response(child.stderr).text()));
    expect(exits, errors.join("\n")).toEqual(new Array(commands.length).fill(0));

    const written = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as {
      output: { detail: string };
      registries: Array<{ name?: string }>;
      bundles: Record<string, { website?: { url?: string } }>;
    };
    expect(written.output.detail).toBe("full");
    expect(written.registries.some((registry) => registry.name === "registry-one")).toBe(true);
    // #37: `akm add` writes a bundles entry keyed by the --name.
    expect(written.bundles["source-one"]?.website?.url).toBeDefined();
  }, 20_000);
});
