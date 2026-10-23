// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `env list` and `secret list` show file symlinks (#1237). A file symlink under
 * `env/` or `secrets/` is readable and indexed, so its own list command must
 * show it too. A directory symlink is never descended, and a `.sensitive`
 * marker still suppresses listing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCliStatus as runCli } from "../_helpers/cli";
import { type Cleanup, sandboxStashDir, writeSandboxConfig } from "../_helpers/sandbox";

let stashCleanup: Cleanup = () => {};
let stashDir = "";
let externalDir = "";

beforeEach(() => {
  const stash = sandboxStashDir();
  stashDir = stash.dir;
  stashCleanup = stash.cleanup;
  externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-list-symlinks-"));
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  stashCleanup();
  stashCleanup = () => {};
  fs.rmSync(externalDir, { recursive: true, force: true });
});

function link(kind: "env" | "secrets", name: string, target: string): void {
  const dir = path.join(stashDir, kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(target, path.join(dir, name));
}

describe("env list / secret list with symlinks (#1237)", () => {
  test("env list shows an external file symlink with its keys, not a directory symlink or a sensitive one", async () => {
    const real = path.join(externalDir, "prod.env");
    fs.writeFileSync(real, "API_URL=https://example.test\n");
    link("env", "prod.env", real);
    const dirTarget = path.join(externalDir, "envdir");
    fs.mkdirSync(dirTarget);
    fs.writeFileSync(path.join(dirTarget, "inner.env"), "X=1\n");
    link("env", "linked-dir", dirTarget);
    const hidden = path.join(externalDir, "hidden.env");
    fs.writeFileSync(hidden, "H=1\n");
    link("env", "hidden.env", hidden);
    fs.writeFileSync(path.join(stashDir, "env", "hidden.sensitive"), "");

    const { stdout, status } = await runCli(["env", "list"]);
    expect(status).toBe(0);
    const envs = JSON.parse(stdout).envs as Array<{ ref: string; keys: string[] }>;
    expect(envs.map((e) => e.ref)).toEqual(["env/prod"]);
    expect(envs[0]?.keys).toEqual(["API_URL"]);
  });

  test("secret list shows an external file symlink, not a directory symlink or a dangling one", async () => {
    const real = path.join(externalDir, "token");
    fs.writeFileSync(real, "value");
    link("secrets", "token", real);
    const dirTarget = path.join(externalDir, "secretdir");
    fs.mkdirSync(dirTarget);
    fs.writeFileSync(path.join(dirTarget, "inner"), "v");
    link("secrets", "linked-dir", dirTarget);
    link("secrets", "dangling", path.join(externalDir, "missing"));

    const { stdout, status } = await runCli(["secret", "list"]);
    expect(status).toBe(0);
    const secrets = JSON.parse(stdout).secrets as Array<{ ref: string }>;
    expect(secrets.map((s) => s.ref)).toEqual(["secrets/token"]);
  });
});
