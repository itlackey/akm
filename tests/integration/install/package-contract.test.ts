// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { realNodeExecutable } from "../../_helpers/node-runtime";

/**
 * The package `exports` map: `akm-cli/api` (recall), `akm-cli/workspace`
 * (existing local workspace operations) and `akm-cli/package.json` (plugins resolve it to find the `akm`
 * bin).
 *
 * Classification: spawns a real `npm pack --dry-run`.
 * The end-to-end check that an installed tarball resolves and runs these
 * under Node and Bun is `bun run test:package` (scripts/package-install.ts).
 */

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  exports?: Record<string, unknown>;
  files: string[];
  bin: Record<string, string>;
};

function packed(): Set<string> {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const first = (JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>)[0];
  if (!first) throw new Error("npm pack --json returned no entries");
  return new Set(first.files.map((f) => f.path));
}

describe("package.json exports", () => {
  test("has exactly ./api, ./workspace and ./package.json", () => {
    expect(Object.keys(pkg.exports ?? {}).sort()).toEqual(["./api", "./package.json", "./workspace"]);
    expect(pkg.exports?.["./package.json"]).toBe("./package.json");
  });

  test("./api has a types, a bun and a node-safe default target", () => {
    expect(pkg.exports?.["./api"]).toEqual({
      types: "./dist/api.d.ts",
      bun: "./dist/api.js",
      default: "./dist/api-node.mjs",
    });
  });

  test("./workspace has types, a bun and a node-safe default target", () => {
    expect(pkg.exports?.["./workspace"]).toEqual({
      types: "./dist/workspace.d.ts",
      bun: "./dist/workspace.js",
      default: "./dist/workspace-node.mjs",
    });
  });

  test("bin and the docs page are still shipped", () => {
    expect(pkg.bin).toEqual({ akm: "dist/akm" });
    expect(pkg.files).toContain("dist");
    // `files` may name the page or a folder that holds it.
    const shipsApiPage = (pkg.files as string[]).some(
      (entry) => entry === "docs/reference/api.md" || "docs/reference/api.md".startsWith(`${entry}/`),
    );
    expect(shipsApiPage).toBe(true);
  });

  test("the build inputs for the ./api targets exist", () => {
    for (const file of ["src/api.ts", "scripts/node-runtime/api-node.mjs", "scripts/node-runtime/api.d.ts"]) {
      expect(fs.existsSync(path.join(ROOT, file))).toBe(true);
    }
    const copyAssets = fs.readFileSync(path.join(ROOT, "scripts", "copy-assets.ts"), "utf8");
    expect(copyAssets).toContain("scripts/node-runtime/api-node.mjs");
    expect(copyAssets).toContain("scripts/node-runtime/api.d.ts");
  });

  test("every ./api target and the docs page are in the tarball (once built)", () => {
    const files = packed();
    expect(files.has("docs/reference/api.md")).toBe(true);
    expect(files.has("package.json")).toBe(true);
    // `dist/` is a build output: CI runs `check` before `build`, so only assert
    // the targets when the checkout has been built.
    if (!fs.existsSync(path.join(ROOT, "dist", "api.js"))) return;
    for (const target of ["dist/api.js", "dist/api-node.mjs", "dist/api.d.ts", "dist/text-import-hook.mjs"]) {
      expect(files.has(target)).toBe(true);
    }
    for (const target of ["dist/workspace.js", "dist/workspace-node.mjs", "dist/workspace.d.ts"]) {
      expect(files.has(target)).toBe(true);
    }
  });
});

{
  // Integration: unpacks the real tarball, then spawns both runtimes against isolated storage.

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
        // A Node TypeScript consumer supplies Node's ambient types (the declarations use Buffer).
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
}

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const NPM_SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?((?:[^ \t=]+=[^ \t=]+\s+)*))?([^ \t]+)(.*)$/;

function npmShimInterpreter(source: string): string | undefined {
  return source.trim().split(/\r*\n/, 1)[0]?.match(NPM_SHEBANG)?.[2];
}

function runAsNodeVersion(version: string, program: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    realNodeExecutable(),
    [
      "--input-type=module",
      "--eval",
      `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)}, configurable: true });\n${program}`,
    ],
    { encoding: "utf8", env: { PATH: path.dirname(realNodeExecutable()) } },
  );
}

function launcherFixture(bin: "akm"): { launcher: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-node-runtime-minimum-"));
  const launcher = path.join(root, bin);
  fs.copyFileSync(path.join(REPO_ROOT, "scripts", "node-runtime", bin), launcher);
  fs.writeFileSync(path.join(root, "cli-node.mjs"), 'console.log("NODE_22_LAUNCHER_RAN");\n');
  return { launcher, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("npm bin contract", () => {
  test("uses Node as the single interpreter shared by npm's POSIX and Windows shims", () => {
    const launcher = fs.readFileSync(path.join(REPO_ROOT, "scripts", "node-runtime", "akm"), "utf8");

    // POSIX executes this shebang and npm embeds the same interpreter in its
    // generated Windows shims. It cannot express a Bun-or-Node choice.
    expect(npmShimInterpreter(launcher)).toBe("node");
  });

  test("declares the Node bootstrap required before Bun can be preferred", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      engines?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(pkg.engines).toEqual({ node: ">=22" });
    // npm 12 blocks install scripts by default, so the floor is checked where akm starts (the launchers, the CLI).
    expect(pkg.scripts?.preinstall).toBeUndefined();
    expect(pkg.scripts?.install).toBeUndefined();
    expect(pkg.scripts?.postinstall).toBeUndefined();
  });

  test("published bins select their supported runtime paths after the Node bootstrap", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };

    expect(pkg.bin?.akm).toBe("dist/akm");
    expect(pkg.bin).toEqual({ akm: "dist/akm" });

    const akmLauncher = fs.readFileSync(path.join(REPO_ROOT, "scripts", "node-runtime", "akm"), "utf8");
    expect(akmLauncher.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(akmLauncher).toContain("requires Node.js >= 22 to bootstrap");
    expect(akmLauncher).toContain('new URL("./cli.js", import.meta.url)');
    expect(akmLauncher).toContain('await import("./cli-node.mjs")');

    const wrapper = fs.readFileSync(path.join(REPO_ROOT, "scripts", "node-runtime", "cli-node.mjs"), "utf8");
    expect(wrapper.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, "scripts", "node-runtime", "akm-migrate-storage"))).toBe(false);
    expect(fs.existsSync(path.join(REPO_ROOT, "scripts", "node-runtime", "migrate-storage-node.mjs"))).toBe(false);

    expect(akmLauncher).toContain('"bun", ["--version"]');
    expect(akmLauncher).toContain("bunMajor >= 1");
  });

  test("rejects Node 20 (below the 22 floor) before the published launcher can execute its payload", () => {
    const fixture = launcherFixture("akm");
    try {
      const result = runAsNodeVersion(
        "20.0.0",
        `await import(${JSON.stringify(pathToFileURL(fixture.launcher).href)});`,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("requires Node.js >= 22 to bootstrap");
      expect(result.stdout).not.toContain("NODE_22_LAUNCHER_RAN");
    } finally {
      fixture.cleanup();
    }
  });
});
