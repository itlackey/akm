/**
 * Tests for the structured-output (`responseSchema`) lift in
 * `runReflectIteration` (Issue B1, reflect-pipeline investigation 2026-05-21).
 *
 * Mirrors the distill / consolidate lift in commit d2dee43. Providers that
 * honour `response_format: json_schema` enforce the
 * target-scoped `{confidence, frontmatterPatch}` shape upstream. AKM derives
 * the known target ref and applies the patch to the source asset it read,
 * keeping the body, rather than asking the model to echo either value.
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

import { akmReflect, REFLECT_JSON_SCHEMA, runReflectIteration } from "../../../src/commands/improve/reflect";
import { splitFrontmatter } from "../../../src/commands/improve/reflect-noise";
import { validateProposal } from "../../../src/commands/proposal/validators/proposals";
import { parseFrontmatter } from "../../../src/core/asset/frontmatter";
import type { AkmConfig, LlmProfileConfig } from "../../../src/core/config/config";
import { ConfigError } from "../../../src/core/errors";
import { readEvents } from "../../../src/core/events";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
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

const NULL_PATCH = { description: null, when_to_use: null, title: null };
const EMPTY_FRAMED_PATCH_LINE = `AKM_REFLECT_FRONTMATTER_PATCH: ${JSON.stringify(NULL_PATCH)}`;
/** A framed reply, which is header lines only, with `patch` over the null patch. */
const framedReply = (patch: Record<string, string | null> = {}, confidence = 0.8) =>
  `AKM_REFLECT_CONFIDENCE: ${confidence}\nAKM_REFLECT_FRONTMATTER_PATCH: ${JSON.stringify({ ...NULL_PATCH, ...patch })}`;

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

  test("requires confidence and a narrow nullable frontmatter patch, and no body", () => {
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
    expect(s.required).toEqual(["confidence", "frontmatterPatch"]);
    expect(Object.keys(s.properties)).toEqual(["confidence", "frontmatterPatch"]);
    expect(s.properties.content).toBeUndefined();
    expect(s.properties.confidence?.type).toBe("number");
    expect(s.properties.frontmatterPatch?.required).toEqual(["description", "when_to_use", "title"]);
    expect(s.properties.frontmatterPatch?.additionalProperties).toBe(false);
    for (const field of ["description", "when_to_use", "title"]) {
      expect(s.properties.frontmatterPatch?.properties?.[field]?.type).toEqual(["string", "null"]);
    }
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

describe("runReflectIteration — responseSchema is plumbed to chatCompletion", () => {
  test("missing required symbolic credential remains a hard config failure", async () => {
    const runner: Extract<RunnerSpec, { kind: "llm" }> = {
      kind: "llm",
      engine: "reflect",
      connection: fakeLlmConnection(),
      credential: { names: ["AKM_REFLECT_REQUIRED_KEY"], required: true },
    };

    const failure = withEnv({ AKM_REFLECT_REQUIRED_KEY: undefined }, () =>
      runReflectIteration({
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

  test("direct generation and refinement each read the credential current at that call", async () => {
    const stash = makeStashDir();
    const original = "reflect-direct-original-secret";
    const rotated = "reflect-direct-rotated-secret";
    const observed: Array<string | undefined> = [];
    const source =
      "---\ndescription: Read direct operation credentials per call\n---\n\n# Existing\n\nPick up a rotated credential during refinement.\n";
    const result = await withEnv({ AKM_REFLECT_DIRECT_ROTATING_KEY: original }, () =>
      akmReflect({
        ref: "knowledge/direct-rotation",
        assetContent: source,
        stashDir: stash,
        config: reflectLlmConfig(fakeLlmConnection(), "$AKM_REFLECT_DIRECT_ROTATING_KEY"),
        maxRefineIters: 2,
        chat: async (connection) => {
          observed.push(connection.apiKey);
          if (observed.length === 1) mutateScopedEnv("AKM_REFLECT_DIRECT_ROTATING_KEY", rotated);
          return JSON.stringify({
            confidence: 0.9,
            frontmatterPatch: { ...NULL_PATCH, description: "Pick up a rotated credential on every refinement call" },
          });
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(observed).toEqual([original, rotated]);
  });

  test("when responseSchema is provided and no test-seam `chat` is set, chatCompletion receives the schema", async () => {
    stubReturn = JSON.stringify({ ref: "lessons/wired", confidence: 0.9, frontmatterPatch: NULL_PATCH });

    const result = await runReflectIteration({
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
    const result = await runReflectIteration({
      prompt: "test prompt",
      runner: fakeLlmRunner(),
      iteration: 0,
      outputMode: "json_schema",
      responseSchema: REFLECT_JSON_SCHEMA,
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ ref: "lessons/test", confidence: 0.9, frontmatterPatch: NULL_PATCH });
      },
    });

    expect(result.ok).toBe(true);
    expect(chatCalls).toBe(1);
    expect(capturedCalls.length).toBe(0);
  });

  test("when responseSchema is omitted, chatCompletion receives undefined responseSchema", async () => {
    stubReturn = JSON.stringify({ ref: "lessons/test", confidence: 0.9, frontmatterPatch: NULL_PATCH });
    await runReflectIteration({
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
      await runReflectIteration({
        prompt: "test prompt",
        runner: fakeLlmRunner(),
        iteration: 0,
        outputMode: "json_schema",
        timeoutMs,
        chat: async (_config, _messages, options) => {
          received = options?.timeoutMs;
          return JSON.stringify({ ref: "lessons/test", confidence: 0.9, frontmatterPatch: NULL_PATCH });
        },
      });
      expect(received).toBe(timeoutMs);
    });
  }
});

describe("runReflectIteration — the reply is a patch, and a body or a malformed field is refused", () => {
  /** What the parser says about `reply`, with no repair turn. */
  async function errorFor(
    reply: Record<string, unknown>,
    outputMode: "json_schema" | "framed_markdown" = "json_schema",
  ) {
    const result = await runReflectIteration({
      prompt: "test prompt",
      runner: fakeLlmRunner(),
      iteration: 0,
      outputMode,
      targetRef: "lessons/test",
      allowRepair: false,
      chat: async () =>
        outputMode === "json_schema"
          ? JSON.stringify(reply)
          : `AKM_REFLECT_CONFIDENCE: 0.9\nAKM_REFLECT_FRONTMATTER_PATCH: ${JSON.stringify(reply.frontmatterPatch)}`,
    });
    expect(result.ok).toBe(false);
    return result.error;
  }

  test("a reply that carries a `content` body is refused: the model no longer writes one", async () => {
    expect(await errorFor({ content: "# Body", confidence: 0.9, frontmatterPatch: NULL_PATCH })).toBe(
      "direct reflect response fields must be exactly: confidence, frontmatterPatch",
    );
  });

  test.each([
    "json_schema",
    "framed_markdown",
  ] as const)("%s: a patch must name exactly description, when_to_use and title", async (mode) => {
    const message = "direct reflect frontmatterPatch fields must be exactly: description, when_to_use, title";
    expect(await errorFor({ confidence: 0.9, frontmatterPatch: { description: null, when_to_use: null } }, mode)).toBe(
      message,
    );
    expect(await errorFor({ confidence: 0.9, frontmatterPatch: { ...NULL_PATCH, tags: null } }, mode)).toBe(message);
  });

  test.each([
    ["description", "two\nlines"],
    ["when_to_use", "  "],
    ["title", 3],
  ])("a %s that is not a non-empty single-line string or null is refused", async (field, value) => {
    expect(await errorFor({ confidence: 0.9, frontmatterPatch: { ...NULL_PATCH, [field]: value } })).toBe(
      `direct reflect frontmatterPatch.${field} must be a non-empty single-line string or null`,
    );
  });

  test("the fields of a valid patch come back trimmed, and a null one is left out", async () => {
    const result = await runReflectIteration({
      prompt: "test prompt",
      runner: fakeLlmRunner(),
      iteration: 0,
      outputMode: "json_schema",
      targetRef: "lessons/test",
      chat: async () =>
        JSON.stringify({
          confidence: 0.4,
          frontmatterPatch: { ...NULL_PATCH, title: "  A title ", description: "Ok." },
        }),
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual({
      ref: "lessons/test",
      confidence: 0.4,
      patch: { description: "Ok.", title: "A title" },
    });
  });
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
          confidence: 0.9,
          frontmatterPatch: { ...NULL_PATCH, description: "Reserve response capacity for a thinking model" },
        });
      },
    });

    expect(result.ok).toBe(true);
    expect(observedMaxTokens).toEqual([undefined]);
  });

  test("selected LLM engine wires REFLECT_JSON_SCHEMA into the underlying chatCompletion call", async () => {
    const stash = makeStashDir();
    // Quotes, a colon and a backslash must survive the JSON reply and the YAML frontmatter.
    const description =
      'Confirm native schema output: "quoted" values and a C:\\tmp\\asset.md path survive reflect calls';
    stubReturn = JSON.stringify({ confidence: 0.91, frontmatterPatch: { ...NULL_PATCH, description } });

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
    expect(parseFrontmatter(result.proposal.payload.content).data.description).toBe(description);
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
      confidence: 0.75,
      frontmatterPatch: {
        ...NULL_PATCH,
        description: "Choose the target returned by unscoped reflection",
        when_to_use: "Running unscoped reflection with structured output",
      },
    });

    const result = await akmReflect({
      stashDir: stash,
      config: reflectLlmConfig(),
      // The asset the reply names, read once it has named it.
      assetContent:
        "---\ndescription: Selected target\n---\n\nUse the model-selected target only when no ref was supplied.\n",
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
      confidence: 0.9,
      frontmatterPatch: { ...NULL_PATCH, description, when_to_use: whenToUse },
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
      confidence: 0.87,
      frontmatterPatch: { ...NULL_PATCH, description, when_to_use: whenToUse },
    });

    const result = await akmReflect({
      stashDir: stash,
      config: reflectLlmConfig(),
      assetContent:
        "---\ntitle: Unscoped patch\n---\n\n# Unscoped patch\n\nSupply required metadata for the selected lesson.\n",
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
  test("non-schema mode accepts a frame of header lines, with quotes and a backslash in the patch", async () => {
    const stash = makeStashDir();
    const prompts: string[] = [];
    const source =
      "---\ndescription: Use a deterministic frame for direct reflect output\nwhen_to_use: When markdown must survive model transport intact\n---\n\n# Old guidance\n\nUse JSON strings.\n";
    const description = 'Frame reflect output: the patch line keeps "quotes" and a C:\\tmp\\asset.md path intact';

    const result = await akmReflect({
      ref: "lessons/framed-output",
      stashDir: stash,
      config: reflectLlmConfig({ ...fakeLlmConnection(), supportsJsonSchema: false }),
      assetContent: source,
      chat: async (_config, messages, options) => {
        prompts.push(messages.at(-1)?.content ?? "");
        expect(options?.responseSchema).toBeUndefined();
        return framedReply({ description }, 0.82);
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(parseFrontmatter(result.proposal.payload.content).data.description).toBe(description);
    expect(splitFrontmatter(result.proposal.payload.content).body).toBe(splitFrontmatter(source).body);
    expect(result.proposal.ref).toEndWith("//lessons/framed-output");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("AKM_REFLECT_FRONTMATTER_PATCH");
    expect(prompts[0]).not.toContain("AKM_REFLECT_CONTENT");
  });

  test("non-schema mode repairs one malformed response and accepts the second framed response", async () => {
    const stash = makeStashDir();
    const calls: Array<{ messageCount: number; lastMessage: string }> = [];
    const responses = [
      "Here is the improved markdown:\n```markdown\n# Missing frame\n\nThis response cannot be extracted deterministically.\n```",
      framedReply({ description: "Repair malformed direct reflect output with one retry" }, 0.88),
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
    expect(result.proposal.payload.content).toContain(
      "description: Repair malformed direct reflect output with one retry",
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]?.messageCount).toBe(3);
    expect(calls[1]?.lastMessage).toContain("AKM_REFLECT_FRONTMATTER_PATCH");
    const completed = readEvents({ type: "reflect_completed" }).events.at(-1);
    expect(completed?.metadata?.outputMode).toBe("framed_markdown");
    expect(completed?.metadata?.repairAttempts).toBe(1);
  });

  test("framed output patches missing required lesson frontmatter and passes proposal validation", async () => {
    const stash = makeStashDir();
    const description = "Explains how framed reflection repairs required lesson metadata.";
    const whenToUse = "Use when a non-schema reflect engine must supply missing lesson metadata.";

    const result = await akmReflect({
      ref: "lessons/framed-frontmatter-patch",
      stashDir: stash,
      config: reflectLlmConfig({ ...fakeLlmConnection(), supportsJsonSchema: false }),
      assetContent: "---\ntitle: Framed metadata patch\n---\n\n# Existing lesson\n\nMetadata is missing.\n",
      chat: async () => framedReply({ description, when_to_use: whenToUse }, 0.85),
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
    const omitted = "AKM_REFLECT_CONFIDENCE: 0.8";
    const responses = [omitted, framedReply({ description, when_to_use: whenToUse })];
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
    expect(repairMessages[1]?.[1]?.content).toBe(omitted);
    expect(result.proposal.payload.frontmatter?.description).toBe(description);
    expect(result.proposal.payload.frontmatter?.when_to_use).toBe(whenToUse);
    expect(validateProposal(result.proposal)).toEqual({ ok: true, findings: [] });
    const completed = readEvents({ type: "reflect_completed" }).events.at(-1);
    expect(completed?.metadata?.repairAttempts).toBe(1);
  });

  test("preserves the first framed response as the self-refine prior draft", async () => {
    const stash = makeStashDir();
    const first = framedReply({ description: "First framed draft: keep this frame intact for refinement" });
    const second = framedReply({ description: "Second framed draft: refine the original framed draft" }, 0.9);
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

  for (const invalidConfidence of ["", "   ", "0x0", "Infinity", "NaN", "-0.1", "1.1"]) {
    test(`repairs framed output with invalid confidence ${JSON.stringify(invalidConfidence)}`, async () => {
      const stash = makeStashDir();
      const responses = [
        `AKM_REFLECT_CONFIDENCE: ${invalidConfidence}\n${EMPTY_FRAMED_PATCH_LINE}`,
        framedReply({ description: "Reject invalid direct reflect confidence values strictly" }, 0.7),
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
        confidence: 0.86,
        frontmatterPatch: { ...NULL_PATCH, description: "Repair malformed native schema output once, strictly" },
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
      framedReply({ description: "Share one output repair across refinement passes" }),
      "malformed second iteration",
      framedReply({ description: "A second repair would exceed the invocation budget" }, 0.9),
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
          return JSON.stringify({
            scores: { need: 1, preservation: 1, quality: 1 },
            reason: "The revision is not useful.",
          });
        }
        reflectCalls += 1;
        return framedReply({ description: "Replace useful guidance with vague prose" }, 0.9);
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected quality rejection");
    expect(result.error).toContain("quality gate rejected");
    // R3: judge rejection is a distinct reason from `parse_error` — the LLM
    // output parsed fine, the judge rejected it. Not injected into later
    // reflect prompts as an "avoid these patterns" LLM fault.
    expect(result.reason).toBe("quality_rejected");
    expect(reflectCalls).toBe(1);
    expect(judgeCalls).toBe(1);
    const completed = readEvents({ type: "reflect_completed" }).events.at(-1);
    expect(completed?.metadata?.repairAttempts).toBe(0);
    // The rejection lands in the improve ledger with the reflect window, so
    // candidate selection does not re-generate it for 14 days.
    const db = openStateDatabase(getStateDbPath());
    try {
      const row = db
        .prepare(
          "SELECT outcome, detail, last_attempt_at, next_eligible_at FROM improve_ledger WHERE ref = ? AND source = 'reflect'",
        )
        .get("lessons/quality-reject") as
        | { outcome: string; detail: string; last_attempt_at: string; next_eligible_at: string }
        | undefined;
      expect(row).toMatchObject({ outcome: "quality_rejected", detail: "The revision is not useful." });
      expect(Date.parse(row?.next_eligible_at ?? "") - Date.parse(row?.last_attempt_at ?? "")).toBe(14 * 86_400_000);
    } finally {
      db.close();
    }
  });
});

// ── 2b. Context-aware content budget — LLM path only (#952) ────────────────

describe("akmReflect — content budget is context-aware on the direct-LLM path", () => {
  // A unique tail marker (not a repeated substring) so "did the prompt include
  // the true end of the body" can be asserted unambiguously.
  const TAIL_SENTINEL = "SENTINEL-TAIL-END-OF-DOCUMENT-952";
  const bigBody = `${"Long detailed reference paragraph about the system under test. ".repeat(400)}\n\n${TAIL_SENTINEL}`; // > 12k chars
  // The truncated-content fence: REFLECT_TRUNCATION_MARKER immediately closing
  // the fenced content block.
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
        // A small change so this isn't a no-op echo of the source.
        return framedReply({ description: "A large reference doc, described" }, 0.9);
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
        return framedReply({ description: "A large reference doc, described" }, 0.9);
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
        return framedReply({ description: "A large reference doc, described" }, 0.9);
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
