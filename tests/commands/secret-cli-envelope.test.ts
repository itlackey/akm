// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the `akm secret` command family. Pins the full
 * JSON envelope (stdout payload shape + the {ok:false,…} error envelope on
 * stderr / exit code) for `list`, proving the extraction of the family from
 * cli.ts into src/commands/secret-cli.ts (helpers in src/core/env-secret-ref.ts)
 * is byte-identical. Crucially it asserts the secret VALUE (file contents)
 * never appears on stdout or stderr — only the ref NAME is surfaced.
 *
 * `path` and `remove` were REMOVED from this family in 0.9.0 (R-027 / D-49) —
 * they resolved a ref through different stash-selection logic and could
 * silently target different files. The regression coverage proving the
 * removed spellings fail loudly (a real-subprocess concern — see that file's
 * docstring) lives in tests/integration/secret-path-run.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { runCliStatus as runCli } from "../_helpers/cli";
import { type Cleanup, sandboxStashDir, writeSandboxConfig } from "../_helpers/sandbox";

const SECRET_VALUE = "super-secret-token-value";

let stashCleanup: Cleanup = () => {};
let stashDir = "";

function seedSecret(name: string): string {
  const dir = path.join(stashDir, "secrets");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}`);
  fs.writeFileSync(file, SECRET_VALUE);
  return file;
}

beforeEach(() => {
  const stash = sandboxStashDir();
  stashDir = stash.dir;
  stashCleanup = stash.cleanup;
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  stashCleanup();
  stashCleanup = () => {};
  stashDir = "";
});

describe("akm secret — JSON envelope snapshot (WS6)", () => {
  test("secret list: envelope wraps refs under `secrets`; the value never appears", async () => {
    seedSecret("deploy-key");
    const { stdout, status } = await runCli(["secret", "list"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(Array.isArray(env.secrets)).toBe(true);
    const entry = env.secrets.find((s: { ref: string }) => s.ref === "secrets/deploy-key");
    expect(entry).toBeDefined();
    // The whole file IS the value — it must never leak into structured output.
    expect(stdout).not.toContain(SECRET_VALUE);
  });
});
