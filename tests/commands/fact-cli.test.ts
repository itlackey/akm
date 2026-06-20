// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm fact` CLI — durable stash facts (fact asset type, phase 2).
 *
 * Locks in: `add` writes facts/<category>/<name>.md with the right frontmatter;
 * --category is required; the index round-trip surfaces facts via `list` and
 * the pinned core via `context`.
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
});

describe("akm fact add", () => {
  test("writes facts/<category>/<name>.md with category + pinned frontmatter", async () => {
    const result = await runCli(["fact", "add", "tool-stack", "We use Bun.", "--category", "team", "--pinned"]);
    expect(result.status).toBe(0);
    const env = JSON.parse(result.stdout);
    expect(env.ok).toBe(true);
    expect(env.ref).toBe("fact:team/tool-stack");

    const file = path.join(stashDir, "facts", "team", "tool-stack.md");
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("category: team");
    expect(content).toContain("pinned: true");
    expect(content).toContain("We use Bun.");
  });

  test("requires a --category", async () => {
    const result = await runCli(["fact", "add", "x", "body"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error).toMatch(/category/i);
  });
});

describe("akm fact list / context (index round-trip)", () => {
  test("lists facts and assembles the pinned core", async () => {
    await runCli(["fact", "add", "tool-stack", "We use Bun.", "--category", "team", "--pinned"]);
    await runCli(["fact", "add", "blogs", "Reads simonwillison.net", "--category", "personal"]);
    const indexed = await runCli(["index"]);
    expect(indexed.status).toBe(0);

    const list = await runCli(["fact", "list"]);
    expect(list.status).toBe(0);
    const listEnv = JSON.parse(list.stdout);
    expect(listEnv.facts.map((f: { name: string }) => f.name).sort()).toEqual(["personal/blogs", "team/tool-stack"]);

    const pinned = await runCli(["fact", "list", "--pinned"]);
    const pinnedEnv = JSON.parse(pinned.stdout);
    expect(pinnedEnv.facts.map((f: { name: string }) => f.name)).toEqual(["team/tool-stack"]);

    const context = await runCli(["fact", "context"]);
    const ctxEnv = JSON.parse(context.stdout);
    expect(ctxEnv.count).toBe(1);
    expect(ctxEnv.content).toContain("## Stash facts");
    expect(ctxEnv.content).toContain("We use Bun.");
    // The non-pinned fact must NOT be in the core.
    expect(ctxEnv.content).not.toContain("simonwillison.net");
  });
});
