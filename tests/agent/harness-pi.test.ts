/**
 * Tests for the Pi coding-agent CLI harness adapter (P2, plan §"The adapter
 * contract" / §"Capability matrix" / §"Structured-output normalization"):
 *   - harnesses/pi/agent-builder.ts    — headless argv construction
 *   - harnesses/pi/result-extractor.ts — stdout → { text, sessionId? }
 *
 * The builder/extractor are exercised directly (they are NOT registered in
 * builders.ts / harnesses/index.ts yet — wiring is a follow-up integration
 * task). No real binaries are spawned; extractor fixtures are representative
 * captures of the documented `--mode json` JSONL agent-event stream.
 */
import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { AgentRunResult } from "../../src/integrations/agent/spawn";
import { PI_PLATFORM, PI_RESUME_FLAG, piBuilder } from "../../src/integrations/harnesses/pi/agent-builder";
import { piResultExtractor } from "../../src/integrations/harnesses/pi/result-extractor";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePiProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "pi",
    bin: "pi",
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

/** One assistant `message_end` JSONL event with a single text block. */
function assistantMessageEnd(text: string): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

// ── Builder — plain prompt ────────────────────────────────────────────────────

describe("piBuilder — plain prompt", () => {
  test("argv = [pi, -p, --, <prompt>] (matrix headless shape)", () => {
    const cmd = piBuilder.build(makePiProfile(), { prompt: "do work" });
    expect(cmd.argv).toEqual(["pi", "-p", "--", "do work"]);
  });

  test("platform id is 'pi'; resume flag constant is '--session' (matrix)", () => {
    expect(piBuilder.platform).toBe("pi");
    expect(PI_PLATFORM).toBe("pi");
    expect(PI_RESUME_FLAG).toBe("--session");
  });

  test("profile.args are preserved ahead of builder flags", () => {
    const cmd = piBuilder.build(makePiProfile({ args: ["--no-color"] }), { prompt: "go" });
    expect(cmd.argv).toEqual(["pi", "--no-color", "-p", "--", "go"]);
  });

  test("systemPrompt maps to --system-prompt", () => {
    const cmd = piBuilder.build(makePiProfile(), { prompt: "do work", systemPrompt: "You are terse." });
    expect(cmd.argv).toEqual(["pi", "--system-prompt", "You are terse.", "-p", "--", "do work"]);
  });

  test("prompt stays positional after `--` so a dash-leading prompt cannot become flags", () => {
    const cmd = piBuilder.build(makePiProfile(), { prompt: "--not-a-flag actually prose" });
    const argv = cmd.argv as string[];
    expect(argv[argv.length - 2]).toBe("--");
    expect(argv[argv.length - 1]).toBe("--not-a-flag actually prose");
  });

  test("tool policy is deliberately dropped (no allowlist flags invented)", () => {
    const cmd = piBuilder.build(makePiProfile(), { prompt: "go", tools: ["read", "shell"] });
    expect(cmd.argv).toEqual(["pi", "-p", "--", "go"]);
  });
});

// ── Builder — model alias resolution ─────────────────────────────────────────

describe("piBuilder — model resolution via resolveModel('pi')", () => {
  test("profile.modelAliases resolves a custom alias for the pi platform", () => {
    const profile = makePiProfile({ modelAliases: { fast: "gpt-5-mini" } });
    const cmd = piBuilder.build(profile, { prompt: "go", model: "fast" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("gpt-5-mini");
  });

  test("globalModelAliases pi column wins over '*' fallback", () => {
    const profile = makePiProfile({
      globalModelAliases: { deep: { pi: "claude-sonnet-4-6", "*": "generic-deep" } },
    });
    const cmd = piBuilder.build(profile, { prompt: "go", model: "deep" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
  });

  test("globalModelAliases '*' fallback applies when no pi column exists", () => {
    const profile = makePiProfile({
      globalModelAliases: { deep: { "*": "generic-deep" } },
    });
    const cmd = piBuilder.build(profile, { prompt: "go", model: "deep" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("generic-deep");
  });

  test("builtin alias without a pi column passes through verbatim (user aliases own pi ids)", () => {
    const cmd = piBuilder.build(makePiProfile(), { prompt: "go", model: "sonnet" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
  });

  test("exact model id passes through verbatim", () => {
    const cmd = piBuilder.build(makePiProfile(), { prompt: "go", model: "gpt-5" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("gpt-5");
  });

  test("no model → no --model flag", () => {
    const cmd = piBuilder.build(makePiProfile(), { prompt: "go" });
    expect((cmd.argv as string[]).includes("--model")).toBe(false);
  });
});

// ── Builder — schema (via prompt + --mode json) ──────────────────────────────

describe("piBuilder — schema passthrough (prompt+validate tier)", () => {
  const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };

  test("--mode json is emitted when a schema is present", () => {
    const cmd = piBuilder.build(makePiProfile(), { prompt: "judge it", schema });
    const argv = cmd.argv as string[];
    const idx = argv.indexOf("--mode");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("json");
  });

  test("schema directive is injected into the prompt payload (no native schema flag)", () => {
    const cmd = piBuilder.build(makePiProfile(), { prompt: "judge it", schema });
    const argv = cmd.argv as string[];
    const payload = argv[argv.length - 1] as string;
    expect(argv[argv.length - 2]).toBe("--");
    expect(payload).toStartWith("judge it");
    expect(payload).toContain("Respond with ONLY a JSON value matching this JSON Schema");
    expect(payload).toContain(JSON.stringify(schema));
    // No codex-style schema flag leaks into pi argv.
    expect(argv.includes("--output-schema")).toBe(false);
  });

  test("no schema → no --mode flag (bare matrix headless shape)", () => {
    const cmd = piBuilder.build(makePiProfile(), { prompt: "go" });
    expect((cmd.argv as string[]).includes("--mode")).toBe(false);
  });
});

// ── Builder — injection guards ────────────────────────────────────────────────

describe("piBuilder — assertNotFlag guards", () => {
  test("model starting with '--' throws", () => {
    expect(() => piBuilder.build(makePiProfile(), { prompt: "go", model: "--evil" })).toThrow(
      /model must not start with "--"/,
    );
  });

  test("systemPrompt starting with '--' throws", () => {
    expect(() => piBuilder.build(makePiProfile(), { prompt: "go", systemPrompt: "--inject" })).toThrow(
      /systemPrompt must not start with "--"/,
    );
  });

  test("valid values do not throw", () => {
    expect(() =>
      piBuilder.build(makePiProfile(), { prompt: "go", model: "gpt-5", systemPrompt: "Be helpful." }),
    ).not.toThrow();
  });
});

// ── Extractor — JSONL agent-event stream (--mode json) ───────────────────────

describe("piResultExtractor — JSONL event stream", () => {
  test("last assistant message_end wins; session id comes from session_start", () => {
    const stdout = [
      JSON.stringify({ type: "session_start", session_id: "pi-sess-1" }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }),
      assistantMessageEnd("Intermediate note before tools."),
      JSON.stringify({ type: "tool_execution_start", toolName: "bash" }),
      assistantMessageEnd("Final answer."),
      JSON.stringify({ type: "agent_end" }),
    ].join("\n");
    const extraction = piResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "Final answer.", sessionId: "pi-sess-1" });
  });

  test("session-lifecycle events carrying a bare `id` supply the session id", () => {
    const stdout = [JSON.stringify({ type: "session", id: "pi-sess-2" }), assistantMessageEnd("done")].join("\n");
    const extraction = piResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "done", sessionId: "pi-sess-2" });
  });

  test("user-role echoes and tool events never contribute text", () => {
    const stdout = [
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "task" }] } }),
      assistantMessageEnd("assistant speaks"),
      JSON.stringify({
        type: "message_end",
        message: { role: "user", content: [{ type: "toolResult", output: "x" }] },
      }),
    ].join("\n");
    const extraction = piResultExtractor(makeRunResult({ stdout }));
    expect(extraction.text).toBe("assistant speaks");
  });

  test("assistant content blocks are flattened; thinking/tool blocks are skipped", () => {
    const stdout = [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden reasoning" },
            { type: "text", text: "line one" },
            { type: "toolCall", name: "bash", arguments: { cmd: "ls" } },
            { type: "text", text: "line two" },
          ],
        },
      }),
    ].join("\n");
    const extraction = piResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "line one\nline two" });
  });

  test("agent_end transcript: last assistant entry wins when no message_end was seen", () => {
    const stdout = [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "user", content: [{ type: "text", text: "the task" }] },
          { role: "assistant", content: [{ type: "text", text: "first reply" }] },
          { role: "assistant", content: [{ type: "text", text: "transcript final" }] },
        ],
      }),
    ].join("\n");
    const extraction = piResultExtractor(makeRunResult({ stdout }));
    expect(extraction.text).toBe("transcript final");
  });

  test("non-JSON banner lines interleaved in the stream are skipped", () => {
    const stdout = ["pi v0.9.0 — session started", assistantMessageEnd("done"), ""].join("\n");
    const extraction = piResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "done" });
  });

  test("stream with JSON events but no assistant text falls back to raw stdout", () => {
    const stdout = [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "tool_execution_start", toolName: "bash" }),
    ].join("\n");
    const extraction = piResultExtractor(makeRunResult({ stdout }));
    expect(extraction.text).toBe(stdout);
  });
});

// ── Extractor — single JSON document ─────────────────────────────────────────

describe("piResultExtractor — single JSON document", () => {
  test("one message_end line parses as a whole document", () => {
    const stdout = assistantMessageEnd("solo event answer");
    const extraction = piResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "solo event answer" });
  });

  test("pre-parsed result.parsed takes precedence over re-parsing stdout", () => {
    const extraction = piResultExtractor(
      makeRunResult({
        stdout: assistantMessageEnd("from stdout"),
        parsed: {
          type: "message_end",
          session_id: "p-1",
          message: { role: "assistant", content: [{ type: "text", text: "from parsed" }] },
        },
      }),
    );
    expect(extraction).toEqual({ text: "from parsed", sessionId: "p-1" });
  });

  test("unrecognized envelope keys fall back to raw stdout as text", () => {
    const stdout = JSON.stringify({ some_future_key: "x", session_id: "s-9" });
    const extraction = piResultExtractor(makeRunResult({ stdout }));
    expect(extraction.text).toBe(stdout);
    expect(extraction.sessionId).toBe("s-9");
  });
});

// ── Extractor — plain text + fallbacks ────────────────────────────────────────

describe("piResultExtractor — plain text and fallbacks", () => {
  test("plain text stdout passes through trimmed", () => {
    const extraction = piResultExtractor(makeRunResult({ stdout: "  just some prose \n" }));
    expect(extraction).toEqual({ text: "just some prose" });
  });

  test("empty stdout yields empty text", () => {
    const extraction = piResultExtractor(makeRunResult({ stdout: "   \n " }));
    expect(extraction).toEqual({ text: "" });
  });

  test("result.sessionId is the fallback when the output carries none", () => {
    const extraction = piResultExtractor(makeRunResult({ stdout: assistantMessageEnd("ok"), sessionId: "raw-sess" }));
    expect(extraction).toEqual({ text: "ok", sessionId: "raw-sess" });
  });

  test("output-borne session id wins over result.sessionId", () => {
    const stdout = [JSON.stringify({ type: "session_start", session_id: "fresh" }), assistantMessageEnd("ok")].join(
      "\n",
    );
    const extraction = piResultExtractor(makeRunResult({ stdout, sessionId: "stale" }));
    expect(extraction.sessionId).toBe("fresh");
  });

  test("malformed JSON degrades to plain-text passthrough", () => {
    const stdout = '{"type":"message_end","message":{"role":"assist';
    const extraction = piResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: stdout });
  });
});
