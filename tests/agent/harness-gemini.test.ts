/**
 * Tests for the Gemini CLI harness adapter (P2, plan §"The adapter contract"
 * / §"Capability matrix" / §"Structured-output normalization"):
 *   - harnesses/gemini/agent-builder.ts    — headless argv construction
 *   - harnesses/gemini/result-extractor.ts — stdout → { text, sessionId? }
 *
 * The builder/extractor are exercised directly (they are NOT registered in
 * builders.ts / harnesses/index.ts yet — wiring is a follow-up integration
 * task). No real binaries are spawned; extractor fixtures are representative
 * captures of the documented `--output-format json` / `stream-json` shapes.
 */
import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { AgentRunResult } from "../../src/integrations/agent/spawn";
import { GEMINI_PLATFORM, geminiBuilder } from "../../src/integrations/harnesses/gemini/agent-builder";
import { geminiResultExtractor } from "../../src/integrations/harnesses/gemini/result-extractor";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeGeminiProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "gemini",
    bin: "gemini",
    args: [],
    stdio: "captured",
    envPassthrough: ["PATH", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
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

describe("geminiBuilder — plain prompt", () => {
  test("argv = [gemini, -p, <prompt>] (matrix headless shape)", () => {
    const cmd = geminiBuilder.build(makeGeminiProfile(), { prompt: "do work" });
    expect(cmd.argv).toEqual(["gemini", "-p", "do work"]);
  });

  test("platform id is 'gemini'", () => {
    expect(geminiBuilder.platform).toBe("gemini");
    expect(GEMINI_PLATFORM).toBe("gemini");
  });

  test("profile.args are preserved ahead of builder flags", () => {
    const cmd = geminiBuilder.build(makeGeminiProfile({ args: ["--yolo"] }), { prompt: "go" });
    expect(cmd.argv).toEqual(["gemini", "--yolo", "-p", "go"]);
  });

  test("systemPrompt is folded into the -p payload ahead of the prompt (no system-prompt flag)", () => {
    const cmd = geminiBuilder.build(makeGeminiProfile(), {
      prompt: "do work",
      systemPrompt: "You are terse.",
    });
    const argv = cmd.argv as string[];
    expect(argv).not.toContain("--system-prompt");
    expect(argv[argv.length - 2]).toBe("-p");
    expect(argv[argv.length - 1]).toBe("You are terse.\n\ndo work");
  });
});

// ── Builder — model alias resolution ─────────────────────────────────────────

describe("geminiBuilder — model resolution via resolveModel('gemini')", () => {
  test("profile.modelAliases resolves a custom alias for the gemini platform", () => {
    const profile = makeGeminiProfile({ modelAliases: { fast: "gemini-2.5-flash" } });
    const cmd = geminiBuilder.build(profile, { prompt: "go", model: "fast" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("gemini-2.5-flash");
  });

  test("globalModelAliases gemini column wins over '*' fallback", () => {
    const profile = makeGeminiProfile({
      globalModelAliases: { deep: { gemini: "gemini-2.5-pro", "*": "generic-deep" } },
    });
    const cmd = geminiBuilder.build(profile, { prompt: "go", model: "deep" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("gemini-2.5-pro");
  });

  test("globalModelAliases '*' fallback applies when no gemini column exists", () => {
    const profile = makeGeminiProfile({
      globalModelAliases: { deep: { "*": "generic-deep" } },
    });
    const cmd = geminiBuilder.build(profile, { prompt: "go", model: "deep" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("generic-deep");
  });

  test("exact model id passes through verbatim (builtin aliases carry no gemini column)", () => {
    const cmd = geminiBuilder.build(makeGeminiProfile(), { prompt: "go", model: "gemini-2.5-pro" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("gemini-2.5-pro");
  });

  test("no model → no --model flag", () => {
    const cmd = geminiBuilder.build(makeGeminiProfile(), { prompt: "go" });
    expect((cmd.argv as string[]).includes("--model")).toBe(false);
  });
});

// ── Builder — schema (via prompt + --output-format json) ─────────────────────

describe("geminiBuilder — schema passthrough (prompt+validate tier)", () => {
  const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };

  test("--output-format json is emitted when a schema is present", () => {
    const cmd = geminiBuilder.build(makeGeminiProfile(), { prompt: "judge it", schema });
    const argv = cmd.argv as string[];
    const idx = argv.indexOf("--output-format");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("json");
  });

  test("schema directive is injected into the -p payload (no native schema flag)", () => {
    const cmd = geminiBuilder.build(makeGeminiProfile(), { prompt: "judge it", schema });
    const argv = cmd.argv as string[];
    const payload = argv[argv.length - 1] as string;
    expect(argv[argv.length - 2]).toBe("-p");
    expect(payload).toStartWith("judge it");
    expect(payload).toContain("Respond with ONLY a JSON value matching this JSON Schema");
    expect(payload).toContain(JSON.stringify(schema));
    // No codex-style schema flag leaks into gemini argv.
    expect(argv.includes("--output-schema")).toBe(false);
  });

  test("no schema → no --output-format flag", () => {
    const cmd = geminiBuilder.build(makeGeminiProfile(), { prompt: "go" });
    expect((cmd.argv as string[]).includes("--output-format")).toBe(false);
  });
});

// ── Builder — tool policy ─────────────────────────────────────────────────────

describe("geminiBuilder — tool policy", () => {
  test("string policy → repeated --allowed-tools flags", () => {
    const cmd = geminiBuilder.build(makeGeminiProfile(), { prompt: "go", tools: "run_shell_command, write_file" });
    expect(cmd.argv).toEqual([
      "gemini",
      "--allowed-tools",
      "run_shell_command",
      "--allowed-tools",
      "write_file",
      "-p",
      "go",
    ]);
  });

  test("array policy → repeated --allowed-tools flags", () => {
    const cmd = geminiBuilder.build(makeGeminiProfile(), { prompt: "go", tools: ["read_file", "run_shell_command"] });
    expect(cmd.argv).toEqual([
      "gemini",
      "--allowed-tools",
      "read_file",
      "--allowed-tools",
      "run_shell_command",
      "-p",
      "go",
    ]);
  });

  test("structured policy object → NO tool flags (restriction is never widened)", () => {
    const cmd = geminiBuilder.build(makeGeminiProfile(), {
      prompt: "go",
      tools: { read_file: "allow", write_file: "deny" },
    });
    const argv = cmd.argv as string[];
    expect(argv.includes("--allowed-tools")).toBe(false);
    expect(argv.includes("--yolo")).toBe(false);
  });

  test("no policy → bare headless shape (no auto-approval flag is invented)", () => {
    const cmd = geminiBuilder.build(makeGeminiProfile(), { prompt: "go" });
    expect(cmd.argv).toEqual(["gemini", "-p", "go"]);
  });
});

// ── Builder — injection guards ────────────────────────────────────────────────

describe("geminiBuilder — assertNotFlag guards", () => {
  test("model starting with '--' throws", () => {
    expect(() => geminiBuilder.build(makeGeminiProfile(), { prompt: "go", model: "--evil" })).toThrow(
      /model must not start with "--"/,
    );
  });

  test("systemPrompt starting with '--' throws (it heads the -p payload)", () => {
    expect(() => geminiBuilder.build(makeGeminiProfile(), { prompt: "go", systemPrompt: "--inject" })).toThrow(
      /systemPrompt must not start with "--"/,
    );
  });

  test("tool entry starting with '--' throws", () => {
    expect(() => geminiBuilder.build(makeGeminiProfile(), { prompt: "go", tools: ["--evil-flag"] })).toThrow(
      /tools entry must not start with "--"/,
    );
  });

  test("valid values do not throw", () => {
    expect(() =>
      geminiBuilder.build(makeGeminiProfile(), {
        prompt: "go",
        model: "gemini-2.5-pro",
        systemPrompt: "Be helpful.",
        tools: "run_shell_command",
      }),
    ).not.toThrow();
  });
});

// ── Extractor — single JSON envelope (--output-format json) ──────────────────

describe("geminiResultExtractor — single JSON envelope", () => {
  test("documented envelope: text from `response`, stats ignored", () => {
    const stdout = JSON.stringify({
      response: "The verdict is PASS.",
      stats: { models: { "gemini-2.5-pro": { tokens: { prompt: 100, candidates: 20 } } }, tools: {}, files: {} },
    });
    const extraction = geminiResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "The verdict is PASS." });
  });

  test("envelope with session id: sessionId captured from `session_id`", () => {
    const stdout = JSON.stringify({
      response: "done",
      session_id: "0199aa11-sess",
      stats: {},
    });
    const extraction = geminiResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "done", sessionId: "0199aa11-sess" });
  });

  test("pretty-printed (multi-line) JSON envelope still parses as one document", () => {
    const stdout = JSON.stringify({ response: "hello world", sessionId: "s-42" }, null, 2);
    const extraction = geminiResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "hello world", sessionId: "s-42" });
  });

  test("`response` wins over other text-bearing keys", () => {
    const stdout = JSON.stringify({ response: "the answer", message: "loading model" });
    const extraction = geminiResultExtractor(makeRunResult({ stdout }));
    expect(extraction.text).toBe("the answer");
  });

  test("nested parts-style content blocks are flattened", () => {
    const stdout = JSON.stringify({
      conversation_id: "c-7",
      message: {
        role: "model",
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      },
    });
    const extraction = geminiResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "line one\nline two", sessionId: "c-7" });
  });

  test("pre-parsed result.parsed takes precedence over re-parsing stdout", () => {
    const extraction = geminiResultExtractor(
      makeRunResult({
        stdout: '{"response":"from stdout"}',
        parsed: { response: "from parsed", session_id: "p-1" },
      }),
    );
    expect(extraction).toEqual({ text: "from parsed", sessionId: "p-1" });
  });

  test("error-only envelope falls back to raw stdout as text (engine sees full material)", () => {
    const stdout = JSON.stringify({
      error: { type: "ApiError", message: "quota exceeded", code: 429 },
      session_id: "s-9",
    });
    const extraction = geminiResultExtractor(makeRunResult({ stdout, ok: false, exitCode: 1 }));
    expect(extraction.text).toBe(stdout);
    expect(extraction.sessionId).toBe("s-9");
  });
});

// ── Extractor — JSONL event stream (--output-format stream-json) ─────────────

describe("geminiResultExtractor — JSONL event stream", () => {
  test("last text-bearing event wins; session id comes from the stream", () => {
    const stdout = [
      JSON.stringify({ type: "init", session_id: "sess-jsonl-1", model: "gemini-2.5-pro" }),
      JSON.stringify({ type: "message", role: "model", content: "thinking..." }),
      JSON.stringify({ type: "tool_call", name: "run_shell_command", args: { command: "ls" } }),
      JSON.stringify({ type: "message", role: "model", content: "final answer" }),
    ].join("\n");
    const extraction = geminiResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "final answer", sessionId: "sess-jsonl-1" });
  });

  test("non-JSON banner lines interleaved in the stream are skipped", () => {
    const stdout = [
      "Loaded cached credentials.",
      JSON.stringify({ type: "init", session_id: "sess-2" }),
      JSON.stringify({ type: "result", response: "done" }),
    ].join("\n");
    const extraction = geminiResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "done", sessionId: "sess-2" });
  });

  test("stream with JSON events but no text falls back to raw stdout", () => {
    // Two lines force the JSONL path (a single JSON line parses as a whole
    // document first).
    const stdout = [
      JSON.stringify({ type: "init", session_id: "sess-3" }),
      JSON.stringify({ type: "tool_call", name: "run_shell_command" }),
    ].join("\n");
    const extraction = geminiResultExtractor(makeRunResult({ stdout }));
    expect(extraction.text).toBe(stdout);
    expect(extraction.sessionId).toBe("sess-3");
  });
});

// ── Extractor — plain text + fallbacks ────────────────────────────────────────

describe("geminiResultExtractor — plain text and fallbacks", () => {
  test("plain text stdout passes through trimmed", () => {
    const extraction = geminiResultExtractor(makeRunResult({ stdout: "  just some prose \n" }));
    expect(extraction).toEqual({ text: "just some prose" });
  });

  test("empty stdout yields empty text", () => {
    const extraction = geminiResultExtractor(makeRunResult({ stdout: "   \n " }));
    expect(extraction).toEqual({ text: "" });
  });

  test("result.sessionId is the fallback when the output carries none", () => {
    const extraction = geminiResultExtractor(
      makeRunResult({ stdout: JSON.stringify({ response: "ok" }), sessionId: "raw-sess" }),
    );
    expect(extraction).toEqual({ text: "ok", sessionId: "raw-sess" });
  });

  test("output-borne session id wins over result.sessionId", () => {
    const extraction = geminiResultExtractor(
      makeRunResult({ stdout: JSON.stringify({ response: "ok", session_id: "fresh" }), sessionId: "stale" }),
    );
    expect(extraction.sessionId).toBe("fresh");
  });

  test("malformed JSON degrades to plain-text passthrough", () => {
    const stdout = '{"response": "trunca';
    const extraction = geminiResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: stdout });
  });
});
