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
