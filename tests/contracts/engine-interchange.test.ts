// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Cross-engine contract: every transport meets the same contract, so any
 * engine can stand in for any other. Each row runs the real path, from
 * resolveExecution through buildExecution to runExecution, against local stubs
 * only (no network):
 *
 *   - llm: a Bun.serve stub on 127.0.0.1 answers the real chatCompletion.
 *   - every CLI harness: a fake binary per scenario is the engine's `bin`, so
 *     the real argv builder and runAgent run. A harness reports a provider
 *     error by exiting non-zero; claude 2.1.283 and opencode 1.18.25 do so
 *     against a stub that answers 400.
 *   - opencode-sdk: the runner's __setTestServer seam supplies a fake client.
 *
 * The contract:
 *   C1  Success means the transport succeeded: a provider or harness error is
 *       ok:false, never ok with empty output.
 *   C2  Structured output arrives through a native channel or one uniform
 *       prompt fallback, and is validated with one repair.
 *   C3  The model-work tool policy is confined, visibly in argv, the injected
 *       config or the prompt body, or refused at build.
 *   C4  Failures and timeouts are reported the same way on every transport.
 *   C5  Credentials akm owns are checked before dispatch.
 *   C6  Every dispatch leaves one usage record.
 *   C7  Inference reaches the transport, or is reported as untranslated.
 * C5 and C2's empty-reply case have no rows.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callStage } from "../../src/commands/improve/stage";
import type { AkmConfig } from "../../src/core/config/config";
import type { UnresolvedExecutionDefaults } from "../../src/execution/source";
import { buildExecution, resolveExecution } from "../../src/integrations/agent/execution";
import type { RunnerSpec } from "../../src/integrations/agent/runner";
import { runExecution } from "../../src/integrations/agent/runner-dispatch";
import type { AgentRunResult } from "../../src/integrations/agent/spawn";
import { HARNESS_REGISTRY } from "../../src/integrations/harnesses";
import { MODEL_WORK_OPENCODE_AGENT } from "../../src/integrations/harnesses/opencode/model-work-agent";
import {
  __setServerFactory,
  __setTestServer,
  closeServer,
} from "../../src/integrations/harnesses/opencode-sdk/sdk-runner";
import type { V1Client } from "../../src/integrations/harnesses/opencode-sdk/v1-adapter";
import { clearLlmUsageSink, type LlmUsageRecord, setLlmUsageSink, withLlmStage } from "../../src/llm/usage-telemetry";
import { serveLlmStub } from "../_helpers/engine-stubs";
import { fakeOpencodeMajor } from "../_helpers/opencode-version";
import { makeSandboxDir, type SandboxedDir, sandboxStashDir } from "../_helpers/sandbox";

beforeEach(() => fakeOpencodeMajor(1));

const PROVIDER_MESSAGE = "provider exploded: model stub-model not found";
const REPLY = '{"verdict":"ok"}';
/** Shell that counts a fake binary's calls in a file beside it, as `$n`. */
const COUNT_CALL = 'n=$(cat "$0.count" 2>/dev/null || echo 0)\nn=$((n + 1))\necho "$n" > "$0.count"\n';

/** The LLM stub answers by the first path segment of the engine's endpoint. */
const LLM_REPLIES: Record<string, (req: Request) => Response | Promise<Response>> = {
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
  repair: () => Response.json({ choices: [{ message: { content: llmBodies.length === 1 ? "not json" : REPLY } }] }),
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
  // Prints the argv it was given, so a row can see what reached the harness.
  reply: `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
  // Prints what reached it: argv, working directory and the injected opencode config.
  probe: `#!${process.execPath}\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), config: process.env.OPENCODE_CONFIG_CONTENT ?? null }));\n`,
  // Claude Code's --output-format json result envelope around the reply.
  envelope: `#!/bin/sh\necho '${JSON.stringify({ type: "result", result: REPLY, session_id: "envelope-session" })}'\n`,
  // Records its pid beside itself, then outlives any timeout a row sets.
  hang: `#!/bin/sh\necho $$ > "$0.pid"\nexec sleep 30\n`,
  // Each counts its calls beside itself; repair answers prose first, then the reply.
  valid: `#!/bin/sh\n${COUNT_CALL}echo '${REPLY}'\n`,
  repair: `#!/bin/sh\n${COUNT_CALL}if [ "$n" -eq 1 ]; then echo 'not json'; else echo '${REPLY}'; fi\n`,
};

/** A prompt call that never settles. */
const SDK_HANG = Symbol("sdk-hang");

const sdkText = (text: string) => ({ data: { info: {}, parts: [{ type: "text", text }] } });

/** What the fake SDK client's prompt call resolves to, per scenario; a function gets the call's number. */
const SDK_REPLIES: Record<string, unknown> = {
  reply: { data: { info: { tokens: { input: 3, output: 5 } }, parts: [{ type: "text", text: REPLY }] } },
  valid: sdkText(REPLY),
  repair: (call: number) => sdkText(call === 1 ? "not json" : REPLY),
  hang: SDK_HANG,
  // An HTTP error: without throwOnError the client resolves to `{ error }`.
  "client-error": { error: { name: "UnknownError", data: { message: PROVIDER_MESSAGE } } },
  // A provider rejection: HTTP 200 with the error on the assistant message.
  "info-error": {
    data: { info: { error: { name: "APIError", data: { message: PROVIDER_MESSAGE, isRetryable: false } } }, parts: [] },
  },
};

/** The request bodies the LLM stub received, and the prompt bodies the fake SDK client did, in order. */
const { server: llmStub, bodies: llmBodies } = serveLlmStub(LLM_REPLIES);
let bins: SandboxedDir;
let sdkBodies: Record<string, unknown>[] = [];

beforeAll(() => {
  bins = makeSandboxDir("akm-engine-interchange-bin");
  for (const [scenario, script] of Object.entries(CLI_SCRIPTS)) {
    fs.writeFileSync(path.join(bins.dir, scenario), script, { mode: 0o755 });
  }
});

afterAll(() => {
  llmStub.stop(true);
  bins.cleanup();
});

afterEach(async () => {
  __setTestServer(null);
  __setServerFactory(null);
  await closeServer();
  llmBodies.length = 0;
  sdkBodies = [];
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
  /** The engine config entry that runs `scenario` on this transport. */
  engine(scenario: string): Record<string, unknown>;
  /** Install whatever the scenario needs outside the engine config. */
  arrange?(scenario: string): void;
  /** What the last dispatch delivered, read after a `reply` scenario. */
  delivered(result: AgentRunResult): Delivered;
}

const LLM: Transport = {
  name: "llm",
  engine: (scenario) => ({
    kind: "llm",
    endpoint: `http://127.0.0.1:${llmStub.port}/${scenario}/v1/chat/completions`,
    model: "stub-model",
  }),
  delivered: () => {
    const body = llmBodies.at(-1) as {
      messages: { content: string }[];
      response_format?: { json_schema?: { schema?: unknown } };
    };
    return {
      prompt: body.messages.map((message) => message.content).join("\n"),
      ...(body.response_format ? { nativeSchema: body.response_format.json_schema?.schema } : {}),
    };
  },
};

const CLI_HARNESSES: Transport[] = HARNESS_REGISTRY.filter((entry) => entry.id !== "opencode-sdk").map((entry) => ({
  name: entry.id,
  engine: (scenario) => ({ kind: "agent", platform: entry.id, bin: path.join(bins.dir, scenario) }),
  delivered: (result) => {
    const argv = JSON.parse(result.stdout) as string[];
    const schemaFile = argv.includes("--output-schema") ? argv[argv.indexOf("--output-schema") + 1] : undefined;
    return {
      prompt: argv.join("\n"),
      ...(schemaFile ? { nativeSchema: JSON.parse(fs.readFileSync(schemaFile, "utf8")) } : {}),
    };
  },
}));

const OPENCODE_SDK: Transport = {
  name: "opencode-sdk",
  engine: () => ({ kind: "agent", platform: "opencode-sdk" }),
  arrange: (scenario) => {
    const reply = SDK_REPLIES[scenario];
    __setTestServer({
      client: {
        session: {
          create: async () => ({ data: { id: "contract-session" } }),
          prompt: async (args: Parameters<V1Client["session"]["prompt"]>[0]) => {
            sdkBodies.push(args.body as Record<string, unknown>);
            if (reply === SDK_HANG) return new Promise<never>(() => {});
            return (typeof reply === "function" ? reply(sdkBodies.length) : reply) as never;
          },
        },
      },
      server: { close() {} },
    });
  },
  delivered: () => {
    const body = sdkBodies.at(-1) as { system?: string; parts: { text: string }[] };
    return { prompt: [body.system ?? "", ...body.parts.map((part) => part.text)].join("\n") };
  },
};

/** The SDK transport without its fake client, for a row that inspects the server config. */
const OPENCODE_SDK_UNARRANGED: Transport = { ...OPENCODE_SDK, arrange: undefined };

/** The resolved runner that runs `scenario` on `transport`. */
function runnerFor(transport: Transport, scenario: string): RunnerSpec {
  transport.arrange?.(scenario);
  const config = { configVersion: "0.9.0", engines: { contract: transport.engine(scenario) } } as unknown as AkmConfig;
  return resolveExecution({ content: "engine selection", config, current: { engine: "contract" } }).runner;
}

/** What a row selects for one dispatch: invocation values, and whether it is model work. */
type Selection = UnresolvedExecutionDefaults & { modelWork?: boolean };

/** Resolve, build and run one dispatch of `scenario` on `transport`. */
async function dispatch(transport: Transport, scenario: string, selection: Selection = {}): Promise<AgentRunResult> {
  transport.arrange?.(scenario);
  const config = { configVersion: "0.9.0", engines: { contract: transport.engine(scenario) } } as unknown as AkmConfig;
  const { modelWork, ...current } = selection;
  const resolved = resolveExecution({
    content: "Reply with the single word: pong",
    config,
    current: { engine: "contract", ...current },
    modelWork,
  });
  return runExecution(buildExecution(resolved.request, resolved.runner));
}

const ALL_TRANSPORTS: [string, Transport][] = [LLM, ...CLI_HARNESSES, OPENCODE_SDK].map((transport) => [
  transport.name,
  transport,
]);

/** A stage call is model work: it runs on the transports that confine the model-work tool policy. */
const MODEL_WORK_TRANSPORTS = ALL_TRANSPORTS.filter(
  ([name]) => name === LLM.name || HARNESS_REGISTRY.some((entry) => entry.id === name && entry.capabilities.modelWork),
);

/** How many times `transport` was called for `scenario` in this test. */
function calls(transport: Transport, scenario: string): number {
  if (transport === LLM) return llmBodies.length;
  if (transport === OPENCODE_SDK) return sdkBodies.length;
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
    [LLM.name, "http-500", LLM],
    [LLM.name, "http-200-error-body", LLM],
    ...CLI_HARNESSES.map((harness): [string, string, Transport] => [harness.name, "exit-1", harness]),
    [OPENCODE_SDK.name, "client-error", OPENCODE_SDK],
    [OPENCODE_SDK.name, "info-error", OPENCODE_SDK],
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
  // An LLM gets the schema as response_format; every agent transport gets the
  // one instruction, and codex also gets its --output-schema file.
  const rows: [string, Transport, { native: boolean; instructions: number }][] = [
    [LLM.name, LLM, { native: true, instructions: 0 }],
    ...CLI_HARNESSES.map((harness): [string, Transport, { native: boolean; instructions: number }] => [
      harness.name,
      harness,
      { native: harness.name === "codex", instructions: 1 },
    ]),
    [OPENCODE_SDK.name, OPENCODE_SDK, { native: false, instructions: 1 }],
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
  test.each(
    MODEL_WORK_TRANSPORTS,
  )("%s: only a reply the stage's parser rejects is retried", async (_name, transport) => {
    for (const [parse, want, count] of [
      [(raw: string) => raw, "not json", 1],
      [undefined, REPLY, 2],
    ] as const) {
      fs.rmSync(path.join(bins.dir, "repair.count"), { force: true });
      const outcome = await callStage({
        feature: "distill",
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

describe("C3: the model-work tool policy is confined or refused at build", () => {
  const modelWork = { modelWork: true };
  const PROMPT = "Reply with the single word: pong";

  let stash: SandboxedDir;
  beforeEach(() => {
    stash = sandboxStashDir();
  });
  afterEach(() => stash.cleanup());

  /**
   * The permission block the injected opencode agent must carry, checked against opencode 1.18.25. Its order is part
   * of the rule, since opencode lets the last match win, so rows compare it as JSON.
   */
  const opencodeRules = () =>
    JSON.stringify({
      "*": "deny",
      read: "allow",
      grep: "allow",
      glob: "allow",
      edit: { "*": "allow", [`${stash.dir.slice(1)}/*`]: "deny" },
      external_directory: { [`${stash.dir}/*`]: "allow", "~/.local/share/opencode/tool-output/*": "deny" },
      akm_search: "allow",
      akm_show: "allow",
      akm_feedback: "deny",
      akm_remember: "deny",
      akm_curate: "deny",
      bash: "deny",
      doom_loop: "deny",
      list: "deny",
      lsp: "deny",
      question: "deny",
      skill: "deny",
      task: "deny",
      todowrite: "deny",
      webfetch: "deny",
      websearch: "deny",
    });

  /** What the fake `probe` binary saw of one model-work dispatch on the CLI harness `name`. */
  async function probeModelWork(name: string) {
    const transport = CLI_HARNESSES.find((harness) => harness.name === name) as Transport;
    const result = await dispatch(transport, "probe", modelWork);
    const seen = JSON.parse(result.stdout) as { argv: string[]; cwd: string; config: string | null };
    // Its own scratch working directory, removed after the dispatch.
    expect(path.basename(seen.cwd)).toStartWith("akm-model-work-");
    expect(fs.existsSync(seen.cwd)).toBe(false);
    return { argv: seen.argv, config: seen.config === null ? null : JSON.parse(seen.config) };
  }

  test("llm: an LLM gets no tools, which meets the policy", async () => {
    const result = await dispatch(LLM, "reply", modelWork);

    expect(result.ok).toBe(true);
    expect(llmBodies.at(-1)).not.toHaveProperty("tools");
  });

  // Checked against Claude Code 2.1.283: see MODEL_WORK_CLAUDE_FLAGS.
  test("claude: the model is offered Read, Edit, and akm search and show, and denied the rest", async () => {
    const { argv } = await probeModelWork("claude");
    const value = (flag: string) => argv[argv.indexOf(flag) + 1];

    expect(value("--tools")).toBe("Read,Edit,Bash");
    expect(value("--allowedTools")).toBe("Read,Edit,Bash(akm search *),Bash(akm show *)");
    expect(value("--permission-mode")).toBe("dontAsk");
    expect(argv).toContain("--restricted");
    expect(argv).toContain("--strict-mcp-config");
  });

  test("opencode: the confined agent is the one selected, with the stash readable and nothing writable but its working directory", async () => {
    const { argv, config } = await probeModelWork("opencode");

    expect(argv.slice(argv.indexOf("--agent"), argv.indexOf("--agent") + 2)).toEqual([
      "--agent",
      MODEL_WORK_OPENCODE_AGENT,
    ]);
    expect(JSON.stringify(config.permission)).toBe(opencodeRules());
    expect(JSON.stringify(config.agent[MODEL_WORK_OPENCODE_AGENT].permission)).toBe(opencodeRules());
  });

  // Model work, a stage call for one, runs only where the policy is confined.
  test.each(
    ALL_TRANSPORTS.filter((row) => !MODEL_WORK_TRANSPORTS.includes(row)),
  )("%s: a stage call is refused before dispatch", async (_name, transport) => {
    fs.rmSync(path.join(bins.dir, "valid.count"), { force: true });
    await expect(
      callStage({ feature: "distill", runner: runnerFor(transport, "valid"), prompt: "Reply with a verdict." }),
    ).rejects.toThrow(/cannot enforce the model-work tool policy/);
    expect(fs.existsSync(path.join(bins.dir, "valid.count"))).toBe(false);
  });

  test("claude: a stage call gets the answer out of claude's result envelope", async () => {
    const outcome = await callStage({
      feature: "distill",
      runner: runnerFor(CLI_HARNESSES.find((harness) => harness.name === "claude") as Transport, "envelope"),
      prompt: "Reply with a verdict.",
      request: { responseSchema: { type: "object", properties: { verdict: { type: "string" } } } },
    });

    expect(outcome).toEqual({ ok: true, raw: REPLY });
  });

  test("opencode-sdk: the server defines the confined agent and the prompt selects it", async () => {
    let started: { config?: Record<string, unknown> } | undefined;
    const queries: unknown[] = [];
    __setServerFactory(async (options) => {
      started = options;
      return {
        client: {
          session: {
            create: async (args: Parameters<V1Client["session"]["create"]>[0]) => {
              queries.push(args.query);
              return { data: { id: "contract-session" } };
            },
            prompt: async (args: Parameters<V1Client["session"]["prompt"]>[0]) => {
              sdkBodies.push(args.body as Record<string, unknown>);
              return sdkText(REPLY) as never;
            },
          },
        },
        server: { close() {} },
      };
    });
    // Not dispatch(): its arrange installs a test server, which bypasses the server config.
    const config = {
      configVersion: "0.9.0",
      engines: { contract: OPENCODE_SDK.engine("valid") },
    } as unknown as AkmConfig;
    const resolved = resolveExecution({ content: PROMPT, config, current: { engine: "contract" }, modelWork: true });
    const result = await runExecution(buildExecution(resolved.request, resolved.runner));

    expect(result.ok).toBe(true);
    const serverConfig = started?.config as { permission: unknown; agent: Record<string, { permission: unknown }> };
    expect(JSON.stringify(serverConfig.permission)).toBe(opencodeRules());
    expect(JSON.stringify(serverConfig.agent[MODEL_WORK_OPENCODE_AGENT]?.permission)).toBe(opencodeRules());
    expect(sdkBodies.at(-1)).toMatchObject({ agent: MODEL_WORK_OPENCODE_AGENT });
    expect(sdkBodies.at(-1)).not.toHaveProperty("tools");
    const directory = (queries[0] as { directory: string }).directory;
    expect(path.basename(directory)).toStartWith("akm-model-work-");
    expect(directory.startsWith(fs.realpathSync(os.tmpdir())) || directory.startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(directory)).toBe(false);
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
  test.each(MODEL_WORK_TRANSPORTS)("%s: a stage call reports a timeout as timeout", async (_name, transport) => {
    const outcome = await callStage({
      feature: "distill",
      runner: runnerFor(transport, "hang"),
      prompt: "Reply with the single word: pong",
      request: { timeoutMs: 300 },
    });

    expect(outcome).toMatchObject({ ok: false, reason: "timeout" });
  });

  test.each(MODEL_WORK_TRANSPORTS)("%s: a stage call reports an abort as aborted", async (_name, transport) => {
    const outcome = await callStage({
      feature: "distill",
      runner: runnerFor(transport, "hang"),
      prompt: "Reply with the single word: pong",
      request: { signal: AbortSignal.abort() },
    });

    expect(outcome).toMatchObject({ ok: false, reason: "aborted" });
  });

  // A caller that reports a failure the way the transport did (an agent's exit code and stderr) reads the dispatch's own result.
  const FAILING_SCENARIOS: Record<string, string> = {
    llm: "http-500",
    claude: "exit-1",
    opencode: "exit-1",
    "opencode-sdk": "client-error",
  };

  test.each(
    MODEL_WORK_TRANSPORTS,
  )("%s: a failed stage call keeps the dispatch's own result", async (name, transport) => {
    const outcome = await callStage({
      feature: "distill",
      runner: runnerFor(transport, FAILING_SCENARIOS[name] ?? ""),
      prompt: "Reply with the single word: pong",
    });

    expect(outcome).toMatchObject({ ok: false, reason: "error", result: { ok: false } });
    const result = outcome.ok ? undefined : outcome.result;
    expect([result?.error, result?.stderr].join("\n")).toContain(PROVIDER_MESSAGE);
    // A CLI's exit code reaches the caller; an LLM or SDK call has none.
    if (CLI_HARNESSES.some((harness) => harness.name === name)) expect(result?.exitCode).toBe(1);
  });
});

describe("C7: inference reaches the transport, or is reported as untranslated", () => {
  const PROMPT = "Reply with the single word: pong";
  const INFERENCE = {
    temperature: 0.2,
    maxTokens: 4096,
    contextLength: 120000,
    enableThinking: false,
    reasoningEffort: "high",
  };
  /** A model that opencode can attach inference to: provider/model. */
  const MODEL = "krang/stub-model";

  /** The inference keys a build reported as untranslated, sorted. */
  const untranslatedKeys = (notices: readonly { code: string; field?: string | null }[]): string[] =>
    notices
      .filter((notice) => notice.code === "untranslated-field" && notice.field?.startsWith("inference."))
      .map((notice) => (notice.field ?? "").slice("inference.".length))
      .sort();

  /** Resolve, build and run one dispatch, returning the result and the build's untranslated inference keys. */
  async function dispatchBuilt(
    transport: Transport,
    scenario: string,
    selection: Selection,
    engines?: Record<string, unknown>,
  ): Promise<{ result: AgentRunResult; untranslated: string[] }> {
    transport.arrange?.(scenario);
    const config = {
      configVersion: "0.9.0",
      engines: engines ?? { contract: transport.engine(scenario) },
    } as unknown as AkmConfig;
    const { modelWork, ...current } = selection;
    const resolved = resolveExecution({
      content: PROMPT,
      config,
      current: { engine: "contract", ...current },
      modelWork,
    });
    const built = buildExecution(resolved.request, resolved.runner);
    return { result: await runExecution(built), untranslated: untranslatedKeys(built.notices) };
  }

  type Probe = { argv: string[]; cwd: string; config: string | null };
  const probed = (result: AgentRunResult): Probe => JSON.parse(result.stdout) as Probe;

  test("llm: every field is sent as its wire form", async () => {
    const { result, untranslated } = await dispatchBuilt(LLM, "reply", { inference: INFERENCE });

    expect(result.ok).toBe(true);
    expect(untranslated).toEqual([]);
    expect(llmBodies.at(-1)).toMatchObject({
      temperature: 0.2,
      max_tokens: 4096,
      reasoning_effort: "high",
      chat_template_kwargs: { enable_thinking: false },
      enable_thinking: false,
    });
  });

  // opencode makes a title call of its own on the model and applies the
  // model's options to it; the model-work agent is akm's, so its options reach
  // only the work. The model itself is the user's, in the user's opencode config.
  test("opencode: model work puts the options on the confined agent, and nothing on the model", async () => {
    const opencode = CLI_HARNESSES.find((harness) => harness.name === "opencode") as Transport;
    const { result, untranslated } = await dispatchBuilt(opencode, "probe", {
      model: MODEL,
      inference: INFERENCE,
      modelWork: true,
    });
    const config = JSON.parse(probed(result).config ?? "null");

    // The limit is the model's, which akm does not write for a CLI dispatch.
    expect(untranslated).toEqual(["contextLength", "maxTokens"]);
    expect(config.agent[MODEL_WORK_OPENCODE_AGENT].options).toEqual({
      temperature: 0.2,
      reasoningEffort: "high",
      chat_template_kwargs: { enable_thinking: false },
      enable_thinking: false,
    });
    expect(config).not.toHaveProperty("provider");
  });

  test("opencode-sdk: the server config gives the llmEngine fallback's model every field", async () => {
    let started: { config?: Record<string, unknown> } | undefined;
    __setServerFactory(async (options) => {
      started = options;
      return {
        client: {
          session: {
            create: async () => ({ data: { id: "contract-session" } }),
            prompt: async () => sdkText(REPLY) as never,
          },
        },
        server: { close() {} },
      };
    });
    const engines = {
      contract: { kind: "agent", platform: "opencode-sdk", llmEngine: "backing" },
      backing: { kind: "llm", endpoint: "http://127.0.0.1:1/v1/chat/completions", model: "stub-model" },
    };
    // Not the arranged transport: its fake client bypasses the server config.
    const { result } = await dispatchBuilt(OPENCODE_SDK_UNARRANGED, "valid", { inference: INFERENCE }, engines);

    expect(result.ok).toBe(true);
    const provider = started?.config?.provider as Record<string, { models: Record<string, unknown> }>;
    expect(provider["akm-custom"]?.models).toEqual({
      "stub-model": {
        options: {
          temperature: 0.2,
          reasoningEffort: "high",
          chat_template_kwargs: { enable_thinking: false },
          enable_thinking: false,
        },
        limit: { context: 120000, output: 4096 },
      },
    });
  });

  // Anything else runs through the user's own engine config, where inference is set.
  test("any other dispatch sends nothing and reports every field untranslated, on every CLI harness", async () => {
    const sent = ({ result }: { result: AgentRunResult }) => {
      const { argv, config } = probed(result);
      return { argv, config };
    };
    for (const harness of CLI_HARNESSES) {
      const withInference = await dispatchBuilt(harness, "probe", { model: MODEL, inference: INFERENCE });
      const without = await dispatchBuilt(harness, "probe", { model: MODEL });

      expect(sent(withInference)).toEqual(sent(without));
      expect(withInference.untranslated).toEqual(Object.keys(INFERENCE).sort());
    }
  });

  // `effort` (a models.json alias, `effort:` frontmatter) and `reasoningEffort`
  // (an LLM request, opencode's options) are one setting.
  test("an alias's `effort` is reasoningEffort on an LLM and on model work's agent", async () => {
    await dispatchBuilt(LLM, "reply", { inference: { effort: "high" } });
    const opencode = await dispatchBuilt(
      CLI_HARNESSES.find((harness) => harness.name === "opencode") as Transport,
      "probe",
      { inference: { effort: "high" }, modelWork: true },
    );

    expect(llmBodies.at(-1)).toMatchObject({ reasoning_effort: "high" });
    expect(JSON.parse(probed(opencode.result).config ?? "null").agent[MODEL_WORK_OPENCODE_AGENT].options).toEqual({
      reasoningEffort: "high",
    });
  });
});

describe("C6: usage", () => {
  const reported = { promptTokens: 3, completionTokens: 5, totalTokens: 8 };
  // The LLM path records each HTTP attempt; an agent or SDK path records the dispatch.
  const rows: [string, Transport, Partial<LlmUsageRecord>][] = [
    [LLM.name, LLM, reported],
    ...CLI_HARNESSES.map((harness): [string, Transport, Partial<LlmUsageRecord>] => [harness.name, harness, {}]),
    [OPENCODE_SDK.name, OPENCODE_SDK, reported],
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
