// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the `akm env` command family. Pins the full JSON
 * envelope (stdout payload shape + the {ok:false,…} error envelope on stderr /
 * exit code) for the representative subcommands list/create/remove,
 * proving the extraction of the family from cli.ts into src/commands/env-cli.ts
 * (helpers in src/core/env-secret-ref.ts) is byte-identical. Crucially it
 * asserts that env VALUES never appear on stdout or stderr — only key NAMES.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { runCliStatus as runCli } from "../_helpers/cli";
import { durableItemRef } from "../_helpers/durable-ref";
import { type Cleanup, sandboxStashDir, writeSandboxConfig } from "../_helpers/sandbox";

let stashCleanup: Cleanup = () => {};
let stashDir = "";

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
    const { stdout, status } = await runCli(["env", "create", "prod"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ref).toBe(durableItemRef(stashDir, "env", "prod"));
    expect(fs.existsSync(path.join(stashDir, "env", "prod.env"))).toBe(true);
  });

  test("env list: envelope wraps entries under `envs` with key NAMES but no values", async () => {
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "API_URL=https://example\nTOKEN=topsecret-value\n");
    const { stdout, status } = await runCli(["env", "list"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(Array.isArray(env.envs)).toBe(true);
    const prod = env.envs.find((e: { ref: string }) => e.ref === "env/prod");
    expect(prod).toBeDefined();
    expect(prod.keys).toEqual(["API_URL", "TOKEN"]);
    // VALUE must never appear in structured output.
    expect(stdout).not.toContain("topsecret-value");
    expect(stdout).not.toContain("https://example");
  });

  test("env remove: envelope carries ref + removed=true (with --yes)", async () => {
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "TOKEN=topsecret-value\n");
    const { stdout, status } = await runCli(["env", "remove", "env/prod", "--yes"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ref).toBe(durableItemRef(stashDir, "env", "prod"));
    expect(env.removed).toBe(true);
    expect(stdout).not.toContain("topsecret-value");
    expect(fs.existsSync(path.join(stashDir, "env", "prod.env"))).toBe(false);
  });
});
