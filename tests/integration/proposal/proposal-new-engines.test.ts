// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm proposal new` gets the proposal as JSON on stdout from every engine
 * kind: an LLM, an agent CLI and opencode-sdk. Integration: it serves an LLM
 * stub on 127.0.0.1 and spawns fake CLI harness binaries; opencode-sdk runs
 * through the runner's `__setTestServer` seam. Nothing leaves loopback.
 *
 * Every stub answers as an engine that follows its instructions. Asked for
 * the proposal as JSON, it prints JSON. Asked to write a draft file, which none
 * of them can do, it prints the `DRAFT_WRITTEN` line that instruction asks for.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { listProposals } from "../../../src/commands/proposal/repository";
import { __setTestServer } from "../../../src/integrations/harnesses/opencode-sdk/sdk-runner";
import { type CliResult, runCliCapture } from "../../_helpers/cli";
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
/** From the draft-file instruction; an engine that receives it answers with the draft line. */
const FILE_WRITE_INSTRUCTION = "Do NOT output JSON to stdout";
const DRAFT_LINE = "DRAFT_WRITTEN confidence=0.9";
const SCHEMA_INSTRUCTION = "Respond with ONLY a JSON value matching this JSON Schema";

/** What an engine following `prompt` prints on its `call`th dispatch, from its scripted replies. */
function answer(prompt: string, replies: readonly string[], call: number): string {
  if (prompt.includes(FILE_WRITE_INSTRUCTION)) return DRAFT_LINE;
  return replies[Math.min(call, replies.length) - 1] ?? "";
}

const SCENARIOS: Record<string, readonly string[]> = {
  proposal: [PROPOSAL],
  repair: [NOT_A_PROPOSAL, PROPOSAL],
  invalid: [NOT_A_PROPOSAL],
};

/**
 * A fake harness binary. It records its argv (and any `--output-schema` file)
 * per call beside itself and answers per {@link answer}, framed as `framing`
 * says: as Claude Code's result envelope when `--output-format json` is
 * passed, as a codex `--json` event stream, or as plain text.
 */
function fakeHarness(replies: readonly string[], framing: "plain" | "claude" | "codex"): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const self = process.argv[1];
const argv = process.argv.slice(2);
const countFile = self + ".count";
const call = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0) + 1;
fs.writeFileSync(countFile, String(call));
fs.writeFileSync(self + ".argv." + call, JSON.stringify(argv));
const schemaAt = argv.indexOf("--output-schema");
if (schemaAt >= 0) fs.copyFileSync(argv[schemaAt + 1], self + ".schema." + call);
const prompt = argv.at(-1) ?? "";
const replies = ${JSON.stringify(replies)};
const text = prompt.includes(${JSON.stringify(FILE_WRITE_INSTRUCTION)})
  ? ${JSON.stringify(DRAFT_LINE)}
  : replies[Math.min(call, replies.length) - 1];
const format = argv.indexOf("--output-format");
let out = text;
if (${JSON.stringify(framing)} === "claude" && format >= 0 && argv[format + 1] === "json") {
  out = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, session_id: "fake-claude-session" });
} else if (${JSON.stringify(framing)} === "codex") {
  out = [
    JSON.stringify({ type: "thread.started", thread_id: "fake-codex-thread" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } }),
  ].join("\\n");
}
process.stdout.write(out + "\\n");
`;
}

const BINARIES: Record<string, string> = {
  "claude-envelope": fakeHarness(SCENARIOS.proposal ?? [], "claude"),
  "codex-events": fakeHarness(SCENARIOS.proposal ?? [], "codex"),
  plain: fakeHarness(SCENARIOS.proposal ?? [], "plain"),
  "plain-repair": fakeHarness(SCENARIOS.repair ?? [], "plain"),
  "plain-invalid": fakeHarness(SCENARIOS.invalid ?? [], "plain"),
};

let llmStub: ReturnType<typeof Bun.serve>;
let bins: SandboxedDir;
let storage: IsolatedAkmStorage;
/** The LLM stub's request bodies and the fake SDK client's prompts, in order. */
let llmBodies: Array<{ messages: Array<{ content: string }>; response_format?: unknown }> = [];
let sdkPrompts: string[] = [];

beforeAll(() => {
  llmStub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const scenario = new URL(req.url).pathname.split("/")[1] ?? "";
      const body = (await req.json()) as (typeof llmBodies)[number];
      llmBodies.push(body);
      const prompt = body.messages.map((message) => message.content).join("\n");
      const replies = SCENARIOS[scenario];
      if (!replies) return new Response("unknown scenario", { status: 404 });
      return Response.json({ choices: [{ message: { content: answer(prompt, replies, llmBodies.length) } }] });
    },
  });
  bins = makeSandboxDir("akm-proposal-new-bin");
  for (const [name, script] of Object.entries(BINARIES)) {
    fs.writeFileSync(path.join(bins.dir, name), script, { mode: 0o755 });
  }
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
      "claude-plain": agent("claude", "plain"),
      codex: agent("codex", "codex-events"),
      opencode: agent("opencode", "plain"),
      "opencode-invalid": agent("opencode", "plain-invalid"),
      "opencode-repair": agent("opencode", "plain-repair"),
      sdk: { kind: "agent", platform: "opencode-sdk" },
    },
    defaults: { engine: "llm" },
  });
});

afterEach(() => {
  __setTestServer(null);
  storage.cleanup();
  llmBodies = [];
  sdkPrompts = [];
  for (const file of fs.readdirSync(bins.dir)) {
    if (/\.(count|argv\.\d+|schema\.\d+)$/.test(file)) fs.rmSync(path.join(bins.dir, file));
  }
});

/** The fake opencode-sdk client: it answers each prompt per {@link answer}. */
function arrangeSdk(replies: readonly string[]): void {
  __setTestServer({
    client: {
      session: {
        create: async () => ({ data: { id: "proposal-new-session" } }),
        prompt: async (args: { body: { parts: Array<{ text: string }> } }) => {
          const prompt = args.body.parts.map((part) => part.text).join("\n");
          sdkPrompts.push(prompt);
          return { data: { info: {}, parts: [{ type: "text", text: answer(prompt, replies, sdkPrompts.length) }] } };
        },
        delete: async () => ({}),
      },
    },
    server: { close() {} },
  } as never);
}

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

/** The argv a fake harness received on its `call`th dispatch. */
function harnessArgv(bin: string, call = 1): string[] {
  return JSON.parse(fs.readFileSync(path.join(bins.dir, `${bin}.argv.${call}`), "utf8")) as string[];
}

function harnessCalls(bin: string): number {
  return Number(fs.readFileSync(path.join(bins.dir, `${bin}.count`), "utf8"));
}

/** `proposal new` succeeded on `engine` and queued the reply's proposal. */
function expectProposalCreated(result: CliResult, engine: string): void {
  if (result.code !== 0) throw new Error(`proposal new --engine ${engine} exited ${result.code}: ${result.stdout}`);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, engine, ref: `work//skills/${NAME}` });
  const proposals = listProposals(storage.stashDir);
  expect(proposals).toHaveLength(1);
  expect(proposals[0]).toMatchObject({ source: "propose", ref: `work//skills/${NAME}`, status: "pending" });
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
    expect(prompt).not.toContain(FILE_WRITE_INSTRUCTION);
  });

  test("a claude engine's JSON result envelope is unwrapped by the claude result extractor", async () => {
    const result = await proposalNew("claude");

    expectProposalCreated(result, "claude");
    const argv = harnessArgv("claude-envelope");
    expect(argv.join(" ")).toContain("--output-format json");
    expect(argv.at(-1)).toContain(SCHEMA_INSTRUCTION);
    expect(argv.at(-1)).not.toContain(FILE_WRITE_INSTRUCTION);
  });

  test("a codex engine gets the schema in the strict form its --output-schema needs", async () => {
    const result = await proposalNew("codex");

    expectProposalCreated(result, "codex");
    const schema = JSON.parse(fs.readFileSync(path.join(bins.dir, "codex-events.schema.1"), "utf8")) as {
      required: string[];
      properties: Record<string, unknown>;
      additionalProperties: unknown;
    };
    // OpenAI-style strict schemas: every property required, no other property allowed.
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.required).toEqual(expect.arrayContaining(["ref", "content"]));
    expect(schema.additionalProperties).toBe(false);
  });

  test.each([
    ["claude", "claude-plain"],
    ["opencode", "opencode"],
  ])("%s printing plain JSON succeeds", async (_platform, engine) => {
    const result = await proposalNew(engine);

    expectProposalCreated(result, engine);
    expect(harnessArgv("plain").at(-1)).toContain(SCHEMA_INSTRUCTION);
  });

  test("an opencode-sdk engine replies with JSON through its session", async () => {
    arrangeSdk(SCENARIOS.proposal ?? []);
    const result = await proposalNew("sdk");

    expectProposalCreated(result, "sdk");
    expect(sdkPrompts).toHaveLength(1);
    expect(sdkPrompts[0]).toContain(SCHEMA_INSTRUCTION);
    expect(sdkPrompts[0]).not.toContain(FILE_WRITE_INSTRUCTION);
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
    expect(harnessCalls("plain-repair")).toBe(2);
    expect(harnessArgv("plain-repair", 2).at(-1)).toContain("failed validation");
  });

  test.each([
    ["llm-invalid", () => llmBodies.length],
    ["opencode-invalid", () => harnessCalls("plain-invalid")],
  ])("%s: a reply still invalid after the retry fails clearly and creates nothing", async (engine, calls) => {
    const result = await proposalNew(engine);

    expect(result.code).toBe(1);
    const out = JSON.parse(result.stdout) as { ok: boolean; reason: string; error: string; engine: string };
    expect(out).toMatchObject({ ok: false, reason: "parse_error", engine });
    expect(out.error).toContain(`Engine "${engine}"`);
    expect(out.error).toContain("not valid proposal JSON");
    expect(out.error).toContain('"content"');
    expect(out.error).not.toContain("interactive");
    expect(calls()).toBe(2);
    expect(listProposals(storage.stashDir)).toEqual([]);
  });
});
