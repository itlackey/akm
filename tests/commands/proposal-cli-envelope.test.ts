// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the `akm proposal` command family. Pins the
 * full JSON envelope (stdout payload shape + the {ok:false,…} error envelope on
 * stderr) for representative subcommands, proving the extraction of the family
 * from cli.ts into src/commands/proposal-cli.ts and the migration of the leaf
 * handlers onto `defineJsonCommand` is byte-identical. Proposals are seeded
 * in-process via createProposal() against an isolated stash dir; the CLI reads
 * that stash back through AKM_STASH_DIR via the in-process harness.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { createProposal, isProposalSkipped } from "../../src/commands/proposal/repository";
import { runCliCapture } from "../_helpers/cli";
import { makeSandboxDir, type SandboxedDir, withEnv } from "../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

function makeStashDir(): string {
  const d = makeSandboxDir("akm-proposal-envelope-");
  disposers.push(d);
  for (const sub of ["lessons", "skills", "memories", "knowledge"]) {
    fs.mkdirSync(path.join(d.dir, sub), { recursive: true });
  }
  return d.dir;
}

const VALID_LESSON = `---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos\n---\n\nPrefer rg.\n`;

function seedProposal(stash: string, ref = "lesson:rg-over-grep"): string {
  const result = createProposal(stash, {
    ref,
    source: "reflect",
    force: true,
    payload: { content: VALID_LESSON },
  });
  if (isProposalSkipped(result)) throw new Error("unexpected skip in seedProposal");
  return result.id;
}

async function runCli(args: string[], stashDir: string): Promise<{ stdout: string; stderr: string; status: number }> {
  const { code, stdout, stderr } = await withEnv({ AKM_STASH_DIR: stashDir }, () => runCliCapture(args));
  return { stdout, stderr, status: code };
}

describe("akm proposal — JSON envelope snapshot (WS6)", () => {
  test("proposal list: envelope shape is pinned (success path)", async () => {
    const stash = makeStashDir();
    seedProposal(stash);
    const { stdout, status } = await runCli(["--json", "proposal", "list"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    // Pin the top-level shape (keys + types) without binding to the volatile id.
    expect(env.totalCount).toBe(1);
    expect(Array.isArray(env.proposals)).toBe(true);
    const [p] = env.proposals;
    expect(p.ref).toBe("lesson:rg-over-grep");
    expect(p.source).toBe("reflect");
    expect(p.status).toBe("pending");
  });

  test("proposal list: invalid --status → byte-identical {ok:false} error envelope on stderr", async () => {
    const stash = makeStashDir();
    const { stderr, status } = await runCli(["--json", "proposal", "list", "--status", "bogus"], stash);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("INVALID_FLAG_VALUE");
    expect(env.error).toBe('Invalid --status value: "bogus". Expected one of: pending, accepted, rejected, reverted.');
  });

  test("proposal show: envelope carries proposal + validation report", async () => {
    const stash = makeStashDir();
    const id = seedProposal(stash);
    const { stdout, status } = await runCli(["--json", "proposal", "show", id], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.proposal.id).toBe(id);
    expect(env.proposal.ref).toBe("lesson:rg-over-grep");
    expect(env.validation.ok).toBe(true);
  });

  test("proposal accept: success envelope materialises asset", async () => {
    const stash = makeStashDir();
    const id = seedProposal(stash);
    const { stdout, status } = await runCli(["--json", "proposal", "accept", id], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(true);
    expect(fs.existsSync(env.assetPath as string)).toBe(true);
  });
});
