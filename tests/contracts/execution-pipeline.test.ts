// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The execution pipeline end to end, through its observable edges: the argv a
 * harness receives, the connection a chat call or the internal runtime receives,
 * and the request/runner a workflow journals.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { renderMarkdownExecutionSource } from "../../src/core/adapter/execution-source";
import type { AkmConfig } from "../../src/core/config/config";
import { effectiveRequestFields } from "../../src/core/llm-inference";
import type { SpawnedSubprocess, SpawnFn } from "../../src/core/subprocess";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { canonicalResolvedExecutionRequest, createResolvedPersona } from "../../src/execution/resolved-request";
import {
  buildExecution,
  buildExecutionFromWire,
  currentLayer,
  type ResolveExecutionInput,
  resolveExecution,
} from "../../src/integrations/agent/execution";
import { runExecution } from "../../src/integrations/agent/runner-dispatch";
import { getHarness, HARNESS_CONFIG_PLATFORMS } from "../../src/integrations/harnesses";
import type { ChatCompletionConfig } from "../../src/llm/client";
import { fakeOpencodeMajor } from "../_helpers/opencode-version";
import { withEnv } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

beforeEach(() => fakeOpencodeMajor(1));

function exitedWith(stdout: string, stdin?: WritableStream<Uint8Array>): SpawnedSubprocess {
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  return { exitCode: 0, exited: Promise.resolve(0), stdout: stream(stdout), stderr: stream(""), stdin, kill() {} };
}

/** Resolve, build and run one execution, returning the argv, env and stdin the child would get. */
async function spawnedFor(
  input: ResolveExecutionInput,
): Promise<{ argv: string[]; env: Record<string, string>; stdin: string }> {
  const resolved = resolveExecution(input);
  let argv: string[] = [];
  let env: Record<string, string> = {};
  let stdin = "";
  const decoder = new TextDecoder();
  const spawn: SpawnFn = (cmd, options) => {
    argv = cmd;
    env = options.env ?? {};
    return exitedWith(
      "done",
      new WritableStream<Uint8Array>({
        write(chunk) {
          stdin += decoder.decode(chunk, { stream: true });
        },
      }),
    );
  };
  const result = await runExecution(buildExecution(resolved.request, resolved.runner), { runOptions: { spawn } });
  expect(result.ok).toBe(true);
  return { argv, env, stdin };
}

function config(partial: Record<string, unknown>): AkmConfig {
  return { configVersion: "0.9.0", ...partial } as unknown as AkmConfig;
}

const LAB = {
  endpoint: "https://llm.invalid/v1/chat/completions",
  apiKey: "$AKM_PIPELINE_TEST_KEY",
  models: { fast: "local/qwen", balanced: "local/qwen" },
};

function reviewer() {
  return createResolvedPersona(
    renderMarkdownExecutionSource({
      kind: "persona",
      raw: "---\ndescription: reviewer\n---\nYou review carefully.\n",
      identity: { ref: "fixture//agents/reviewer", bundle: "fixture", adapter: "akm", file: "agents/reviewer.md" },
      defaults: {},
    }),
  );
}

describe("harnesses: config harness → argv", () => {
  test("claude gets the alias-resolved model, the persona as its system prompt, and the prompt", async () => {
    const { argv } = await spawnedFor({
      content: "Review the diff.",
      config: config({ harnesses: { claude: {} } }),
      persona: reviewer(),
      layers: [currentLayer({ model: "fast" })],
    });
    expect(argv).toEqual([
      "claude",
      "--system-prompt",
      "You review carefully.\n",
      "--model",
      "claude-haiku-4-5-20251001",
      "--print",
      "--",
      "Review the diff.",
    ]);
  });

  test("opencode gets the persona composed into its prompt, since `opencode run` has no --system-prompt", async () => {
    const { argv, stdin } = await spawnedFor({
      content: "Review the diff.",
      config: config({ harnesses: { oc: { platform: "opencode" } } }),
      persona: reviewer(),
    });
    expect(argv).toEqual(["opencode", "run"]);
    expect(stdin).toBe("<AKM_PERSONA>\nYou review carefully.\n</AKM_PERSONA>\n\nReview the diff.");
  });

  test("opencode replaces its profile model flag with the harness's model for the alias", async () => {
    const { argv, stdin } = await spawnedFor({
      content: "Summarise.",
      config: config({
        harnesses: { oc: { platform: "opencode", models: { balanced: "opencode/claude-sonnet-4-6" } } },
      }),
      layers: [currentLayer({ model: "balanced" })],
    });
    expect(argv).toEqual(["opencode", "run", "--model", "opencode/claude-sonnet-4-6"]);
    expect(stdin).toBe("Summarise.");
  });

  test("pi passes an exact model through untouched and composes nothing it has no channel for", async () => {
    const { argv } = await spawnedFor({
      content: "Plan it.",
      config: config({ harnesses: { pi: {} } }),
      layers: [currentLayer({ harness: "pi", model: "provider/exact" })],
    });
    expect(argv).toEqual(["pi", "--model", "provider/exact", "-p", "--", "Plan it."]);
  });

  test("a harness that maps other aliases but not this one passes none, and notes it once", () => {
    const warnings: string[] = [];
    _resetWarnOnceForTests();
    overrideSeam(_setWarnSinkForTests, (level: string, args: unknown[]) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    const resolved = resolveExecution({
      content: "Think.",
      config: config({ harnesses: { pi: { models: { fast: "provider/small" } } } }),
      layers: [currentLayer({ model: "reasoning" })],
    });
    expect(resolved.request.model).toBeUndefined();
    expect(warnings.filter((w) => w.includes('Harness "pi" has no model for "reasoning"'))).toHaveLength(1);
  });

  // `effort` (`effort:` frontmatter) and `reasoningEffort` (OpenCode, the LLM request)
  // are one setting, with one word in the request: the nearest layer wins
  // whichever word it used.
  describe("one word for reasoning effort", () => {
    const harness = { harnesses: { oc: { platform: "opencode" } } };

    test("a nearer reasoningEffort overrides a farther effort", () => {
      const resolved = resolveExecution({
        content: "Think.",
        config: config(harness),
        layers: [
          { kind: "command", id: "command", values: { inference: { effort: "high" } } },
          currentLayer({ inference: { reasoningEffort: "low" } }),
        ],
      });

      expect(resolved.request.inference).toEqual({ reasoningEffort: "low" });
    });

    test("in one inference object reasoningEffort wins over effort", () => {
      const resolved = resolveExecution({
        content: "Think.",
        config: config(harness),
        layers: [currentLayer({ inference: { effort: "high", reasoningEffort: "low" } })],
      });

      expect(resolved.request.inference).toEqual({ reasoningEffort: "low" });
    });

    test("an explicit null effort is a null reasoningEffort", () => {
      const resolved = resolveExecution({
        content: "Think.",
        config: config(harness),
        layers: [currentLayer({ inference: { effort: null } })],
      });

      expect(resolved.request.inference).toEqual({ reasoningEffort: null });
    });

    test("the request never carries the other word", () => {
      const resolved = resolveExecution({
        content: "Think.",
        config: config(harness),
        layers: [currentLayer({ inference: { effort: "high", temperature: 0 } })],
      });

      expect(resolved.request.inference).not.toHaveProperty("effort");
      expect(Object.keys(resolved.provenance).filter((key) => key.endsWith("/effort"))).toEqual([]);
    });
  });
});

describe("a connection running agent work: akm's internal runtime", () => {
  test("runs the connection's model, timeout and credential", async () => {
    const resolved = resolveExecution({
      content: "Draft it.",
      config: config({ connections: { local: { ...LAB, timeoutMs: 90_000 } } }),
    });
    expect(resolved.request.target).toEqual({ name: "local", kind: "connection" });
    expect(resolved.request.model).toEqual({ model: "local/qwen" });
    expect(resolved.runner.timeoutMs).toBe(90_000);

    await withEnv({ AKM_PIPELINE_TEST_KEY: "sk-runtime" }, async () => {
      let seen: { model?: string; connection?: { apiKey?: string; endpoint?: string } } = {};
      const result = await runExecution(buildExecution(resolved.request, resolved.runner), {
        runSdk: async (profile, _prompt, _opts, connection) => {
          seen = { model: profile.model, connection };
          return { ok: true, exitCode: 0, stdout: `used ${connection?.apiKey}`, stderr: "", durationMs: 1 };
        },
      });
      expect(seen.model).toBe("local/qwen");
      expect(seen.connection).toMatchObject({ apiKey: "sk-runtime", endpoint: LAB.endpoint });
      expect(result.stdout).toBe("used [REDACTED]");
    });
  });

  test("a harness is preferred over a connection for agent work", () => {
    const resolved = resolveExecution({
      content: "Draft it.",
      config: config({ connections: { local: LAB }, harnesses: { pi: {} } }),
    });
    expect(resolved.request.target).toEqual({ name: "pi", kind: "harness", platform: "pi" });
  });

  test("a conversation prefix is composed into one prompt block for CLI harnesses", () => {
    const resolved = resolveExecution({
      content: "Now finish.",
      config: config({ harnesses: { pi: {} } }),
      conversation: [{ role: "assistant", content: "First draft." }],
    });
    const built = buildExecution(resolved.request, resolved.runner);
    expect(built.prompt).toContain("First draft.");
    expect(built.prompt.endsWith("\n\nNow finish.")).toBe(true);
    expect(built.notices.map((notice) => notice.code)).toEqual(["conversation-prompt-composed"]);
  });
});

describe("target selection", () => {
  const harnesses = { default: { platform: "claude" }, pi: {} };

  test("the nearest layer that names a target wins, then the default by name", () => {
    const base = { content: "x", config: config({ harnesses }) };
    expect(resolveExecution(base).request.target.name).toBe("default");
    expect(
      resolveExecution({ ...base, layers: [{ kind: "command", id: "cmd", values: { harness: "pi" } }] }).request.target
        .name,
    ).toBe("pi");
    const nearest = resolveExecution({
      ...base,
      layers: [{ kind: "command", id: "cmd", values: { harness: "pi" } }, currentLayer({ harness: "default" })],
    });
    expect(nearest.request.target.name).toBe("default");
    expect(nearest.provenance.target).toEqual({ layer: "current-invocation", kind: "current", via: "explicit" });
  });

  test("a named target that is not configured warns once and uses the default", () => {
    const warnings: string[] = [];
    _resetWarnOnceForTests();
    overrideSeam(_setWarnSinkForTests, (level: string, args: unknown[]) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    const input = { content: "x", config: config({ harnesses }), layers: [currentLayer({ harness: "codex" })] };
    expect(resolveExecution(input).request.target.name).toBe("default");
    expect(resolveExecution(input).request.target.name).toBe("default");
    expect(warnings.filter((w) => w.includes('"codex" is not configured'))).toHaveLength(1);
  });

  test("with nothing configured there is nothing to run on, whatever is on PATH", async () => {
    await withEnv({ PATH: "" }, () => {
      expect(() => resolveExecution({ content: "x", config: config({}) })).toThrow(/nothing to run agent work on/);
    });
  });
});

describe("connections: config connection → chat call", () => {
  test("the credential is read at dispatch, never frozen into the resolved runner", async () => {
    await withEnv({ AKM_PIPELINE_TEST_KEY: "sk-resolve-time" }, async () => {
      const resolved = resolveExecution({
        content: "Classify this.",
        config: config({ connections: { local: LAB } }),
        layers: [currentLayer({ connection: "local", outputSchema: { type: "object" }, timeout: "2m" })],
        conversation: [{ role: "assistant", content: "Earlier draft." }],
        persona: reviewer(),
        modelWork: true,
      });
      expect(JSON.stringify(resolved)).not.toContain("sk-");
      const built = buildExecution(resolved.request, resolved.runner);
      process.env.AKM_PIPELINE_TEST_KEY = "sk-dispatch-time";
      let seen: { apiKey?: string; messages: unknown; responseSchema?: unknown; timeoutMs?: unknown } | undefined;
      const result = await runExecution(built, {
        chat: async (connection, messages, options) => {
          seen = { apiKey: connection.apiKey, messages, ...options };
          return `echo ${connection.apiKey}`;
        },
      });
      expect(seen?.apiKey).toBe("sk-dispatch-time");
      expect(seen?.messages).toEqual([
        { role: "system", content: "You review carefully.\n" },
        { role: "assistant", content: "Earlier draft." },
        { role: "user", content: "Classify this." },
      ]);
      expect(seen?.responseSchema).toEqual({ type: "object" });
      expect(seen?.timeoutMs).toBe(120_000);
      expect(result.stdout).toBe("echo [REDACTED]");
    });
  });

  test("a key variable that is unset is named once and the request goes without a key", async () => {
    const warnings: string[] = [];
    _resetWarnOnceForTests();
    overrideSeam(_setWarnSinkForTests, (level: string, args: unknown[]) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    await withEnv({ AKM_PIPELINE_TEST_KEY: undefined }, async () => {
      const resolved = resolveExecution({
        content: "x",
        config: config({ connections: { local: LAB } }),
        modelWork: true,
      });
      const built = buildExecution(resolved.request, resolved.runner);
      let apiKey: string | undefined = "unset";
      await runExecution(built, {
        chat: async (connection) => {
          apiKey = connection.apiKey;
          return "ok";
        },
      });
      expect(apiKey).toBeUndefined();
      expect(warnings.filter((w) => w.includes("AKM_PIPELINE_TEST_KEY"))).toHaveLength(1);
    });
  });

  test("the connection's request fields reach the chat call as written, under the layers' inference", async () => {
    const resolved = resolveExecution({
      content: "x",
      config: config({
        connections: {
          local: { ...LAB, top_p: 0.9, models: { fast: { model: "local/qwen", temperature: 0.1 } } },
        },
      }),
      layers: [currentLayer({ inference: { temperature: 0 } })],
      modelWork: true,
    });
    let seen: Pick<ChatCompletionConfig, "request" | "inference"> = {};
    await runExecution(buildExecution(resolved.request, resolved.runner), {
      chat: async (connection) => {
        seen = { request: connection.request, inference: connection.inference };
        return "ok";
      },
    });
    // The connection's and the model entry's fields as written; the layers' settings beside them, translated when sent.
    expect(seen).toEqual({ request: { top_p: 0.9, temperature: 0.1 }, inference: { temperature: 0 } });
    expect(effectiveRequestFields(seen.request, seen.inference)).toEqual({ top_p: 0.9, temperature: 0 });
  });
});

describe("provenance and notices", () => {
  test("each field names the layer that set it", () => {
    const resolved = resolveExecution({
      content: "x",
      config: config({ connections: { local: { ...LAB, timeoutMs: 1000, temperature: 0.5 } } }),
      layers: [
        { kind: "command", id: "fixture//commands/review", values: { model: "exact/model" } },
        currentLayer({ timeout: 5000 }),
      ],
    });
    expect(resolved.provenance).toMatchObject({
      target: { layer: "installation-defaults", kind: "installation", via: "explicit" },
      model: { layer: "fixture//commands/review", kind: "command", via: "explicit" },
      "runtime.timeoutMs": { layer: "current-invocation", kind: "current", via: "explicit" },
    });
    expect(resolved.runner.timeoutMs).toBe(5000);
  });

  test("a field a transport cannot carry is noted, not refused", () => {
    const resolved = resolveExecution({
      content: "x",
      config: config({ harnesses: { oc: { platform: "opencode" } } }),
      layers: [currentLayer({ outputSchema: { type: "object" }, inference: { vendorKnob: 1 } })],
    });
    const built = buildExecution(resolved.request, resolved.runner);
    // The schema travels as the prompt instruction, so only the inference knob is noted.
    expect(built.notices.map((notice) => notice.field)).toEqual(["inference.vendorKnob"]);
  });
});

describe("resume from the journaled wire form", () => {
  test("a config edit after the freeze does not change what a resumed unit runs", async () => {
    const live = config({
      harnesses: {
        oc: { platform: "opencode", models: { fast: "provider/frozen" }, bin: "opencode-frozen" },
      },
    });
    const resolved = resolveExecution({ content: "Resume me.", config: live });
    const frozen = buildExecution(resolved.request, resolved.runner);
    const wire = JSON.parse(
      JSON.stringify({ request: JSON.parse(canonicalResolvedExecutionRequest(frozen.request)), runner: frozen.runner }),
    );

    // The operator repoints the harness after the freeze.
    (live.harnesses as Record<string, unknown>).oc = { platform: "claude", models: { fast: "provider/new" } };

    const resumed = buildExecutionFromWire(wire);
    let argv: string[] = [];
    let stdin = "";
    await runExecution(resumed, {
      runOptions: {
        spawn: (cmd) => {
          argv = cmd;
          return exitedWith(
            "ok",
            new WritableStream<Uint8Array>({
              write(chunk) {
                stdin += new TextDecoder().decode(chunk);
              },
            }),
          );
        },
      },
    });
    expect(argv).toEqual(["opencode-frozen", "run", "--model", "provider/frozen"]);
    expect(stdin).toBe("Resume me.");
  });

  test("the wire decoder tolerates unknown keys and fills missing runner defaults", () => {
    const built = buildExecutionFromWire({
      request: {
        ...JSON.parse(
          canonicalResolvedExecutionRequest(
            resolveExecution({ content: "x", config: config({ harnesses: { pi: {} } }) }).request,
          ),
        ),
        addedByANewerRelease: true,
      },
      runner: { kind: "harness", name: "pi", platform: "pi", bin: "pi", legacyField: 1 },
    });
    expect(built.runner).toMatchObject({ kind: "harness", name: "pi", platform: "pi", bin: "pi", args: [] });
    expect(built.prompt).toBe("x");
  });
});

describe("dispatch options", () => {
  test("only operational run options apply; eventSource stamps AKM_EVENT_SOURCE", async () => {
    const resolved = resolveExecution({
      content: "x",
      config: config({ harnesses: { pi: {} } }),
      layers: [currentLayer({ environment: { KEEP: "request-value" }, timeout: 1000 })],
    });
    let env: Record<string, string> = {};
    let cwd: string | undefined;
    await runExecution(buildExecution(resolved.request, resolved.runner), {
      eventSource: "task",
      runOptions: {
        env: { KEEP: "caller-override" },
        cwd: "/ignored",
        spawn: (_cmd, options) => {
          env = options.env ?? {};
          cwd = options.cwd;
          return exitedWith("ok");
        },
      },
    });
    expect(env.KEEP).toBe("request-value");
    expect(env.AKM_EVENT_SOURCE).toBe("task");
    expect(cwd).toBeUndefined();
  });
});

describe("a harness's default agent", () => {
  const oc = config({ harnesses: { oc: { platform: "opencode", agent: "akm-workflow" } } });

  test("its agent reaches the prompt when the request names none", () => {
    const resolved = resolveExecution({ content: "Who are you?", config: oc });
    expect(resolved.request.agent).toBe("akm-workflow");
    expect(resolved.provenance.agent).toEqual({ layer: "oc", kind: "installation", via: "explicit" });
    expect(buildExecution(resolved.request, resolved.runner).options.dispatch?.agent).toBe("akm-workflow");
  });

  test("a request's own agent wins", () => {
    const resolved = resolveExecution({ content: "x", config: oc, layers: [currentLayer({ agent: "reviewer" })] });
    expect(buildExecution(resolved.request, resolved.runner).options.dispatch?.agent).toBe("reviewer");
  });

  test("an explicit null agent clears it", () => {
    const resolved = resolveExecution({ content: "x", config: oc, layers: [currentLayer({ agent: null })] });
    expect(buildExecution(resolved.request, resolved.runner).options.dispatch?.agent).toBeUndefined();
  });

  test("a persona is kept, not replaced by the harness's agent", () => {
    const resolved = resolveExecution({ content: "x", config: oc, persona: reviewer() });
    const dispatch = buildExecution(resolved.request, resolved.runner).options.dispatch;
    expect(dispatch?.agent).toBeUndefined();
    expect(dispatch?.systemPrompt).toBeUndefined();
    expect(buildExecution(resolved.request, resolved.runner).prompt).toContain("You review carefully.");
  });

  test("model work keeps its confined agent", () => {
    const claude = config({ harnesses: { claude: { agent: "akm-workflow" } } });
    const resolved = resolveExecution({ content: "x", config: claude, modelWork: true });
    expect(resolved.request.agent).toBeUndefined();
    const dispatch = buildExecution(resolved.request, resolved.runner).options.dispatch;
    expect(dispatch?.agent).toBeUndefined();
    expect(dispatch?.modelWork).toBe(true);
  });

  test("a pre-resolved runner carries the harness's agent too", () => {
    const { runner } = resolveExecution({ content: "x", config: oc });
    expect(resolveExecution({ content: "y", runner }).request.agent).toBe("akm-workflow");
  });

  test("the opencode and claude CLIs pass it as --agent", async () => {
    for (const [platform, bin] of [
      ["opencode", "opencode"],
      ["claude", "claude"],
    ] as const) {
      const { argv } = await spawnedFor({
        content: "Hi.",
        config: config({ harnesses: { e: { platform, agent: "akm-workflow" } } }),
      });
      expect(argv[0]).toBe(bin);
      expect(argv.slice(argv.indexOf("--agent"), argv.indexOf("--agent") + 2)).toEqual(["--agent", "akm-workflow"]);
    }
  });
});

describe("the model-work tool policy", () => {
  const modelWork = config({ harnesses: { claude: { workspace: "/configured/workspace" } } });

  test("is akm's own: allowed on a runner-only resolution too", () => {
    const { runner } = resolveExecution({ content: "x", config: modelWork });
    const again = resolveExecution({ content: "y", runner, modelWork: true });
    expect(again.request.modelWork).toBe(true);
    expect(() => buildExecution(again.request, again.runner)).not.toThrow();
  });

  test("ignores a native agent, which would replace the confined one, with one notice", () => {
    const resolved = resolveExecution({
      content: "x",
      config: modelWork,
      layers: [currentLayer({ agent: "reviewer" })],
      modelWork: true,
    });
    const built = buildExecution(resolved.request, resolved.runner);
    expect(built.options.dispatch?.agent).toBeUndefined();
    expect(built.options.dispatch?.modelWork).toBe(true);
    expect(built.notices.filter((notice) => notice.code === "model-work-agent-ignored")).toHaveLength(1);
  });

  test("a harness that cannot confine model work runs it unrestricted, with one notice", () => {
    const resolved = resolveExecution({ content: "x", config: config({ harnesses: { pi: {} } }), modelWork: true });
    const built = buildExecution(resolved.request, resolved.runner);
    expect(built.options.dispatch?.modelWork).toBeUndefined();
    expect(built.notices.filter((notice) => notice.code === "model-work-unrestricted")).toHaveLength(1);
  });

  test("every harness a config can name builds model work, confined only where it can be", () => {
    for (const platform of HARNESS_CONFIG_PLATFORMS) {
      const resolved = resolveExecution({
        content: "x",
        config: config({ harnesses: { [platform]: {} } }),
        modelWork: true,
      });
      const built = buildExecution(resolved.request, resolved.runner);
      const confines = getHarness(platform)?.confinable === true;
      expect(built.options.dispatch?.modelWork === true, platform).toBe(confines);
      expect(
        built.notices.some((notice) => notice.code === "model-work-unrestricted"),
        platform,
      ).toBe(!confines);
    }
  });

  test("an agent runs in a fresh scratch directory, removed afterwards even when the dispatch throws", async () => {
    const resolved = resolveExecution({ content: "x", config: modelWork, modelWork: true });
    const built = buildExecution(resolved.request, resolved.runner);
    const seen: string[] = [];
    const runAgent = async (_profile: unknown, _prompt: string, opts: { cwd?: string }) => {
      seen.push(opts.cwd ?? "");
      if (seen.length === 2) throw new Error("dispatch exploded");
      return { ok: true, exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    };
    await runExecution(built, { runAgent });
    await expect(runExecution(built, { runAgent })).rejects.toThrow("dispatch exploded");

    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
    for (const cwd of seen) {
      // Not the harness's configured workspace, which could be the stash.
      expect(path.basename(cwd)).toStartWith("akm-model-work-");
      expect(fs.existsSync(cwd)).toBe(false);
    }
  });

  test("an agent that ends with no answer has failed with parse_error; other work keeps its empty reply", async () => {
    const runAgent = async () => ({ ok: true, exitCode: 0, stdout: "  \n", stderr: "", durationMs: 1 });
    const run = (isModelWork: boolean) => {
      const resolved = resolveExecution({ content: "x", config: modelWork, modelWork: isModelWork });
      return runExecution(buildExecution(resolved.request, resolved.runner), { runAgent });
    };

    expect(await run(true)).toMatchObject({
      ok: false,
      reason: "parse_error",
      error: '"claude" returned no answer.',
    });
    expect(await run(false)).toMatchObject({ ok: true, stdout: "  \n" });
  });

  // The owner's harnesses name their model only in `args`, which model work otherwise leaves out.
  test("claude: a model named only in the harness's args reaches the model-work argv", async () => {
    const model = "claude-args-model";
    const harnesses = {
      argsonly: { platform: "claude", args: ["--verbose", "--model=claude-args-model"] },
    };
    const { argv } = await spawnedFor({
      content: "x",
      config: config({ harnesses }),
      layers: [currentLayer({ harness: "argsonly" })],
      modelWork: true,
    });
    expect(argv[argv.indexOf("--model") + 1]).toBe(model);
    // The rest of the harness's args stay out of model work.
    expect(argv).not.toContain("--verbose");
  });
});
