/**
 * Tests for the structured-output (`responseSchema`) lift in
 * `runReflectViaLlm` (Issue B1, reflect-pipeline investigation 2026-05-21).
 *
 * Mirrors the distill / consolidate lift in commit d2dee43. Providers that
 * honour `response_format: json_schema` enforce the
 * target-scoped `{content, confidence}` shape upstream. AKM derives the known
 * target ref and preserves source frontmatter rather than asking the model to
 * echo either value.
 *
 * Coverage:
 *   1. Strict-provider-compatible schema shape and target identity derivation.
 *   2. Wiring: when `akmReflect` resolves a named LLM engine, the underlying
 *      `chatCompletion` call receives
 *      REFLECT_JSON_SCHEMA as `responseSchema`.
 *   3. Framed fallback, bounded parse repair, cancellation/deadline behavior,
 *      telemetry, and unchanged downstream policy failures.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { akmReflect, REFLECT_JSON_SCHEMA, runReflectViaLlm } from "../../../src/commands/improve/reflect";
import { listProposals } from "../../../src/commands/proposal/repository";
import { validateProposal } from "../../../src/commands/proposal/validators/proposals";
import type { AkmConfig, LlmProfileConfig } from "../../../src/core/config/config";
import { ConfigError } from "../../../src/core/errors";
import { readEvents } from "../../../src/core/events";
import { getStateDbPath } from "../../../src/core/state-db";
import { parseAgentProposalPayload, REFLECT_TRUNCATION_MARKER } from "../../../src/integrations/agent/prompts";
import type { RunnerSpec } from "../../../src/integrations/agent/runner";
import { _setChatCompletionForTests } from "../../../src/llm/client";
import { quietQualityGateConfig } from "../../_helpers/factories";
import { type IsolatedAkmStorage, mutateScopedEnv, withEnv, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";

// ── chatCompletion spy (swap-and-restore seam) ──────────────────────────────
//
// The seam installs a deterministic stub that records the `responseSchema`
// option passed by the production path; all other client exports stay real.

interface CapturedCall {
  responseSchema: Record<string, unknown> | undefined;
  enableThinking: boolean | undefined;
  messageCount: number;
  prompt: string;
}

const capturedCalls: CapturedCall[] = [];
let stubReturn = "";

// ── Scaffolding ─────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
let storage: IsolatedAkmStorage;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  return storage.stashDir;
}

function fakeLlmConnection(): LlmProfileConfig {
  return {
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "test-model",
    supportsJsonSchema: true,
  };
}

function fakeLlmRunner(): Extract<RunnerSpec, { kind: "llm" }> {
  return { kind: "llm", engine: "test-llm", connection: fakeLlmConnection() };
}

function reflectLlmConfig(connection: LlmProfileConfig = fakeLlmConnection(), apiKey?: string): AkmConfig {
  const base = quietQualityGateConfig();
  return {
    ...base,
    engines: {
      ...base.engines,
      "test-llm": {
        kind: "llm",
        ...connection,
        ...(apiKey ? { apiKey } : {}),
      },
    },
    defaults: {
      ...base.defaults,
      engine: "test-llm",
      llmEngine: "test-llm",
    },
  };
}

const EMPTY_FRAMED_PATCH_LINE = 'AKM_REFLECT_FRONTMATTER_PATCH: {"description":null,"when_to_use":null}';

beforeEach(() => {
  overrideSeam(_setChatCompletionForTests, async (config, messages, options) => {
    capturedCalls.push({
      responseSchema: options?.responseSchema,
      // The resolved boundary canonicalizes inference onto the symbolic LLM
      // connection before dispatch; the effective provider option is unchanged.
      enableThinking: options?.enableThinking ?? config.enableThinking,
      messageCount: messages.length,
      prompt: messages[0]?.content ?? "",
    });
    return stubReturn;
  });
  storage = withIsolatedAkmStorage();
  capturedCalls.length = 0;
  stubReturn = "";
});

afterEach(() => {
  storage.cleanup();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 1. Schema shape ─────────────────────────────────────────────────────────

describe("REFLECT_JSON_SCHEMA — top-level shape", () => {
  test("round-trips through JSON.parse(JSON.stringify(...)) cleanly", () => {
    const cloned = JSON.parse(JSON.stringify(REFLECT_JSON_SCHEMA)) as Record<string, unknown>;
    expect(cloned).toEqual(REFLECT_JSON_SCHEMA as Record<string, unknown>);
  });

  test("requires content, confidence, and a narrow nullable frontmatter patch", () => {
    const s = REFLECT_JSON_SCHEMA as {
      type: string;
      required: string[];
      properties: Record<
        string,
        {
          type?: string;
          required?: string[];
          additionalProperties?: boolean;
          properties?: Record<string, { type?: string | string[] }>;
        }
      >;
    };
    expect(s.type).toBe("object");
    expect(s.required).toEqual(["content", "confidence", "frontmatterPatch"]);
    expect(Object.keys(s.properties)).toEqual(["content", "confidence", "frontmatterPatch"]);
    expect(s.properties.content?.type).toBe("string");
    expect(s.properties.confidence?.type).toBe("number");
    expect(s.properties.frontmatterPatch?.required).toEqual(["description", "when_to_use"]);
    expect(s.properties.frontmatterPatch?.additionalProperties).toBe(false);
    expect(s.properties.frontmatterPatch?.properties?.description?.type).toEqual(["string", "null"]);
    expect(s.properties.frontmatterPatch?.properties?.when_to_use?.type).toEqual(["string", "null"]);
  });

  test("forbids additionalProperties at the top level so hallucinated keys are dropped", () => {
    const s = REFLECT_JSON_SCHEMA as { additionalProperties: boolean };
    expect(s.additionalProperties).toBe(false);
  });

  test("does not ask the model to echo target identity or arbitrary frontmatter", () => {
    const s = REFLECT_JSON_SCHEMA as {
      required: string[];
      properties: Record<string, { type?: string }>;
    };
    expect(s.required).not.toContain("ref");
    expect(s.required).not.toContain("frontmatter");
    expect(s.properties.ref).toBeUndefined();
    expect(s.properties.frontmatter).toBeUndefined();
    expect(s.properties.frontmatterPatch).toBeDefined();
  });

  test("confidence is required and bounded to [0, 1] (strict-provider-compatible)", () => {
    const s = REFLECT_JSON_SCHEMA as {
      required: string[];
      properties: Record<string, { type?: string; minimum?: number; maximum?: number }>;
    };
    expect(s.required).toContain("confidence");
    expect(s.properties.confidence?.type).toBe("number");
    expect(s.properties.confidence?.minimum).toBe(0);
    expect(s.properties.confidence?.maximum).toBe(1);
  });
});

// ── 2. Wiring ───────────────────────────────────────────────────────────────

describe("runReflectViaLlm — responseSchema is plumbed to chatCompletion", () => {
  test("missing required symbolic credential remains a hard config failure", async () => {
    const runner: Extract<RunnerSpec, { kind: "llm" }> = {
      kind: "llm",
      engine: "reflect",
      connection: fakeLlmConnection(),
      credential: { names: ["AKM_REFLECT_REQUIRED_KEY"], required: true },
    };

    const failure = withEnv({ AKM_REFLECT_REQUIRED_KEY: undefined }, () =>
      runReflectViaLlm({
        prompt: "test prompt",
        runner,
        iteration: 0,
        outputMode: "json_schema",
      }),
    );

    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    expect(capturedCalls.length).toBe(0);
  });

  test("full reflect command leaves assets, proposals, and state untouched when a required credential is missing", async () => {
    const stash = makeStashDir();
    const sourcePath = path.join(stash, "memories", "credential-boundary.md");
    const original = "---\ndescription: Credential boundary\n---\n\nOriginal memory body.\n";
    fs.writeFileSync(sourcePath, original, "utf8");
    const eventDbPath = path.join(makeTempDir("akm-reflect-required-credential-state-"), "state.db");
    const defaultStateDbPath = getStateDbPath();
    await withEnv({ AKM_REFLECT_REQUIRED_KEY: undefined }, async () => {
      await expect(
        akmReflect({
          ref: "memories/credential-boundary",
          assetContent: original,
          stashDir: stash,
          config: reflectLlmConfig(fakeLlmConnection(), "$AKM_REFLECT_REQUIRED_KEY"),
          eventsCtx: { dbPath: eventDbPath },
        }),
      ).rejects.toBeInstanceOf(ConfigError);
    });

    expect(capturedCalls).toHaveLength(0);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(original);
    expect(fs.existsSync(eventDbPath)).toBe(false);
    expect(fs.existsSync(defaultStateDbPath)).toBe(false);
  });

  test.each([
    { mutation: "deletion", nextCredential: undefined },
    { mutation: "replacement", nextCredential: "replacement-secret" },
  ])("direct generation and refinement survive ambient credential $mutation", async ({ nextCredential }) => {
    const stash = makeStashDir();
    const original = "reflect-direct-original-secret";
    const observed: Array<string | undefined> = [];
    const source =
      "---\ndescription: Preserve direct operation credentials\n---\n\n# Existing\n\nKeep the credential snapshot stable across refinement.\n";
    const result = await withEnv({ AKM_REFLECT_DIRECT_LEASE_KEY: original }, () =>
      akmReflect({
        ref: "knowledge/direct-lease",
        assetContent: source,
        stashDir: stash,
        config: reflectLlmConfig(fakeLlmConnection(), "$AKM_REFLECT_DIRECT_LEASE_KEY"),
        maxRefineIters: 2,
        chat: async (connection) => {
          observed.push(connection.apiKey);
          if (observed.length === 1) mutateScopedEnv("AKM_REFLECT_DIRECT_LEASE_KEY", nextCredential);
          return JSON.stringify({
            content: "# Existing\n\nKeep the credential snapshot stable across every refinement call.\n",
            confidence: 0.9,
            frontmatterPatch: { description: null, when_to_use: null },
          });
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(observed).toEqual([original, original]);
  });

  test("when responseSchema is provided and no test-seam `chat` is set, chatCompletion receives the schema", async () => {
    stubReturn = JSON.stringify({
      ref: "lessons/wired",
      content: "---\ndescription: ok\nwhen_to_use: when wired\n---\n\nbody.\n",
      confidence: 0.9,
      frontmatterPatch: { description: null, when_to_use: null },
    });

    const result = await runReflectViaLlm({
      prompt: "test prompt",
      runner: fakeLlmRunner(),
      iteration: 0,
      outputMode: "json_schema",
      responseSchema: REFLECT_JSON_SCHEMA,
    });

    expect(result.ok).toBe(true);
    expect(capturedCalls.length).toBe(1);
    expect(capturedCalls[0]?.responseSchema).toEqual(REFLECT_JSON_SCHEMA as Record<string, unknown>);
    expect(capturedCalls[0]?.enableThinking).toBe(false);
  });

  test("when `chat` test seam is provided, chatCompletion is NOT called (responseSchema is ignored)", async () => {
    // Belt-and-suspenders: confirms the additive-only contract — existing test
    // seams that don't pass responseSchema continue to short-circuit around
    // the production chatCompletion path.
    let chatCalls = 0;
    const result = await runReflectViaLlm({
      prompt: "test prompt",
      runner: fakeLlmRunner(),
      iteration: 0,
      outputMode: "json_schema",
      responseSchema: REFLECT_JSON_SCHEMA,
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({
          ref: "lessons/test",
          content: "body",
          confidence: 0.9,
          frontmatterPatch: { description: null, when_to_use: null },
        });
      },
    });

    expect(result.ok).toBe(true);
    expect(chatCalls).toBe(1);
    expect(capturedCalls.length).toBe(0);
  });

  test("when responseSchema is omitted, chatCompletion receives undefined responseSchema", async () => {
    stubReturn = JSON.stringify({
      ref: "lessons/test",
      content: "body",
      confidence: 0.9,
      frontmatterPatch: { description: null, when_to_use: null },
    });
    await runReflectViaLlm({
      prompt: "test prompt",
      runner: fakeLlmRunner(),
      iteration: 0,
      outputMode: "json_schema",
    });
    expect(capturedCalls.length).toBe(1);
    expect(capturedCalls[0]?.responseSchema).toBeUndefined();
  });

  for (const timeoutMs of [1, null] as const) {
    test(`forwards normalized timeoutMs=${String(timeoutMs)} to an injected chat transport`, async () => {
      let received: number | null | undefined;
      await runReflectViaLlm({
        prompt: "test prompt",
        runner: fakeLlmRunner(),
        iteration: 0,
        outputMode: "json_schema",
        timeoutMs,
        chat: async (_config, _messages, options) => {
          received = options?.timeoutMs;
          return JSON.stringify({
            ref: "lessons/test",
            content: "body",
            confidence: 0.9,
            frontmatterPatch: { description: null, when_to_use: null },
          });
        },
      });
      expect(received).toBe(timeoutMs);
    });
  }
});

describe("akmReflect — passes REFLECT_JSON_SCHEMA for the selected LLM engine", () => {
  test("does not send a content-derived max_tokens cap", async () => {
    const stash = makeStashDir();
    const observedMaxTokens: Array<number | undefined> = [];
    const sourceBody = "x".repeat(1_000);

    const result = await akmReflect({
      ref: "lessons/reasoning-headroom",
      stashDir: stash,
      config: reflectLlmConfig(),
      assetContent: `---\ndescription: Reserve enough response capacity for thinking models\nwhen_to_use: When direct reflection sends a content-derived output ceiling\n---\n\n${sourceBody}`,
      chat: async (connection) => {
        observedMaxTokens.push(connection.maxTokens);
        return JSON.stringify({
          content: `# Completed response\n\n${"y".repeat(600)}`,
          confidence: 0.9,
          frontmatterPatch: { description: null, when_to_use: null },
        });
      },
    });

    expect(result.ok).toBe(true);
    expect(observedMaxTokens).toEqual([undefined]);
  });

  test("selected LLM engine wires REFLECT_JSON_SCHEMA into the underlying chatCompletion call", async () => {
    const stash = makeStashDir();
    stubReturn = JSON.stringify({
      content:
        '# Schema output\n\nKeep "quotes", fenced code, and a C:\\\\tmp\\\\asset.md path intact.\n\n```ts\nconst ok = true;\n```\n',
      confidence: 0.91,
      frontmatterPatch: { description: null, when_to_use: null },
    });

    const result = await akmReflect({
      ref: "lessons/akm-reflect-wires-schema",
      stashDir: stash,
      config: reflectLlmConfig(),
      // Bypass indexer lookup so the test does not need a built FTS index.
      assetContent:
        "---\ndescription: Confirm native schema output for direct reflect calls\nwhen_to_use: When a provider supports strict JSON schema responses\n---\n\n# Old body\n\nOld guidance.\n",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.proposal.ref).toEndWith("//lessons/akm-reflect-wires-schema");
    expect(result.proposal.payload.content).toContain('Keep "quotes", fenced code');
    // At least one chatCompletion call must have happened, and the FIRST one
    // (the reflect iteration) must carry REFLECT_JSON_SCHEMA. Downstream
    // quality-judge LLM calls may or may not pass a schema — we pin only the
    // reflect call here.
    expect(capturedCalls.length).toBeGreaterThanOrEqual(1);
    expect(capturedCalls[0]?.responseSchema).toEqual(REFLECT_JSON_SCHEMA as Record<string, unknown>);
    expect(capturedCalls[0]?.prompt).not.toContain('JSON "ref" field');
    expect(capturedCalls[0]?.prompt).not.toContain('"frontmatter"');
    const completed = readEvents({ type: "reflect_completed" }).events.at(-1);
    expect(completed?.metadata?.outputMode).toBe("json_schema");
    expect(completed?.metadata?.repairAttempts).toBe(0);
  });

  test("an unscoped schema response still carries the model-selected ref", async () => {
    const stash = makeStashDir();
    stubReturn = JSON.stringify({
      ref: "lessons/model-selected",
      content: "# Selected target\n\nUse the model-selected target only when no ref was supplied.\n",
      confidence: 0.75,
      frontmatterPatch: {
        description: "Choose the target returned by unscoped reflection",
        when_to_use: "Running unscoped reflection with structured output",
      },
    });

    const result = await akmReflect({
      stashDir: stash,
      config: reflectLlmConfig(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.proposal.ref).toEndWith("//lessons/model-selected");
    const schema = capturedCalls[0]?.responseSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.required).toContain("ref");
    expect(schema.properties?.ref).toBeDefined();
  });

  test("target-scoped schema output patches missing required lesson frontmatter and passes proposal validation", async () => {
    const stash = makeStashDir();
    const description = "Explains how direct reflection repairs required lesson metadata.";
    const whenToUse = "Use when a reflected lesson is missing required frontmatter fields.";
    const response = JSON.stringify({
      content: "# Patched lesson\n\nApply a narrow metadata patch before proposal validation.\n",
      confidence: 0.9,
      frontmatterPatch: { description, when_to_use: whenToUse },
    });

    const result = await akmReflect({
      ref: "lessons/targeted-frontmatter-patch",
      stashDir: stash,
      config: reflectLlmConfig(),
      assetContent: "---\ntitle: Patch required metadata\n---\n\n# Existing lesson\n\nMetadata is missing.\n",
      chat: async () => response,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.proposal.payload.frontmatter?.description).toBe(description);
    expect(result.proposal.payload.frontmatter?.when_to_use).toBe(whenToUse);
    expect(result.proposal.payload.frontmatter?.title).toBe("Patch required metadata");
    expect(validateProposal(result.proposal)).toEqual({ ok: true, findings: [] });
  });

  test("unscoped schema output patches selected lesson frontmatter and passes proposal validation", async () => {
    const stash = makeStashDir();
    const description = "Explains how unscoped reflection supplies lesson metadata safely.";
    const whenToUse = "Use when direct reflection selects a lesson without source metadata.";
    const response = JSON.stringify({
      ref: "lessons/unscoped-frontmatter-patch",
      content: "# Unscoped patch\n\nSupply required metadata for the selected lesson.\n",
      confidence: 0.87,
      frontmatterPatch: { description, when_to_use: whenToUse },
    });

    const result = await akmReflect({
      stashDir: stash,
      config: reflectLlmConfig(),
      chat: async () => response,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.proposal.payload.frontmatter?.description).toBe(description);
    expect(result.proposal.payload.frontmatter?.when_to_use).toBe(whenToUse);
    expect(validateProposal(result.proposal)).toEqual({ ok: true, findings: [] });
  });
});

describe("akmReflect — direct LLM output recovery", () => {
  test("non-schema mode accepts framed markdown without JSON-escaping quotes, fences, or backslashes", async () => {
    const stash = makeStashDir();
    const prompts: string[] = [];
    const body = [
      "# Reliable parsing",
      "",
      'Keep the quoted value "exactly as written".',
      "",
      "```ts",
      'const windowsPath = "C:\\\\tmp\\\\asset.md";',
      "```",
    ].join("\n");

    const result = await akmReflect({
      ref: "lessons/framed-output",
      stashDir: stash,
      config: reflectLlmConfig({ ...fakeLlmConnection(), supportsJsonSchema: false }),
      assetContent:
        "---\ndescription: Use a deterministic frame for direct reflect output\nwhen_to_use: When markdown must survive model transport intact\n---\n\n# Old guidance\n\nUse JSON strings.\n",
      chat: async (_config, messages, options) => {
        prompts.push(messages.at(-1)?.content ?? "");
        expect(options?.responseSchema).toBeUndefined();
        return `AKM_REFLECT_CONFIDENCE: 0.82\n${EMPTY_FRAMED_PATCH_LINE}\nAKM_REFLECT_CONTENT_BEGIN\n${body}\nAKM_REFLECT_CONTENT_END`;
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.proposal.payload.content).toContain(body);
    expect(result.proposal.ref).toEndWith("//lessons/framed-output");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("AKM_REFLECT_CONTENT_BEGIN");
  });

  test("non-schema mode repairs one malformed response and accepts the second framed response", async () => {
    const stash = makeStashDir();
    const calls: Array<{ messageCount: number; lastMessage: string }> = [];
    const responses = [
      "Here is the improved markdown:\n```markdown\n# Missing frame\n\nThis response cannot be extracted deterministically.\n```",
      `AKM_REFLECT_CONFIDENCE: 0.88\n${EMPTY_FRAMED_PATCH_LINE}\nAKM_REFLECT_CONTENT_BEGIN\n# Repaired output\n\nUse one bounded formatting repair.\nAKM_REFLECT_CONTENT_END`,
    ];

    const result = await akmReflect({
      ref: "lessons/repair-output",
      stashDir: stash,
      config: reflectLlmConfig({ ...fakeLlmConnection(), supportsJsonSchema: false }),
      assetContent:
        "---\ndescription: Repair malformed direct reflect output once\nwhen_to_use: When the first model response violates its output contract\n---\n\n# Old output\n\nParsing fails permanently.\n",
      chat: async (_config, messages) => {
        calls.push({ messageCount: messages.length, lastMessage: messages.at(-1)?.content ?? "" });
        return responses.shift() ?? "";
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.proposal.payload.content).toContain("# Repaired output");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.messageCount).toBe(3);
    expect(calls[1]?.lastMessage).toContain("AKM_REFLECT_CONTENT_BEGIN");
    const completed = readEvents({ type: "reflect_completed" }).events.at(-1);
    expect(completed?.metadata?.outputMode).toBe("framed_markdown");
    expect(completed?.metadata?.repairAttempts).toBe(1);
  });

  test("framed output patches missing required lesson frontmatter and passes proposal validation", async () => {
    const stash = makeStashDir();
    const description = "Explains how framed reflection repairs required lesson metadata.";
    const whenToUse = "Use when a non-schema reflect engine must supply missing lesson metadata.";
    const patch = JSON.stringify({ description, when_to_use: whenToUse });

    const result = await akmReflect({
      ref: "lessons/framed-frontmatter-patch",
      stashDir: stash,
      config: reflectLlmConfig({ ...fakeLlmConnection(), supportsJsonSchema: false }),
      assetContent: "---\ntitle: Framed metadata patch\n---\n\n# Existing lesson\n\nMetadata is missing.\n",
      chat: async () =>
        `AKM_REFLECT_CONFIDENCE: 0.85\nAKM_REFLECT_FRONTMATTER_PATCH: ${patch}\nAKM_REFLECT_CONTENT_BEGIN\n# Framed patch\n\nApply a narrow metadata patch before validation.\nAKM_REFLECT_CONTENT_END`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.proposal.payload.frontmatter?.description).toBe(description);
    expect(result.proposal.payload.frontmatter?.when_to_use).toBe(whenToUse);
    expect(validateProposal(result.proposal)).toEqual({ ok: true, findings: [] });
  });

  test("repairs a missing-metadata lesson frame that omits the required frontmatter patch header", async () => {
    const stash = makeStashDir();
    const description = "Explains why framed reflect metadata headers are mandatory.";
    const whenToUse = "Use when repairing a non-schema lesson response that omitted metadata.";
    const patch = JSON.stringify({ description, when_to_use: whenToUse });
    const responses = [
      "AKM_REFLECT_CONFIDENCE: 0.8\nAKM_REFLECT_CONTENT_BEGIN\n# Missing patch\n\nThis frame omitted required metadata.\nAKM_REFLECT_CONTENT_END",
      `AKM_REFLECT_CONFIDENCE: 0.8\nAKM_REFLECT_FRONTMATTER_PATCH: ${patch}\nAKM_REFLECT_CONTENT_BEGIN\n# Repaired patch\n\nThis frame includes required metadata.\nAKM_REFLECT_CONTENT_END`,
    ];
    let calls = 0;
    const repairMessages: Array<Array<{ role: string; content: string }>> = [];

    const result = await akmReflect({
      ref: "lessons/required-framed-patch",
      stashDir: stash,
      config: reflectLlmConfig({ ...fakeLlmConnection(), supportsJsonSchema: false }),
      assetContent: "---\ntitle: Required framed patch\n---\n\n# Existing lesson\n\nMetadata is missing.\n",
      chat: async (_config, messages) => {
        calls += 1;
        repairMessages.push(messages.map((message) => ({ ...message })));
        return responses.shift() ?? "";
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(calls).toBe(2);
    expect(repairMessages.map((messages) => messages.map(({ role }) => role))).toEqual([
      ["user"],
      ["user", "assistant", "user"],
    ]);
    expect(repairMessages[1]?.[1]?.content).toContain("AKM_REFLECT_CONTENT_BEGIN");
    expect(result.proposal.payload.frontmatter?.description).toBe(description);
    expect(result.proposal.payload.frontmatter?.when_to_use).toBe(whenToUse);
    expect(validateProposal(result.proposal)).toEqual({ ok: true, findings: [] });
    const completed = readEvents({ type: "reflect_completed" }).events.at(-1);
    expect(completed?.metadata?.repairAttempts).toBe(1);
  });

  test("preserves the first framed response as the self-refine prior draft", async () => {
    const stash = makeStashDir();
    const first =
      'AKM_REFLECT_CONFIDENCE: 0.8\nAKM_REFLECT_FRONTMATTER_PATCH: {"description":null,"when_to_use":null}\nAKM_REFLECT_CONTENT_BEGIN\n# First framed draft\n\nKeep this frame intact for refinement.\nAKM_REFLECT_CONTENT_END';
    const second =
      'AKM_REFLECT_CONFIDENCE: 0.9\nAKM_REFLECT_FRONTMATTER_PATCH: {"description":null,"when_to_use":null}\nAKM_REFLECT_CONTENT_BEGIN\n# Second framed draft\n\nRefine the original framed draft.\nAKM_REFLECT_CONTENT_END';
    const responses = [first, second];
    const calls: Array<Array<{ role: string; content: string }>> = [];

    const result = await akmReflect({
      ref: "lessons/framed-self-refine",
      stashDir: stash,
      config: reflectLlmConfig({ ...fakeLlmConnection(), supportsJsonSchema: false }),
      maxRefineIters: 2,
      assetContent:
        "---\ndescription: Preserve framed prior drafts during self refinement\nwhen_to_use: When direct reflect runs multiple semantic iterations\n---\n\n# Existing draft\n\nRefine this guidance.\n",
      chat: async (_config, messages) => {
        calls.push(messages.map((message) => ({ ...message })));
        return responses.shift() ?? "";
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.map(({ role }) => role)).toEqual(["user"]);
    expect(calls[1]?.map(({ role }) => role)).toEqual(["user", "assistant", "user"]);
    expect(calls[1]?.[0]?.content).toContain(first);
    expect(calls[1]?.[1]?.content).toBe(first);
    expect(calls[1]?.[2]?.content).toBe(
      "Your previous proposal is shown above. Review it critically and provide an improved version that is more specific, actionable, and avoids any issues with the previous attempt. Return only the improved response using the output contract from the original prompt.",
    );
    expect(calls[1]?.[0]?.content).not.toContain('{"ref":"lessons/framed-self-refine"');
  });

  test("uses the final end marker so marker lines inside framed markdown remain content", async () => {
    const stash = makeStashDir();
    const body = [
      "# Marker examples",
      "",
      "The following literal marker lines are documentation:",
      "AKM_REFLECT_CONTENT_BEGIN",
      "embedded content",
      "AKM_REFLECT_CONTENT_END",
      "The asset continues after the embedded marker.",
    ].join("\n");
    let calls = 0;

    const result = await akmReflect({
      ref: "knowledge/embedded-frame-markers",
      stashDir: stash,
      config: reflectLlmConfig({ ...fakeLlmConnection(), supportsJsonSchema: false }),
      assetContent:
        "---\ndescription: Document framed reflect marker handling safely\n---\n\n# Existing marker notes\n\nMarker examples belong in content.\n",
      chat: async () => {
        calls += 1;
        return `AKM_REFLECT_CONFIDENCE: 0.8\n${EMPTY_FRAMED_PATCH_LINE}\nAKM_REFLECT_CONTENT_BEGIN\n${body}\nAKM_REFLECT_CONTENT_END`;
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(calls).toBe(1);
    expect(result.proposal.payload.content).toContain(body);
  });

  for (const invalidConfidence of ["", "   ", "0x0", "Infinity", "NaN", "-0.1", "1.1"]) {
    test(`repairs framed output with invalid confidence ${JSON.stringify(invalidConfidence)}`, async () => {
      const stash = makeStashDir();
      const responses = [
        `AKM_REFLECT_CONFIDENCE: ${invalidConfidence}\n${EMPTY_FRAMED_PATCH_LINE}\nAKM_REFLECT_CONTENT_BEGIN\n# Invalid confidence\n\nReject coercive confidence parsing.\nAKM_REFLECT_CONTENT_END`,
        `AKM_REFLECT_CONFIDENCE: 0.7\n${EMPTY_FRAMED_PATCH_LINE}\nAKM_REFLECT_CONTENT_BEGIN\n# Repaired confidence\n\nAccept only canonical decimal confidence.\nAKM_REFLECT_CONTENT_END`,
      ];
      let calls = 0;

      const result = await akmReflect({
        ref: "knowledge/invalid-confidence",
        stashDir: stash,
        config: reflectLlmConfig({ ...fakeLlmConnection(), supportsJsonSchema: false }),
        assetContent:
          "---\ndescription: Reject invalid direct reflect confidence values\n---\n\n# Existing confidence guidance\n\nValidate confidence strictly.\n",
        chat: async () => {
          calls += 1;
          return responses.shift() ?? "";
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(calls).toBe(2);
      expect(result.proposal.confidence).toBe(0.7);
      const completed = readEvents({ type: "reflect_completed" }).events.at(-1);
      expect(completed?.metadata?.repairAttempts).toBe(1);
    });
  }

  test("schema mode repairs one malformed response without accepting a model-echoed ref", async () => {
    const stash = makeStashDir();
    const responses = [
      '{"ref":"lessons/wrong-target","content":"unterminated',
      JSON.stringify({
        content: "# Native repair\n\nRepair only the response envelope, not the target identity.\n",
        confidence: 0.86,
        frontmatterPatch: { description: null, when_to_use: null },
      }),
    ];
    const calls: Array<{ messageCount: number; schema?: Record<string, unknown> }> = [];

    const result = await akmReflect({
      ref: "lessons/native-repair",
      stashDir: stash,
      config: reflectLlmConfig(),
      assetContent:
        "---\ndescription: Repair malformed native schema output once\nwhen_to_use: When strict output still arrives malformed\n---\n\n# Old repair\n\nThe response fails.\n",
      chat: async (_config, messages, options) => {
        calls.push({ messageCount: messages.length, schema: options?.responseSchema });
        return responses.shift() ?? "";
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.proposal.ref).toEndWith("//lessons/native-repair");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.messageCount).toBe(3);
    expect(calls[1]?.schema).toEqual(REFLECT_JSON_SCHEMA as Record<string, unknown>);
  });

  for (const supportsJsonSchema of [true, false]) {
    test(`returns parse_error after one failed repair when supportsJsonSchema=${supportsJsonSchema}`, async () => {
      const stash = makeStashDir();
      let calls = 0;
      const result = await akmReflect({
        ref: "lessons/double-failure",
        stashDir: stash,
        config: reflectLlmConfig({ ...fakeLlmConnection(), supportsJsonSchema }),
        assetContent:
          "---\ndescription: Stop after one failed response repair attempt\nwhen_to_use: When a model repeatedly violates the output contract\n---\n\n# Old failure\n\nRetry forever.\n",
        chat: async () => {
          calls += 1;
          return supportsJsonSchema ? "{still malformed" : "unframed markdown";
        },
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected parse failure");
      expect(result.reason).toBe("parse_error");
      expect(calls).toBe(2);
      const completed = readEvents({ type: "reflect_completed" }).events.at(-1);
      expect(completed?.metadata?.repairAttempts).toBe(1);
    });
  }

  test("shares the single repair budget across semantic refinement iterations", async () => {
    const stash = makeStashDir();
    const responses = [
      "malformed first iteration",
      `AKM_REFLECT_CONFIDENCE: 0.8\n${EMPTY_FRAMED_PATCH_LINE}\nAKM_REFLECT_CONTENT_BEGIN\n# First repaired iteration\n\nUse the only repair here.\nAKM_REFLECT_CONTENT_END`,
      "malformed second iteration",
      `AKM_REFLECT_CONFIDENCE: 0.9\n${EMPTY_FRAMED_PATCH_LINE}\nAKM_REFLECT_CONTENT_BEGIN\n# Repair that must not run\n\nA second repair exceeds the invocation budget.\nAKM_REFLECT_CONTENT_END`,
    ];
    let calls = 0;

    const result = await akmReflect({
      ref: "lessons/shared-repair-budget",
      stashDir: stash,
      config: reflectLlmConfig({ ...fakeLlmConnection(), supportsJsonSchema: false }),
      maxRefineIters: 2,
      assetContent:
        "---\ndescription: Share one output repair across refinement iterations\nwhen_to_use: When semantic refinement is configured for direct reflect\n---\n\n# Existing body\n\nDo not multiply repair attempts.\n",
      chat: async () => {
        calls += 1;
        return responses.shift() ?? "";
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the second malformed iteration to fail");
    expect(result.reason).toBe("parse_error");
    expect(calls).toBe(3);
    const completed = readEvents({ type: "reflect_completed" }).events.at(-1);
    expect(completed?.metadata?.repairAttempts).toBe(1);
  });

  test("does not start repair after the caller aborts", async () => {
    const stash = makeStashDir();
    const controller = new AbortController();
    let calls = 0;
    const result = await akmReflect({
      ref: "lessons/aborted-repair",
      stashDir: stash,
      config: reflectLlmConfig({ ...fakeLlmConnection(), supportsJsonSchema: false }),
      assetContent: "# Existing body\n\nKeep the existing body after cancellation.\n",
      signal: controller.signal,
      chat: async () => {
        calls += 1;
        controller.abort();
        return "malformed";
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected aborted failure");
    expect(result.reason).toBe("aborted");
    expect(calls).toBe(1);
  });

  test("does not give repair a fresh timeout after the original deadline expires", async () => {
    const stash = makeStashDir();
    let calls = 0;
    const result = await akmReflect({
      ref: "lessons/expired-repair",
      stashDir: stash,
      config: reflectLlmConfig({ ...fakeLlmConnection(), supportsJsonSchema: false }),
      assetContent: "# Existing body\n\nKeep the existing body after timeout.\n",
      timeoutMs: 0,
      chat: async () => {
        calls += 1;
        return "malformed";
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected timeout failure");
    expect(result.reason).toBe("timeout");
    expect(calls).toBe(1);
  });

  test("does not repair a valid response flagged by the size guard", async () => {
    const stash = makeStashDir();
    let calls = 0;
    const sourceBody = "Preserve this concrete sentence. ".repeat(20);
    const result = await akmReflect({
      ref: "knowledge/policy-reject",
      stashDir: stash,
      config: reflectLlmConfig({ ...fakeLlmConnection(), supportsJsonSchema: false }),
      assetContent: `---\ndescription: Preserve content policy failures without repair\n---\n\n${sourceBody}`,
      chat: async () => {
        calls += 1;
        return `AKM_REFLECT_CONFIDENCE: 0.9\n${EMPTY_FRAMED_PATCH_LINE}\nAKM_REFLECT_CONTENT_BEGIN\nToo short.\nAKM_REFLECT_CONTENT_END`;
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(calls).toBe(1);
    expect(listProposals(stash)[0]?.gateDecision).toMatchObject({ outcome: "deferred", reason: "reflect-size-ratio" });
    const completed = readEvents({ type: "reflect_completed" }).events.at(-1);
    expect(completed?.metadata?.repairAttempts).toBe(0);
  });

  test("does not repair a valid response that leaks the truncation marker (#952)", async () => {
    const stash = makeStashDir();
    let calls = 0;
    const result = await akmReflect({
      ref: "knowledge/leak-marker",
      stashDir: stash,
      config: reflectLlmConfig({ ...fakeLlmConnection(), supportsJsonSchema: false }),
      // Deliberately tiny so the body-size ratio guard cannot fire (source
      // body stays under REFLECT_SIZE_GUARD_MIN_BYTES) — isolates the
      // truncation-marker rail from the size-ratio rail.
      assetContent: "---\ndescription: Short doc under the size-guard floor\n---\n\nShort body.\n",
      chat: async () => {
        calls += 1;
        return `AKM_REFLECT_CONFIDENCE: 0.9\n${EMPTY_FRAMED_PATCH_LINE}\nAKM_REFLECT_CONTENT_BEGIN\nRewritten body.\n${REFLECT_TRUNCATION_MARKER}\nAKM_REFLECT_CONTENT_END`;
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(calls).toBe(1);
    expect(listProposals(stash)[0]?.gateDecision).toMatchObject({
      outcome: "deferred",
      reason: "reflect-truncation-leak",
    });
    const completed = readEvents({ type: "reflect_completed" }).events.at(-1);
    expect(completed?.metadata?.repairAttempts).toBe(0);
    expect(completed?.metadata?.truncationMarkerLeaked).toBe(true);
  });

  test("does not repair a valid response rejected by the quality gate", async () => {
    const stash = makeStashDir();
    let reflectCalls = 0;
    let judgeCalls = 0;
    const config = reflectLlmConfig({ ...fakeLlmConnection(), supportsJsonSchema: false });
    const processes = config.improve?.strategies?.default?.processes;
    if (!processes) throw new Error("quiet quality-gate fixture is missing the default process config");
    processes.reflect = { qualityGate: { enabled: true } };
    const result = await akmReflect({
      ref: "lessons/quality-reject",
      stashDir: stash,
      config,
      assetContent:
        "---\ndescription: Preserve quality gate failures without response repair\nwhen_to_use: When a valid candidate has poor quality\n---\n\n# Existing quality\n\nKeep useful guidance.\n",
      chat: async (_config, messages) => {
        if (messages[0]?.role === "system") {
          judgeCalls += 1;
          return JSON.stringify({ score: 1, reason: "The revision is not useful." });
        }
        reflectCalls += 1;
        return `AKM_REFLECT_CONFIDENCE: 0.9\n${EMPTY_FRAMED_PATCH_LINE}\nAKM_REFLECT_CONTENT_BEGIN\n# Weak revision\n\nReplace useful guidance with vague prose.\nAKM_REFLECT_CONTENT_END`;
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected quality rejection");
    expect(result.error).toContain("quality gate rejected");
    expect(reflectCalls).toBe(1);
    expect(judgeCalls).toBe(1);
    const completed = readEvents({ type: "reflect_completed" }).events.at(-1);
    expect(completed?.metadata?.repairAttempts).toBe(0);
  });
});

// ── 2b. Context-aware content budget — LLM path only (#952) ────────────────

describe("akmReflect — content budget is context-aware on the direct-LLM path", () => {
  // A unique tail marker (not a repeated substring) so "did the prompt include
  // the true end of the body" can be asserted unambiguously.
  const TAIL_SENTINEL = "SENTINEL-TAIL-END-OF-DOCUMENT-952";
  const bigBody = `${"Long detailed reference paragraph about the system under test. ".repeat(400)}\n\n${TAIL_SENTINEL}`; // > 12k chars
  // The truncated-content fence: REFLECT_TRUNCATION_MARKER immediately closing
  // the fenced content block. Distinguishes an ACTUALLY truncated content
  // section from the output contract's own prose, which also quotes
  // REFLECT_TRUNCATION_MARKER verbatim (to forbid echoing it) and would
  // otherwise make a plain `.toContain(REFLECT_TRUNCATION_MARKER)` check
  // vacuously true regardless of whether the asset content was capped.
  const TRUNCATED_CONTENT_FENCE = `${REFLECT_TRUNCATION_MARKER}\n\n\`\`\``;

  test("a large configured engines.<name>.contextLength sends the full asset instead of truncating at the flat 12k cap", async () => {
    const stash = makeStashDir();
    const config = reflectLlmConfig({
      ...fakeLlmConnection(),
      supportsJsonSchema: false,
      // Comfortably large: even after halving the usable window to reserve
      // room for the response (see the next test), this must still fit the
      // asset body with margin to spare.
      contextLength: 400_000,
    });
    let capturedPrompt = "";
    const result = await akmReflect({
      ref: "knowledge/large-asset",
      stashDir: stash,
      config,
      assetContent: `---\ndescription: Large reference doc\n---\n\n${bigBody}`,
      chat: async (_config, messages) => {
        capturedPrompt = messages[0]?.content ?? "";
        // A trivial edit so this isn't a no-op/cosmetic echo of the source.
        return `AKM_REFLECT_CONFIDENCE: 0.9\n${EMPTY_FRAMED_PATCH_LINE}\nAKM_REFLECT_CONTENT_BEGIN\nRevised opening line.\n\n${bigBody}\nAKM_REFLECT_CONTENT_END`;
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(capturedPrompt).not.toContain(TRUNCATED_CONTENT_FENCE);
    expect(capturedPrompt).toContain("Current asset content (verbatim):");
    // The tail sentinel only survives in the prompt if the content was not sliced off.
    expect(capturedPrompt).toContain(TAIL_SENTINEL);
  });

  test("the content budget reserves half the usable window for the response, so a contextLength whose FULL window would fit the asset still truncates", async () => {
    const stash = makeStashDir();
    // Chosen so that contextLength * 3 chars/token comfortably exceeds the
    // asset body on its own (the un-halved, pre-#952-fix budget would have
    // sent the whole thing) but HALF of that usable window does not — pinning
    // that the reflect rewrite's own output gets a reserved half rather than
    // the request consuming the entire context window on input alone.
    const config = reflectLlmConfig({
      ...fakeLlmConnection(),
      supportsJsonSchema: false,
      contextLength: 16_000,
    });
    let capturedPrompt = "";
    const result = await akmReflect({
      ref: "knowledge/large-asset-half-window",
      stashDir: stash,
      config,
      assetContent: `---\ndescription: Large reference doc\n---\n\n${bigBody}`,
      chat: async (_config, messages) => {
        capturedPrompt = messages[0]?.content ?? "";
        return `AKM_REFLECT_CONFIDENCE: 0.9\n${EMPTY_FRAMED_PATCH_LINE}\nAKM_REFLECT_CONTENT_BEGIN\nRewritten.\nAKM_REFLECT_CONTENT_END`;
      },
    });

    expect(result.ok).toBe(true);
    expect(capturedPrompt).toContain(TRUNCATED_CONTENT_FENCE);
    // The tail sentinel must be gone — it fell past the halved budget even
    // though the full (unhalved) window would have had room for it.
    expect(capturedPrompt).not.toContain(TAIL_SENTINEL);
  });

  test("an unconfigured contextLength still truncates around the flat 12k floor", async () => {
    const stash = makeStashDir();
    const config = reflectLlmConfig({ ...fakeLlmConnection(), supportsJsonSchema: false });
    let capturedPrompt = "";
    const result = await akmReflect({
      ref: "knowledge/large-asset-default",
      stashDir: stash,
      config,
      assetContent: `---\ndescription: Large reference doc\n---\n\n${bigBody}`,
      chat: async (_config, messages) => {
        capturedPrompt = messages[0]?.content ?? "";
        return `AKM_REFLECT_CONFIDENCE: 0.9\n${EMPTY_FRAMED_PATCH_LINE}\nAKM_REFLECT_CONTENT_BEGIN\nRewritten.\nAKM_REFLECT_CONTENT_END`;
      },
    });

    expect(result.ok).toBe(true);
    expect(capturedPrompt).toContain(TRUNCATED_CONTENT_FENCE);
    // The tail sentinel must be gone — it fell past the (near-)12k cap.
    expect(capturedPrompt).not.toContain(TAIL_SENTINEL);
  });
});

// ── 3. Parser compatibility ─────────────────────────────────────────────────

describe("agent proposal parser compatibility", () => {
  test("a minimal schema-conforming payload (ref + content) parses successfully", () => {
    const sample = {
      ref: "lessons/demo",
      content: "Some markdown body.",
    };
    const out = parseAgentProposalPayload(JSON.stringify(sample));
    expect(out.ref).toBe("lessons/demo");
    expect(out.content).toBe("Some markdown body.");
    expect(out.frontmatter).toBeUndefined();
    expect(out.confidence).toBeUndefined();
  });

  test("a full schema-conforming payload (ref + content + frontmatter + confidence) parses successfully", () => {
    const sample = {
      ref: "lessons/demo",
      content: "---\ndescription: ok\nwhen_to_use: when relevant\n---\n\nBody.\n",
      frontmatter: { description: "ok", when_to_use: "when relevant" },
      confidence: 0.85,
    };
    const out = parseAgentProposalPayload(JSON.stringify(sample));
    expect(out.ref).toBe("lessons/demo");
    expect(out.frontmatter?.description).toBe("ok");
    expect(out.confidence).toBe(0.85);
  });

  test("parser rejects a legacy agent payload missing ref", () => {
    const sample = { content: "Body without a ref." };
    expect(() => parseAgentProposalPayload(JSON.stringify(sample))).toThrow(/ref/);
  });

  test("parser rejects a legacy agent payload missing content", () => {
    const sample = { ref: "lessons/demo" };
    expect(() => parseAgentProposalPayload(JSON.stringify(sample))).toThrow(/content/);
  });
});
