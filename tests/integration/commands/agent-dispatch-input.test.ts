// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What `akm agent` and `akm run` say about the input a dispatch needs: a prompt that is empty is refused before any
 * harness starts, and each refusal's hint names the thing that is wrong. Integration: the real command against a fake
 * harness binary that records every call.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmAgentDispatch } from "../../../src/commands/agent/agent-dispatch";
import { loadConfig } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import { harnessCalls, writeFakeHarness } from "../../_helpers/engine-stubs";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let bins: SandboxedDir;
let bin: string;

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  bins = makeSandboxDir("akm-agent-dispatch-input-bin");
  bin = writeFakeHarness(bins.dir, "claude", ["FAKE-REPLY"]);
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "fixture",
    bundles: { fixture: { path: storage.stashDir, components: { main: { root: ".", adapter: "akm" } } } },
    harnesses: { claude: { platform: "claude", bin } },
  });
  fs.mkdirSync(path.join(storage.stashDir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(storage.stashDir, "agents", "reader.md"), "---\ntype: agent\n---\nA careful reader.\n");
  fs.mkdirSync(path.join(storage.stashDir, "commands"), { recursive: true });
  fs.writeFileSync(
    path.join(storage.stashDir, "commands", "review.md"),
    "---\nname: review\ntype: command\nupdated: 2026-08-19\n---\nReview: [$ARGUMENTS]\n",
  );
  await akmIndex({ stashDir: storage.stashDir, full: true });
});

afterEach(() => {
  bins.cleanup();
  storage.cleanup();
});

const repoRoot = path.resolve(import.meta.dir, "../../..");

/** The real CLI as a child process, with `stdin` as its standard input. */
async function akm(args: string[], stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", "src/cli.ts", ...args, "--format", "json"], {
    cwd: repoRoot,
    env: { ...process.env },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

/** The error envelope, which follows any deprecation line on stderr. */
function failure(result: { stdout: string; stderr: string }): { message: string; hint?: string; code: string } {
  const text = result.stderr || result.stdout;
  return JSON.parse(text.slice(text.indexOf("{")));
}

describe("an empty prompt", () => {
  test("empty or blank text on --prompt-stdin is refused as a usage error, and no harness starts", async () => {
    for (const stdin of ["", "  \n "]) {
      const result = await akm(["agent", "--prompt-stdin"], stdin);
      expect(result.code).toBe(2);
      expect(failure(result)).toMatchObject({ code: "MISSING_REQUIRED_ARGUMENT" });
    }
    expect(harnessCalls(bin)).toHaveLength(0);
  });

  test("the dispatch itself refuses an empty or blank prompt, whichever command passes it", async () => {
    for (const prompt of ["", " \t\n"]) {
      await expect(akmAgentDispatch({ prompt, agentConfig: loadConfig() })).rejects.toMatchObject({
        code: "MISSING_REQUIRED_ARGUMENT",
      });
    }
    expect(harnessCalls(bin)).toHaveLength(0);
  });
});

describe("the hint names what is wrong", () => {
  test("an agent ref with no prompt says to pass a prompt or drop the ref, not how a ref is written", async () => {
    const result = await akm(["agent", "agents/reader", "--harness", "claude"]);
    expect(result.code).toBe(2);
    const { hint } = failure(result);
    expect(hint).toContain("--prompt");
    expect(hint).not.toContain("Refs use the form");
  });

  test("an agent ref that is not indexed is named as the agent ref, not the command ref", async () => {
    const result = await akm(["run", "commands/review", "--agent", "agents/missing"]);
    expect(result.code).not.toBe(0);
    const { hint } = failure(result);
    expect(hint).toContain('agent ref "agents/missing"');
    expect(hint).toContain("agents/missing");
    expect(hint).not.toContain("retry the command ref");
  });
});
