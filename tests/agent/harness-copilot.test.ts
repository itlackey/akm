/**
 * Tests for the GitHub Copilot CLI harness adapter (P2, plan §"The adapter
 * contract" / §"Capability matrix" / §"Structured-output normalization"):
 *   - harnesses/copilot/agent-builder.ts   — headless argv construction
 *   - harnesses/copilot/result-extractor.ts — stdout → { text, sessionId? }
 *
 * The builder/extractor are exercised directly (they are NOT registered in
 * builders.ts / harnesses/index.ts yet — wiring is a follow-up integration
 * task). No real binaries are spawned; extractor fixtures are representative
 * captures of the documented `--output-format json` shapes.
 */
import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { AgentRunResult } from "../../src/integrations/agent/spawn";
import { copilotBuilder } from "../../src/integrations/harnesses/copilot/agent-builder";
import { copilotResultExtractor } from "../../src/integrations/harnesses/copilot/result-extractor";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCopilotProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "copilot",
    bin: "copilot",
    args: [],
    stdio: "captured",
    envPassthrough: ["PATH", "GH_TOKEN"],
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

// ── Builder — plain prompt ────────────────────────────────────────────────────

describe("copilotBuilder — plain prompt", () => {
  test("argv = [copilot, --allow-all-tools, -p, <prompt>] (matrix headless shape)", () => {
    const cmd = copilotBuilder.build(makeCopilotProfile(), { prompt: "do work" });
    expect(cmd.argv).toEqual(["copilot", "--allow-all-tools", "-p", "do work"]);
  });

  test("platform id is 'copilot'", () => {
    expect(copilotBuilder.platform).toBe("copilot");
  });

  test("profile.args are preserved ahead of builder flags", () => {
    const cmd = copilotBuilder.build(makeCopilotProfile({ args: ["--no-color"] }), { prompt: "go" });
    expect(cmd.argv).toEqual(["copilot", "--no-color", "--allow-all-tools", "-p", "go"]);
  });

  test("systemPrompt is folded into the -p payload ahead of the prompt (no system-prompt flag)", () => {
    const cmd = copilotBuilder.build(makeCopilotProfile(), {
      prompt: "do work",
      systemPrompt: "You are terse.",
    });
    const argv = cmd.argv as string[];
    expect(argv).not.toContain("--system-prompt");
    expect(argv[argv.length - 1]).toBe("You are terse.\n\ndo work");
  });
});

// ── Builder — model alias resolution ─────────────────────────────────────────

describe("copilotBuilder — model resolution via resolveModel('copilot')", () => {
  test("profile.modelAliases resolves a custom alias for the copilot platform", () => {
    const profile = makeCopilotProfile({ modelAliases: { fast: "gpt-5-mini" } });
    const cmd = copilotBuilder.build(profile, { prompt: "go", model: "fast" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("gpt-5-mini");
  });

  test("globalModelAliases copilot column wins over '*' fallback", () => {
    const profile = makeCopilotProfile({
      globalModelAliases: { deep: { copilot: "claude-sonnet-4-6", "*": "generic-deep" } },
    });
    const cmd = copilotBuilder.build(profile, { prompt: "go", model: "deep" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
  });

  test("globalModelAliases '*' fallback applies when no copilot column exists", () => {
    const profile = makeCopilotProfile({
      globalModelAliases: { deep: { "*": "generic-deep" } },
    });
    const cmd = copilotBuilder.build(profile, { prompt: "go", model: "deep" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("generic-deep");
  });

  test("exact model id passes through verbatim", () => {
    const cmd = copilotBuilder.build(makeCopilotProfile(), { prompt: "go", model: "gpt-5" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("gpt-5");
  });

  test("no model → no --model flag", () => {
    const cmd = copilotBuilder.build(makeCopilotProfile(), { prompt: "go" });
    expect((cmd.argv as string[]).includes("--model")).toBe(false);
  });
});

// ── Builder — schema (via prompt + --output-format json) ─────────────────────

describe("copilotBuilder — schema passthrough (prompt+validate tier)", () => {
  const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };

  test("--output-format json is emitted when a schema is present", () => {
    const cmd = copilotBuilder.build(makeCopilotProfile(), { prompt: "judge it", schema });
    const argv = cmd.argv as string[];
    const idx = argv.indexOf("--output-format");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("json");
  });

  test("schema directive is injected into the -p payload (no native schema flag)", () => {
    const cmd = copilotBuilder.build(makeCopilotProfile(), { prompt: "judge it", schema });
    const argv = cmd.argv as string[];
    const payload = argv[argv.length - 1] as string;
    expect(argv[argv.length - 2]).toBe("-p");
    expect(payload).toStartWith("judge it");
    expect(payload).toContain("Respond with ONLY a JSON value matching this JSON Schema");
    expect(payload).toContain(JSON.stringify(schema));
    // No codex-style schema flag leaks into copilot argv.
    expect(argv.includes("--output-schema")).toBe(false);
  });

  test("no schema → no --output-format flag", () => {
    const cmd = copilotBuilder.build(makeCopilotProfile(), { prompt: "go" });
    expect((cmd.argv as string[]).includes("--output-format")).toBe(false);
  });
});

// ── Builder — tool policy ─────────────────────────────────────────────────────

describe("copilotBuilder — tool policy", () => {
  test("string policy → repeated --allow-tool flags, no --allow-all-tools", () => {
    const cmd = copilotBuilder.build(makeCopilotProfile(), { prompt: "go", tools: "shell, write" });
    expect(cmd.argv).toEqual(["copilot", "--allow-tool", "shell", "--allow-tool", "write", "-p", "go"]);
  });

  test("array policy → repeated --allow-tool flags", () => {
    const cmd = copilotBuilder.build(makeCopilotProfile(), { prompt: "go", tools: ["read", "shell"] });
    expect(cmd.argv).toEqual(["copilot", "--allow-tool", "read", "--allow-tool", "shell", "-p", "go"]);
  });

  test("structured policy object → NO allow flags (restriction is never widened)", () => {
    const cmd = copilotBuilder.build(makeCopilotProfile(), {
      prompt: "go",
      tools: { read: "allow", write: "deny" },
    });
    const argv = cmd.argv as string[];
    expect(argv.includes("--allow-all-tools")).toBe(false);
    expect(argv.includes("--allow-tool")).toBe(false);
  });
});

// ── Builder — injection guards ────────────────────────────────────────────────

describe("copilotBuilder — assertNotFlag guards", () => {
  test("model starting with '--' throws", () => {
    expect(() => copilotBuilder.build(makeCopilotProfile(), { prompt: "go", model: "--evil" })).toThrow(
      /model must not start with "--"/,
    );
  });

  test("systemPrompt starting with '--' throws (it heads the -p payload)", () => {
    expect(() => copilotBuilder.build(makeCopilotProfile(), { prompt: "go", systemPrompt: "--inject" })).toThrow(
      /systemPrompt must not start with "--"/,
    );
  });

  test("tool entry starting with '--' throws", () => {
    expect(() => copilotBuilder.build(makeCopilotProfile(), { prompt: "go", tools: ["--evil-flag"] })).toThrow(
      /tools entry must not start with "--"/,
    );
  });

  test("valid values do not throw", () => {
    expect(() =>
      copilotBuilder.build(makeCopilotProfile(), {
        prompt: "go",
        model: "gpt-5",
        systemPrompt: "Be helpful.",
        tools: "shell",
      }),
    ).not.toThrow();
  });
});

// ── Extractor — single JSON envelope (--output-format json) ──────────────────

describe("copilotResultExtractor — single JSON envelope", () => {
  test("result envelope: text from `result`, sessionId from `session_id`", () => {
    const stdout = JSON.stringify({
      type: "result",
      session_id: "0199aa11-sess",
      result: "The verdict is PASS.",
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const extraction = copilotResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "The verdict is PASS.", sessionId: "0199aa11-sess" });
  });

  test("pretty-printed (multi-line) JSON envelope still parses as one document", () => {
    const stdout = JSON.stringify({ response: "hello world", sessionId: "s-42" }, null, 2);
    const extraction = copilotResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "hello world", sessionId: "s-42" });
  });

  test("nested assistant message with content blocks is flattened", () => {
    const stdout = JSON.stringify({
      type: "result",
      conversation_id: "c-7",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      },
    });
    const extraction = copilotResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "line one\nline two", sessionId: "c-7" });
  });

  test("pre-parsed result.parsed takes precedence over re-parsing stdout", () => {
    const extraction = copilotResultExtractor(
      makeRunResult({
        stdout: '{"result":"from stdout"}',
        parsed: { result: "from parsed", session_id: "p-1" },
      }),
    );
    expect(extraction).toEqual({ text: "from parsed", sessionId: "p-1" });
  });

  test("unrecognized envelope keys fall back to raw stdout as text", () => {
    const stdout = JSON.stringify({ some_future_key: "x", session_id: "s-9" });
    const extraction = copilotResultExtractor(makeRunResult({ stdout }));
    expect(extraction.text).toBe(stdout);
    expect(extraction.sessionId).toBe("s-9");
  });
});

// ── Extractor — JSONL event stream ────────────────────────────────────────────

describe("copilotResultExtractor — JSONL event stream", () => {
  test("last text-bearing event wins; session id comes from the stream", () => {
    const stdout = [
      JSON.stringify({ type: "session.start", session_id: "sess-jsonl-1" }),
      JSON.stringify({ type: "message", role: "assistant", content: "thinking..." }),
      JSON.stringify({ type: "tool.call", name: "shell", arguments: { cmd: "ls" } }),
      JSON.stringify({ type: "message", role: "assistant", content: "final answer" }),
    ].join("\n");
    const extraction = copilotResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "final answer", sessionId: "sess-jsonl-1" });
  });

  test("non-JSON banner lines interleaved in the stream are skipped", () => {
    const stdout = [
      "Welcome to GitHub Copilot CLI",
      JSON.stringify({ type: "session.start", session_id: "sess-2" }),
      JSON.stringify({ type: "result", result: "done" }),
    ].join("\n");
    const extraction = copilotResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "done", sessionId: "sess-2" });
  });

  test("stream with JSON events but no text falls back to raw stdout", () => {
    const stdout = [JSON.stringify({ type: "session.start", session_id: "sess-3" })].join("\n");
    // Single JSON line parses as a whole document first — use two lines to
    // force the JSONL path.
    const twoLines = `${stdout}\n${JSON.stringify({ type: "tool.call", name: "shell" })}`;
    const extraction = copilotResultExtractor(makeRunResult({ stdout: twoLines }));
    expect(extraction.text).toBe(twoLines);
    expect(extraction.sessionId).toBe("sess-3");
  });
});

// ── Extractor — plain text + fallbacks ────────────────────────────────────────

describe("copilotResultExtractor — plain text and fallbacks", () => {
  test("plain text stdout passes through trimmed", () => {
    const extraction = copilotResultExtractor(makeRunResult({ stdout: "  just some prose \n" }));
    expect(extraction).toEqual({ text: "just some prose" });
  });

  test("empty stdout yields empty text", () => {
    const extraction = copilotResultExtractor(makeRunResult({ stdout: "   \n " }));
    expect(extraction).toEqual({ text: "" });
  });

  test("result.sessionId is the fallback when a genuine envelope carries none", () => {
    // A `type`-marked result envelope with no in-band session id still unwraps;
    // the raw run result's sessionId is the fallback.
    const extraction = copilotResultExtractor(
      makeRunResult({ stdout: JSON.stringify({ type: "result", result: "ok" }), sessionId: "raw-sess" }),
    );
    expect(extraction).toEqual({ text: "ok", sessionId: "raw-sess" });
  });

  test("output-borne session id wins over result.sessionId", () => {
    const extraction = copilotResultExtractor(
      makeRunResult({ stdout: JSON.stringify({ result: "ok", session_id: "fresh" }), sessionId: "stale" }),
    );
    expect(extraction.sessionId).toBe("fresh");
  });

  test("malformed JSON degrades to plain-text passthrough", () => {
    const stdout = '{"result": "trunca';
    const extraction = copilotResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: stdout });
  });
});

// ── Extractor — bare JSON answers must NOT be unwrapped (PR #714 review) ──────
//
// When copilot runs without its JSON envelope, a schema unit's own JSON answer
// can legitimately use the envelope's common keys (result/response/text). Such
// an answer carries NO transport marker (no `type`, no session id), so it must
// reach the engine's schema validator raw instead of being unwrapped to a bare
// field value (which made runStructured report a false parse/validation failure
// on otherwise valid JSON).
describe("copilotResultExtractor — bare JSON answers pass through raw (no transport marker)", () => {
  test('{"result":"ok"} with no marker is returned raw, not unwrapped to "ok"', () => {
    const stdout = JSON.stringify({ result: "ok" });
    const extraction = copilotResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: stdout });
  });

  test("a schema answer using `response`/`text` keys is not unwrapped without a marker", () => {
    const stdout = JSON.stringify({ response: "the answer", text: "ignored", score: 3 });
    const extraction = copilotResultExtractor(makeRunResult({ stdout }));
    expect(extraction.text).toBe(stdout);
    expect(extraction.sessionId).toBeUndefined();
  });

  test("the raw run sessionId is still attached to a bare answer as a fallback", () => {
    const stdout = JSON.stringify({ result: "ok" });
    const extraction = copilotResultExtractor(makeRunResult({ stdout, sessionId: "raw-sess" }));
    expect(extraction).toEqual({ text: stdout, sessionId: "raw-sess" });
  });

  test("a session-id marker still identifies a genuine envelope and unwraps it", () => {
    const stdout = JSON.stringify({ result: "ok", session_id: "s-env" });
    const extraction = copilotResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "ok", sessionId: "s-env" });
  });

  test("a discriminated-union answer with an unrecognized `type` is not unwrapped", () => {
    // A schema answer may itself be a discriminated union — `type` alone is not
    // a transport marker unless it is one of Copilot's documented envelope
    // discriminators (peer review of the PR #714 fix).
    const stdout = JSON.stringify({ type: "success", output: "data" });
    const extraction = copilotResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: stdout });
  });

  test("documented envelope discriminators still unwrap (result, session.*)", () => {
    const result = copilotResultExtractor(
      makeRunResult({ stdout: JSON.stringify({ type: "result", result: "final" }) }),
    );
    expect(result.text).toBe("final");
    const sessionEvent = copilotResultExtractor(
      makeRunResult({ stdout: JSON.stringify({ type: "session.start", session_id: "s1", message: "hello" }) }),
    );
    expect(sessionEvent).toEqual({ text: "hello", sessionId: "s1" });
  });
});
