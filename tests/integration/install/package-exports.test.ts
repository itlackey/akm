// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The package `exports` map: `akm-cli/api` (the one supported programmatic
 * entry point), `akm-cli/package.json` (plugins resolve it to find the `akm`
 * bin) and `akm-cli/dist/*` (published `akm-opencode` versions deep-import
 * `akm-cli/dist/commands/read/*.js`).
 *
 * Classification (AGENTS.md ORG-03): spawns a real `npm pack --dry-run`.
 * The end-to-end check that an installed tarball resolves and runs these
 * under Node and Bun is `bun run test:package` (scripts/package-install.ts).
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
  test("has exactly ./api, ./package.json and ./dist/*", () => {
    expect(Object.keys(pkg.exports ?? {}).sort()).toEqual(["./api", "./dist/*", "./package.json"]);
    expect(pkg.exports?.["./package.json"]).toBe("./package.json");
    expect(pkg.exports?.["./dist/*"]).toBe("./dist/*");
  });

  test("./api has a types, a bun and a node-safe default target", () => {
    expect(pkg.exports?.["./api"]).toEqual({
      types: "./dist/api.d.ts",
      bun: "./dist/api.js",
      default: "./dist/api-node.mjs",
    });
  });

  test("bin and the docs page are still shipped", () => {
    expect(pkg.bin).toEqual({ akm: "dist/akm", "akm-migrate": "dist/akm-migrate" });
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("docs/reference/api.md");
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
  });
});
