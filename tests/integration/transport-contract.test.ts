// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Cross-transport contract: every way akm reaches a model meets the same
 * contract, so any of them can stand in for any other. Each row runs the real
 * path, from resolveExecution through buildExecution to runExecution, against
 * local stubs only: no external network, but a loopback HTTP server and fake
 * programs that are spawned, which is why this is an integration test. The
 * transports are:
 *
 *   - connection chat: model work on a connection goes straight to its endpoint;
 *     a Bun.serve stub on 127.0.0.1 answers the real chatCompletion.
 *   - each CLI harness: a fake binary per scenario is the harness's `bin`, so the
 *     real argv builder and runAgent run. A harness reports a provider error by
 *     exiting non-zero.
 *   - internal runtime: agent work on a connection runs akm's embedded OpenCode,
 *     scripted here (`installFakeOpencodeHost`).
 *
 * The contract:
 *   C1  Success means the transport succeeded: a provider or harness error is
 *       ok:false, never ok with empty output.
 *   C2  Structured output arrives through a native channel or one uniform
 *       prompt fallback, and a stage call retries once when its own parser
 *       rejects the reply.
 *   C4  Failures and timeouts are reported the same way on every transport.
 *   C6  Every dispatch leaves one usage record.
 *   C7  Inference reaches the transport, or is reported as untranslated.
 * (Model work is confined, or runs unrestricted with a notice, on every harness:
 * `execution-pipeline.test.ts`.)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { callStage } from "../../src/commands/improve/stage";
import type { AkmConfig } from "../../src/core/config/config";
import type { UnresolvedExecutionDefaults } from "../../src/execution/source";
import { buildExecution, currentLayer, resolveExecution } from "../../src/integrations/agent/execution";
import type { RunnerSpec } from "../../src/integrations/agent/runner";
import { runExecution } from "../../src/integrations/agent/runner-dispatch";
import type { AgentRunResult } from "../../src/integrations/agent/spawn";
import { HARNESS_CONFIG_PLATFORMS } from "../../src/integrations/harnesses";
import { closeOpencodeSdk } from "../../src/integrations/harnesses/opencode/embedded/host";
import { clearLlmUsageSink, type LlmUsageRecord, setLlmUsageSink, withLlmStage } from "../../src/llm/usage-telemetry";
import { serveLlmStub } from "../_helpers/engine-stubs";
import { type FakeOpencodeCall, type FakeOpencodeReply, installFakeOpencodeHost } from "../_helpers/fake-opencode-host";
import { fakeOpencodeMajor } from "../_helpers/opencode-version";
import { makeSandboxDir, type SandboxedDir } from "../_helpers/sandbox";

beforeEach(() => fakeOpencodeMajor(1));

const PROVIDER_MESSAGE = "provider exploded: model stub-model not found";
const REPLY = '{"verdict":"ok"}';
/** Shell that counts a fake binary's calls in a file beside it, as `$n`. */
const COUNT_CALL = 'n=$(cat "$0.count" 2>/dev/null || echo 0)\nn=$((n + 1))\necho "$n" > "$0.count"\n';

/** The chat stub answers by the first path segment of the connection's endpoint. */
const CHAT_REPLIES: Record<string, (req: Request) => Response | Promise<Response>> = {
  "http-500": () => Response.json({ error: { message: PROVIDER_MESSAGE } }, { status: 500 }),
  // OpenRouter answers a provider that fails after the headers with HTTP 200
  // and a body that holds only an `error` object and no `choices`.
  "http-200-error-body": () => Response.json({ error: { code: 502, message: PROVIDER_MESSAGE } }),
  reply: () =>
    Response.json({
      choices: [{ message: { content: REPLY } }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    }),
  valid: () => Response.json({ choices: [{ message: { content: REPLY } }] }),
  // Prose first, then the reply, as a model corrected by a repair turn.
  repair: () => Response.json({ choices: [{ message: { content: chatBodies.length === 1 ? "not json" : REPLY } }] }),
  // Answers only once the client gives up.
  hang: (req) =>
    new Promise((resolve) => {
      const late = setTimeout(() => resolve(new Response("late", { status: 504 })), 5_000);
      late.unref();
      req.signal.addEventListener("abort", () => resolve(new Response("aborted", { status: 499 })));
    }),
};

/** The fake binaries, one per scenario, shared by every CLI harness. */
const CLI_SCRIPTS: Record<string, string> = {
  "exit-1": `#!/bin/sh\necho "${PROVIDER_MESSAGE}" >&2\nexit 1\n`,
  // Prints the argv it was given, then its stdin when it got one, so a row can see what reached the harness.
  reply: `#!${process.execPath}\nconst input = require("node:fs").readFileSync(0, "utf8");\nconsole.log(JSON.stringify([...process.argv.slice(2), ...(input ? [input] : [])]));\n`,
  // Prints what reached it: argv and working directory.
  probe: `#!${process.execPath}\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n`,
  // Records its pid beside itself, then outlives any timeout a row sets.
  hang: `#!/bin/sh\necho $$ > "$0.pid"\nexec sleep 30\n`,
  // Each counts its calls beside itself; repair answers prose first, then the reply.
  valid: `#!/bin/sh\n${COUNT_CALL}echo '${REPLY}'\n`,
  repair: `#!/bin/sh\n${COUNT_CALL}if [ "$n" -eq 1 ]; then echo 'not json'; else echo '${REPLY}'; fi\n`,
};

/** What the scripted OpenCode answers, per scenario; a function gets the call's number. A promise that never settles hangs. */
const RUNTIME_REPLIES: Record<string, FakeOpencodeReply | ((call: number) => FakeOpencodeReply | Promise<never>)> = {
  reply: { text: REPLY, tokens: { input: 3, output: 5 } },
  valid: { text: REPLY },
  repair: (call) => ({ text: call === 1 ? "not json" : REPLY }),
  hang: () => new Promise<never>(() => {}),
  // A provider rejection on the assistant message.
  "assistant-error": { error: { type: "provider.api", message: PROVIDER_MESSAGE } },
  // A failure OpenCode reports on the turn.
  "turn-error": { error: { type: "provider.api", message: PROVIDER_MESSAGE }, onTurn: true },
};

/** The request bodies the chat stub received, and the prompts the scripted OpenCode did, in order. */
const { server: chatStub, bodies: chatBodies } = serveLlmStub(CHAT_REPLIES);
let bins: SandboxedDir;
let runtimeCalls: FakeOpencodeCall[] = [];

beforeAll(() => {
  bins = makeSandboxDir("akm-transport-contract-bin");
  for (const [scenario, script] of Object.entries(CLI_SCRIPTS)) {
    fs.writeFileSync(path.join(bins.dir, scenario), script, { mode: 0o755 });
  }
});

afterAll(() => {
  chatStub.stop(true);
  bins.cleanup();
});

afterEach(async () => {
  await closeOpencodeSdk();
  chatBodies.length = 0;
  runtimeCalls = [];
});

/** What one dispatch delivered to its transport. */
interface Delivered {
  /** Every prompt string the transport received, joined. */
  readonly prompt: string;
  /** The schema the transport received on a native channel, if any. */
  readonly nativeSchema?: unknown;
}

interface Transport {
  readonly name: string;
  /** Whether a plain dispatch is model work: a connection's is a direct chat, an agent's is not. */
  readonly modelWork: boolean;
  /** The config that runs `scenario` on this transport, as the entry named `contract`. */
  config(scenario: string, connection?: Record<string, unknown>): Partial<AkmConfig>;
  /** The layer that selects it. */
  readonly selects: UnresolvedExecutionDefaults;
  /** Install whatever the scenario needs outside the config. */
  arrange?(scenario: string): void;
  /** What the last dispatch delivered, read after a `reply` scenario. */
  delivered(result: AgentRunResult): Delivered;
}

const chatEndpoint = (scenario: string): string => `http://127.0.0.1:${chatStub.port}/${scenario}/v1`;

const CHAT: Transport = {
  name: "connection chat",
  modelWork: true,
  selects: { connection: "contract" },
  config: (scenario, connection = {}) => ({
    connections: { contract: { endpoint: chatEndpoint(scenario), models: { fast: "stub-model" }, ...connection } },
  }),
  delivered: () => {
    const body = chatBodies.at(-1) as {
      messages: { content: string }[];
      response_format?: { json_schema?: { schema?: unknown } };
    };
    return {
      prompt: body.messages.map((message) => message.content).join("\n"),
      ...(body.response_format ? { nativeSchema: body.response_format.json_schema?.schema } : {}),
    };
  },
};

const CLI_HARNESSES: Transport[] = HARNESS_CONFIG_PLATFORMS.map((platform) => ({
  name: platform,
  modelWork: false,
  selects: { harness: "contract" },
  config: (scenario) => ({ harnesses: { contract: { platform, bin: path.join(bins.dir, scenario) } } }),
  delivered: (result) => {
    return { prompt: (JSON.parse(result.stdout) as string[]).join("\n") };
  },
}));

const RUNTIME: Transport = {
  name: "internal runtime",
  modelWork: false,
  selects: { connection: "contract" },
  config: (_scenario, connection = {}) => ({
    connections: {
      contract: { endpoint: "http://127.0.0.1:1/v1", models: { fast: "stub-model" }, ...connection },
    },
  }),
  arrange: (scenario) => {
    const reply = RUNTIME_REPLIES[scenario];
    runtimeCalls = installFakeOpencodeHost({
      reply: () => (typeof reply === "function" ? reply(runtimeCalls.length) : (reply ?? REPLY)),
    }).calls;
  },
  delivered: () => {
    const call = runtimeCalls.at(-1) as FakeOpencodeCall;
    return { prompt: [call.system ?? "", call.prompt].join("\n") };
  },
};

const ALL_TRANSPORTS: [string, Transport][] = [CHAT, ...CLI_HARNESSES, RUNTIME].map((transport) => [
  transport.name,
  transport,
]);

/** A stage call is model work: it runs on a connection's chat and on every harness, but not on the runtime, which is for agent work. */
const STAGE_TRANSPORTS: [string, Transport][] = ALL_TRANSPORTS.filter(([, transport]) => transport !== RUNTIME);

function configFor(transport: Transport, scenario: string, connection?: Record<string, unknown>): AkmConfig {
  return { configVersion: "0.9.0", semanticSearchMode: "off", ...transport.config(scenario, connection) } as AkmConfig;
}

/** The resolved runner that runs `scenario` on `transport`, for a stage call. */
function runnerFor(transport: Transport, scenario: string): RunnerSpec {
  transport.arrange?.(scenario);
  return resolveExecution({
    content: "transport selection",
    config: configFor(transport, scenario),
    layers: [currentLayer(transport.selects)],
    modelWork: true,
  }).runner;
}

/** What a row selects for one dispatch: invocation values, and whether it is model work. */
type Selection = UnresolvedExecutionDefaults & { modelWork?: boolean };

/** Resolve, build and run one dispatch of `scenario` on `transport`; the built execution comes back with the result. */
async function dispatchBuilt(
  transport: Transport,
  scenario: string,
  selection: Selection = {},
  connection?: Record<string, unknown>,
) {
  transport.arrange?.(scenario);
  const { modelWork = transport.modelWork, ...values } = selection;
  const resolved = resolveExecution({
    content: "Reply with the single word: pong",
    config: configFor(transport, scenario, connection),
    layers: [currentLayer({ ...transport.selects, ...values })],
    modelWork,
  });
  const built = buildExecution(resolved.request, resolved.runner);
  return { built, result: await runExecution(built) };
}

async function dispatch(transport: Transport, scenario: string, selection: Selection = {}): Promise<AgentRunResult> {
  return (await dispatchBuilt(transport, scenario, selection)).result;
}

/** How many times `transport` was called for `scenario` in this test. */
function calls(transport: Transport, scenario: string): number {
  if (transport === CHAT) return chatBodies.length;
  if (transport === RUNTIME) return runtimeCalls.length;
  return Number(fs.readFileSync(path.join(bins.dir, `${scenario}.count`), "utf8").trim());
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("C1: a provider or harness error is ok:false, never ok with empty output", () => {
  const rows: [string, string, Transport][] = [
    [CHAT.name, "http-500", CHAT],
    [CHAT.name, "http-200-error-body", CHAT],
    ...CLI_HARNESSES.map((harness): [string, string, Transport] => [harness.name, "exit-1", harness]),
    [RUNTIME.name, "assistant-error", RUNTIME],
    [RUNTIME.name, "turn-error", RUNTIME],
  ];

  test.each(rows)("%s: %s", async (_name, scenario, transport) => {
    const result = await dispatch(transport, scenario);

    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
    expect([result.error, result.stderr, result.stdout].join("\n")).toContain(PROVIDER_MESSAGE);
  });
});

describe("C2: structured output", () => {
  const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
  const instruction = `\n\nRespond with ONLY a JSON value matching this JSON Schema (no prose, no code fences):\n${JSON.stringify(schema)}`;
  // A connection's chat gets the schema as response_format; every agent transport gets the one instruction.
  const rows: [string, Transport, { native: boolean; instructions: number }][] = [
    [CHAT.name, CHAT, { native: true, instructions: 0 }],
    ...CLI_HARNESSES.map((harness): [string, Transport, { native: boolean; instructions: number }] => [
      harness.name,
      harness,
      { native: false, instructions: 1 },
    ]),
    [RUNTIME.name, RUNTIME, { native: false, instructions: 1 }],
  ];

  test.each(
    rows,
  )("%s: the schema reaches the transport, natively or as the instruction", async (_name, transport, want) => {
    const result = await dispatch(transport, "reply", { outputSchema: schema });

    expect(result.ok).toBe(true);
    const delivered = transport.delivered(result);
    expect(delivered.prompt.split(instruction).length - 1).toBe(want.instructions);
    expect(delivered.nativeSchema).toEqual(want.native ? schema : undefined);
  });

  // A stage call retries once when the stage's own parser rejects the reply, whatever the schema says.
  test.each(STAGE_TRANSPORTS)("%s: only a reply the stage's parser rejects is retried", async (_name, transport) => {
    for (const [parse, want, count] of [
      [(raw: string) => raw, "not json", 1],
      [undefined, REPLY, 2],
    ] as const) {
      fs.rmSync(path.join(bins.dir, "repair.count"), { force: true });
      chatBodies.length = 0;
      const outcome = await callStage({
        runner: runnerFor(transport, "repair"),
        prompt: "Reply with a verdict.",
        request: { responseSchema: schema },
        ...(parse ? { parse } : {}),
      });

      expect(outcome).toEqual({ ok: true, raw: expect.stringContaining(want) });
      expect(calls(transport, "repair")).toBe(count);
    }
  });
});

describe("C4: failures and timeouts", () => {
  test.each(ALL_TRANSPORTS)("%s: a timeout is reason timeout", async (_name, transport) => {
    const result = await dispatch(transport, "hang", { timeout: 300 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  test.each(
    CLI_HARNESSES.map((harness): [string, Transport] => [harness.name, harness]),
  )("%s: a timed-out child is killed", async (_name, transport) => {
    const pidFile = path.join(bins.dir, "hang.pid");
    fs.rmSync(pidFile, { force: true });
    await dispatch(transport, "hang", { timeout: 300 });

    expect(processAlive(Number(fs.readFileSync(pidFile, "utf8").trim()))).toBe(false);
  });

  // A stage call branches on the dispatch's reason, never on the runner's kind.
  test.each(STAGE_TRANSPORTS)("%s: a stage call reports a timeout as timeout", async (_name, transport) => {
    const outcome = await callStage({
      runner: runnerFor(transport, "hang"),
      prompt: "Reply with the single word: pong",
      request: { timeoutMs: 300 },
    });

    expect(outcome).toMatchObject({ ok: false, reason: "timeout" });
  });

  test.each(STAGE_TRANSPORTS)("%s: a stage call reports an abort as aborted", async (_name, transport) => {
    const outcome = await callStage({
      runner: runnerFor(transport, "hang"),
      prompt: "Reply with the single word: pong",
      request: { signal: AbortSignal.abort() },
    });

    expect(outcome).toMatchObject({ ok: false, reason: "aborted" });
  });

  // A caller that reports a failure the way the transport did (an agent's exit code and stderr) reads the dispatch's own result.
  test.each(STAGE_TRANSPORTS)("%s: a failed stage call keeps the dispatch's own result", async (_name, transport) => {
    const outcome = await callStage({
      runner: runnerFor(transport, transport === CHAT ? "http-500" : "exit-1"),
      prompt: "Reply with the single word: pong",
    });

    expect(outcome).toMatchObject({ ok: false, reason: "error", result: { ok: false } });
    const result = outcome.ok ? undefined : outcome.result;
    expect([result?.error, result?.stderr].join("\n")).toContain(PROVIDER_MESSAGE);
    // A CLI's exit code reaches the caller; a chat call has none.
    if (CLI_HARNESSES.includes(transport)) expect(result?.exitCode).toBe(1);
  });
});

describe("C7: inference reaches the transport, or is reported as untranslated", () => {
  const INFERENCE = { temperature: 0.2, maxTokens: 4096, enableThinking: false, reasoningEffort: "high" };
  /** A model that opencode can attach inference to: provider/model. */
  const MODEL = "krang/stub-model";

  /** The inference keys a build reported as untranslated, sorted. */
  const untranslatedKeys = (notices: readonly { code: string; field?: string | null }[]): string[] =>
    notices
      .filter((notice) => notice.code === "untranslated-field" && notice.field?.startsWith("inference."))
      .map((notice) => (notice.field ?? "").slice("inference.".length))
      .sort();

  type Probe = { argv: string[]; cwd: string };
  const probed = (result: AgentRunResult): Probe => JSON.parse(result.stdout) as Probe;

  test("connection chat: every field is sent as its wire form", async () => {
    const { built, result } = await dispatchBuilt(CHAT, "reply", { inference: INFERENCE });

    expect(result.ok).toBe(true);
    expect(untranslatedKeys(built.notices)).toEqual([]);
    expect(chatBodies.at(-1)).toMatchObject({
      temperature: 0.2,
      max_tokens: 4096,
      reasoning_effort: "high",
      chat_template_kwargs: { enable_thinking: false },
      enable_thinking: false,
    });
  });

  test("internal runtime: every field is sent as its wire form, as on a connection's chat", async () => {
    const { built, result } = await dispatchBuilt(RUNTIME, "valid", { inference: INFERENCE });

    expect(result.ok).toBe(true);
    expect(untranslatedKeys(built.notices)).toEqual([]);
    expect(runtimeCalls.at(-1)?.requestBody).toMatchObject({
      temperature: 0.2,
      max_tokens: 4096,
      reasoning_effort: "high",
      chat_template_kwargs: { enable_thinking: false },
      enable_thinking: false,
    });
  });

  // Anything else runs through the user's own harness config, where inference is set.
  test("a CLI harness sends nothing of it and reports every field untranslated", async () => {
    const sent = ({ result }: { result: AgentRunResult }) => probed(result).argv;
    for (const harness of CLI_HARNESSES) {
      const withInference = await dispatchBuilt(harness, "probe", { model: MODEL, inference: INFERENCE });
      const without = await dispatchBuilt(harness, "probe", { model: MODEL });

      expect(sent(withInference), harness.name).toEqual(sent(without));
      expect(untranslatedKeys(withInference.built.notices), harness.name).toEqual(Object.keys(INFERENCE).sort());
    }
  });

  // `effort` (`effort:` frontmatter) and `reasoningEffort` (a request, opencode's options) are one setting.
  test("an asset's `effort` is reasoningEffort on a connection's chat and on the runtime's requests", async () => {
    await dispatchBuilt(CHAT, "reply", { inference: { effort: "high" } });
    await dispatchBuilt(RUNTIME, "valid", { inference: { effort: "high" } });

    expect(chatBodies.at(-1)).toMatchObject({ reasoning_effort: "high" });
    expect(runtimeCalls.at(-1)?.requestBody).toMatchObject({ reasoning_effort: "high" });
  });
});

describe("C6: usage", () => {
  const reported = { promptTokens: 3, completionTokens: 5, totalTokens: 8 };
  // The chat path records each HTTP attempt; an agent or runtime path records the dispatch.
  const rows: [string, Transport, Partial<LlmUsageRecord>][] = [
    [CHAT.name, CHAT, reported],
    ...CLI_HARNESSES.map((harness): [string, Transport, Partial<LlmUsageRecord>] => [harness.name, harness, {}]),
    [RUNTIME.name, RUNTIME, reported],
  ];

  test.each(rows)("%s: one usage record per dispatch, attributed to its engine", async (_name, transport, tokens) => {
    const records: LlmUsageRecord[] = [];
    setLlmUsageSink((record) => records.push(record));
    try {
      const result = await withLlmStage("contract-stage", () => dispatch(transport, "reply", { model: "stub-model" }), {
        engine: "contract",
      });
      expect(result.ok).toBe(true);
    } finally {
      clearLlmUsageSink();
    }

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      stage: "contract-stage",
      engine: "contract",
      outcome: "success",
      model: "stub-model",
      ...tokens,
    });
  });
});
