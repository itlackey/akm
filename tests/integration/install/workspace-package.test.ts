// Integration: unpacks the real tarball, then spawns both runtimes against isolated storage.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../..");

test.skipIf(process.env.AKM_WORKSPACE_PACKAGE_TESTS !== "1")(
  "packed workspace namespace reads and mutates through existing operations under Node and Bun",
  () => {
    if (!fs.existsSync(path.join(ROOT, "dist/workspace.js"))) {
      throw new Error("Build the package before running workspace package acceptance: bun run build");
    }
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "akm-workspace-package-"));
    try {
      const run = (bin: string, args: string[], cwd = scratch, env: NodeJS.ProcessEnv = process.env) =>
        execFileSync(bin, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
      const packed = JSON.parse(
        run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], ROOT),
      ) as Array<{ filename: string }>;
      const tarball = path.join(scratch, packed[0]!.filename);
      const installed = path.join(scratch, "node_modules", "akm-cli");
      fs.mkdirSync(installed, { recursive: true });
      run("tar", ["-xzf", tarball, "--strip-components=1", "-C", installed]);
      // Reuse only dependencies, never checkout AKM code or a live/global installation.
      fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(installed, "node_modules"), "junction");
      // A Node TypeScript consumer supplies Node's ambient types; the generated
      // workspace declarations now expose real Buffer/filesystem helper types.
      fs.symlinkSync(path.join(ROOT, "node_modules/@types"), path.join(scratch, "node_modules/@types"), "junction");
      const fixture = path.join(scratch, "smoke.mjs");
      fs.copyFileSync(path.join(ROOT, "tests/fixtures/workspace-package-smoke.mjs"), fixture);
      const types = path.join(scratch, "types.mts");
      fs.copyFileSync(path.join(ROOT, "tests/fixtures/workspace-package-types.mts"), types);
      run(process.execPath, [
        path.join(ROOT, "node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--target",
        "es2022",
        "--module",
        "nodenext",
        "--moduleResolution",
        "nodenext",
        types,
      ]);
      const node = process.env.AKM_TEST_NODE_BIN ?? Bun.which("node");
      if (!node) throw new Error("Node >=22 is required (set AKM_TEST_NODE_BIN when node on PATH is a Bun shim)");
      for (const [runtime, bin] of [
        ["node", node],
        ["bun", process.execPath],
      ] as const) {
        const home = path.join(scratch, runtime);
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !/^(AKM_|XDG_|HOME$|CODEX_HOME$|CLAUDE_CONFIG_DIR$|OPENCODE_)/.test(key),
          ),
        );
        Object.assign(env, {
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, "xdg-config"),
          XDG_DATA_HOME: path.join(home, "xdg-data"),
          XDG_CACHE_HOME: path.join(home, "xdg-cache"),
          XDG_STATE_HOME: path.join(home, "xdg-state"),
          AKM_CONFIG_DIR: path.join(home, "config"),
          AKM_DATA_DIR: path.join(home, "data"),
          AKM_CACHE_DIR: path.join(home, "cache"),
          AKM_STATE_DIR: path.join(home, "state"),
          AKM_BUNDLE_DIR: path.join(home, "stash"),
          CODEX_HOME: path.join(home, "codex"),
          CLAUDE_CONFIG_DIR: path.join(home, "claude"),
          OPENCODE_TEST_HOME: path.join(home, "opencode"),
        });
        const output = run(bin, [fixture, runtime], scratch, env);
        expect(JSON.parse(output)).toMatchObject({ ok: true, runtime });
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  },
  300_000,
);
