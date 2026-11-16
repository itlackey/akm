// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * akm's own commits leave `env/` and `secrets/` out unless the bundle's config sets `trackSecrets`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { saveGitStash } from "../../../src/sources/providers/git";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

describe("saveGitStash and env/secrets", () => {
  let storage: IsolatedAkmStorage;
  let dir: string;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    dir = storage.stashDir;
    const run = (...args: string[]) => expect(spawnSync("git", ["-C", dir, ...args]).status).toBe(0);
    run("init", "--initial-branch=main");
    run("config", "user.email", "test@akm.local");
    run("config", "user.name", "akm test");
    fs.writeFileSync(path.join(dir, "README.md"), "seed\n");
    run("add", "-A");
    run("commit", "-m", "seed");
    fs.mkdirSync(path.join(dir, "env"), { recursive: true });
    fs.mkdirSync(path.join(dir, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "env", "prod.env"), "TOKEN=synthetic\n");
    fs.writeFileSync(path.join(dir, "secrets", "key"), "synthetic\n");
    fs.writeFileSync(path.join(dir, "note.md"), "note\n");
  });
  afterEach(() => storage.cleanup());

  function committed(): string[] {
    const result = spawnSync("git", ["-C", dir, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" });
    return result.stdout.split("\n").filter(Boolean).sort();
  }

  test("by default the commit leaves env/ and secrets/ out", () => {
    writeSandboxConfig({ defaultBundle: "stash", bundles: { stash: { path: dir, writable: true } } });
    saveGitStash(undefined, "sync", true, { repoDir: dir });
    expect(committed()).toEqual(["note.md"]);
  });

  test("an explicit path list leaves them out too", () => {
    writeSandboxConfig({ defaultBundle: "stash", bundles: { stash: { path: dir, writable: true } } });
    saveGitStash(undefined, "sync", true, { repoDir: dir, paths: ["note.md", "env/prod.env"] });
    expect(committed()).toEqual(["note.md"]);
  });

  test("trackSecrets: true stages them", () => {
    writeSandboxConfig({
      defaultBundle: "stash",
      bundles: { stash: { path: dir, writable: true, trackSecrets: true } },
    });
    saveGitStash(undefined, "sync", true, { repoDir: dir });
    expect(committed()).toEqual(["env/prod.env", "note.md", "secrets/key"]);
  });
});
