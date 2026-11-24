// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `src/core/stdio.ts` is the only place that names `process.stdout`, `process.stderr` or `process.stdin`.
 * On Bun, reading any of them puts an inherited pipe into non-blocking mode, so a stray read at startup loses a
 * child program's output. The lint must pass on the real tree and fail on each way of reaching a stream.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { makeSandboxDir } from "../_helpers/sandbox";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const LINT_SCRIPT = path.join(REPO_ROOT, "scripts", "lint-stdio-owner.ts");

function runLint(files: Record<string, string>): { exitCode: number; stderr: string } {
  const sandbox = makeSandboxDir("akm-stdio-owner");
  try {
    const script = path.join(sandbox.dir, "scripts", "lint-stdio-owner.ts");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(LINT_SCRIPT, script);
    fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(sandbox.dir, "node_modules"));
    for (const [relativePath, contents] of Object.entries(files)) {
      const destination = path.join(sandbox.dir, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, contents, "utf8");
    }
    const result = Bun.spawnSync([process.execPath, script], { cwd: sandbox.dir, stdout: "pipe", stderr: "pipe" });
    return { exitCode: result.exitCode, stderr: new TextDecoder().decode(result.stderr) };
  } finally {
    sandbox.cleanup();
  }
}

describe("lint-stdio-owner", () => {
  test("passes on the real source tree", () => {
    const result = Bun.spawnSync([process.execPath, LINT_SCRIPT], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
  });

  const reaches: Array<[string, string]> = [
    ["a stream read", "export const tty = process.stdout.isTTY;\n"],
    ["a write", 'process.stderr.write("x");\n'],
    ["a stdin read", "export const input = process.stdin;\n"],
    ["a bracket access", 'export const out = process["stdout"];\n'],
    ["a destructuring", "const { stderr } = process;\nexport default stderr;\n"],
    ["a template expression", "export const s = `${process.stdout.isTTY}`;\n"],
  ];
  for (const [name, source] of reaches) {
    test(`rejects ${name} outside stdio.ts`, () => {
      const result = runLint({ "src/other/feature.ts": source });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("src/other/feature.ts");
    });
  }

  test("ignores comments, strings and the owner itself", () => {
    const result = runLint({
      "src/core/stdio.ts": "export const a = process.stdout;\n",
      "src/other/feature.ts": '// process.stdout\nexport const s = "process.stderr";\n',
    });
    expect(result.exitCode).toBe(0);
  });
});
