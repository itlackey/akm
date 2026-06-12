// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the `akm env` command family. Pins the full JSON
 * envelope (stdout payload shape + the {ok:false,…} error envelope on stderr /
 * exit code) for the representative subcommands list/create/set/unset/remove,
 * proving the extraction of the family from cli.ts into src/commands/env-cli.ts
 * (helpers in src/core/env-secret-ref.ts) is byte-identical. Crucially it
 * asserts that env VALUES never appear on stdout or stderr — only key NAMES.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { runCliCapture } from "../_helpers/cli";
import { type Cleanup, sandboxStashDir, writeSandboxConfig } from "../_helpers/sandbox";

let stashCleanup: Cleanup = () => {};
let stashDir = "";

async function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await runCliCapture(args);
  return { status: code, stdout, stderr };
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
  delete process.env.AKM_TEST_ENV_VALUE;
});

describe("akm env — JSON envelope snapshot (WS6)", () => {
  test("env create: success envelope carries the env ref", async () => {
    const { stdout, status } = await runCli(["--json", "env", "create", "prod"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ref).toBe("env:prod");
    expect(fs.existsSync(path.join(stashDir, "env", "prod.env"))).toBe(true);
  });

  test("env list: envelope wraps entries under `envs` with key NAMES but no values", async () => {
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "API_URL=https://example\nTOKEN=topsecret-value\n");
    const { stdout, status } = await runCli(["--json", "env", "list"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(Array.isArray(env.envs)).toBe(true);
    const prod = env.envs.find((e: { ref: string }) => e.ref === "env:prod");
    expect(prod).toBeDefined();
    expect(prod.keys).toEqual(["API_URL", "TOKEN"]);
    // VALUE must never appear in structured output.
    expect(stdout).not.toContain("topsecret-value");
    expect(stdout).not.toContain("https://example");
  });

  test("env set: envelope carries ref + key; value never echoed", async () => {
    process.env.AKM_TEST_ENV_VALUE = "topsecret-value";
    const { stdout, stderr, status } = await runCli([
      "--json",
      "env",
      "set",
      "env:prod",
      "API_TOKEN",
      "--from-env",
      "AKM_TEST_ENV_VALUE",
    ]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ref).toBe("env:prod");
    expect(env.key).toBe("API_TOKEN");
    expect(stdout).not.toContain("topsecret-value");
    expect(stderr).not.toContain("topsecret-value");
  });

  test("env unset: envelope reports removed/missing; --format value never leaks into keys", async () => {
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "# cfg\nDEBUG=secret-debug\nKEEP=yes\n");
    const { stdout, status } = await runCli(["env", "unset", "env:prod", "DEBUG", "NOPE", "--format", "json"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ref).toBe("env:prod");
    expect(env.removed).toEqual(["DEBUG"]);
    expect(env.missing).toEqual(["NOPE"]);
    expect(stdout).not.toContain("secret-debug");
  });

  test("env remove: envelope carries ref + removed=true (with --yes)", async () => {
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "TOKEN=topsecret-value\n");
    const { stdout, status } = await runCli(["--json", "env", "remove", "env:prod", "--yes"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ref).toBe("env:prod");
    expect(env.removed).toBe(true);
    expect(stdout).not.toContain("topsecret-value");
    expect(fs.existsSync(path.join(stashDir, "env", "prod.env"))).toBe(false);
  });

  test("env set: invalid key → {ok:false} usage envelope on stderr (exit 2)", async () => {
    process.env.AKM_TEST_ENV_VALUE = "x";
    const { stderr, status } = await runCli([
      "--json",
      "env",
      "set",
      "env:prod",
      "bad-key!",
      "--from-env",
      "AKM_TEST_ENV_VALUE",
    ]);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.error).toMatch(/Invalid env key/);
  });
});
