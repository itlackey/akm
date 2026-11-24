// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Meta-tests for the website secret-resolver composition ratchet.
 *
 * The exact regression matters here: `akm bundle update <website>` composes a
 * provider sync directly. Removing only `secrets: storeSecretResolver` leaves
 * a valid, successful env-only refresh, so the boundary lint must reject that
 * mutation rather than relying solely on the runtime integration test.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { makeSandboxDir } from "../../_helpers/sandbox";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const LINT_SCRIPT = path.join(REPO_ROOT, "scripts", "lint-secret-resolver-boundary.ts");
const UPDATE_COMMAND = path.join(REPO_ROOT, "src", "commands", "sources", "installed-stashes.ts");

function runBoundaryLint(files: Record<string, string>): { exitCode: number; stdout: string; stderr: string } {
  const sandbox = makeSandboxDir("akm-secret-boundary");
  try {
    const script = path.join(sandbox.dir, "scripts", "lint-secret-resolver-boundary.ts");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(LINT_SCRIPT, script);
    for (const [relativePath, contents] of Object.entries(files)) {
      const destination = path.join(sandbox.dir, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, contents, "utf8");
    }

    const result = Bun.spawnSync([process.execPath, script], {
      cwd: sandbox.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  } finally {
    sandbox.cleanup();
  }
}

describe("lint-secret-resolver-boundary", () => {
  test("rejects removing the resolver from the real website provider-sync composition", () => {
    const source = fs.readFileSync(UPDATE_COMMAND, "utf8");
    const resolverBinding = "    secrets: storeSecretResolver,\n";
    expect(source.split(resolverBinding)).toHaveLength(2);

    const result = runBoundaryLint({
      "src/commands/sources/installed-stashes.ts": source.replace(resolverBinding, ""),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("provider.sync");
  });

  test("allows sync callers that do not compose a website mirror and website callers that inject both capabilities", () => {
    const result = runBoundaryLint({
      "src/example.ts": [
        "await gitProvider.sync({ force: true });",
        "await deps.sync();",
        "await websiteProvider.sync({ force: true, secrets: storeSecretResolver, ensureWebsiteMirror });",
      ].join("\n"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("lint-secret-resolver-boundary: OK");
  });
});
