/**
 * Tests for the OpenHands CLI harness adapter (P2, plan §"The adapter
 * contract" / §"Capability matrix" / §"Structured-output normalization"):
 *   - harnesses/openhands/agent-builder.ts    — headless argv construction
 *   - harnesses/openhands/result-extractor.ts — stdout → { text, sessionId? }
 *
 * The OpenHands harness IS registered in `HARNESS_REGISTRY` /
 * `BUILTIN_BUILDERS` (see `src/integrations/harnesses/index.ts`); the
 * builder/extractor are exercised directly here for focused unit-level
 * coverage of argv construction and result extraction. No real binaries are
 * spawned; extractor fixtures are representative captures of the documented
 * `--json` JSONL action/observation event stream.
 */
import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { AgentRunResult } from "../../src/integrations/agent/spawn";
import {
  OPENHANDS_MODEL_ENV,
  OPENHANDS_PLATFORM,
  openhandsBuilder,
} from "../../src/integrations/harnesses/openhands/agent-builder";
import { openhandsResultExtractor } from "../../src/integrations/harnesses/openhands/result-extractor";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOpenhandsProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "openhands",
    bin: "openhands",
    args: [],
    stdio: "captured",
    envPassthrough: ["PATH"],
    parseOutput: "text",
    ...overrides,
  };
}

function makeRunResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    ok: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 42,
    ...overrides,
  };
}

/** One agent-sourced `action:"message"` JSONL event. */
function agentMessage(text: string): string {
  return JSON.stringify({ source: "agent", action: "message", args: { content: text }, message: text });
}

/** The task payload is always the last argv token, glued to --task=. */
function taskPayloadOf(argv: readonly string[]): string {
  const last = argv[argv.length - 1] as string;
  expect(last).toStartWith("--task=");
  return last.slice("--task=".length);
}

// ── Builder — plain prompt ────────────────────────────────────────────────────

describe("openhandsBuilder — plain prompt", () => {
  test("argv = [openhands, --headless, --json, --task=<prompt>] (matrix headless shape)", () => {
    const cmd = openhandsBuilder.build(makeOpenhandsProfile(), { prompt: "do work" });
    expect(cmd.argv).toEqual(["openhands", "--headless", "--json", "--task=do work"]);
  });

  test("platform id is 'openhands'; model env constant is LLM_MODEL", () => {
    expect(openhandsBuilder.platform).toBe("openhands");
    expect(OPENHANDS_PLATFORM).toBe("openhands");
    expect(OPENHANDS_MODEL_ENV).toBe("LLM_MODEL");
  });

  test("profile.args are preserved ahead of builder flags", () => {
    const cmd = openhandsBuilder.build(makeOpenhandsProfile({ args: ["--no-color"] }), { prompt: "go" });
    expect(cmd.argv).toEqual(["openhands", "--no-color", "--headless", "--json", "--task=go"]);
  });

  test("systemPrompt is folded into the task payload (no system-prompt flag exists)", () => {
    const cmd = openhandsBuilder.build(makeOpenhandsProfile(), { prompt: "do work", systemPrompt: "You are terse." });
    expect(cmd.argv).toEqual(["openhands", "--headless", "--json", "--task=You are terse.\n\ndo work"]);
  });

  test("dash-leading prompt binds lexically to --task= and cannot become a flag", () => {
    const cmd = openhandsBuilder.build(makeOpenhandsProfile(), { prompt: "--not-a-flag actually prose" });
    const argv = cmd.argv as string[];
    expect(argv[argv.length - 1]).toBe("--task=--not-a-flag actually prose");
    // No bare payload token exists anywhere in argv.
    expect(argv.includes("--not-a-flag actually prose")).toBe(false);
  });

  test("tool policy is deliberately dropped (no allowlist flags invented)", () => {
    const cmd = openhandsBuilder.build(makeOpenhandsProfile(), { prompt: "go", tools: ["read", "shell"] });
    expect(cmd.argv).toEqual(["openhands", "--headless", "--json", "--task=go"]);
  });

  test("no model → no env override on the built command", () => {
    const cmd = openhandsBuilder.build(makeOpenhandsProfile(), { prompt: "go" });
    expect(cmd.env).toBeUndefined();
  });
});

// ── Builder — exact model selection (via env, not argv) ─────────────────────

describe("openhandsBuilder — exact model selection through LLM_MODEL", () => {
  test("a model selector passes through verbatim", () => {
    const cmd = openhandsBuilder.build(makeOpenhandsProfile(), { prompt: "go", model: "sonnet" });
    expect(cmd.env).toEqual({ LLM_MODEL: "sonnet" });
  });

  test("exact model id passes through verbatim", () => {
    const cmd = openhandsBuilder.build(makeOpenhandsProfile(), { prompt: "go", model: "anthropic/claude-opus-4-7" });
    expect(cmd.env).toEqual({ LLM_MODEL: "anthropic/claude-opus-4-7" });
  });

  test("model never leaks into argv (no --model flag invented)", () => {
    const cmd = openhandsBuilder.build(makeOpenhandsProfile(), { prompt: "go", model: "sonnet" });
    expect((cmd.argv as string[]).includes("--model")).toBe(false);
    expect((cmd.argv as string[]).some((a) => a.includes("sonnet"))).toBe(false);
  });
});

// ── Builder — schema (prompt+validate tier) ──────────────────────────────────

describe("openhandsBuilder — schema passthrough (prompt+validate tier)", () => {
  const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };

  test("the task payload is the lowered prompt (no native schema flag)", () => {
    const cmd = openhandsBuilder.build(makeOpenhandsProfile(), { prompt: "judge it", schema });
    // The shared lowering appended the schema instruction; the builder adds no second copy.
    expect(taskPayloadOf(cmd.argv)).toBe("judge it");
    // No codex-style schema flag leaks into openhands argv.
    expect((cmd.argv as string[]).includes("--output-schema")).toBe(false);
  });

  test("--json is emitted regardless of schema (matrix headless shape is always JSONL)", () => {
    const bare = openhandsBuilder.build(makeOpenhandsProfile(), { prompt: "go" });
    const withSchema = openhandsBuilder.build(makeOpenhandsProfile(), { prompt: "go", schema });
    expect((bare.argv as string[]).includes("--json")).toBe(true);
    expect((withSchema.argv as string[]).includes("--json")).toBe(true);
  });

  test("system + prompt compose in order in one payload", () => {
    const cmd = openhandsBuilder.build(makeOpenhandsProfile(), {
      prompt: "judge it",
      systemPrompt: "Be strict.",
      schema,
    });
    expect(taskPayloadOf(cmd.argv)).toBe("Be strict.\n\njudge it");
  });
});

// ── Builder — injection guards ────────────────────────────────────────────────

describe("openhandsBuilder — model/systemPrompt values", () => {
  test("a leading '--' in model/systemPrompt is passed through, not rejected", () => {
    expect(() =>
      openhandsBuilder.build(makeOpenhandsProfile(), { prompt: "go", model: "--evil", systemPrompt: "--inject" }),
    ).not.toThrow();
  });

  test("valid values do not throw", () => {
    expect(() =>
      openhandsBuilder.build(makeOpenhandsProfile(), { prompt: "go", model: "gpt-5", systemPrompt: "Be helpful." }),
    ).not.toThrow();
  });
});

// ── Extractor — JSONL action/observation event stream (--json) ───────────────

describe("openhandsResultExtractor — JSONL event stream", () => {
  test("last agent message wins over intermediate ones; session id from first id-bearing event", () => {
    const stdout = [
      JSON.stringify({ id: 0, session_id: "oh-sess-1", source: "user", action: "message", args: { content: "task" } }),
      JSON.stringify({
        id: 1,
        source: "agent",
        action: "run",
        args: { command: "ls" },
        message: "Running command: ls",
      }),
      JSON.stringify({ id: 2, source: "agent", observation: "run", content: "README.md", message: "exit code 0" }),
      agentMessage("Intermediate note before tools."),
      agentMessage("Final answer."),
    ].join("\n");
    const extraction = openhandsResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "Final answer.", sessionId: "oh-sess-1" });
  });

  test("finish action's final_thought is the final message when it comes last", () => {
    const stdout = [
      agentMessage("working…"),
      JSON.stringify({
        id: 4,
        source: "agent",
        action: "finish",
        args: { final_thought: "All checks pass.", task_completed: "true", outputs: {} },
        message: "All done",
      }),
    ].join("\n");
    const extraction = openhandsResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "All checks pass." });
  });

  test("finish without final_thought falls back to thought, then message", () => {
    const viaThought = openhandsResultExtractor(
      makeRunResult({
        stdout: JSON.stringify({ source: "agent", action: "finish", args: { thought: "done via thought" } }),
      }),
    );
    expect(viaThought.text).toBe("done via thought");
    const viaMessage = openhandsResultExtractor(
      makeRunResult({
        stdout: JSON.stringify({ source: "agent", action: "finish", args: {}, message: "done via message" }),
      }),
    );
    expect(viaMessage.text).toBe("done via message");
  });

  test("user echoes, observations, and tool actions never contribute text", () => {
    const stdout = [
      JSON.stringify({ source: "user", action: "message", args: { content: "the task text" } }),
      agentMessage("agent speaks"),
      JSON.stringify({ source: "agent", action: "edit", args: { path: "a.ts" }, message: "Editing a.ts" }),
      JSON.stringify({ source: "environment", observation: "run", content: "tool output", message: "tool output" }),
    ].join("\n");
    const extraction = openhandsResultExtractor(makeRunResult({ stdout }));
    expect(extraction.text).toBe("agent speaks");
  });

  test("sid / conversation_id variants supply the session id; first one wins", () => {
    const bySid = openhandsResultExtractor(
      makeRunResult({
        stdout: [JSON.stringify({ sid: "oh-2", source: "agent", action: "run", args: {} }), agentMessage("ok")].join(
          "\n",
        ),
      }),
    );
    expect(bySid).toEqual({ text: "ok", sessionId: "oh-2" });
    const byConversation = openhandsResultExtractor(
      makeRunResult({ stdout: [JSON.stringify({ conversation_id: "conv-3" }), agentMessage("ok")].join("\n") }),
    );
    expect(byConversation).toEqual({ text: "ok", sessionId: "conv-3" });
  });

  test("non-JSON banner lines interleaved in the stream are skipped", () => {
    const stdout = ["OpenHands v0.40 — starting headless run", agentMessage("done"), ""].join("\n");
    const extraction = openhandsResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "done" });
  });

  test("stream with JSON events but no agent message falls back to raw stdout", () => {
    const stdout = [
      JSON.stringify({ source: "agent", action: "run", args: { command: "ls" }, message: "Running command: ls" }),
      JSON.stringify({ source: "agent", observation: "run", content: "README.md" }),
    ].join("\n");
    const extraction = openhandsResultExtractor(makeRunResult({ stdout }));
    expect(extraction.text).toBe(stdout);
  });
});

// ── Extractor — single JSON document ─────────────────────────────────────────

describe("openhandsResultExtractor — single JSON document", () => {
  test("one agent message line parses as a whole document", () => {
    const extraction = openhandsResultExtractor(makeRunResult({ stdout: agentMessage("solo event answer") }));
    expect(extraction).toEqual({ text: "solo event answer" });
  });

  test("pre-parsed result.parsed takes precedence over re-parsing stdout", () => {
    const extraction = openhandsResultExtractor(
      makeRunResult({
        stdout: agentMessage("from stdout"),
        parsed: { source: "agent", action: "message", session_id: "p-1", args: { content: "from parsed" } },
      }),
    );
    expect(extraction).toEqual({ text: "from parsed", sessionId: "p-1" });
  });

  test("unrecognized envelope keys fall back to raw stdout as text", () => {
    const stdout = JSON.stringify({ some_future_key: "x", session_id: "s-9" });
    const extraction = openhandsResultExtractor(makeRunResult({ stdout }));
    expect(extraction.text).toBe(stdout);
    expect(extraction.sessionId).toBe("s-9");
  });
});

// ── Extractor — plain text + fallbacks ────────────────────────────────────────

describe("openhandsResultExtractor — plain text and fallbacks", () => {
  test("plain text stdout passes through trimmed", () => {
    const extraction = openhandsResultExtractor(makeRunResult({ stdout: "  just some prose \n" }));
    expect(extraction).toEqual({ text: "just some prose" });
  });

  test("empty stdout yields empty text", () => {
    const extraction = openhandsResultExtractor(makeRunResult({ stdout: "   \n " }));
    expect(extraction).toEqual({ text: "" });
  });

  test("result.sessionId is the fallback when the output carries none", () => {
    const extraction = openhandsResultExtractor(makeRunResult({ stdout: agentMessage("ok"), sessionId: "raw-sess" }));
    expect(extraction).toEqual({ text: "ok", sessionId: "raw-sess" });
  });

  test("output-borne session id wins over result.sessionId", () => {
    const stdout = [JSON.stringify({ session_id: "fresh" }), agentMessage("ok")].join("\n");
    const extraction = openhandsResultExtractor(makeRunResult({ stdout, sessionId: "stale" }));
    expect(extraction.sessionId).toBe("fresh");
  });

  test("malformed JSON degrades to plain-text passthrough", () => {
    const stdout = '{"source":"agent","action":"message","args":{"conte';
    const extraction = openhandsResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: stdout });
  });
});
