// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reflect has one path for every kind of target: a connection and a harness are each
 * asked for the same JSON reply, the reply is held to the same contract, and an
 * invalid one is repaired once. The contract suite runs every transport; one
 * agent row stands for them here.
 *
 * Integration: it serves an LLM stub on 127.0.0.1, spawns fake harness
 * binaries, and opens state.db for the proposal queue. Nothing leaves loopback.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmReflect, REFLECT_JSON_SCHEMA } from "../../../../src/commands/improve/reflect";
import { splitFrontmatter } from "../../../../src/commands/improve/reflect-noise";
import { listProposals } from "../../../../src/commands/proposal/repository";
import { parseFrontmatter } from "../../../../src/core/asset/frontmatter";
import type { AkmConfig } from "../../../../src/core/config/config";
import { readEvents } from "../../../../src/core/events";
import {
  clearHarnessCalls,
  fakeHarness,
  type HarnessCall,
  harnessCalls,
  promptOf,
  serveLlmStub,
} from "../../../_helpers/engine-stubs";
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
const PATCH = { description: "Prefer ripgrep for recursive repository searches" };
const PROSE = "I have improved the asset.";
const SCHEMA_INSTRUCTION = "\n\nRespond with ONLY a JSON value matching this JSON Schema (no prose, no code fences):\n";
const REPAIR_REQUEST = "could not be extracted using the required output contract";

/** The replies an engine gives to its first, second, … dispatch; the last one repeats. */
const SCENARIOS: Record<string, readonly string[]> = {
  valid: [reflectReply(PATCH)],
  repair: [PROSE, reflectReply(PATCH)],
  invalid: [PROSE],
  // What the engine says to a reflect run that names no asset: the asset, too.
  unscoped: [reflectReply(PATCH, { ref: REF })],
  // The first pass needs its repair; the second pass replies in prose again.
};

const { server: llmStub, bodies: llmBodies } = serveLlmStub(SCENARIOS);
let bins: SandboxedDir;
let storage: IsolatedAkmStorage;

beforeAll(() => {
  bins = makeSandboxDir("akm-reflect-engines-bin");
  for (const [scenario, replies] of Object.entries(SCENARIOS)) {
    fs.writeFileSync(path.join(bins.dir, scenario), fakeHarness(replies), { mode: 0o755 });
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
  storage.cleanup();
  llmBodies.length = 0;
  clearHarnessCalls(bins.dir);
});

/** One kind of target, and how to see what reached it. */
interface Transport {
  readonly name: string;
  /** The config entries, named `contract`, that run `scenario`. */
  engine(scenario: string): Record<string, unknown>;
  /** Each dispatch's prompt, in order. */
  prompts(scenario: string): string[];
  /** The schema the engine received as a native channel, if it has one. */
  nativeSchema?(): unknown;
}

const LLM: Transport = {
  name: "llm",
  engine: (scenario) => ({
    connections: {
      contract: {
        endpoint: `http://127.0.0.1:${llmStub.port}/${scenario}/v1/chat/completions`,
        models: { fast: "stub-model" },
      },
    },
  }),
  prompts: () => llmBodies.map((body) => body.messages.map((message) => message.content).join("\n")),
  nativeSchema: () => llmBodies[0]?.response_format?.json_schema?.schema,
};

/** The calls the fake claude binary recorded for `scenario`. */
const claudeCalls = (scenario: string): HarnessCall[] => harnessCalls(path.join(bins.dir, scenario));

const CLAUDE: Transport = {
  name: "claude",
  engine: (scenario) => ({ harnesses: { contract: { platform: "claude", bin: path.join(bins.dir, scenario) } } }),
  prompts: (scenario) => claudeCalls(scenario).map((call) => promptOf(call)),
};

const TRANSPORTS: [string, Transport][] = [LLM, CLAUDE].map((transport) => [transport.name, transport]);

/** Reflect `REF` on `transport`'s engine for `scenario`, with the quality gate off. */
function reflect(transport: Transport, scenario: string, options: Parameters<typeof akmReflect>[0] = {}) {
  const config = {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    ...transport.engine(scenario),
    improve: {
      strategy: "default",
      strategies: { default: { processes: { reflect: { qualityGate: { enabled: false } } } } },
    },
  } as unknown as AkmConfig;
  return akmReflect({
    ref: REF,
    stashDir: storage.stashDir,
    config,
    assetContent: SOURCE,
    ...options,
  });
}

function completedEvent() {
  const events = readEvents({ type: "reflect_completed" }).events;
  expect(events).toHaveLength(1);
  return events[0]?.metadata as Record<string, unknown>;
}

describe("reflect runs the runner the improve plan froze", () => {
  test("it resolves nothing of its own: a config that configures nothing still dispatches, and the plan's runner answers", async () => {
    const result = await akmReflect({
      ref: REF,
      stashDir: storage.stashDir,
      config: {
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        improve: {
          strategy: "default",
          strategies: { default: { processes: { reflect: { qualityGate: { enabled: false } } } } },
        },
      } as unknown as AkmConfig,
      assetContent: SOURCE,
      llmRunner: {
        kind: "harness",
        name: "frozen",
        platform: "claude",
        bin: path.join(bins.dir, "valid"),
        args: [],
        timeoutMs: null,
      },
    });

    if (!result.ok) throw new Error(`expected a proposal, got ${result.reason}: ${result.error}`);
    expect(result.engine).toBe("frozen");
    expect(claudeCalls("valid")).toHaveLength(1);
  });

  test("a plan that froze none for reflect (null) is the same error as a config that names none", async () => {
    await expect(
      akmReflect({
        ref: REF,
        stashDir: storage.stashDir,
        config: { configVersion: "0.9.0" } as AkmConfig,
        assetContent: SOURCE,
        llmRunner: null,
      }),
    ).rejects.toMatchObject({ code: "LLM_NOT_CONFIGURED" });
  });
});

describe("reflect asks every engine kind for the same JSON reply", () => {
  test.each(TRANSPORTS)("%s: the reply is queued as a proposal", async (_name, transport) => {
    const result = await reflect(transport, "valid");

    if (!result.ok) throw new Error(`expected a proposal, got ${result.reason}: ${result.error}`);
    expect(result.engine).toBe("contract");
    expect(transport.prompts("valid")).toHaveLength(1);
    const proposals = listProposals(storage.stashDir);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ source: "reflect", status: "pending", confidence: 0.8 });
    // The patch changes the description; the body is the source's.
    const content = proposals[0]?.payload.content ?? "";
    expect(parseFrontmatter(content).data).toMatchObject({
      description: PATCH.description,
      when_to_use: "When searching a source repository",
    });
    expect(splitFrontmatter(content).body).toBe(splitFrontmatter(SOURCE).body);
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
    const result = await reflect(transport, "unscoped", { ref: undefined });

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
  )("%s: a reply still invalid after the repair fails and queues nothing", async (_name, transport) => {
    const result = await reflect(transport, "invalid");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result).toMatchObject({ reason: "parse_error", engine: "contract" });
    expect(result.stdout?.trim()).toBe(PROSE);
    // The parser's own message, on every engine kind: improve feeds a failed reflect's error into later prompts.
    expect(result.error).toBe("direct reflect response was not valid JSON");
    expect(transport.prompts("invalid")).toHaveLength(2);
    expect(listProposals(storage.stashDir)).toEqual([]);
    expect(completedEvent()).toMatchObject({ ok: false, reason: "parse_error", repairAttempts: 1 });
  });
});

describe("a harness's environment", () => {
  test("model work runs in a scratch directory with the improve event source", async () => {
    await reflect(CLAUDE, "valid", { eventSource: "improve" });

    const [call] = claudeCalls("valid");
    expect(call?.eventSource).toBe("improve");
    expect(path.basename(call?.cwd ?? "")).toStartWith("akm-model-work-");
  });
});
