// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm proposal new` gets the proposal as JSON on stdout from a harness. The
 * contract suite runs every transport; one agent row stands for them here.
 * Integration: it spawns fake CLI harness binaries. Nothing leaves the machine.
 *
 * Every stub replays a scripted reply, so a row sees what reached the harness
 * and what `proposal new` did with the reply.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { listProposals } from "../../../src/commands/proposal/repository";
import { type CliResult, runCliCapture } from "../../_helpers/cli";
import { clearHarnessCalls, fakeHarness, harnessCalls, promptOf } from "../../_helpers/engine-stubs";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

const NAME = "engine-proof";
const CONTENT =
  "---\ndescription: Proves proposal new on every engine kind\nwhen_to_use: Checking an engine\n---\n\nReturn the proposal as JSON.\n";
const PROPOSAL = JSON.stringify({ ref: `skills/${NAME}`, content: CONTENT, confidence: 0.8 });
/** Valid JSON with no `content`: not a proposal. */
const NOT_A_PROPOSAL = JSON.stringify({ ref: `skills/${NAME}` });
const SCHEMA_INSTRUCTION = "Respond with ONLY a JSON value matching this JSON Schema";

const SCENARIOS: Record<string, readonly string[]> = {
  proposal: [PROPOSAL],
  repair: [NOT_A_PROPOSAL, PROPOSAL],
  invalid: [NOT_A_PROPOSAL],
};

let bins: SandboxedDir;
let storage: IsolatedAkmStorage;

beforeAll(() => {
  bins = makeSandboxDir("akm-proposal-new-bin");
  fs.writeFileSync(path.join(bins.dir, "plain-proposal"), fakeHarness(SCENARIOS.proposal ?? []), { mode: 0o755 });
  fs.writeFileSync(path.join(bins.dir, "plain-repair"), fakeHarness(SCENARIOS.repair ?? []), { mode: 0o755 });
  fs.writeFileSync(path.join(bins.dir, "plain-invalid"), fakeHarness(SCENARIOS.invalid ?? []), { mode: 0o755 });
});

afterAll(() => {
  bins.cleanup();
});

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  const harness = (platform: string, bin: string) => ({ platform, bin: path.join(bins.dir, bin) });
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: { work: { path: storage.stashDir, writable: true } },
    defaultBundle: "work",
    defaultWriteTarget: "work",
    harnesses: {
      claude: harness("claude", "plain-proposal"),
      "claude-invalid": harness("claude", "plain-invalid"),
      "claude-repair": harness("claude", "plain-repair"),
    },
  });
});

afterEach(() => {
  storage.cleanup();
  clearHarnessCalls(bins.dir);
});

function proposalNew(engine: string): Promise<CliResult> {
  return runCliCapture([
    "proposal",
    "new",
    "skill",
    NAME,
    "--task",
    "Author a skill that proves this engine returns JSON",
    "--harness",
    engine,
    "--format",
    "json",
  ]);
}

/** The calls the fake harness `bin` recorded. */
const calls = (bin: string) => harnessCalls(path.join(bins.dir, bin));

/** `proposal new` succeeded on `engine` and queued the reply's proposal. */
function expectProposalCreated(result: CliResult, engine: string): void {
  if (result.code !== 0) throw new Error(`proposal new --harness ${engine} exited ${result.code}: ${result.stdout}`);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, engine, ref: `work//skills/${NAME}` });
  const proposals = listProposals(storage.stashDir);
  expect(proposals).toHaveLength(1);
  expect(proposals[0]).toMatchObject({ source: "propose", ref: `work//skills/${NAME}`, status: "pending" });
  expect(proposals[0]?.confidence).toBe(0.8);
  // The queue stamps `type` and `updated` into the reply's frontmatter.
  expect(proposals[0]?.payload.content).toContain("description: Proves proposal new on every engine kind");
  expect(proposals[0]?.payload.content).toContain("Return the proposal as JSON.");
}

describe("proposal new returns JSON from a harness", () => {
  test("a claude harness gets the prompt, with the schema instruction, on stdin and answers in plain text", async () => {
    const result = await proposalNew("claude");

    expectProposalCreated(result, "claude");
    const [call] = calls("plain-proposal");
    expect(call?.argv).toContain("-p");
    expect(call?.argv).not.toContain("--output-format");
    expect(promptOf(call)).toContain(SCHEMA_INSTRUCTION);
  });
});

describe("a reply that is not a proposal gets one corrective retry", () => {
  test("a harness corrected by the retry creates the proposal", async () => {
    const result = await proposalNew("claude-repair");

    expectProposalCreated(result, "claude-repair");
    expect(calls("plain-repair")).toHaveLength(2);
    expect(promptOf(calls("plain-repair")[1])).toContain("failed validation");
  });

  test.each([
    ["claude-invalid", () => calls("plain-invalid").length],
  ])("%s: a reply still invalid after the retry fails clearly and creates nothing", async (engine, count) => {
    const result = await proposalNew(engine);

    expect(result.code).toBe(1);
    const out = JSON.parse(result.stdout) as { ok: boolean; reason: string; error: string; engine: string };
    expect(out).toMatchObject({ ok: false, reason: "parse_error", engine });
    expect(out.error).toContain(`Engine "${engine}"`);
    expect(out.error).toContain("not valid proposal JSON");
    expect(out.error).toContain('"content"');
    expect(out.error).not.toContain("interactive");
    expect(count()).toBe(2);
    expect(listProposals(storage.stashDir)).toEqual([]);
  });
});
