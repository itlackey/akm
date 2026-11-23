// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `scripts/lint-asset-io.ts` counts the code that reads or writes assets outside the adapter layer and holds it to a
 * checked-in baseline that can only shrink. It must pass on the real tree, find each kind of violation in a
 * fixture, fail on a violation the baseline lacks, and fail on a baseline entry that no longer occurs.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { compare, countsOf, scan } from "../../../scripts/lint-asset-io";
import { makeSandboxDir } from "../../_helpers/sandbox";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const IDS = ["akm", "okf", "akm-workflow"];

function violationsIn(files: Record<string, string>) {
  const sandbox = makeSandboxDir("akm-asset-io");
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const destination = path.join(sandbox.dir, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, contents, "utf8");
    }
    return scan(sandbox.dir, IDS).map(([file, rule]) => `${file} ${rule}`);
  } finally {
    sandbox.cleanup();
  }
}

describe("lint-asset-io", () => {
  test("passes on the real source tree: it matches its baseline exactly", () => {
    const result = Bun.spawnSync([process.execPath, path.join(REPO_ROOT, "scripts", "lint-asset-io.ts")], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("finds file I/O, an adapter import and an adapter-id comparison outside the adapter layer", () => {
    expect(
      violationsIn({
        "src/feature/read.ts": 'import fs from "node:fs";\nexport const a = fs.readFileSync("x", "utf8");\n',
        "src/feature/walk.ts": "export const b = walkStashFlat(root);\n",
        "src/feature/adapter.ts":
          'import { akmAdapter } from "../core/adapter/adapters/akm-adapter";\nexport { akmAdapter };\n',
        "src/feature/compare.ts": 'export const c = source.adapterId === "okf";\n',
        "src/feature/switch.ts": 'switch (adapterId) {\n  case "akm":\n    break;\n}\n',
      }).sort(),
    ).toEqual([
      "src/feature/adapter.ts adapter-import",
      "src/feature/compare.ts adapter-id",
      "src/feature/read.ts asset-io",
      "src/feature/switch.ts adapter-id",
      "src/feature/walk.ts asset-io",
    ]);
  });

  test("lets through the adapter layer, allowed paths, exempt lines, the contract imports, and ids compared with nothing about an adapter", () => {
    expect(
      violationsIn({
        "src/core/adapter/adapters/x.ts": 'import fs from "node:fs";\nexport const a = fs.readFileSync("x");\n',
        "src/core/assets/read.ts":
          'import { akmAdapter } from "../adapter/adapters/akm-adapter";\nexport const a = akmAdapter;\n',
        "src/storage/db.ts": 'import fs from "node:fs";\nexport const a = fs.readFileSync("x");\n',
        "src/feature/exempt.ts":
          'import fs from "node:fs";\nexport const a = fs.readFileSync(p); // asset-io: user-supplied input\n// asset-io: run state\nexport const b = fs.writeFileSync(q, "");\n',
        "src/feature/contract.ts":
          'import type { BundleAdapter } from "../core/adapter/bundle-adapter";\nimport type { Bundle } from "../core/adapter/types";\nexport type T = [BundleAdapter, Bundle];\n',
        "src/feature/platform.ts": 'export const p = runner.platform === "okf";\n',
      }),
    ).toEqual([]);
  });

  test("an exemption needs its reason", () => {
    expect(
      violationsIn({
        "src/feature/bare.ts": 'import fs from "node:fs";\nexport const a = fs.readFileSync(p); // asset-io:\n',
      }),
    ).toEqual(["src/feature/bare.ts asset-io"]);
  });

  test("a baseline that matches passes; a new violation and a stale entry each fail", () => {
    const found = countsOf([
      ["src/a.ts", "asset-io", 3],
      ["src/a.ts", "asset-io", 9],
      ["src/b.ts", "adapter-import", 1],
    ]);
    expect(found).toEqual({ "src/a.ts": { "asset-io": 2 }, "src/b.ts": { "adapter-import": 1 } });

    expect(compare(found, found)).toEqual({ added: [], stale: [] });

    // A violation the baseline lacks: a new file, a new rule in a known file, one more in a known file.
    expect(compare(found, { "src/a.ts": { "asset-io": 2 } }).added).toEqual(["src/b.ts: adapter-import 0 -> 1"]);
    expect(compare(found, { "src/a.ts": { "asset-io": 1 }, "src/b.ts": { "adapter-import": 1 } }).added).toEqual([
      "src/a.ts: asset-io 1 -> 2",
    ]);

    // A baseline entry that no longer occurs: a gone file, or a count that shrank.
    expect(compare(found, { ...found, "src/gone.ts": { "adapter-id": 1 } }).stale).toEqual([
      "src/gone.ts: adapter-id 1 -> 0",
    ]);
    expect(compare(found, { "src/a.ts": { "asset-io": 5 }, "src/b.ts": { "adapter-import": 1 } }).stale).toEqual([
      "src/a.ts: asset-io 5 -> 2",
    ]);
  });
});
