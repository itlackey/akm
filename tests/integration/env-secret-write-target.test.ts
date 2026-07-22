// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * env/secret WRITE-target routing parity (owner ruling: env/secret mutations
 * adopt the canonical write-target selection every other write command shares).
 *
 * Locks in:
 *  - explicit `--target <source>` routes the write to the named source (not the
 *    working stash) and spells the qualified `bundle//…` ref;
 *  - `defaultWriteTarget` is the fallback when no `--target` is given;
 *  - a non-writable `--target` fails fast with the shared ConfigError shape
 *    (exit 78) and writes nothing;
 *  - a git-backed writable target lands the mutation through a single boundary
 *    commit (working tree clean afterwards);
 *  - the security invariants survive: files are mode 0600 and the value never
 *    appears in stdout/stderr regardless of the chosen target.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getCachePaths, parseGitRepoUrl } from "../../src/sources/providers/git";
import { runCliCapture } from "../_helpers/cli";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../_helpers/sandbox";

const SECRET_VALUE = "route-me-do-not-leak";

let storage: IsolatedAkmStorage;
let extra: SandboxedDir[] = [];

function bundleDir(): string {
  const d = makeSandboxDir("akm-wt-bundle");
  extra.push(d);
  return d.dir;
}

function valueFile(): string {
  const p = path.join(storage.root, "value.txt");
  fs.writeFileSync(p, SECRET_VALUE);
  return p;
}

function mode(p: string): string {
  return (fs.statSync(p).mode & 0o777).toString(8);
}

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  extra = [];
});

afterEach(() => {
  for (const e of extra) e.cleanup();
  storage.cleanup();
});

describe("env/secret write-target routing", () => {
  test("explicit --target routes an env write to the named source and never leaks the value", async () => {
    const team = bundleDir();
    writeSandboxConfig({
      bundles: { stash: { path: storage.stashDir }, team: { path: team } },
      defaultBundle: "stash",
    });

    const res = await runCliCapture([
      "env",
      "set",
      "prod",
      "API_TOKEN",
      "--from-file",
      valueFile(),
      "--target",
      "team",
      "--format",
      "json",
    ]);

    expect(res.code).toBe(0);
    const teamEnv = path.join(team, "env", "prod.env");
    // Landed in the named target, NOT the working stash.
    expect(fs.existsSync(teamEnv)).toBe(true);
    expect(fs.existsSync(path.join(storage.stashDir, "env", "prod.env"))).toBe(false);
    // Output ref is qualified with the non-default bundle.
    expect(JSON.parse(res.stdout).ref).toBe("team//env/prod");
    // Security invariants: 0600 mode, value never surfaced.
    expect(mode(teamEnv)).toBe("600");
    expect(fs.readFileSync(teamEnv, "utf8")).toContain(SECRET_VALUE);
    expect(res.stdout).not.toContain(SECRET_VALUE);
    expect(res.stderr).not.toContain(SECRET_VALUE);
  });

  test("defaultWriteTarget is the fallback destination for a secret write without --target", async () => {
    const team = bundleDir();
    writeSandboxConfig({
      bundles: { stash: { path: storage.stashDir }, team: { path: team } },
      defaultBundle: "stash",
      defaultWriteTarget: "team",
    });

    const res = await runCliCapture(["secret", "set", "deploy-key", "--from-file", valueFile(), "--format", "json"]);

    expect(res.code).toBe(0);
    const teamSecret = path.join(team, "secrets", "deploy-key");
    expect(fs.existsSync(teamSecret)).toBe(true);
    expect(fs.existsSync(path.join(storage.stashDir, "secrets", "deploy-key"))).toBe(false);
    expect(JSON.parse(res.stdout).ref).toBe("team//secrets/deploy-key");
    expect(mode(teamSecret)).toBe("600");
    expect(res.stdout).not.toContain(SECRET_VALUE);
    expect(res.stderr).not.toContain(SECRET_VALUE);
  });

  test("no --target and no defaultWriteTarget writes to the working stash (unchanged default)", async () => {
    writeSandboxConfig({ bundles: { stash: { path: storage.stashDir } }, defaultBundle: "stash" });

    const res = await runCliCapture([
      "env",
      "set",
      "prod",
      "API_TOKEN",
      "--from-file",
      valueFile(),
      "--format",
      "json",
    ]);

    expect(res.code).toBe(0);
    expect(fs.existsSync(path.join(storage.stashDir, "env", "prod.env"))).toBe(true);
    // Bare (unqualified) ref for the primary stash.
    expect(JSON.parse(res.stdout).ref).toBe("env/prod");
  });

  test("a non-writable --target fails fast with the shared ConfigError and writes nothing", async () => {
    const ro = bundleDir();
    writeSandboxConfig({
      bundles: { stash: { path: storage.stashDir }, ro: { path: ro, writable: false } },
      defaultBundle: "stash",
    });

    const res = await runCliCapture([
      "env",
      "set",
      "prod",
      "API_TOKEN",
      "--from-file",
      valueFile(),
      "--target",
      "ro",
      "--format",
      "json",
    ]);

    expect(res.code).toBe(78);
    expect(JSON.parse(res.stderr).error).toMatch(/not writable/i);
    expect(fs.existsSync(path.join(ro, "env", "prod.env"))).toBe(false);
  });

  test("a git-backed writable target lands the write through a single boundary commit", async () => {
    const url = "https://example.com/akm/env-secret-write-target.git";
    const repo = getCachePaths(parseGitRepoUrl(url).canonicalUrl).repoDir;
    const content = path.join(repo, "content");
    fs.mkdirSync(content, { recursive: true });
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "test@akm.local"]);
    git(repo, ["config", "user.name", "akm-test"]);
    fs.writeFileSync(path.join(content, "README.md"), "seed\n", "utf8");
    git(repo, ["add", "--", "content/README.md"]);
    git(repo, ["commit", "-m", "initial"]);

    writeSandboxConfig({
      bundles: { stash: { path: storage.stashDir }, team: { git: url, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "team",
    });

    const res = await runCliCapture([
      "env",
      "set",
      "prod",
      "API_TOKEN",
      "--from-file",
      valueFile(),
      "--format",
      "json",
    ]);

    expect(res.code).toBe(0);
    // Exactly one boundary commit was added and the tree is clean.
    expect(git(repo, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    const envPath = path.join(content, "env", "prod.env");
    expect(fs.existsSync(envPath)).toBe(true);
    expect(mode(envPath)).toBe("600");
    // The committed content carries the value but stdout/stderr never do.
    expect(git(repo, ["show", "HEAD:content/env/prod.env"])).toContain(SECRET_VALUE);
    expect(res.stdout).not.toContain(SECRET_VALUE);
    expect(res.stderr).not.toContain(SECRET_VALUE);
  });
});
