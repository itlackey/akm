// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reflect has one path for every engine kind: an LLM, an opencode CLI, a
 * claude CLI and opencode-sdk are each asked for the same JSON reply, the reply
 * is held to the same contract, and an invalid one is repaired once.
 *
 * Integration: it serves an LLM stub on 127.0.0.1, spawns fake harness
 * binaries, and opens state.db for the proposal queue; opencode-sdk runs
 * through the runner's `__setTestServer` seam. Nothing leaves loopback.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmReflect, REFLECT_JSON_SCHEMA } from "../../../../src/commands/improve/reflect";
import { listProposals } from "../../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../../src/core/config/config";
import { readEvents } from "../../../../src/core/events";
import { __setTestServer } from "../../../../src/integrations/harnesses/opencode-sdk/sdk-runner";
import { reflectReply } from "../../../_helpers/factories";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
} from "../../../_helpers/sandbox";

const REF = "lessons/rg-over-grep";
const SOURCE =
  "---\ndescription: Prefer ripgrep for repository search\nwhen_to_use: When searching a source repository\n---\n\n# Prefer ripgrep\n\nUse rg for recursive repository searches. It respects .gitignore.\n\n## Examples\n\n- rg -n TODO src\n";
const REVISED =
  "# Prefer ripgrep\n\nUse rg for recursive repository searches. It respects .gitignore and skips binary files.\n\n## Examples\n\n- rg -n TODO src\n- rg --hidden API_URL .\n";
const PROSE = "I have improved the asset.";
/** What the engine says to a reflect run that names no asset: the frontmatter a new lesson needs, and its ref. */
const UNSCOPED_REPLY = reflectReply(REVISED, {
  ref: REF,
  frontmatterPatch: {
    description: "Prefer ripgrep for repository search",
    when_to_use: "When searching a source repository",
  },
});
const SCHEMA_INSTRUCTION = "\n\nRespond with ONLY a JSON value matching this JSON Schema (no prose, no code fences):\n";
const REPAIR_REQUEST = "could not be extracted using the required output contract";

/** The replies an engine gives to its first, second, … dispatch; the last one repeats. */
const SCENARIOS: Record<string, readonly string[]> = {
  valid: [reflectReply(REVISED)],
  repair: [PROSE, reflectReply(REVISED)],
  invalid: [PROSE],
  unscoped: [UNSCOPED_REPLY],
  // The first pass needs its repair; the second pass replies in prose again.
  refine: [PROSE, reflectReply(REVISED), PROSE],
};

/**
 * A fake harness binary. It records its argv, working directory and event
 * source per call beside itself, and replies per {@link SCENARIOS}: as Claude
 * Code's result envelope when `--output-format json` is passed and `framing`
 * says so, as plain text otherwise.
 */
function fakeHarness(replies: readonly string[], framing: "plain" | "claude"): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const self = process.argv[1];
const argv = process.argv.slice(2);
const countFile = self + ".count";
const call = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0) + 1;
fs.writeFileSync(countFile, String(call));
fs.writeFileSync(self + ".call." + call, JSON.stringify({ argv, eventSource: process.env.AKM_EVENT_SOURCE ?? null, cwd: process.cwd() }));
const replies = ${JSON.stringify(replies)};
const text = replies[Math.min(call, replies.length) - 1];
const format = argv.indexOf("--output-format");
const envelope = ${JSON.stringify(framing)} === "claude" && format >= 0 && argv[format + 1] === "json";
process.stdout.write((envelope ? JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, session_id: "fake-claude-session" }) : text) + "\\n");
`;
}

let llmStub: ReturnType<typeof Bun.serve>;
let bins: SandboxedDir;
let storage: IsolatedAkmStorage;
/** The LLM stub's request bodies and the fake SDK client's prompt bodies, in order. */
let llmBodies: Array<{
  messages: Array<{ content: string }>;
  response_format?: { json_schema?: { schema?: unknown } };
}> = [];
let sdkBodies: Array<{ parts: Array<{ text: string }> }> = [];

beforeAll(() => {
  llmStub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const replies = SCENARIOS[new URL(req.url).pathname.split("/")[1] ?? ""];
      if (!replies) return new Response("unknown scenario", { status: 404 });
      llmBodies.push((await req.json()) as (typeof llmBodies)[number]);
      const text = replies[Math.min(llmBodies.length, replies.length) - 1];
      return Response.json({ choices: [{ message: { content: text } }] });
    },
  });
  bins = makeSandboxDir("akm-reflect-engines-bin");
  for (const [scenario, replies] of Object.entries(SCENARIOS)) {
    for (const framing of ["plain", "claude"] as const) {
      fs.writeFileSync(path.join(bins.dir, `${framing}-${scenario}`), fakeHarness(replies, framing), { mode: 0o755 });
    }
  }
});

afterAll(() => {
  llmStub.stop(true);
  bins.cleanup();
});

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  __setTestServer(null);
  storage.cleanup();
  llmBodies = [];
  sdkBodies = [];
  for (const file of fs.readdirSync(bins.dir)) {
    if (/\.(count|call\.\d+)$/.test(file)) fs.rmSync(path.join(bins.dir, file));
  }
});

/** One engine kind, and how to see what reached it. */
interface Transport {
  readonly name: string;
  /** The engine config entry that runs `scenario`. */
  engine(scenario: string): Record<string, unknown>;
  /** Install what the scenario needs outside the engine config. */
  arrange?(scenario: string): void;
  /** Each dispatch's prompt, in order. */
  prompts(scenario: string): string[];
  /** The schema the engine received as a native channel, if it has one. */
  nativeSchema?(): unknown;
  /** The calls a CLI's fake binary recorded; only a CLI has a process. */
  calls?(scenario: string): HarnessCall[];
}

/** What a fake harness binary saw on one call. */
interface HarnessCall {
  argv: string[];
  eventSource: string | null;
  cwd: string;
}

const LLM: Transport = {
  name: "llm",
  engine: (scenario) => ({
    kind: "llm",
    endpoint: `http://127.0.0.1:${llmStub.port}/${scenario}/v1/chat/completions`,
    model: "stub-model",
  }),
  prompts: () => llmBodies.map((body) => body.messages.map((message) => message.content).join("\n")),
  nativeSchema: () => llmBodies[0]?.response_format?.json_schema?.schema,
};

const cli = (name: string, platform: string, framing: "plain" | "claude"): Transport => {
  const bin = (scenario: string) => path.join(bins.dir, `${framing}-${scenario}`);
  const calls = (scenario: string): HarnessCall[] => {
    const count = fs.existsSync(`${bin(scenario)}.count`)
      ? Number(fs.readFileSync(`${bin(scenario)}.count`, "utf8"))
      : 0;
    return Array.from(
      { length: count },
      (_, index) => JSON.parse(fs.readFileSync(`${bin(scenario)}.call.${index + 1}`, "utf8")) as HarnessCall,
    );
  };
  return {
    name,
    engine: (scenario) => ({ kind: "agent", platform, bin: bin(scenario) }),
    prompts: (scenario) => calls(scenario).map((call) => call.argv.at(-1) ?? ""),
    calls,
  };
};

const OPENCODE = cli("opencode", "opencode", "plain");
const CLAUDE = cli("claude", "claude", "claude");

const OPENCODE_SDK: Transport = {
  name: "opencode-sdk",
  engine: () => ({ kind: "agent", platform: "opencode-sdk" }),
  arrange: (scenario) => {
    const replies = SCENARIOS[scenario] ?? [];
    __setTestServer({
      client: {
        session: {
          create: async () => ({ data: { id: "reflect-engines-session" } }),
          prompt: async (args: { body: { parts: Array<{ text: string }> } }) => {
            sdkBodies.push(args.body);
            const text = replies[Math.min(sdkBodies.length, replies.length) - 1];
            return { data: { info: {}, parts: [{ type: "text", text }] } };
          },
          delete: async () => ({}),
        },
      },
      server: { close() {} },
    } as never);
  },
  prompts: () => sdkBodies.map((body) => body.parts.map((part) => part.text).join("\n")),
};

const TRANSPORTS: [string, Transport][] = [LLM, OPENCODE, CLAUDE, OPENCODE_SDK].map((transport) => [
  transport.name,
  transport,
]);
const PROCESS_TRANSPORTS: [string, Transport][] = [OPENCODE, CLAUDE].map((transport) => [transport.name, transport]);

/** Reflect `REF` on `transport`'s engine for `scenario`, with the quality gate off. */
function reflect(transport: Transport, scenario: string, options: Parameters<typeof akmReflect>[0] = {}) {
  transport.arrange?.(scenario);
  const config = {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    engines: { contract: transport.engine(scenario) },
    defaults: { engine: "contract", improveStrategy: "default" },
    improve: { strategies: { default: { processes: { reflect: { qualityGate: { enabled: false } } } } } },
  } as unknown as AkmConfig;
  return akmReflect({
    ref: REF,
    stashDir: storage.stashDir,
    config,
    assetContent: SOURCE,
    engine: "contract",
    ...options,
  });
}

function completedEvent() {
  const events = readEvents({ type: "reflect_completed" }).events;
  expect(events).toHaveLength(1);
  return events[0]?.metadata as Record<string, unknown>;
}

describe("reflect asks every engine kind for the same JSON reply", () => {
  test.each(TRANSPORTS)("%s: the reply is queued as a proposal", async (_name, transport) => {
    const result = await reflect(transport, "valid");

    if (!result.ok) throw new Error(`expected a proposal, got ${result.reason}: ${result.error}`);
    expect(result.engine).toBe("contract");
    expect(transport.prompts("valid")).toHaveLength(1);
    const proposals = listProposals(storage.stashDir);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ source: "reflect", status: "pending", confidence: 0.8 });
    expect(proposals[0]?.payload.content).toContain("rg --hidden API_URL");
    // The source's frontmatter survives the rewrite.
    expect(proposals[0]?.payload.content).toContain("description: Prefer ripgrep for repository search");
    expect(completedEvent()).toMatchObject({ source: "reflect", engine: "contract", outputMode: "json_schema" });
  });

  // An LLM gets the schema as response_format; an agent engine gets it as the one instruction at the end of its prompt.
  test.each(TRANSPORTS)("%s: the reply's JSON Schema is the request's output schema", async (name, transport) => {
    await reflect(transport, "valid");

    const [prompt = ""] = transport.prompts("valid");
    expect(prompt).toContain("Respond only through the provider's native JSON schema.");
    if (name === "llm") {
      expect(transport.nativeSchema?.()).toEqual(REFLECT_JSON_SCHEMA);
      expect(prompt).not.toContain(SCHEMA_INSTRUCTION);
    } else {
      expect(prompt.endsWith(`${SCHEMA_INSTRUCTION}${JSON.stringify(REFLECT_JSON_SCHEMA)}`)).toBe(true);
      expect(prompt.split(SCHEMA_INSTRUCTION)).toHaveLength(2);
    }
  });

  test.each(TRANSPORTS)("%s: a run that names no asset asks for the object that names it", async (name, transport) => {
    const result = await reflect(transport, "unscoped", { ref: undefined, assetContent: undefined });

    if (!result.ok) throw new Error(`expected a proposal, got ${result.reason}: ${result.error}`);
    expect(result.ref).toContain(REF);
    const [prompt = ""] = transport.prompts("unscoped");
    const schema = (
      name === "llm" ? transport.nativeSchema?.() : JSON.parse(prompt.split(SCHEMA_INSTRUCTION)[1] ?? "{}")
    ) as {
      required: string[];
    };
    expect(schema.required).toContain("ref");
  });
});

describe("reflect repairs an invalid reply once, on every engine kind", () => {
  test.each(TRANSPORTS)("%s: an invalid first reply is corrected by one repair turn", async (_name, transport) => {
    const result = await reflect(transport, "repair");

    if (!result.ok) throw new Error(`expected a proposal, got ${result.reason}: ${result.error}`);
    const prompts = transport.prompts("repair");
    expect(prompts).toHaveLength(2);
    // The repair turn carries the first reply and asks for it again in the required contract.
    expect(prompts[1]).toContain(PROSE);
    expect(prompts[1]).toContain(REPAIR_REQUEST);
    expect(listProposals(storage.stashDir)).toHaveLength(1);
    expect(completedEvent()).toMatchObject({ outputMode: "json_schema", repairAttempts: 1 });
  });

  test.each(
    TRANSPORTS,
  )("%s: a reply still invalid after the repair fails and queues nothing", async (name, transport) => {
    const result = await reflect(transport, "invalid");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result).toMatchObject({ reason: "parse_error", engine: "contract" });
    expect(result.stdout?.trim()).toBe(PROSE);
    // An agent or SDK engine's failure says which engine broke the contract; an LLM keeps its bare message,
    // which improve feeds into later prompts as a pattern to avoid.
    if (name === "llm") expect(result.error).not.toContain("Engine");
    else expect(result.error).toContain('Engine "contract" reply was not a valid reflect proposal after 2 attempts');
    expect(transport.prompts("invalid")).toHaveLength(2);
    expect(listProposals(storage.stashDir)).toEqual([]);
    expect(completedEvent()).toMatchObject({ ok: false, reason: "parse_error", repairAttempts: 1 });
  });
});

describe("reflect's repair is spent once across refine passes, on every engine kind", () => {
  test.each(TRANSPORTS)("%s: a second pass with an invalid reply is not repaired again", async (name, transport) => {
    const result = await reflect(transport, "refine", { maxRefineIters: 2 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.reason).toBe("parse_error");
    // The first pass, its repair, and the second pass, which critiques the repaired draft and gets no repair.
    const prompts = transport.prompts("refine");
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain("Your previous proposal is shown above");
    if (name !== "llm") expect(result.error).toContain("after 1 attempt:");
    expect(listProposals(storage.stashDir)).toEqual([]);
    expect(completedEvent()).toMatchObject({ ok: false, reason: "parse_error", repairAttempts: 1 });
  });
});

describe("a harness's own framing and environment", () => {
  test("claude's JSON result envelope is unwrapped before the reply is validated", async () => {
    const result = await reflect(CLAUDE, "valid");

    expect(result.ok).toBe(true);
    const [call] = CLAUDE.calls?.("valid") ?? [];
    expect(call?.argv.join(" ")).toContain("--output-format json");
  });

  test.each(
    PROCESS_TRANSPORTS,
  )("%s: model work runs in a scratch directory with the improve event source", async (_name, transport) => {
    await reflect(transport, "valid", { eventSource: "improve" });

    const [call] = transport.calls?.("valid") ?? [];
    expect(call?.eventSource).toBe("improve");
    expect(path.basename(call?.cwd ?? "")).toStartWith("akm-model-work-");
  });
});
