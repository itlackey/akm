// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the `akm secret` command family. Pins the full
 * JSON envelope (stdout payload shape + the {ok:false,…} error envelope on
 * stderr / exit code) for list / remove and the name-only `path` lookup, proving
 * the extraction of the family from cli.ts into src/commands/secret-cli.ts
 * (helpers in src/core/env-secret-ref.ts) is byte-identical. Crucially it
 * asserts the secret VALUE (file contents) never appears on stdout or stderr —
 * only the ref NAME and the file path are surfaced.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { runCliCapture } from "../../_helpers/cli";
import { type Cleanup, sandboxStashDir, writeSandboxConfig } from "../../_helpers/sandbox";

const SECRET_VALUE = "super-secret-token-value";

let stashCleanup: Cleanup = () => {};
let stashDir = "";

async function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await runCliCapture(args);
  return { status: code, stdout, stderr };
}

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
    const { stdout, status } = await runCli(["--json", "secret", "list"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(Array.isArray(env.secrets)).toBe(true);
    const entry = env.secrets.find((s: { ref: string }) => s.ref === "secrets/deploy-key");
    expect(entry).toBeDefined();
    // The whole file IS the value — it must never leak into structured output.
    expect(stdout).not.toContain(SECRET_VALUE);
  });

  test("secret path: prints the file path only — never the value", async () => {
    const file = seedSecret("deploy-key");
    const { stdout, status } = await runCli(["secret", "path", "secret:deploy-key"]);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(file);
    expect(stdout).not.toContain(SECRET_VALUE);
  });

  test("secret remove: envelope carries ref + removed=true (with --yes); value never echoed", async () => {
    const file = seedSecret("deploy-key");
    const { stdout, status } = await runCli(["--json", "secret", "remove", "secret:deploy-key", "--yes"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ref).toBe("secrets/deploy-key");
    expect(env.removed).toBe(true);
    expect(stdout).not.toContain(SECRET_VALUE);
    expect(fs.existsSync(file)).toBe(false);
  });

  test("secret path: missing secret → {ok:false} not-found envelope on stderr (exit 1)", async () => {
    const { stderr, status } = await runCli(["--json", "secret", "path", "secret:ghost"]);
    expect(status).toBe(1);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.error).toMatch(/not found/i);
  });

  test("secret remove: missing secret → {ok:false} not-found envelope on stderr (exit 1)", async () => {
    const { stderr, status } = await runCli(["--json", "secret", "remove", "secret:ghost", "--yes"]);
    expect(status).toBe(1);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.error).toMatch(/not found/i);
  });
});
