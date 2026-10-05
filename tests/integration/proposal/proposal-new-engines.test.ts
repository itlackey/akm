// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm proposal new` gets the proposal as JSON on stdout from every engine
 * kind: an LLM and an agent CLI. The contract suite runs every transport; one
 * agent row stands for them here. Integration: it serves an LLM stub on
 * 127.0.0.1 and spawns fake CLI harness binaries. Nothing leaves loopback.
 *
 * Every stub replays a scripted reply, so a row sees what reached the engine
 * and what `proposal new` did with the reply.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { listProposals } from "../../../src/commands/proposal/repository";
import { type CliResult, runCliCapture } from "../../_helpers/cli";
import { clearHarnessCalls, fakeHarness, harnessCalls, serveLlmStub } from "../../_helpers/engine-stubs";
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

const { server: llmStub, bodies: llmBodies } = serveLlmStub(SCENARIOS);
let bins: SandboxedDir;
let storage: IsolatedAkmStorage;

beforeAll(() => {
  bins = makeSandboxDir("akm-proposal-new-bin");
  // claude answers in its JSON result envelope; opencode prints the reply as it is.
  fs.writeFileSync(path.join(bins.dir, "claude-envelope"), fakeHarness(SCENARIOS.proposal ?? [], "claude"), {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(bins.dir, "plain-repair"), fakeHarness(SCENARIOS.repair ?? []), { mode: 0o755 });
  fs.writeFileSync(path.join(bins.dir, "plain-invalid"), fakeHarness(SCENARIOS.invalid ?? []), { mode: 0o755 });
});

afterAll(() => {
  llmStub.stop(true);
  bins.cleanup();
});

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  const llm = (scenario: string) => ({
    kind: "llm",
    endpoint: `http://127.0.0.1:${llmStub.port}/${scenario}/v1/chat/completions`,
    model: "stub-model",
  });
  const agent = (platform: string, bin: string) => ({ kind: "agent", platform, bin: path.join(bins.dir, bin) });
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: { work: { path: storage.stashDir, writable: true } },
    defaultBundle: "work",
    defaultWriteTarget: "work",
    engines: {
      llm: llm("proposal"),
      "llm-repair": llm("repair"),
      "llm-invalid": llm("invalid"),
      claude: agent("claude", "claude-envelope"),
      "opencode-invalid": agent("opencode", "plain-invalid"),
      "opencode-repair": agent("opencode", "plain-repair"),
    },
    defaults: { engine: "llm" },
  });
});

afterEach(() => {
  storage.cleanup();
  llmBodies.length = 0;
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
    "--engine",
    engine,
    "--format",
    "json",
  ]);
}

/** The calls the fake harness `bin` recorded. */
const calls = (bin: string) => harnessCalls(path.join(bins.dir, bin));

/** `proposal new` succeeded on `engine` and queued the reply's proposal. */
function expectProposalCreated(result: CliResult, engine: string): void {
  if (result.code !== 0) throw new Error(`proposal new --engine ${engine} exited ${result.code}: ${result.stdout}`);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, engine, ref: `work//skills/${NAME}` });
  const proposals = listProposals(storage.stashDir);
  expect(proposals).toHaveLength(1);
  expect(proposals[0]).toMatchObject({ source: "propose", ref: `work//skills/${NAME}`, status: "pending" });
  expect(proposals[0]?.confidence).toBe(0.8);
  // The queue stamps `type` and `updated` into the reply's frontmatter.
  expect(proposals[0]?.payload.content).toContain("description: Proves proposal new on every engine kind");
  expect(proposals[0]?.payload.content).toContain("Return the proposal as JSON.");
}

describe("proposal new returns JSON for every engine kind", () => {
  test("an LLM engine gets the schema as response_format and the prompt asks for JSON", async () => {
    const result = await proposalNew("llm");

    expectProposalCreated(result, "llm");
    expect(llmBodies).toHaveLength(1);
    const body = llmBodies[0] as { messages: Array<{ content: string }>; response_format?: unknown };
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { schema: { type: "object", required: expect.arrayContaining(["ref", "content"]) } },
    });
    const prompt = body.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("Respond ONLY with a single JSON object");
  });

  test("a claude engine's JSON result envelope is unwrapped by the claude result extractor", async () => {
    const result = await proposalNew("claude");

    expectProposalCreated(result, "claude");
    const [call] = calls("claude-envelope");
    expect(call?.argv.join(" ")).toContain("--output-format json");
    expect(call?.argv.at(-1)).toContain(SCHEMA_INSTRUCTION);
  });
});

describe("a reply that is not a proposal gets one corrective retry", () => {
  test("an LLM engine corrected by the retry creates the proposal", async () => {
    const result = await proposalNew("llm-repair");

    expectProposalCreated(result, "llm-repair");
    expect(llmBodies).toHaveLength(2);
    const retry = llmBodies[1]?.messages.map((message) => message.content).join("\n") ?? "";
    expect(retry).toContain("failed validation");
    expect(retry).toContain('"content"');
  });

  test("an agent CLI engine corrected by the retry creates the proposal", async () => {
    const result = await proposalNew("opencode-repair");

    expectProposalCreated(result, "opencode-repair");
    expect(calls("plain-repair")).toHaveLength(2);
    expect(calls("plain-repair")[1]?.argv.at(-1)).toContain("failed validation");
  });

  test.each([
    ["llm-invalid", () => llmBodies.length],
    ["opencode-invalid", () => calls("plain-invalid").length],
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
