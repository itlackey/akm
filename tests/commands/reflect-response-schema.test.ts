/**
 * Tests for the structured-output (`responseSchema`) lift in
 * `runReflectViaLlm` (Issue B1, reflect-pipeline investigation 2026-05-21).
 *
 * Mirrors the distill / consolidate lift in commit d2dee43. Providers that
 * honour `response_format: json_schema` enforce the
 * `{ref, content, frontmatter?, confidence?}` shape upstream, which targets
 * the ~22% schema-shape failure rate observed in the 2026-05-21 reflect eval
 * data (gemma-4-e4b dropping the `ref` field on some runs).
 *
 * Coverage:
 *   1. Schema shape: required fields, additionalProperties off, round-trip JSON.
 *   2. Wiring: when `akmReflect` dispatches through the `kind: "llm"`
 *      RunnerSpec, the underlying `chatCompletion` call receives
 *      REFLECT_JSON_SCHEMA as `responseSchema`.
 *   3. Parser compatibility: a payload that satisfies the schema is also
 *      accepted by `parseAgentProposalPayload` (the parser of record).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LlmConnectionConfig } from "../../src/core/config";
import { parseAgentProposalPayload } from "../../src/integrations/agent/prompts";

// ── Module-level chatCompletion spy ─────────────────────────────────────────
//
// `mock.module` must run before the modules under test are imported. We spread
// the real `client` module exports so unrelated callers keep working, and
// override only `chatCompletion` with a deterministic stub that records the
// `responseSchema` option passed by the production path.

interface CapturedCall {
  responseSchema: Record<string, unknown> | undefined;
  messageCount: number;
}

const capturedCalls: CapturedCall[] = [];
let stubReturn = "";

const realClient = await import("../../src/llm/client");
mock.module("../../src/llm/client", () => ({
  ...realClient,
  chatCompletion: async (
    _conn: LlmConnectionConfig,
    messages: Array<{ role: string; content: string }>,
    options?: { responseSchema?: Record<string, unknown> },
  ): Promise<string> => {
    capturedCalls.push({
      responseSchema: options?.responseSchema,
      messageCount: messages.length,
    });
    return stubReturn;
  },
}));

// Import AFTER mock.module so reflect / runReflectViaLlm pick up the stub.
const reflectModule = await import("../../src/commands/reflect");
const { akmReflect, runReflectViaLlm, REFLECT_JSON_SCHEMA } = reflectModule;

// ── Scaffolding ─────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
const savedEnv = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-reflect-rs-stash-");
  for (const dir of ["lessons", "skills", "memories", "knowledge"]) {
    fs.mkdirSync(path.join(stash, dir), { recursive: true });
  }
  return stash;
}

function fakeLlmConnection(): LlmConnectionConfig & { supportsJsonSchema?: boolean } {
  return {
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "test-model",
    supportsJsonSchema: true,
  };
}

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-reflect-rs-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-reflect-rs-config-");
  process.env.XDG_DATA_HOME = makeTempDir("akm-reflect-rs-data-");
  capturedCalls.length = 0;
  stubReturn = "";
});

afterEach(() => {
  if (savedEnv.AKM_STASH_DIR === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = savedEnv.AKM_STASH_DIR;
  if (savedEnv.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  if (savedEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedEnv.XDG_DATA_HOME;
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

  test("declares ref and content as required string fields", () => {
    const s = REFLECT_JSON_SCHEMA as {
      type: string;
      required: string[];
      properties: Record<string, { type?: string }>;
    };
    expect(s.type).toBe("object");
    expect(s.required).toContain("ref");
    expect(s.required).toContain("content");
    expect(s.properties.ref?.type).toBe("string");
    expect(s.properties.content?.type).toBe("string");
  });

  test("forbids additionalProperties at the top level so hallucinated keys are dropped", () => {
    const s = REFLECT_JSON_SCHEMA as { additionalProperties: boolean };
    expect(s.additionalProperties).toBe(false);
  });

  test("frontmatter is optional and typed as an object", () => {
    const s = REFLECT_JSON_SCHEMA as {
      required: string[];
      properties: Record<string, { type?: string }>;
    };
    expect(s.required).not.toContain("frontmatter");
    expect(s.properties.frontmatter?.type).toBe("object");
  });

  test("confidence is optional and bounded to [0, 1] (Phase 6A invariant)", () => {
    const s = REFLECT_JSON_SCHEMA as {
      required: string[];
      properties: Record<string, { type?: string; minimum?: number; maximum?: number }>;
    };
    expect(s.required).not.toContain("confidence");
    expect(s.properties.confidence?.type).toBe("number");
    expect(s.properties.confidence?.minimum).toBe(0);
    expect(s.properties.confidence?.maximum).toBe(1);
  });
});

// ── 2. Wiring ───────────────────────────────────────────────────────────────

describe("runReflectViaLlm — responseSchema is plumbed to chatCompletion", () => {
  test("when responseSchema is provided and no test-seam `chat` is set, chatCompletion receives the schema", async () => {
    stubReturn = JSON.stringify({
      ref: "lesson:wired",
      content: "---\ndescription: ok\nwhen_to_use: when wired\n---\n\nbody.\n",
    });

    const result = await runReflectViaLlm({
      prompt: "test prompt",
      connection: fakeLlmConnection(),
      iteration: 0,
      responseSchema: REFLECT_JSON_SCHEMA,
    });

    expect(result.ok).toBe(true);
    expect(capturedCalls.length).toBe(1);
    expect(capturedCalls[0].responseSchema).toBe(REFLECT_JSON_SCHEMA as Record<string, unknown>);
  });

  test("when `chat` test seam is provided, chatCompletion is NOT called (responseSchema is ignored)", async () => {
    // Belt-and-suspenders: confirms the additive-only contract — existing test
    // seams that don't pass responseSchema continue to short-circuit around
    // the production chatCompletion path.
    let chatCalls = 0;
    const result = await runReflectViaLlm({
      prompt: "test prompt",
      connection: fakeLlmConnection(),
      iteration: 0,
      responseSchema: REFLECT_JSON_SCHEMA,
      chat: async () => {
        chatCalls += 1;
        return "stub";
      },
    });

    expect(result.ok).toBe(true);
    expect(chatCalls).toBe(1);
    expect(capturedCalls.length).toBe(0);
  });

  test("when responseSchema is omitted, chatCompletion receives undefined responseSchema", async () => {
    stubReturn = "stub";
    await runReflectViaLlm({
      prompt: "test prompt",
      connection: fakeLlmConnection(),
      iteration: 0,
    });
    expect(capturedCalls.length).toBe(1);
    expect(capturedCalls[0].responseSchema).toBeUndefined();
  });
});

describe("akmReflect — passes REFLECT_JSON_SCHEMA when dispatching via the llm RunnerSpec", () => {
  test("llm RunnerSpec path wires REFLECT_JSON_SCHEMA into the underlying chatCompletion call", async () => {
    const stash = makeStashDir();
    stubReturn = JSON.stringify({
      ref: "lesson:akm-reflect-wires-schema",
      content:
        "---\ndescription: This lesson exists only to prove the schema is wired through to the LLM call site\nwhen_to_use: When confirming that the llm RunnerSpec dispatches with REFLECT_JSON_SCHEMA\n---\n\nBody.\n",
    });

    await akmReflect({
      ref: "lesson:akm-reflect-wires-schema",
      stashDir: stash,
      runner: { kind: "llm", connection: fakeLlmConnection() },
      // Bypass indexer lookup so the test does not need a built FTS index.
      assetContent: "",
    });

    // At least one chatCompletion call must have happened, and the FIRST one
    // (the reflect iteration) must carry REFLECT_JSON_SCHEMA. Downstream
    // quality-judge LLM calls may or may not pass a schema — we pin only the
    // reflect call here.
    expect(capturedCalls.length).toBeGreaterThanOrEqual(1);
    expect(capturedCalls[0].responseSchema).toBe(REFLECT_JSON_SCHEMA as Record<string, unknown>);
  });
});

// ── 3. Parser compatibility ─────────────────────────────────────────────────

describe("REFLECT_JSON_SCHEMA — parser compatibility with parseAgentProposalPayload", () => {
  test("a minimal schema-conforming payload (ref + content) parses successfully", () => {
    const sample = {
      ref: "lesson:demo",
      content: "Some markdown body.",
    };
    const out = parseAgentProposalPayload(JSON.stringify(sample));
    expect(out.ref).toBe("lesson:demo");
    expect(out.content).toBe("Some markdown body.");
    expect(out.frontmatter).toBeUndefined();
    expect(out.confidence).toBeUndefined();
  });

  test("a full schema-conforming payload (ref + content + frontmatter + confidence) parses successfully", () => {
    const sample = {
      ref: "lesson:demo",
      content: "---\ndescription: ok\nwhen_to_use: when relevant\n---\n\nBody.\n",
      frontmatter: { description: "ok", when_to_use: "when relevant" },
      confidence: 0.85,
    };
    const out = parseAgentProposalPayload(JSON.stringify(sample));
    expect(out.ref).toBe("lesson:demo");
    expect(out.frontmatter?.description).toBe("ok");
    expect(out.confidence).toBe(0.85);
  });

  test("parser rejects a payload missing ref — mirrors the schema's required-key contract", () => {
    const sample = { content: "Body without a ref." };
    expect(() => parseAgentProposalPayload(JSON.stringify(sample))).toThrow(/ref/);
  });

  test("parser rejects a payload missing content — mirrors the schema's required-key contract", () => {
    const sample = { ref: "lesson:demo" };
    expect(() => parseAgentProposalPayload(JSON.stringify(sample))).toThrow(/content/);
  });
});
