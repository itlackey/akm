// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the `akm wiki` command family. Pins the full
 * JSON envelope (stdout payload shape + the {ok:false,…} error envelope on
 * stderr / exit code) for representative subcommands, proving the extraction of
 * the family from cli.ts into src/commands/wiki-cli.ts and the migration of the
 * leaf handlers onto `defineJsonCommand` is byte-identical. Wikis are scaffolded
 * in-process via createWiki() against an isolated stash dir; the CLI reads that
 * stash back through AKM_STASH_DIR via the in-process harness.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { createWiki } from "../../src/wiki/wiki";
import { runCliCapture } from "../_helpers/cli";
import { makeSandboxDir, type SandboxedDir, withEnv } from "../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

function makeStashDir(): string {
  const d = makeSandboxDir("akm-wiki-envelope-");
  disposers.push(d);
  for (const sub of ["lessons", "skills", "memories", "knowledge", "wikis"]) {
    fs.mkdirSync(path.join(d.dir, sub), { recursive: true });
  }
  return d.dir;
}

async function runCli(args: string[], stashDir: string): Promise<{ stdout: string; stderr: string; status: number }> {
  const { code, stdout, stderr } = await withEnv({ AKM_STASH_DIR: stashDir }, () => runCliCapture(args));
  return { stdout, stderr, status: code };
}

describe("akm wiki — JSON envelope snapshot (WS6)", () => {
  test("wiki create: success envelope scaffolds the wiki", async () => {
    const stash = makeStashDir();
    const { stdout, status } = await runCli(["--json", "wiki", "create", "alpha"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.name).toBe("alpha");
    expect(env.ref).toBe("wiki:alpha");
    expect(Array.isArray(env.created)).toBe(true);
    expect(Array.isArray(env.skipped)).toBe(true);
    expect(fs.existsSync(env.path as string)).toBe(true);
  });

  test("wiki list: envelope wraps summaries under `wikis`", async () => {
    const stash = makeStashDir();
    createWiki(stash, "alpha");
    const { stdout, status } = await runCli(["--json", "wiki", "list"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(Array.isArray(env.wikis)).toBe(true);
    const alpha = env.wikis.find((w: { name: string }) => w.name === "alpha");
    expect(alpha).toBeDefined();
    expect(typeof alpha.pages).toBe("number");
    expect(typeof alpha.raws).toBe("number");
  });

  test("wiki show: envelope carries ref + recentLog for an existing wiki", async () => {
    const stash = makeStashDir();
    createWiki(stash, "alpha");
    const { stdout, status } = await runCli(["--json", "wiki", "show", "alpha"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.name).toBe("alpha");
    expect(env.ref).toBe("wiki:alpha");
    expect(Array.isArray(env.recentLog)).toBe(true);
  });

  test("wiki search: missing wiki → byte-identical {ok:false} not-found envelope on stderr", async () => {
    const stash = makeStashDir();
    const { stderr, status } = await runCli(["--json", "wiki", "search", "ghost", "anything"], stash);
    expect(status).toBe(1);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("STASH_NOT_FOUND");
  });

  test("wiki show: missing wiki → {ok:false} not-found envelope on stderr", async () => {
    const stash = makeStashDir();
    const { stderr, status } = await runCli(["--json", "wiki", "show", "ghost"], stash);
    expect(status).toBe(1);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("STASH_NOT_FOUND");
  });
});
