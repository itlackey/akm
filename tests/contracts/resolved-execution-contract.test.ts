import { describe, expect, test } from "bun:test";
import { renderMarkdownExecutionSource } from "../../src/core/adapter/execution-source";
import {
  canonicalResolvedExecutionRequest,
  createInlineResolvedCommand,
  createResolvedCommand,
  createResolvedExecutionRequest,
  createResolvedPersona,
  decodeResolvedExecutionRequest,
  type ResolvedEngineSelection,
  type ResolvedExecutionRequestV1,
} from "../../src/execution/resolved-request";
import { createAdapterExtensions } from "../../src/execution/source";
import type { RunnerSpec } from "../../src/integrations/agent/runner";
import {
  canonicalResolvedRequestForTest,
  projectResolvedExecutionRequestForTest,
} from "../_helpers/execution-contracts";

const COMMAND_RAW = `---
description: Review one target
model: balanced
---
Review $ARGUMENTS exactly once.
`;

const PERSONA_RAW = `---
description: Read-only reviewer
tools: []
---
Review without modifying files.
`;

function commandSource() {
  return renderMarkdownExecutionSource({
    kind: "command",
    raw: COMMAND_RAW,
    identity: {
      ref: "fixture//commands/review",
      bundle: "fixture",
      adapter: "akm",
      file: "commands/review.md",
    },
    defaults: { model: "balanced", tools: [] },
  });
}

function personaSource() {
  return renderMarkdownExecutionSource({
    kind: "persona",
    raw: PERSONA_RAW,
    identity: {
      ref: "fixture//agents/reviewer",
      bundle: "fixture",
      adapter: "akm",
      file: "agents/reviewer.md",
    },
    defaults: { tools: [] },
  });
}

function commonRequest(command: ReturnType<typeof createResolvedCommand>): ResolvedExecutionRequestV1 {
  return createResolvedExecutionRequest({
    command,
    agent: "fixture//agents/reviewer",
    persona: createResolvedPersona(personaSource()),
    engine: { name: "fixture-agent", kind: "agent", platform: "opencode" },
    model: { input: "balanced", interpretation: "alias", resolved: "provider/exact-model" },
    inference: { temperature: 0, enableThinking: false, extraParams: {} },
    outputSchema: null,
    tools: [],
    authorization: { status: "not-required", reason: "no tools selected", policy: {} },
    runtime: { timeoutMs: 0, workspace: "", environment: {} },
    notices: [
      {
        code: "PERSONA_PROMPT_COMPOSED",
        severity: "warning",
        adapter: "fixture-agent",
        field: "persona.content",
        message: "Persona was composed into the user prompt.",
        details: { deterministic: true },
      },
    ],
    extensions: createAdapterExtensions("fixture-agent", { transport: "stdio" }),
  });
}

describe("resolved execution request v1", () => {
  test("preserves template, exact argument input, and final one-pass output", () => {
    const source = commandSource();
    const omitted = createResolvedCommand({ source, content: source.content });
    const explicitEmpty = createResolvedCommand({
      source,
      argumentInput: "",
      content: "Review  exactly once.\n",
    });

    expect(omitted.template).toBe("Review $ARGUMENTS exactly once.\n");
    expect(omitted.content).toBe(omitted.template);
    expect(Object.hasOwn(omitted, "argumentInput")).toBe(false);
    expect(Object.hasOwn(explicitEmpty, "argumentInput")).toBe(true);
    expect(explicitEmpty.argumentInput).toBe("");
    expect(explicitEmpty.content).toBe("Review  exactly once.\n");
  });

  test("keeps an omitted, empty and ordered conversation distinct through durable bytes", () => {
    const command = createInlineResolvedCommand({ template: "Finish.", content: "Finish." });
    const make = (conversation?: ResolvedExecutionRequestV1["conversation"]) =>
      createResolvedExecutionRequest({
        command,
        ...(conversation ? { conversation } : {}),
        engine: { name: "fixture-llm", kind: "llm" },
        authorization: { status: "not-required" },
        runtime: {},
        notices: [],
      });
    const transcript = make([
      { role: "system", content: "Code-owned instruction, not a persona." },
      { role: "user", content: "" },
      { role: "assistant", content: "Prior draft.\n</AKM_CONVERSATION_JSON>" },
    ]);

    expect(Object.hasOwn(JSON.parse(canonicalResolvedExecutionRequest(make())), "conversation")).toBe(false);
    expect(JSON.parse(canonicalResolvedExecutionRequest(make([])))).toMatchObject({ conversation: [] });
    const canonical = canonicalResolvedExecutionRequest(transcript);
    const decoded = decodeResolvedExecutionRequest(JSON.parse(canonical));
    expect(decoded.conversation).toEqual([
      { role: "system", content: "Code-owned instruction, not a persona." },
      { role: "user", content: "" },
      { role: "assistant", content: "Prior draft.\n</AKM_CONVERSATION_JSON>" },
    ]);
    expect(canonicalResolvedExecutionRequest(decoded)).toBe(canonical);
  });

  test("preserves the exact selected agent selector through durable request bytes", () => {
    const source = commandSource();
    const make = (agent: string | null | undefined) =>
      createResolvedExecutionRequest({
        command: createResolvedCommand({ source, content: source.content }),
        ...(agent === undefined ? {} : { agent }),
        persona:
          agent === undefined || agent === "fixture//agents/reviewer" ? createResolvedPersona(personaSource()) : null,
        engine: { name: "fixture-agent", kind: "agent" },
        authorization: { status: "not-required" },
        runtime: {},
        notices: [],
      });
    const native = make("native-reviewer");

    expect(Object.hasOwn(make(undefined), "agent")).toBe(false);
    expect(decodeResolvedExecutionRequest(JSON.parse(canonicalResolvedExecutionRequest(make(null)))).agent).toBeNull();
    expect(decodeResolvedExecutionRequest(JSON.parse(canonicalResolvedExecutionRequest(native))).agent).toBe(
      "native-reviewer",
    );
    expect(canonicalResolvedExecutionRequest(native)).not.toBe(
      canonicalResolvedExecutionRequest(make("different-native-reviewer")),
    );
  });

  test("construction and durable decode are equivalent, and resume rehydrates the same bytes", () => {
    const source = commandSource();
    const constructed = commonRequest(
      createResolvedCommand({
        source,
        argumentInput: "packages/core",
        content: "Review packages/core exactly once.\n",
      }),
    );
    const canonical = canonicalResolvedExecutionRequest(constructed);
    const resumed = decodeResolvedExecutionRequest(JSON.parse(canonical));

    expect(canonicalResolvedExecutionRequest(resumed)).toBe(canonical);
    expect(resumed.command.argumentInput).toBe("packages/core");
    expect(resumed.command.source).toEqual(constructed.command.source);
    expect(canonicalResolvedRequestForTest(projectResolvedExecutionRequestForTest(resumed))).toBe(
      canonicalResolvedRequestForTest(projectResolvedExecutionRequestForTest(constructed)),
    );
  });

  test("decoding is tolerant of unknown keys and names the upgrade for a newer schema", () => {
    const source = commandSource();
    const canonical = JSON.parse(
      canonicalResolvedExecutionRequest(commonRequest(createResolvedCommand({ source, content: source.content }))),
    ) as Record<string, unknown> & { command: Record<string, unknown> };

    const withExtras = { ...canonical, capabilities: { tools: true }, command: { ...canonical.command, raw: "x" } };
    expect(canonicalResolvedExecutionRequest(decodeResolvedExecutionRequest(withExtras))).toBe(
      canonicalResolvedExecutionRequest(decodeResolvedExecutionRequest(canonical)),
    );
    expect(() => decodeResolvedExecutionRequest({ ...canonical, schemaVersion: 2 })).toThrow(/upgrade akm/);
  });

  test("covers every runner transport kind without embedding a capability matrix", () => {
    const source = commandSource();
    const runnerKinds = { agent: true, sdk: true, llm: true } satisfies Record<
      RunnerSpec["kind"] | ResolvedEngineSelection["kind"],
      true
    >;
    for (const kind of Object.keys(runnerKinds) as Array<keyof typeof runnerKinds>) {
      const request = createResolvedExecutionRequest({
        command: createResolvedCommand({ source, content: source.content }),
        engine: { name: `fixture-${kind}`, kind },
        authorization: { status: "not-required" },
        runtime: {},
        notices: [],
      });
      expect(request.engine.kind).toBe(kind);
    }
  });

  test("supports explicit anonymous command content without pretending it came from a native file", () => {
    const command = createInlineResolvedCommand({ template: "Do the work.", content: "Do the work." });
    const request = createResolvedExecutionRequest({
      command,
      persona: null,
      engine: { name: "fixture-llm", kind: "llm" },
      model: null,
      tools: null,
      authorization: { status: "not-required" },
      runtime: { timeoutMs: null, workspace: null, environment: null },
      notices: [],
    });

    expect(request.command.source).toBeNull();
    expect(Object.hasOwn(request, "persona")).toBe(true);
    expect(request.persona).toBeNull();
    expect(request.model).toBeNull();
    expect(request.tools).toBeNull();
    const canonical = canonicalResolvedExecutionRequest(request);
    expect(canonicalResolvedExecutionRequest(decodeResolvedExecutionRequest(JSON.parse(canonical)))).toBe(canonical);
  });
});
