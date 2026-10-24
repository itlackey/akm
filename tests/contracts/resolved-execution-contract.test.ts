import { describe, expect, test } from "bun:test";
import { renderMarkdownExecutionSource } from "../../src/core/adapter/execution-source";
import {
  canonicalResolvedExecutionRequest,
  createInlineResolvedCommand,
  createResolvedCommand,
  createResolvedExecutionRequest,
  createResolvedPersona,
  decodeResolvedExecutionRequest,
  type ResolvedExecutionRequestV1,
  type ResolvedTargetSelection,
} from "../../src/execution/resolved-request";
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
    defaults: { model: "balanced" },
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
  });
}

function commonRequest(command: ReturnType<typeof createResolvedCommand>): ResolvedExecutionRequestV1 {
  return createResolvedExecutionRequest({
    command,
    agent: "fixture//agents/reviewer",
    persona: createResolvedPersona(personaSource()),
    target: { name: "fixture-agent", kind: "harness", platform: "opencode" },
    model: { model: "provider/exact-model", alias: "balanced" },
    inference: { temperature: 0, enableThinking: false, extraParams: {} },
    outputSchema: null,
    modelWork: false,
    runtime: { timeoutMs: 0, workspace: "", environment: {} },
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
        target: { name: "fixture-lab", kind: "connection" },
        modelWork: false,
        runtime: {},
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
        target: { name: "fixture-agent", kind: "harness" },
        modelWork: false,
        runtime: {},
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
    expect(() => decodeResolvedExecutionRequest({ ...canonical, schemaVersion: 3 })).toThrow(/upgrade akm/);
  });

  test("covers every runner kind without embedding a capability matrix", () => {
    const source = commandSource();
    const kinds = { connection: true, harness: true } satisfies Record<
      RunnerSpec["kind"] | ResolvedTargetSelection["kind"],
      true
    >;
    for (const kind of Object.keys(kinds) as Array<keyof typeof kinds>) {
      const request = createResolvedExecutionRequest({
        command: createResolvedCommand({ source, content: source.content }),
        target: { name: `fixture-${kind}`, kind },
        modelWork: false,
        runtime: {},
      });
      expect(request.target.kind).toBe(kind);
    }
  });

  test("reads a schemaVersion 1 request as the current one: its engine kind is the target kind, its authorization is modelWork, its model is the exact name and alias", () => {
    const source = commandSource();
    const v1 = (engine: Record<string, unknown>, authorization: Record<string, unknown>) => ({
      schemaVersion: 1,
      command: { template: source.content, content: source.content, source: null },
      engine,
      model: { input: "balanced", interpretation: "alias", resolved: "provider/exact-model" },
      authorization,
      runtime: { timeoutMs: 5 },
      notices: [{ code: "ANY", severity: "info", adapter: "x", message: "dropped" }],
    });

    const llm = decodeResolvedExecutionRequest(
      v1({ name: "lab", kind: "llm", platform: "openai-compatible" }, { status: "allowed" }),
    );
    expect(llm.target).toEqual({ name: "lab", kind: "connection", platform: "openai-compatible" });
    expect(llm.modelWork).toBe(true);
    expect(llm.model).toEqual({ model: "provider/exact-model", alias: "balanced" });
    expect(llm).not.toHaveProperty("notices");
    expect(llm).not.toHaveProperty("authorization");

    const agent = decodeResolvedExecutionRequest(
      v1({ name: "claude", kind: "agent", platform: "claude" }, { status: "not-required" }),
    );
    expect(agent.target).toEqual({ name: "claude", kind: "harness", platform: "claude" });
    expect(agent.modelWork).toBe(false);

    // A request read from schemaVersion 1 is written back as schemaVersion 2.
    expect(JSON.parse(canonicalResolvedExecutionRequest(agent))).toMatchObject({ schemaVersion: 2 });
    const exact = decodeResolvedExecutionRequest({
      ...v1({ name: "lab", kind: "llm" }, { status: "not-required" }),
      model: { input: "gpt-x", interpretation: "exact", resolved: "gpt-x" },
    });
    expect(exact.model).toEqual({ model: "gpt-x" });
  });

  test("supports explicit anonymous command content without pretending it came from a native file", () => {
    const command = createInlineResolvedCommand({ template: "Do the work.", content: "Do the work." });
    const request = createResolvedExecutionRequest({
      command,
      persona: null,
      target: { name: "fixture-lab", kind: "connection" },
      model: null,
      modelWork: false,
      runtime: { timeoutMs: null, workspace: null, environment: null },
    });

    expect(request.command.source).toBeNull();
    expect(Object.hasOwn(request, "persona")).toBe(true);
    expect(request.persona).toBeNull();
    expect(request.model).toBeNull();
    const canonical = canonicalResolvedExecutionRequest(request);
    expect(canonicalResolvedExecutionRequest(decodeResolvedExecutionRequest(JSON.parse(canonical)))).toBe(canonical);
  });
});
