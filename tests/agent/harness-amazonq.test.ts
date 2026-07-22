/**
 * Tests for the Amazon Q Developer CLI harness adapter (P2, plan §"The
 * adapter contract" / §"Capability matrix" / §"Structured-output
 * normalization"):
 *   - harnesses/amazonq/agent-builder.ts    — headless argv construction
 *   - harnesses/amazonq/result-extractor.ts — stdout → { text, sessionId? }
 *
 * The builder/extractor are exercised directly (they are NOT registered in
 * builders.ts / harnesses/index.ts yet — wiring is a follow-up integration
 * task). No real binaries are spawned; extractor fixtures are representative
 * captures of `q chat --no-interactive` plain-text output (Q has no
 * documented structured output — the matrix's tier-"none" harness), including
 * the ANSI color/spinner framing Q writes even to a piped stdout.
 */
import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { AgentRunResult } from "../../src/integrations/agent/spawn";
import { AMAZONQ_PLATFORM, amazonqBuilder } from "../../src/integrations/harnesses/amazonq/agent-builder";
import {
  amazonqResultExtractor,
  stripTerminalFraming,
} from "../../src/integrations/harnesses/amazonq/result-extractor";

// ── Helpers ───────────────────────────────────────────────────────────────────

const ESC = "\u001B";

function makeQProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "amazonq",
    bin: "q",
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

// ── Builder — plain prompt ────────────────────────────────────────────────────

describe("amazonqBuilder — plain prompt", () => {
  test("argv = [q, chat, --no-interactive, --trust-all-tools, --, <prompt>] (matrix headless shape)", () => {
    const cmd = amazonqBuilder.build(makeQProfile(), { prompt: "do work" });
    expect(cmd.argv).toEqual(["q", "chat", "--no-interactive", "--trust-all-tools", "--", "do work"]);
  });

  test("platform id is 'amazonq' (matrix)", () => {
    expect(amazonqBuilder.platform).toBe("amazonq");
    expect(AMAZONQ_PLATFORM).toBe("amazonq");
  });

  test("profile.args are preserved after the chat subcommand", () => {
    const cmd = amazonqBuilder.build(makeQProfile({ args: ["--agent", "dev"] }), { prompt: "go" });
    expect(cmd.argv).toEqual(["q", "chat", "--agent", "dev", "--no-interactive", "--trust-all-tools", "--", "go"]);
  });

  test("a profile that already pins `chat` as its first arg is not doubled", () => {
    const cmd = amazonqBuilder.build(makeQProfile({ args: ["chat", "--agent", "dev"] }), { prompt: "go" });
    expect(cmd.argv).toEqual(["q", "chat", "--agent", "dev", "--no-interactive", "--trust-all-tools", "--", "go"]);
  });

  test("systemPrompt is folded into the positional payload (q chat has no system-prompt flag)", () => {
    const cmd = amazonqBuilder.build(makeQProfile(), { prompt: "do work", systemPrompt: "You are terse." });
    const argv = cmd.argv as string[];
    expect(argv[argv.length - 1]).toBe("You are terse.\n\ndo work");
    expect(argv.includes("--system-prompt")).toBe(false);
  });

  test("prompt stays positional after `--` so a dash-leading prompt cannot become flags", () => {
    const cmd = amazonqBuilder.build(makeQProfile(), { prompt: "--not-a-flag actually prose" });
    const argv = cmd.argv as string[];
    expect(argv[argv.length - 2]).toBe("--");
    expect(argv[argv.length - 1]).toBe("--not-a-flag actually prose");
  });
});

// ── Builder — tool policy (--trust-tools / --trust-all-tools) ────────────────

describe("amazonqBuilder — tool policy", () => {
  test("no tools → --trust-all-tools (headless autonomy per the matrix)", () => {
    const cmd = amazonqBuilder.build(makeQProfile(), { prompt: "go" });
    expect((cmd.argv as string[]).includes("--trust-all-tools")).toBe(true);
  });

  test("array policy maps to equals-joined --trust-tools and suppresses --trust-all-tools", () => {
    const cmd = amazonqBuilder.build(makeQProfile(), { prompt: "go", tools: ["fs_read", "fs_write"] });
    const argv = cmd.argv as string[];
    expect(argv.includes("--trust-tools=fs_read,fs_write")).toBe(true);
    expect(argv.includes("--trust-all-tools")).toBe(false);
  });

  test("comma-separated string policy is normalized (whitespace trimmed, empties dropped)", () => {
    const cmd = amazonqBuilder.build(makeQProfile(), { prompt: "go", tools: "fs_read, execute_bash ," });
    expect((cmd.argv as string[]).includes("--trust-tools=fs_read,execute_bash")).toBe(true);
  });

  test("structured policy object is dropped WITHOUT widening to --trust-all-tools", () => {
    const cmd = amazonqBuilder.build(makeQProfile(), {
      prompt: "go",
      tools: { allowed: ["fs_read"] } as unknown as string[],
    });
    const argv = cmd.argv as string[];
    expect(argv.includes("--trust-all-tools")).toBe(false);
    expect(argv.some((a) => a.startsWith("--trust-tools"))).toBe(false);
  });

  test("empty array trusts no tools (--trust-tools= with empty value, still no trust-all)", () => {
    const cmd = amazonqBuilder.build(makeQProfile(), { prompt: "go", tools: [] });
    const argv = cmd.argv as string[];
    expect(argv.includes("--trust-tools=")).toBe(true);
    expect(argv.includes("--trust-all-tools")).toBe(false);
  });
});

// ── Builder — model alias resolution ─────────────────────────────────────────

describe("amazonqBuilder — model resolution via resolveModel('amazonq')", () => {
  test("profile.modelAliases resolves a custom alias for the amazonq platform", () => {
    const profile = makeQProfile({ modelAliases: { fast: "claude-haiku-4-5" } });
    const cmd = amazonqBuilder.build(profile, { prompt: "go", model: "fast" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-haiku-4-5");
  });

  test("globalModelAliases amazonq column wins over '*' fallback", () => {
    const profile = makeQProfile({
      globalModelAliases: { deep: { amazonq: "claude-sonnet-4-6", "*": "generic-deep" } },
    });
    const cmd = amazonqBuilder.build(profile, { prompt: "go", model: "deep" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
  });

  test("globalModelAliases '*' fallback applies when no amazonq column exists", () => {
    const profile = makeQProfile({
      globalModelAliases: { deep: { "*": "generic-deep" } },
    });
    const cmd = amazonqBuilder.build(profile, { prompt: "go", model: "deep" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("generic-deep");
  });

  test("builtin alias without an amazonq column passes through verbatim (user aliases own q ids)", () => {
    const cmd = amazonqBuilder.build(makeQProfile(), { prompt: "go", model: "sonnet" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
  });

  test("exact model id passes through verbatim", () => {
    const cmd = amazonqBuilder.build(makeQProfile(), { prompt: "go", model: "claude-sonnet-4" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-4");
  });

  test("no model → no --model flag", () => {
    const cmd = amazonqBuilder.build(makeQProfile(), { prompt: "go" });
    expect((cmd.argv as string[]).includes("--model")).toBe(false);
  });
});

// ── Builder — schema (prompt-injected, tier "none") ──────────────────────────

describe("amazonqBuilder — schema passthrough (prompt+validate tier)", () => {
  const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };

  test("schema directive is injected into the prompt payload", () => {
    const cmd = amazonqBuilder.build(makeQProfile(), { prompt: "judge it", schema });
    const argv = cmd.argv as string[];
    const payload = argv[argv.length - 1] as string;
    expect(argv[argv.length - 2]).toBe("--");
    expect(payload).toStartWith("judge it");
    expect(payload).toContain("Respond with ONLY a JSON value matching this JSON Schema");
    expect(payload).toContain(JSON.stringify(schema));
  });

  test("no native schema/json flags are invented (Q documents none)", () => {
    const cmd = amazonqBuilder.build(makeQProfile(), { prompt: "judge it", schema });
    const argv = cmd.argv as string[];
    expect(argv.includes("--output-schema")).toBe(false);
    expect(argv.includes("--json")).toBe(false);
    expect(argv.includes("--output-format")).toBe(false);
  });

  test("systemPrompt + prompt + schema directive compose in that order", () => {
    const cmd = amazonqBuilder.build(makeQProfile(), { prompt: "judge it", systemPrompt: "Be strict.", schema });
    const payload = (cmd.argv as string[])[cmd.argv.length - 1] as string;
    expect(payload.indexOf("Be strict.")).toBe(0);
    expect(payload.indexOf("judge it")).toBeGreaterThan(payload.indexOf("Be strict."));
    expect(payload.indexOf("JSON Schema")).toBeGreaterThan(payload.indexOf("judge it"));
  });

  test("no schema → payload is exactly the prompt", () => {
    const cmd = amazonqBuilder.build(makeQProfile(), { prompt: "go" });
    expect((cmd.argv as string[])[cmd.argv.length - 1]).toBe("go");
  });
});

// ── Builder — injection guards ────────────────────────────────────────────────

describe("amazonqBuilder — assertNotFlag guards", () => {
  test("model starting with '--' throws", () => {
    expect(() => amazonqBuilder.build(makeQProfile(), { prompt: "go", model: "--evil" })).toThrow(
      /model must not start with "--"/,
    );
  });

  test("systemPrompt starting with '--' throws", () => {
    expect(() => amazonqBuilder.build(makeQProfile(), { prompt: "go", systemPrompt: "--inject" })).toThrow(
      /systemPrompt must not start with "--"/,
    );
  });

  test("tool entry starting with '--' throws", () => {
    expect(() => amazonqBuilder.build(makeQProfile(), { prompt: "go", tools: ["--trust-all-tools"] })).toThrow(
      /tools entry must not start with "--"/,
    );
  });

  test("valid values do not throw", () => {
    expect(() =>
      amazonqBuilder.build(makeQProfile(), { prompt: "go", model: "claude-sonnet-4", systemPrompt: "Be helpful." }),
    ).not.toThrow();
  });
});

// ── Extractor — plain text with terminal framing ─────────────────────────────

describe("amazonqResultExtractor — terminal framing (captured q chat output)", () => {
  test("plain text passes through trimmed", () => {
    const extraction = amazonqResultExtractor(makeRunResult({ stdout: "  The answer is 42. \n" }));
    expect(extraction).toEqual({ text: "The answer is 42." });
  });

  test("ANSI SGR color/bold sequences are stripped", () => {
    const stdout = `${ESC}[38;5;10m${ESC}[1mThe fix${ESC}[0m is in ${ESC}[36msrc/app.ts${ESC}[0m.\n`;
    const extraction = amazonqResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "The fix is in src/app.ts." });
  });

  test("carriage-return spinner frames are overwritten like a real terminal", () => {
    const stdout = `⠋ Thinking...\r${ESC}[2KHere is the summary.\nSecond line survives.\n`;
    const extraction = amazonqResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "Here is the summary.\nSecond line survives." });
  });

  test("OSC title/hyperlink sequences (BEL- and ST-terminated) are stripped", () => {
    const stdout = `${ESC}]0;q chat\u0007See ${ESC}]8;;https://docs.aws${ESC}\\the docs${ESC}]8;;${ESC}\\ for details.`;
    const extraction = amazonqResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "See the docs for details." });
  });

  test("leading '> ' response marker is dropped from the first answer line only", () => {
    const stdout = "\n> Done. Two files changed.\n> quoted content stays\n";
    const extraction = amazonqResultExtractor(makeRunResult({ stdout }));
    expect(extraction.text).toBe("Done. Two files changed.\n> quoted content stays");
  });

  test("CRLF line endings do not leave stray carriage returns", () => {
    const extraction = amazonqResultExtractor(makeRunResult({ stdout: "line one\r\nline two\r\n" }));
    expect(extraction).toEqual({ text: "line one\nline two" });
  });

  test("empty stdout yields empty text", () => {
    const extraction = amazonqResultExtractor(makeRunResult({ stdout: "   \n " }));
    expect(extraction).toEqual({ text: "" });
  });
});

// ── Extractor — prompt-injected schema output (embedded JSON) ────────────────

describe("amazonqResultExtractor — embedded JSON stays intact for the engine", () => {
  test("a JSON answer wrapped in prose + ANSI is cleaned but NOT parsed here", () => {
    const stdout = [
      `⠙ Thinking...\r${ESC}[2KSure — here is the requested JSON:`,
      `${ESC}[32m{"verdict":"pass","confidence":0.9}${ESC}[0m`,
    ].join("\n");
    const extraction = amazonqResultExtractor(makeRunResult({ stdout }));
    expect(extraction.text).toBe('Sure — here is the requested JSON:\n{"verdict":"pass","confidence":0.9}');
  });

  test("a bare JSON document passes through as text (downstream validation owns parsing)", () => {
    const stdout = '{"verdict":"fail"}';
    const extraction = amazonqResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: '{"verdict":"fail"}' });
  });

  test("pre-parsed string result.parsed is used verbatim; non-string parsed shapes are ignored", () => {
    const asString = amazonqResultExtractor(makeRunResult({ stdout: '"quoted"', parsed: "the answer" }));
    expect(asString.text).toBe("the answer");
    const asObject = amazonqResultExtractor(
      makeRunResult({ stdout: '{"verdict":"fail"}', parsed: { verdict: "fail" } }),
    );
    expect(asObject.text).toBe('{"verdict":"fail"}');
  });
});

// ── Extractor — session id ────────────────────────────────────────────────────

describe("amazonqResultExtractor — session id", () => {
  test("Q output carries no session id; extraction omits it by default", () => {
    const extraction = amazonqResultExtractor(makeRunResult({ stdout: "done" }));
    expect(extraction.sessionId).toBeUndefined();
  });

  test("a spawn-layer result.sessionId passes through", () => {
    const extraction = amazonqResultExtractor(makeRunResult({ stdout: "done", sessionId: "spawn-sess" }));
    expect(extraction).toEqual({ text: "done", sessionId: "spawn-sess" });
  });
});

// ── stripTerminalFraming — exported helper ────────────────────────────────────

describe("stripTerminalFraming", () => {
  test("idempotent on already-clean text", () => {
    const clean = "alpha\nbeta";
    expect(stripTerminalFraming(clean)).toBe(clean);
    expect(stripTerminalFraming(stripTerminalFraming(clean))).toBe(clean);
  });

  test("mixed spinner + colors + marker fixture normalizes to the on-screen answer", () => {
    const raw = [
      `${ESC}]0;q${"\u0007"}`,
      `⠋ Loading...\r⠙ Loading...\r${ESC}[2K> ${ESC}[1mAll tests pass.${ESC}[0m`,
      "",
      "3 files reviewed.",
    ].join("\n");
    expect(stripTerminalFraming(raw)).toBe("All tests pass.\n\n3 files reviewed.");
  });
});
